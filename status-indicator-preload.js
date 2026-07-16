const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  setStatusState: (state) => ipcRenderer.send('status-indicator-set', state),
  onStatusState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('status-indicator-state', handler);
    return () => ipcRenderer.removeListener('status-indicator-state', handler);
  }
});
