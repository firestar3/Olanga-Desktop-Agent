'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const statusLight = require('../shared/status-light');
const quickActions = require('../shared/quick-actions');

const ACTION_CHANNEL = 'status-overlay-action';
const SNAPSHOT_CHANNEL = 'status-overlay-snapshot';
const EDGE = 6;
const MENU_GAP = 8;
const MENU_WIDTH = 280;
const MENU_HEIGHT = 354;
const HOVER_SCALE = 1.12;
const HIDE_DURATIONS = Object.freeze({ '5-seconds': 5000, '1-hour': 60 * 60 * 1000 });

function overlayGeometry(width, height, size) {
  const diameter = Math.min(statusLight.sizeToPixels(size), Math.max(0, Math.min(width, height) - EDGE * 2));
  const menuWidth = Math.min(MENU_WIDTH, Math.max(0, width - EDGE * 2));
  const menuHeight = Math.min(MENU_HEIGHT, Math.max(0, height - diameter - EDGE * 2 - MENU_GAP));
  return {
    diameter,
    orb: { x: width - EDGE - diameter, y: height - EDGE - diameter, width: diameter, height: diameter },
    menu: { x: width - EDGE - menuWidth, y: height - EDGE - diameter - MENU_GAP - menuHeight, width: menuWidth, height: menuHeight }
  };
}

function inRoundedRectangle(point, rect, radius) {
  if (point.x < rect.x || point.x > rect.x + rect.width || point.y < rect.y || point.y > rect.y + rect.height) return false;
  radius = Math.min(radius, rect.width / 2, rect.height / 2);
  const x = Math.max(rect.x + radius, Math.min(point.x, rect.x + rect.width - radius));
  const y = Math.max(rect.y + radius, Math.min(point.y, rect.y + rect.height - radius));
  return (point.x - x) ** 2 + (point.y - y) ** 2 <= radius ** 2;
}

// The transparent BrowserWindow is deliberately bigger than its visible orb.
// Native hit testing captures only the visible circle or the open menu, never
// the invisible rectangular window or its decorative glow/shadow.
function pointerTarget(point, geometry, menuOpen, hovered = false) {
  const orb = geometry.orb;
  const radius = orb.width / 2 * (hovered || menuOpen ? HOVER_SCALE : 1);
  const x = point.x - (orb.x + orb.width / 2);
  const y = point.y - (orb.y + orb.height / 2);
  if (x * x + y * y <= radius * radius) return 'orb';
  if (menuOpen && inRoundedRectangle(point, geometry.menu, 12)) return 'menu';
  return null;
}

function createStatusOverlay({ BrowserWindow, ipcMain, screen, basePath, onOpenApp, onQuickAction }) {
  let window = null;
  let state = 'idle';
  let mode = statusLight.DEFAULT_MODE;
  let size = statusLight.DEFAULT_SIZE;
  let slots = quickActions.normalizeQuickActions();
  let ready = false;
  let menuOpen = false;
  let hovered = false;
  let ignoringMouse = true;
  let hiddenUntil = 0;
  let suspended = false;
  let hiddenTimer = null;
  let pollTimer = null;
  let outsideSince = 0;
  let lastRaise = 0;
  let lastPointer = null;
  let disposed = false;
  let screenListenersRegistered = false;
  const filePath = path.join(basePath, 'status-indicator.html');
  const expectedURL = pathToFileURL(filePath).href;

  function alive() { return window && !window.isDestroyed(); }
  function visibleState() { return statusLight.resolveVisualState(state, mode); }
  function shouldShow() { return !suspended && Date.now() >= hiddenUntil && visibleState() !== 'off'; }

  function getGeometry() {
    const bounds = window.getBounds();
    return overlayGeometry(bounds.width, bounds.height, size);
  }

  function snapshot() {
    if (!alive() || !ready) return;
    window.webContents.send(SNAPSHOT_CHANNEL, {
      state: visibleState(), menuOpen, hovered, geometry: getGeometry(),
      actions: slots.map(({ id, label }) => ({ id, label }))
    });
  }

  function setMouseIgnored(value) {
    if (!alive() || ignoringMouse === value) return;
    ignoringMouse = value;
    window.setIgnoreMouseEvents(value, { forward: true });
  }

  function raise() {
    if (!alive() || !window.isVisible()) return;
    // Reassert after application switches and display changes. moveTop changes
    // z-order without stealing keyboard focus from the user's current app.
    window.setAlwaysOnTop(true, 'screen-saver');
    window.moveTop();
    lastRaise = Date.now();
  }

  function closeMenu() {
    if (!alive() || !menuOpen) return;
    menuOpen = false;
    outsideSince = 0;
    // An outside click has already transferred focus. Blurring again on
    // Windows can deactivate the app the user just selected.
    if (window.isFocused()) window.blur();
    snapshot();
    updatePointer();
  }

  function syncVisibility() {
    if (!alive() || !ready) return;
    if (shouldShow()) {
      if (!window.isVisible()) window.showInactive();
      raise();
    } else {
      closeMenu();
      hovered = false;
      setMouseIgnored(true);
      window.hide();
    }
    snapshot();
  }

  function position() {
    if (!alive()) return;
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    const windowWidth = Math.min(MENU_WIDTH + EDGE * 2, width);
    const windowHeight = Math.min(MENU_HEIGHT + statusLight.sizeToPixels(size) + EDGE * 2 + MENU_GAP, height);
    window.setBounds({ x: Math.round(x + width - windowWidth), y: Math.round(y + height - windowHeight), width: windowWidth, height: windowHeight });
    snapshot();
    updatePointer();
    raise();
  }

  function updatePointer() {
    if (!alive() || !ready || !window.isVisible() || !shouldShow()) {
      setMouseIgnored(true);
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    const point = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
    const target = pointerTarget(point, getGeometry(), menuOpen, hovered);
    setMouseIgnored(!target);
    const nextHover = target === 'orb';
    if (nextHover !== hovered) {
      hovered = nextHover;
      snapshot();
    }
    if (menuOpen) {
      if (target) outsideSince = 0;
      else if (!outsideSince && lastPointer && (cursor.x !== lastPointer.x || cursor.y !== lastPointer.y)) outsideSince = Date.now();
      // Blur normally closes on an outside click. This is a fallback for apps
      // that do not accept focus, and for leaving the monitor altogether.
      if (outsideSince && Date.now() - outsideSince >= 1200) closeMenu();
    }
    lastPointer = cursor;
    if (Date.now() - lastRaise >= 2000) raise();
  }

  function isTrusted(event) {
    return alive() && event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      event.senderFrame.url === expectedURL;
  }

  function handleAction(event, action) {
    if (!isTrusted(event) || !action || typeof action !== 'object' || Array.isArray(action)) return;
    if (action.type === 'ready') {
      ready = true;
      syncVisibility();
      updatePointer();
      return;
    }
    if (!ready || !window.isVisible() || !shouldShow()) return;
    if (action.type === 'pointer') {
      // Use the OS cursor position, never renderer-supplied coordinates.
      updatePointer();
      return;
    }
    if (action.type === 'toggle') {
      if (menuOpen) closeMenu();
      else {
        menuOpen = true;
        outsideSince = 0;
        window.focus();
        raise();
        snapshot();
        updatePointer();
      }
      return;
    }
    if (action.type === 'close') return closeMenu();
    // Commands are accepted only from the visible menu, not arbitrary IPC.
    if (!menuOpen) return;
    if (action.type === 'hide') {
      // Only the two product choices are accepted; renderer input cannot create
      // an unbounded timer, overflow it, or hide the launcher indefinitely.
      if (typeof action.duration !== 'string' || !Object.hasOwn(HIDE_DURATIONS, action.duration)) return;
      const duration = HIDE_DURATIONS[action.duration];
      hiddenUntil = Date.now() + duration;
      clearTimeout(hiddenTimer);
      syncVisibility();
      hiddenTimer = setTimeout(() => { hiddenUntil = 0; syncVisibility(); }, duration);
      hiddenTimer.unref?.();
    } else if (action.type === 'open-app') {
      closeMenu();
      onOpenApp?.();
    } else if (action.type === 'quick-action') {
      const slot = quickActions.getQuickAction(slots, action.id);
      if (!slot) return;
      closeMenu();
      // The saved prompt is resolved here. Renderer IPC cannot substitute one.
      Promise.resolve().then(() => onQuickAction?.(slot)).catch((error) => console.error('[Status overlay] Quick action failed:', error.message));
    }
  }

  function create() {
    if (disposed) throw new Error('Status overlay controller has been destroyed.');
    if (alive()) { position(); return window; }
    if (!screenListenersRegistered) {
      for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, position);
      screenListenersRegistered = true;
    }
    ready = false;
    ignoringMouse = true;
    window = new BrowserWindow({
      width: MENU_WIDTH + EDGE * 2, height: MENU_HEIGHT + 80, frame: false, transparent: true,
      resizable: false, movable: false, maximizable: false, minimizable: false,
      // Keep native activation style stable. On Windows setFocusable() also
      // deactivates the window, which can close a menu while it is reopening.
      // showInactive() and moveTop() keep the idle orb from stealing focus.
      fullscreenable: false, skipTaskbar: true, focusable: true, hasShadow: false,
      show: false, alwaysOnTop: true, backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(basePath, 'status-indicator-preload.js'),
        contextIsolation: true, sandbox: true, nodeIntegration: false,
        backgroundThrottling: false, webSecurity: true,
        partition: 'olanga-side-light', zoomFactor: 1
      }
    });
    window.setMenuBarVisibility(false);
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setIgnoreMouseEvents(true, { forward: true });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('render-process-gone', () => {
      ready = false;
      menuOpen = false;
      setMouseIgnored(true);
      if (alive()) window.hide();
    });
    window.on('blur', () => {
      // A queued blur may arrive after a new click has already reactivated us.
      if (alive() && !window.isFocused()) closeMenu();
    });
    window.on('closed', () => {
      window = null;
      ready = false;
      menuOpen = false;
      hovered = false;
      clearInterval(pollTimer);
      pollTimer = null;
    });
    position();
    window.loadFile(filePath);
    pollTimer = setInterval(updatePointer, 50);
    pollTimer.unref?.();
    return window;
  }

  function destroy() {
    disposed = true;
    clearTimeout(hiddenTimer);
    clearInterval(pollTimer);
    ipcMain.removeListener(ACTION_CHANNEL, handleAction);
    if (screenListenersRegistered) {
      for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, position);
      screenListenersRegistered = false;
    }
    if (alive()) window.destroy();
    window = null;
  }

  ipcMain.on(ACTION_CHANNEL, handleAction);
  return {
    create, destroy, position,
    getWindow: () => alive() ? window : null,
    setState: (value) => { state = statusLight.normalizeState(value); syncVisibility(); },
    setMode: (value) => { mode = statusLight.normalizeMode(value); syncVisibility(); },
    setSize: (value) => { size = statusLight.normalizeSize(value); position(); },
    setQuickActions: (value) => { slots = quickActions.normalizeQuickActions(value); snapshot(); },
    setSuspended: (value) => { suspended = value === true; syncVisibility(); }
  };
}

module.exports = { createStatusOverlay, overlayGeometry, pointerTarget };
