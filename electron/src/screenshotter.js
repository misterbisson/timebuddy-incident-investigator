const { BrowserWindow, session } = require('electron');

let partitionCounter = 0;

/**
 * Renders a Grafana panel URL in a hidden BrowserWindow and captures it as a
 * PNG — the engine's client-side fallback for Grafana instances with no
 * server-side Image Renderer plugin installed (see src/screenshot/types.ts).
 * Each call gets its own in-memory (non-persistent) session partition so its
 * Authorization header — a connection's own bearer token or basic
 * credentials — can be injected via webRequest without leaking into a
 * concurrent call against a different connection: Electron only allows one
 * onBeforeSendHeaders listener per session, so two calls sharing a session
 * would clobber each other's headers. Session objects created this way are
 * never explicitly destroyed (Electron has no API for that); this is fine
 * for the low, bursty call volume an interactive investigation produces, not
 * a suitable pattern for high-frequency screenshotting.
 */
function createScreenshotter() {
  return {
    async capturePanel({ url, headers, width, height, timeoutMs }) {
      const ses = session.fromPartition(`screenshot-${++partitionCounter}`, { cache: false });
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        callback({ requestHeaders: { ...details.requestHeaders, ...headers } });
      });

      const activity = trackNetworkActivity(ses);
      const win = new BrowserWindow({
        show: false,
        width,
        height,
        webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false },
      });

      try {
        await loadWithTimeout(win, url, timeoutMs);
        await waitForNetworkIdle(activity, timeoutMs);
        const image = await win.webContents.capturePage();
        return image.toPNG();
      } finally {
        activity.dispose();
        win.destroy();
      }
    },
  };
}

function loadWithTimeout(win, url, timeoutMs) {
  return Promise.race([
    win.loadURL(url),
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Timed out loading ${url} after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

/**
 * Counts in-flight requests on a session so waitForNetworkIdle can tell "the
 * page finished loading" from "nothing has started yet." A DOM-class
 * heuristic (e.g. polling for a Grafana loading-spinner class) was tried
 * first and rejected: it can't distinguish a panel that finished rendering
 * from one where the app itself never got that far — confirmed against a
 * real Grafana instance with a broken plugin, where the page got stuck
 * forever on Grafana's own generic "Loading ..." bootstrap screen and a
 * spinner-class check declared it "done" instantly, silently screenshotting
 * that placeholder as if it were a real panel. Network idle, by contrast,
 * only declares ready once every fetch the page itself triggered (JS
 * bundles, `/api/ds/query`, etc.) has actually settled — version- and
 * panel-type-agnostic, unlike any specific CSS class.
 */
function trackNetworkActivity(ses) {
  let pending = 0;
  let lastActivity = Date.now();
  const onRequest = (_details, callback) => {
    pending++;
    lastActivity = Date.now();
    callback({});
  };
  const onSettled = () => {
    pending = Math.max(0, pending - 1);
    lastActivity = Date.now();
  };
  ses.webRequest.onBeforeRequest(onRequest);
  ses.webRequest.onCompleted(onSettled);
  ses.webRequest.onErrorOccurred(onSettled);
  return {
    isIdle: (quietMs) => pending === 0 && Date.now() - lastActivity >= quietMs,
    dispose: () => {
      ses.webRequest.onBeforeRequest(null);
      ses.webRequest.onCompleted(null);
      ses.webRequest.onErrorOccurred(null);
    },
  };
}

async function waitForNetworkIdle(activity, timeoutMs) {
  const start = Date.now();
  const quietMs = 500;
  const pollMs = 150;
  while (Date.now() - start < timeoutMs) {
    if (activity.isIdle(quietMs)) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(
    `Panel did not finish loading within ${timeoutMs}ms — network activity never settled (a slow query, a broken/` +
      'incompatible plugin on this Grafana instance, or an actual outage).',
  );
}

module.exports = { createScreenshotter };
