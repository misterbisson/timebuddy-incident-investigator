const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const store = require('./connectionStore.js');
const { testConnection } = require('./grafanaTest.js');
const { createScreenshotter } = require('./screenshotter.js');

// Populated once runMcpServer() has dynamically imported the engine package —
// null in the normal (non --mcp-server) GUI launch, since there's no
// investigation activity to show there.
let activityLog = null;
let activityWindow = null;

// safeStorage's encryption key is scoped to the app's identity (name) in the
// OS keychain. Set it explicitly rather than relying on package.json
// inference, which varies depending on exactly how this binary is invoked
// (e.g. by Claude Code/Desktop spawning it directly vs. a user launching the
// installed app) — a mismatch here means secrets encrypted in one launch
// can't be decrypted in another.
app.setName('timebuddy-connection-manager');

// Dual-mode: launched normally, this opens the connection-manager GUI.
// Launched with --mcp-server (by Claude Code/Desktop spawning this same
// binary as their MCP server command), it skips the window entirely and
// runs the MCP engine over stdio instead, reading connections straight out
// of safeStorage — see connectionStore.js's getConnectionsForEngine().
const isMcpMode = process.argv.includes('--mcp-server');

function createWindow() {
  const win = new BrowserWindow({
    width: 760,
    height: 640,
    title: 'Grafana Connection Manager',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// One persistent, shared session for the Activity window's live-view
// <webview> (partition name matched in renderer/activity.html), authenticated
// the same way screenshotter.js authenticates its one-shot capture windows —
// injecting a connection's own Authorization header via webRequest — but
// long-lived instead of destroyed after one call, and picking which
// connection's header to inject per-request by matching the request's host
// against every configured connection's URL, since one <webview> may be
// pointed at panels from different connections over the life of the window.
function setupLiveViewSession(buildAuthHeader) {
  const ses = session.fromPartition('persist:activity-live-view', { cache: false });
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    let requestHost;
    try {
      requestHost = new URL(details.url).host;
    } catch {
      callback({});
      return;
    }
    const connection = store.getConnectionsForEngine().find((c) => {
      try {
        return new URL(c.url).host === requestHost;
      } catch {
        return false;
      }
    });
    if (!connection) {
      callback({});
      return;
    }
    try {
      callback({ requestHeaders: { ...details.requestHeaders, Authorization: buildAuthHeader(connection) } });
    } catch {
      // Misconfigured connection (e.g. bearer auth with no token saved yet) —
      // load without auth rather than crash the whole live-view session.
      callback({});
    }
  });
}

/** Created lazily on the first activity entry, and re-created the same way if the user closes it and a later entry arrives. */
function getOrCreateActivityWindow() {
  if (activityWindow && !activityWindow.isDestroyed()) return activityWindow;
  activityWindow = new BrowserWindow({
    width: 960,
    height: 680,
    title: 'Timebuddy Activity',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-activity.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  activityWindow.loadFile(path.join(__dirname, '..', 'renderer', 'activity.html'));
  activityWindow.on('closed', () => {
    activityWindow = null;
  });
  return activityWindow;
}

async function runMcpServer() {
  const startupConnections = store.getConnectionsForEngine();
  // The engine package is ESM ("type": "module"); dynamic import works from
  // this CommonJS main process without converting the whole Electron app.
  const { startMcpServer, createActivityLog, buildAuthHeader } = await import('timebuddy-incident-investigator');

  activityLog = createActivityLog();
  activityLog.onEntry((entry) => {
    getOrCreateActivityWindow().webContents.send('activity:entry', entry);
  });
  setupLiveViewSession(buildAuthHeader);

  // Pass a thunk, not the snapshot above, so the engine re-reads
  // connections.json/secrets.enc.json on every tool call — a connection
  // added or edited in the GUI takes effect on the next tool call, with no
  // need to restart this MCP server process (restarting the GUI window
  // alone never did anything here anyway: it's a separate process from the
  // one Claude Code/Desktop is already talking to over stdio).
  await startMcpServer(
    () => store.getConnectionsForEngine(),
    {
      // The engine's own default (DATA_DIR env var, else './.data') is
      // relative to process.cwd() — but Claude Code/Desktop controls what cwd
      // this process is spawned with, not us, and it isn't necessarily
      // consistent. Confirmed in practice: the metric-index cache ended up
      // split across two different .data folders depending on cwd, and the
      // one Claude Code actually used kept serving stale (pre-bugfix) data
      // that a fresh run elsewhere had already proven fixed. Anchoring to
      // Electron's own per-OS userData dir (already used for
      // connections.json/secrets.enc.json) makes the cache location the same
      // every time, regardless of how this process gets launched.
      dataDir: path.join(app.getPath('userData'), 'data'),
    },
    // Only the Electron app has a bundled Chromium to drive a headless
    // capture with — this is what gates screenshot_panel's registration.
    createScreenshotter(),
    activityLog,
  );
  // Deliberately console.error, not console.log — stdout is the MCP
  // JSON-RPC channel once the transport is connected.
  console.error(
    `timebuddy-incident-investigator MCP server running on stdio (${startupConnections.length} Grafana connection(s): ${startupConnections.map((c) => c.id).join(', ')})`,
  );
}

app.whenReady().then(async () => {
  if (isMcpMode) {
    try {
      await runMcpServer();
    } catch (err) {
      console.error('Fatal error starting MCP server:', err);
      app.exit(1);
    }
    return;
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMcpMode && process.platform !== 'darwin') app.quit();
});

ipcMain.handle('connections:list', () => store.listConnectionsForDisplay());
ipcMain.handle('connections:upsert', (_event, connection) => store.upsertConnection(connection));
ipcMain.handle('connections:delete', (_event, id) => store.deleteConnection(id));
ipcMain.handle('connections:test', (_event, draft) => testConnection(draft));
ipcMain.handle('activity:list', () => (activityLog ? activityLog.list() : []));
ipcMain.handle('activity:openExternal', (_event, url) => {
  // Every activity entry's url is built by this app's own buildDashboardUrl()
  // (never renderer-supplied), but guard the scheme anyway since this handler
  // hands the string straight to the OS - only ever open http(s) links.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') shell.openExternal(url);
});

ipcMain.handle('connections:registrationInfo', () => ({
  execPath: app.getPath('exe'),
  appName: app.getName(),
  isPackaged: app.isPackaged,
  // Only meaningful when !isPackaged: the raw dev Electron binary needs the
  // app directory as an explicit argument, or it just prints its own --help
  // and never loads main.js at all. A packaged executable has the app
  // bundled in and must NOT be passed this — it would be misread as an
  // arg to the app rather than "which app to load."
  appPath: app.isPackaged ? undefined : path.join(__dirname, '..'),
}));
