const { BrowserWindow, session } = require('electron');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

let partitionCounter = 0;

// Grafana syncs the Inspect drawer to the URL (?inspect=<id>&inspectTab=data,
// see grafana/urlBuilder.ts's buildInspectDataUrl), so it's already open by
// the time the page settles — these three scripts just drive what's left:
// expand the collapsed "Data options" section, flip "Apply panel
// transformations" on if that panel has any configured, then click Download.
// Matched by visible text/type rather than a class name or data-testid,
// since Grafana doesn't publish either as a stable API for this drawer —
// this is the same risk noted on Screenshotter.exportPanelCsv's doc comment.
const EXPAND_DATA_OPTIONS_SCRIPT = `
(function() {
  const drawer = document.querySelector('[role="dialog"], [class*="Drawer"]');
  if (!drawer) return false;
  for (const el of drawer.querySelectorAll('*')) {
    const ownText = Array.from(el.childNodes).find((n) => n.nodeType === 3 && n.textContent.trim() === 'Data options');
    if (ownText) { el.click(); return true; }
  }
  return false;
})()
`;

const CLICK_TRANSFORM_TOGGLE_SCRIPT = `
(function() {
  const drawer = document.querySelector('[role="dialog"], [class*="Drawer"]');
  if (!drawer) return false;
  for (const cb of drawer.querySelectorAll('input[type=checkbox]')) {
    let p = cb.parentElement, text = '';
    for (let i = 0; i < 4 && p; i++) { text = p.textContent.trim(); if (text) break; p = p.parentElement; }
    if (/^Apply panel transformations/.test(text)) {
      if (!cb.checked) cb.click();
      return true;
    }
  }
  return false;
})()
`;

const CLICK_DOWNLOAD_CSV_SCRIPT = `
(function() {
  const drawer = document.querySelector('[role="dialog"], [class*="Drawer"]');
  if (!drawer) return false;
  const btn = Array.from(drawer.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Download CSV');
  if (!btn) return false;
  btn.click();
  return true;
})()
`;

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

    async exportPanelCsv({ url, headers, timeoutMs }) {
      const ses = session.fromPartition(`csv-export-${++partitionCounter}`, { cache: false });
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        callback({ requestHeaders: { ...details.requestHeaders, ...headers } });
      });

      const activity = trackNetworkActivity(ses);
      const win = new BrowserWindow({
        show: false,
        width: 1400,
        height: 1000,
        webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false },
      });
      const downloadDir = await mkdtemp(join(tmpdir(), 'timebuddy-csv-export-'));

      try {
        await loadWithTimeout(win, url, timeoutMs);
        await waitForNetworkIdle(activity, timeoutMs);

        const expanded = await win.webContents.executeJavaScript(EXPAND_DATA_OPTIONS_SCRIPT);
        if (!expanded) {
          throw new Error(
            'Could not find the Inspect > Data drawer\'s "Data options" section - the panel may not support ' +
              "Inspect, or Grafana's UI has changed in a way this integration doesn't recognize yet.",
          );
        }
        await sleep(500);

        const hasTransformToggle = await win.webContents.executeJavaScript(CLICK_TRANSFORM_TOGGLE_SCRIPT);
        if (!hasTransformToggle) {
          // No transformations configured on this panel - nothing for the
          // real browser to show that the direct /api/ds/query export
          // doesn't already capture just as correctly, and more cheaply.
          return {};
        }
        await sleep(500);

        const downloadedPath = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for the CSV download after ${timeoutMs}ms`));
          }, timeoutMs);
          ses.once('will-download', (_event, item) => {
            const savePath = join(downloadDir, item.getFilename() || 'export.csv');
            item.setSavePath(savePath);
            item.once('done', (_doneEvent, state) => {
              clearTimeout(timer);
              if (state === 'completed') resolve(savePath);
              else reject(new Error(`CSV download did not complete (state: ${state})`));
            });
          });
          win.webContents.executeJavaScript(CLICK_DOWNLOAD_CSV_SCRIPT).then((clicked) => {
            if (!clicked) {
              clearTimeout(timer);
              reject(new Error('Could not find the "Download CSV" button in the Inspect > Data drawer.'));
            }
          });
        });

        const csv = await readFile(downloadedPath);
        return { csv };
      } finally {
        activity.dispose();
        win.destroy();
        await rm(downloadDir, { recursive: true, force: true });
      }
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
