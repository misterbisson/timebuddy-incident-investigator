const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('activityLog', {
  list: () => ipcRenderer.invoke('activity:list'),
  onEntry: (cb) => {
    const listener = (_event, entry) => cb(entry);
    ipcRenderer.on('activity:entry', listener);
    return () => ipcRenderer.removeListener('activity:entry', listener);
  },
  openExternal: (url) => ipcRenderer.invoke('activity:openExternal', url),
});
