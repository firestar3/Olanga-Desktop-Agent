const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  expandWindow: () => ipcRenderer.send('window-expand'),
  setStatusState: (state) => ipcRenderer.send('status-indicator-set', state),
  setStatusLightMode: (mode) => ipcRenderer.send('status-indicator-set-mode', mode),
  setStatusLightSize: (size) => ipcRenderer.send('status-indicator-set-size', size),
  getOpenAtLogin: () => ipcRenderer.invoke('get-open-at-login'),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke('set-open-at-login', enabled),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  playSpotify: (type, term) => ipcRenderer.send('play-spotify', { type, term }),
  reloadSpotify: () => ipcRenderer.send('reload-spotify'),
  mediaControl: (cmd) => ipcRenderer.send('media-control', cmd),
  openApp: (appName) => ipcRenderer.send('open-app', appName),
  requestScreenshot: () => ipcRenderer.invoke('request-screenshot'),
  executeCommand: (payload) => ipcRenderer.invoke('execute-command', payload),
  createTerminalSession: (payload) => ipcRenderer.invoke('terminal-session-create', payload),
  executeTerminalSessionCommand: (payload) => ipcRenderer.invoke('terminal-session-execute', payload),
  closeTerminalSession: (payload) => ipcRenderer.invoke('terminal-session-close', payload),
  fetchNewsBundle: (payload) => ipcRenderer.invoke('fetch-news-bundle', payload),
  nvidiaTtsConfig: (payload) => ipcRenderer.invoke('nvidia-tts-config', payload),
  nvidiaTtsSynthesize: (payload) => ipcRenderer.invoke('nvidia-tts-synthesize', payload),
  nvidiaChat: (payload) => ipcRenderer.invoke('nvidia-chat', payload),
  secureStoreGet: (key) => ipcRenderer.invoke('secure-store-get', key),
  secureStoreSet: (key, value) => ipcRenderer.invoke('secure-store-set', { key, value })
});
