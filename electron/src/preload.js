const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('connectionManager', {
  list: () => ipcRenderer.invoke('connections:list'),
  upsert: (connection) => ipcRenderer.invoke('connections:upsert', connection),
  delete: (id) => ipcRenderer.invoke('connections:delete', id),
  test: (draft) => ipcRenderer.invoke('connections:test', draft),
  registrationInfo: () => ipcRenderer.invoke('connections:registrationInfo'),
});
