const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
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
  const connections = store.getConnectionsForEngine();
  // The engine package is ESM ("type": "module"); dynamic import works from
  // this CommonJS main process without converting the whole Electron app.
  const { startMcpServer } = await import('timebuddy-incident-investigator');
  await startMcpServer(connections);
  // Deliberately console.error, not console.log — stdout is the MCP
  // JSON-RPC channel once the transport is connected.
  console.error(
    `timebuddy-incident-investigator MCP server running on stdio (${connections.length} Grafana connection(s): ${connections.map((c) => c.id).join(', ')})`,
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
ipcMain.handle('connections:storageInfo', () => ({ dir: store.storageDir() }));
ipcMain.handle('connections:openStorageDir', () => shell.openPath(store.storageDir()));
ipcMain.handle('connections:copyStorageDir', () => {
  clipboard.writeText(store.storageDir());
});
ipcMain.handle('connections:registrationInfo', () => ({
  execPath: app.getPath('exe'),
  appName: app.getName(),
}));
