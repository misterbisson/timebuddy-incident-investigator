const { app, BrowserWindow, Menu, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const store = require('./connectionStore.js');
const { testConnection } = require('./grafanaTest.js');
const { createScreenshotter } = require('./screenshotter.js');
const { attachAuthHeaders } = require('./authGuard.js');

// Populated once runMcpServer() has dynamically imported the engine package —
// null in the normal (non --mcp-server) GUI launch, since there's no
// investigation activity to show there.
let activityLog = null;
// Same lifecycle as activityLog: the engine's in-process screenshot/CSV export
// entry point (createPanelActions), backing the Activity window's "Capture
// screenshot" / "Export CSV" buttons. Null outside --mcp-server mode.
let panelActions = null;
let activityWindow = null;
let connectionsWindow = null;

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

/**
 * Singleton: called both from normal GUI startup and from the "Connections…"
 * menu item, so a click while the window is already open should focus it
 * rather than spawn a duplicate — most relevant in --mcp-server mode, where
 * this is otherwise the only way to reach the connections GUI without
 * relaunching the whole process.
 */
function openOrFocusConnectionsWindow() {
  if (connectionsWindow && !connectionsWindow.isDestroyed()) {
    connectionsWindow.focus();
    return connectionsWindow;
  }
  connectionsWindow = new BrowserWindow({
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
  connectionsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  connectionsWindow.on('closed', () => {
    connectionsWindow = null;
  });
  return connectionsWindow;
}

/**
 * Replaces Electron's default menu (generic Electron-branded Help links, a
 * File menu with nothing relevant to this app, etc.) with one scoped to what
 * this app actually does. Built fresh in both launch modes — macOS always
 * shows an app-level menu bar even when --mcp-server mode never opens a
 * window, and "Connections…" is how that mode's user reaches the GUI at all.
 */
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Connections…',
          accelerator: 'CmdOrCtrl+,',
          click: () => openOrFocusConnectionsWindow(),
        },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// One persistent, shared session for the Activity window's live-view
// <webview> (partition name matched in renderer/activity.html), authenticated
// the same way screenshotter.js authenticates its one-shot capture windows —
// injecting a connection's own Authorization header via webRequest — but
// long-lived instead of destroyed after one call, and picking which
// connection's header to inject per-request, since one <webview> may be
// pointed at panels from different connections over the life of the window.
//
// The per-request match goes through the engine's originMatchesConnection so a
// connection's `matchHosts` aliases are honored here exactly as they are in
// tool-call connection resolution — a load-balancer/vanity alias the user was
// told to add there (the #83 error message points at matchHosts) would
// otherwise render an unauthenticated panel here, silently. originMatchesConnection
// pins the alias to the connection's own scheme, so this never widens the
// origin guarantee attachAuthHeaders exists to keep (see authGuard.js / #85).
function setupLiveViewSession(buildAuthHeader, originMatchesConnection) {
  const ses = session.fromPartition('persist:activity-live-view', { cache: false });
  attachAuthHeaders(ses, (origin) => {
    const connection = store.getConnectionsForEngine().find((c) => originMatchesConnection(origin, c));
    return connection ? { Authorization: buildAuthHeader(connection) } : null;
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
  const { startMcpServer, createActivityLog, buildAuthHeader, originMatchesConnection, createPanelActions } = await import('timebuddy-incident-investigator');

  activityLog = createActivityLog();
  activityLog.onEntry((entry) => {
    getOrCreateActivityWindow().webContents.send('activity:entry', entry);
  });
  setupLiveViewSession(buildAuthHeader, originMatchesConnection);

  // The engine's own default (DATA_DIR env var, else './.data') is relative to
  // process.cwd() — but Claude Code/Desktop controls what cwd this process is
  // spawned with, not us, and it isn't necessarily consistent. Confirmed in
  // practice: the metric-index cache ended up split across two different .data
  // folders depending on cwd, and the one Claude Code actually used kept
  // serving stale (pre-bugfix) data that a fresh run elsewhere had already
  // proven fixed. Anchoring to Electron's own per-OS userData dir (already
  // used for connections.json/secrets.enc.json) makes the cache location the
  // same every time, regardless of how this process gets launched.
  const dataDir = path.join(app.getPath('userData'), 'data');
  const connectionsSource = () => store.getConnectionsForEngine();
  // Only the Electron app has a bundled Chromium to drive a headless capture
  // with — this same screenshotter both gates screenshot_panel's registration
  // and backs the Activity window's own export buttons via createPanelActions.
  const screenshotter = createScreenshotter();
  panelActions = createPanelActions(connectionsSource, { dataDir }, screenshotter);

  // Pass a thunk, not the snapshot above, so the engine re-reads
  // connections.json/secrets.enc.json on every tool call — a connection
  // added or edited in the GUI takes effect on the next tool call, with no
  // need to restart this MCP server process (restarting the GUI window
  // alone never did anything here anyway: it's a separate process from the
  // one Claude Code/Desktop is already talking to over stdio).
  await startMcpServer(connectionsSource, { dataDir }, screenshotter, activityLog);
  // Deliberately console.error, not console.log — stdout is the MCP
  // JSON-RPC channel once the transport is connected.
  console.error(
    `timebuddy-incident-investigator MCP server running on stdio (${startupConnections.length} Grafana connection(s): ${startupConnections.map((c) => c.id).join(', ')})`,
  );
}

app.whenReady().then(async () => {
  buildMenu();
  if (isMcpMode) {
    try {
      await runMcpServer();
    } catch (err) {
      console.error('Fatal error starting MCP server:', err);
      app.exit(1);
    }
    return;
  }
  openOrFocusConnectionsWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openOrFocusConnectionsWindow();
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

// Writes `data` into the user's Downloads folder under `filename`, without ever
// clobbering an existing file: on a name collision it appends " (2)", " (3)",
// … until one is free. The `wx` flag makes each attempt fail rather than
// overwrite if the name appeared between attempts, so this is race-free (no
// check-then-write TOCTOU gap). Only the basename of `filename` is used, so a
// engine-suggested name can never write outside Downloads.
async function writeToDownloads(filename, data) {
  const dir = app.getPath('downloads');
  await mkdir(dir, { recursive: true });
  const safe = path.basename(filename);
  const ext = path.extname(safe);
  const stem = path.basename(safe, ext);
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`;
    const full = path.join(dir, name);
    try {
      await writeFile(full, data, { flag: 'wx' });
      return full;
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
  }
}

// The Activity window's "Export CSV" / "Capture screenshot" buttons. Both take
// { connection, url } straight off the selected activity entry — the entry's
// connection id (authoritative) and its round-trippable dashboard/panel url
// (which carries the panelId, window, and var-* overrides). The engine does the
// same resolve → capture the MCP tools do, but hands back bytes; the file lands
// in Downloads and its path goes back to the renderer for the "Reveal" button.
ipcMain.handle('activity:exportCsv', async (_event, { connection, url }) => {
  if (!panelActions) throw new Error('Export is only available while the MCP server is running.');
  const result = await panelActions.exportCsv({ connection, url });
  const files = [];
  for (const file of result.files) {
    const savedPath = await writeToDownloads(file.suggestedFilename, file.content);
    files.push({ path: savedPath, name: path.basename(savedPath), rows: file.rows, columns: file.columns });
  }
  return { files, meta: result.meta };
});

ipcMain.handle('activity:screenshot', async (_event, { connection, url }) => {
  if (!panelActions) throw new Error('Screenshot is only available while the MCP server is running.');
  const result = await panelActions.screenshot({ connection, url });
  const savedPath = await writeToDownloads(result.suggestedFilename, result.png);
  return { path: savedPath, name: path.basename(savedPath), meta: result.meta };
});

ipcMain.handle('activity:revealInFolder', (_event, filePath) => {
  // Only ever reveal a file we just wrote into Downloads — never an arbitrary
  // renderer-supplied path. showItemInFolder opens a native file-manager window
  // selecting the file, so scope it to the one directory these buttons write to.
  const downloads = app.getPath('downloads');
  const resolved = path.resolve(String(filePath));
  if (resolved === downloads || resolved.startsWith(downloads + path.sep)) {
    shell.showItemInFolder(resolved);
  }
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
  // The plugin/skills bundle: package.json's build.extraResources copies the
  // repo's .claude-plugin/ and skills/ into Resources/plugin/ (outside
  // app.asar, since Claude Code reads these files from disk as a separate
  // process — asar's virtual fs is only transparent to this app's own
  // Node/Electron runtime). In a dev checkout there's no packaged Resources
  // dir, so point straight at the repo root two levels up from src/, which
  // already has the same .claude-plugin/skills layout.
  pluginPath: app.isPackaged
    ? path.join(process.resourcesPath, 'plugin')
    : path.join(__dirname, '..', '..'),
}));
