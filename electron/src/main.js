const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const store = require('./connectionStore.js');
const { testConnection } = require('./grafanaTest.js');

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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

async function runMcpServer() {
  const startupConnections = store.getConnectionsForEngine();
  // The engine package is ESM ("type": "module"); dynamic import works from
  // this CommonJS main process without converting the whole Electron app.
  const { startMcpServer } = await import('timebuddy-incident-investigator');
  // Pass a thunk, not the snapshot above, so the engine re-reads
  // connections.json/secrets.enc.json on every tool call — a connection
  // added or edited in the GUI takes effect on the next tool call, with no
  // need to restart this MCP server process (restarting the GUI window
  // alone never did anything here anyway: it's a separate process from the
  // one Claude Code/Desktop is already talking to over stdio).
  await startMcpServer(() => store.getConnectionsForEngine(), {
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
  });
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
