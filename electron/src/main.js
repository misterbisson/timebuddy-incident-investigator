const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const path = require('node:path');
const store = require('./connectionStore.js');
const { testConnection } = require('./grafanaTest.js');

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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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
