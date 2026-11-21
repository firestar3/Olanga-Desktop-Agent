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
  refreshSports: () => send('sports-refresh'),
  openSportsSettings: () => send('sports-settings'),
  startSportsDrag: () => send('sports-drag-start'),
  moveSportsDrag: () => send('sports-drag-move'),
  endSportsDrag: () => send('sports-drag-end'),
  cancelSportsDrag: () => send('sports-drag-cancel'),
  toggleSports: () => send('sports-toggle'),
  setSportsCollapsed: (collapsed) => { if (typeof collapsed === 'boolean') send('sports-set-collapsed', { collapsed }); },
  selectCompanion: (card) => { if (card === 'sports' || card === 'timers') send('companion-select', { card }); },
  openTimerSettings: () => send('timers-settings'),
  openTimers: () => send('timers-open'),
  startTimerDrag: () => send('timers-drag-start'),
  moveTimerDrag: () => send('timers-drag-move'),
  endTimerDrag: () => send('timers-drag-end'),
  cancelTimerDrag: () => send('timers-drag-cancel'),
  toggleTimerMode: () => send('timers-toggle-mode'),
  setTimerMode: (mode) => { if (['expanded', 'compact', 'tucked'].includes(mode)) send('timers-set-mode', { mode }); },
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
