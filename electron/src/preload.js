const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('connectionManager', {
  list: () => ipcRenderer.invoke('connections:list'),
  upsert: (connection) => ipcRenderer.invoke('connections:upsert', connection),
  delete: (id) => ipcRenderer.invoke('connections:delete', id),
  test: (draft) => ipcRenderer.invoke('connections:test', draft),
  storageInfo: () => ipcRenderer.invoke('connections:storageInfo'),
  openStorageDir: () => ipcRenderer.invoke('connections:openStorageDir'),
  copyStorageDir: () => ipcRenderer.invoke('connections:copyStorageDir'),
  registrationInfo: () => ipcRenderer.invoke('connections:registrationInfo'),
});
