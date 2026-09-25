'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const send = (type, details = {}) => ipcRenderer.send('status-overlay-action', { type, ...details });

contextBridge.exposeInMainWorld('olangaSideLight', {
  ready: () => send('ready'),
  refreshPointer: () => send('pointer'),
  toggleMenu: () => send('toggle'),
  closeMenu: () => send('close'),
  hideLight: (duration) => {
    if (duration === '5-seconds' || duration === '1-hour') send('hide', { duration });
  },
  openApp: () => send('open-app'),
  runQuickAction: (id) => {
    if (typeof id === 'string' && /^slot-[1-5]$/.test(id)) send('quick-action', { id });
  },
  onSnapshot: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('status-overlay-snapshot', handler);
    return () => ipcRenderer.removeListener('status-overlay-snapshot', handler);
  }
});
