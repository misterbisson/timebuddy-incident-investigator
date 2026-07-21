const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('activityLog', {
  list: () => ipcRenderer.invoke('activity:list'),
  onEntry: (cb) => {
    const listener = (_event, entry) => cb(entry);
    ipcRenderer.on('activity:entry', listener);
    return () => ipcRenderer.removeListener('activity:entry', listener);
  },
  openExternal: (url) => ipcRenderer.invoke('activity:openExternal', url),
  // Export the selected entry's panel to a CSV / PNG in the user's Downloads
  // folder; each resolves to the saved file path(s) for the "Reveal" affordance.
  exportCsv: (entry) => ipcRenderer.invoke('activity:exportCsv', { connection: entry.connectionId, url: entry.url }),
  screenshot: (entry) => ipcRenderer.invoke('activity:screenshot', { connection: entry.connectionId, url: entry.url }),
  revealInFolder: (filePath) => ipcRenderer.invoke('activity:revealInFolder', filePath),
});
