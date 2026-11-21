'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const statusLight = require('../shared/status-light');
const quickActions = require('../shared/quick-actions');
const timerOverlay = require('../shared/timer-overlay');

const ACTION_CHANNEL = 'status-overlay-action';
const SNAPSHOT_CHANNEL = 'status-overlay-snapshot';
const EDGE = 6;
const MENU_GAP = 8;
const MENU_WIDTH = 280;
const MENU_HEIGHT = 354;
const SPORTS_WIDTH = 190;
const SPORTS_HEIGHT = 96;
const SPORTS_HANDLE_WIDTH = 52;
const SPORTS_HANDLE_HEIGHT = 24;
const SPORTS_DRAG_THRESHOLD = 20;
const TIMER_MODES = Object.freeze(['expanded', 'compact', 'tucked']);
const HOVER_SCALE = 1.12;
const TASKBAR_APPROACH = 3;
const AUTOHIDE_TASKBAR_CLEARANCE = 64;
const HIDE_DURATIONS = Object.freeze({ '5-seconds': 5000, '1-hour': 60 * 60 * 1000 });

function timerCardHeight(mode, count) {
  if (mode === 'tucked') return SPORTS_HANDLE_HEIGHT;
  return mode === 'expanded' ? 48 + 48 * Math.min(5, Math.max(1, Number(count) || 1)) : SPORTS_HEIGHT;
}

function overlayGeometry(width, height, size, sportsEnabled = false, sportsOffset = 0, timerCard = null) {
  const diameter = Math.min(statusLight.sizeToPixels(size), Math.max(0, Math.min(width, height) - EDGE * 2));
  const menuWidth = Math.min(MENU_WIDTH, Math.max(0, width - EDGE * 2));
  const sportsWidth = Math.min(SPORTS_WIDTH, Math.max(0, width - EDGE * 2 - diameter - MENU_GAP));
  const sportsHeight = Math.min(SPORTS_HEIGHT, Math.max(0, height - EDGE * 2 - MENU_GAP));
  const handleHeight = Math.min(sportsWidth <= 172 ? 16 : SPORTS_HANDLE_HEIGHT, sportsHeight);
  const sportsMaxOffset = Math.max(0, sportsHeight - handleHeight);
  const offset = Math.max(0, Math.min(sportsMaxOffset, Number.isFinite(sportsOffset) ? sportsOffset : 0));
  const sports = sportsEnabled && !timerCard && sportsWidth > 0 && sportsHeight > 0 ? {
    x: width - EDGE - diameter - MENU_GAP - sportsWidth,
    y: height - EDGE - sportsHeight + offset, width: sportsWidth, height: sportsHeight
  } : null;
  const sportsHandle = sports ? {
    x: sports.x + (sports.width - Math.min(SPORTS_HANDLE_WIDTH, sports.width)) / 2,
    y: sports.y, width: Math.min(SPORTS_HANDLE_WIDTH, sports.width), height: handleHeight
  } : null;
  const sportsVisible = sports ? { ...sports, height: Math.max(0, sports.height - offset) } : null;
  const timerRestHeight = timerCard?.mode === 'tucked' ? handleHeight : timerCardHeight(timerCard?.mode, timerCard?.count);
  const timerHeight = timerCard ? Math.min(
    Number.isFinite(timerCard.dragHeight) ? timerCard.dragHeight : timerRestHeight,
    Math.max(0, height - EDGE * 2 - MENU_GAP)
  ) : 0;
  const timers = timerCard && sportsWidth > 0 && timerHeight > 0 ? {
    x: width - EDGE - diameter - MENU_GAP - sportsWidth,
    y: height - EDGE - timerHeight, width: sportsWidth, height: timerHeight
  } : null;
  const timerHandle = timers ? {
    x: timers.x + (timers.width - Math.min(SPORTS_HANDLE_WIDTH, timers.width)) / 2,
    y: timers.y, width: Math.min(SPORTS_HANDLE_WIDTH, timers.width), height: Math.min(handleHeight, timerHeight)
  } : null;
  const lowerHeight = Math.max(diameter, sports?.height || 0, timers?.height || 0);
  const menuHeight = Math.min(MENU_HEIGHT, Math.max(0, height - lowerHeight - EDGE * 2 - MENU_GAP));
  return {
    diameter,
    orb: { x: width - EDGE - diameter, y: height - EDGE - diameter, width: diameter, height: diameter },
    menu: { x: width - EDGE - menuWidth, y: height - EDGE - lowerHeight - MENU_GAP - menuHeight, width: menuWidth, height: menuHeight },
    ...(sports ? { sports, sportsHandle, sportsVisible, sportsMaxOffset, sportsTucked: offset >= sportsMaxOffset } : {}),
    ...(timers ? { timers, timerHandle, timerVisible: timers, timerTucked: timerCard.mode === 'tucked' && !Number.isFinite(timerCard.dragHeight) } : {})
  };
}

function inRoundedRectangle(point, rect, radius) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  if (point.x < rect.x || point.x > rect.x + rect.width || point.y < rect.y || point.y > rect.y + rect.height) return false;
  radius = Math.min(radius, rect.width / 2, rect.height / 2);
  const x = Math.max(rect.x + radius, Math.min(point.x, rect.x + rect.width - radius));
  const y = Math.max(rect.y + radius, Math.min(point.y, rect.y + rect.height - radius));
  return (point.x - x) ** 2 + (point.y - y) ** 2 <= radius ** 2;
}

// The transparent BrowserWindow is deliberately bigger than its visible orb.
// Native hit testing captures only the visible circle, score card or open menu, never
// the invisible rectangular window or its decorative glow/shadow.
function pointerTarget(point, geometry, menuOpen, hovered = false, orbVisible = true) {
  const orb = geometry.orb;
  const radius = orb.width / 2 * (hovered || menuOpen ? HOVER_SCALE : 1);
  const x = point.x - (orb.x + orb.width / 2);
  const y = point.y - (orb.y + orb.height / 2);
  if (orbVisible && x * x + y * y <= radius * radius) return 'orb';
  if (menuOpen && inRoundedRectangle(point, geometry.menu, 12)) return 'menu';
  if (inRoundedRectangle(point, geometry.timerHandle, 8)) return 'timers-handle';
  if (!geometry.timerTucked && inRoundedRectangle(point, geometry.timerVisible, 12)) return 'timers';
  if (inRoundedRectangle(point, geometry.sportsHandle, 8)) return 'sports-handle';
  if (!geometry.sportsTucked && inRoundedRectangle(point, geometry.sportsVisible || geometry.sports, 12)) return 'sports';
  return null;
}

// Cursor and display geometry from Electron are in device-independent pixels.
// Enter through the gap below the controls. Use a wider exit band so the
// overlay stays away while the user moves back up onto a revealed taskbar.
function bottomTaskbarRegion({ bounds, workArea }) {
  if (!bounds || !workArea) return null;
  const bottom = bounds.y + bounds.height;
  const workBottom = workArea.y + workArea.height;
  const autoHide = bottom - workBottom <= 2;
  if (autoHide && (workArea.y - bounds.y > 2 || bounds.width - workArea.width > 2)) return null;
  const enter = workBottom - TASKBAR_APPROACH;
  const leave = autoHide ? bottom - AUTOHIDE_TASKBAR_CLEARANCE : enter - EDGE;
  return { left: bounds.x, right: bounds.x + bounds.width, bottom, enter, leave };
}

function createStatusOverlay({ BrowserWindow, ipcMain, screen, basePath, platform = process.platform, onOpenApp, onQuickAction, onSportsActive, onSportsRefresh, onSportsSettings, onTimersSettings, onOpenTimers }) {
  let window = null;
  let state = 'idle';
  let mode = statusLight.DEFAULT_MODE;
  let size = statusLight.DEFAULT_SIZE;
  let slots = quickActions.normalizeQuickActions();
  let sports = { enabled: false };
  let sportsActive = false;
  let sportsCollapsed = false;
  let sportsOffset = 0;
  let sportsDrag = null;
  let timers = { enabled: false, timers: [], total: 0 };
  let selectedCard = null;
  let timerMode = 'compact';
  let timerDrag = null;
  let ready = false;
  let menuOpen = false;
  let hovered = false;
  let ignoringMouse = true;
  let hiddenUntil = 0;
  let suspended = false;
  let mainWindowActive = false;
  let taskbarRegion = null;
  let yieldingToTaskbar = false;
  let reducedMotion = false;
  let hiddenTimer = null;
  let pollTimer = null;
  let outsideSince = 0;
  let lastRaise = 0;
  let lastPointer = null;
  let disposed = false;
  let screenListenersRegistered = false;
  let lastSnapshot = '';
  const filePath = path.join(basePath, 'status-indicator.html');
  const expectedURL = pathToFileURL(filePath).href;

  function alive() { return window && !window.isDestroyed(); }
  function visibleState() { return statusLight.resolveVisualState(state, mode); }
  function sportsShown() { return sports.enabled && (sports.liveOnly !== true || sports.game?.state === 'live'); }
  function timersShown() { return timers.enabled && timers.timers.length > 0; }
  function sportsSelected() { return selectedCard === 'sports' && sportsShown(); }
  function timersSelected() { return selectedCard === 'timers' && timersShown(); }
  function selectAvailableCard() {
    if (sportsSelected() || timersSelected()) return;
    selectedCard = timersShown() ? 'timers' : sportsShown() ? 'sports' : null;
  }
  function eligibleToShow() { return !suspended && !mainWindowActive && Date.now() >= hiddenUntil && (sportsShown() || timersShown() || visibleState() !== 'off'); }
  function shouldShow() { return eligibleToShow() && !yieldingToTaskbar; }

  function cursorAtTaskbar(cursor) {
    if (!taskbarRegion || sportsDrag || timerDrag) return false;
    const { left, right, bottom, enter, leave } = taskbarRegion;
    return cursor.x >= left && cursor.x < right && cursor.y < bottom &&
      cursor.y >= (yieldingToTaskbar ? leave : enter);
  }

  function getGeometry() {
    const bounds = window.getBounds();
    return overlayGeometry(bounds.width, bounds.height, size, sportsSelected(), sportsOffset,
      timersSelected() ? { mode: timerMode, count: timers.timers.length, dragHeight: timerDrag?.height } : null);
  }

  function snapshot() {
    if (!alive() || !ready) return;
    const value = {
      state: visibleState(), menuOpen, hovered, reducedMotion, geometry: getGeometry(),
      sports,
      timers,
      companion: { selected: selectedCard, hasSports: sportsShown(), hasTimers: timersShown() },
      timerPresentation: { mode: timerMode, dragging: !!timerDrag, offset: timerDrag ? timerDrag.startHeight - timerDrag.height : 0 },
      sportsPresentation: { collapsed: sportsCollapsed, dragging: !!sportsDrag, offset: sportsOffset },
      visible: window.isVisible() && shouldShow(),
      actions: slots.map(({ id, label }) => ({ id, label }))
    };
    const key = JSON.stringify(value);
    if (key === lastSnapshot) return;
    lastSnapshot = key;
    window.webContents.send(SNAPSHOT_CHANNEL, value);
  }

  function cancelSportsDrag() {
    if (!sportsDrag) return false;
    sportsCollapsed = sportsDrag.startCollapsed;
    sportsDrag = null;
    sportsOffset = sportsCollapsed && alive() ? getGeometry().sportsMaxOffset || 0 : 0;
    return true;
  }

  function cancelTimerDrag() {
    if (!timerDrag) return false;
    timerDrag = null;
    return true;
  }

  function setTimerMode(value) {
    if (!timersSelected() || !TIMER_MODES.includes(value)) return;
    cancelTimerDrag();
    timerMode = value;
    position();
  }

  function updateTimerDrag(cursor) {
    if (!timerDrag || !Number.isFinite(cursor?.y)) return;
    timerDrag.lastY = cursor.y;
    const height = Math.max(SPORTS_HANDLE_HEIGHT, Math.min(timerCardHeight('expanded', timers.timers.length),
      timerDrag.startHeight - (cursor.y - timerDrag.startY)));
    if (timerDrag.height === height) return;
    timerDrag.height = height;
    snapshot();
  }

  function finishTimerDrag(cancelled = false) {
    if (!timerDrag) return;
    if (!cancelled) {
      updateTimerDrag(screen.getCursorScreenPoint());
      const delta = timerDrag.lastY - timerDrag.startY;
      if (Math.abs(delta) >= SPORTS_DRAG_THRESHOLD) {
        const index = TIMER_MODES.indexOf(timerMode);
        timerMode = TIMER_MODES[Math.max(0, Math.min(TIMER_MODES.length - 1, index + Math.sign(delta)))];
      }
    }
    cancelTimerDrag();
    position();
  }

  function setSportsCollapsed(value) {
    if (!sportsSelected() || !getGeometry().sportsHandle || typeof value !== 'boolean') return;
    cancelSportsDrag();
    sportsCollapsed = value;
    sportsOffset = value ? getGeometry().sportsMaxOffset : 0;
    snapshot();
    updatePointer();
  }

  function updateSportsDrag(cursor) {
    if (!sportsDrag || !Number.isFinite(cursor?.y)) return;
    sportsDrag.lastY = cursor.y;
    const next = Math.max(0, Math.min(getGeometry().sportsMaxOffset || 0,
      sportsDrag.startOffset + cursor.y - sportsDrag.startY));
    if (next === sportsOffset) return;
    sportsOffset = next;
    snapshot();
  }

  function finishSportsDrag(cancelled = false) {
    if (!sportsDrag) return;
    if (cancelled) cancelSportsDrag();
    else {
      updateSportsDrag(screen.getCursorScreenPoint());
      const delta = sportsDrag.lastY - sportsDrag.startY;
      const collapsed = Math.abs(delta) >= SPORTS_DRAG_THRESHOLD ? delta > 0 : sportsDrag.startCollapsed;
      sportsDrag = null;
      sportsCollapsed = collapsed;
      sportsOffset = collapsed ? getGeometry().sportsMaxOffset || 0 : 0;
    }
    snapshot();
    updatePointer();
  }

  function syncSportsActive() {
    // Live-only cards must keep checking while no game is shown, so the next
    // tip-off can appear automatically. Hiding the card is not disabling it.
    const active = !!(!disposed && alive() && ready && !suspended && Date.now() >= hiddenUntil && sports.enabled);
    if (sportsActive === active) return;
    // Set before publishing: the service may synchronously return a snapshot.
    sportsActive = active;
    onSportsActive?.(active);
  }

  function syncPointerPolling() {
    const needed = alive() && ready && eligibleToShow();
    if (!needed) {
      clearInterval(pollTimer);
      pollTimer = null;
      lastPointer = null;
    } else if (pollTimer === null) {
      // A hidden window gets no pointer events. This same poll also detects
      // leaving the taskbar, and stops when another rule hides the overlay.
      pollTimer = setInterval(updatePointer, 50);
      pollTimer.unref?.();
    }
  }

  function setMouseIgnored(value) {
    if (!alive() || ignoringMouse === value) return;
    ignoringMouse = value;
    window.setIgnoreMouseEvents(value, { forward: true });
  }

  function raise() {
    if (platform === 'win32' || !alive() || !window.isVisible()) return;
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

  function syncVisibility(cursor) {
    if (!alive() || !ready) { syncSportsActive(); return; }
    if (eligibleToShow()) {
      cursor ??= screen.getCursorScreenPoint();
      yieldingToTaskbar = cursorAtTaskbar(cursor);
    }
    if (visibleState() === 'off') { closeMenu(); hovered = false; }
    if (shouldShow()) {
      const restoring = !window.isVisible();
      if (restoring) window.showInactive();
      raise();
      // Restore native hit testing immediately, including a stationary cursor.
      // A busy desktop can delay the next pointer event or fallback poll.
      updateHitTesting(cursor);
    } else {
      cancelSportsDrag();
      cancelTimerDrag();
      closeMenu();
      hovered = false;
      setMouseIgnored(true);
      if (window.isVisible()) window.hide();
    }
    syncPointerPolling();
    snapshot();
    syncSportsActive();
  }

  function position() {
    if (!alive()) return;
    cancelSportsDrag();
    cancelTimerDrag();
    const display = screen.getPrimaryDisplay();
    taskbarRegion = platform === 'win32' ? bottomTaskbarRegion(display) : null;
    const { x, y, width, height } = display.workArea;
    const diameter = statusLight.sizeToPixels(size);
    const companionHeight = timersSelected() ? timerCardHeight(timerMode, timers.timers.length) : sportsSelected() ? SPORTS_HEIGHT : 0;
    const windowWidth = Math.min(Math.max(MENU_WIDTH, companionHeight ? SPORTS_WIDTH + MENU_GAP + diameter : 0) + EDGE * 2, width);
    const windowHeight = Math.min(MENU_HEIGHT + Math.max(diameter, companionHeight) + EDGE * 2 + MENU_GAP, height);
    window.setBounds({ x: Math.round(x + width - windowWidth), y: Math.round(y + height - windowHeight), width: windowWidth, height: windowHeight });
    sportsOffset = sportsCollapsed ? getGeometry().sportsMaxOffset || 0 : 0;
    snapshot();
    updatePointer();
    raise();
    syncSportsActive();
  }

  function updatePointer() {
    if (!alive() || !ready || !eligibleToShow()) {
      setMouseIgnored(true);
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    if (cursorAtTaskbar(cursor) !== yieldingToTaskbar) {
      syncVisibility(cursor);
      return;
    }
    if (window.isVisible() && !yieldingToTaskbar) updateHitTesting(cursor);
  }

  function updateHitTesting(cursor) {
    updateSportsDrag(cursor);
    updateTimerDrag(cursor);
    const bounds = window.getBounds();
    const point = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
    const target = pointerTarget(point, getGeometry(), menuOpen, hovered, visibleState() !== 'off');
    setMouseIgnored(!sportsDrag && !timerDrag && !target);
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
    if (platform !== 'win32' && Date.now() - lastRaise >= 2000) raise();
  }

  function isTrusted(event) {
    return alive() && event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      event.senderFrame.url === expectedURL;
  }

  function handleAction(event, action) {
    if (!isTrusted(event) || !action || typeof action !== 'object' || Array.isArray(action)) return;
    if (action.type === 'ready') {
      cancelSportsDrag();
      cancelTimerDrag();
      ready = true;
      lastSnapshot = '';
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
      if (visibleState() === 'off') return;
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
    if (action.type === 'close') { finishSportsDrag(true); finishTimerDrag(true); return closeMenu(); }
    if (action.type === 'companion-select') {
      if (!sportsShown() || !timersShown() || !['sports', 'timers'].includes(action.card)) return;
      if (sportsDrag || timerDrag || action.card === selectedCard) return;
      selectedCard = action.card;
      position();
      return;
    }
    if (action.type === 'timers-toggle-mode') {
      setTimerMode(TIMER_MODES[(TIMER_MODES.indexOf(timerMode) + 1) % TIMER_MODES.length]);
      return;
    }
    if (action.type === 'timers-set-mode') { setTimerMode(action.mode); return; }
    if (action.type === 'timers-drag-start') {
      if (!timersSelected() || timerDrag || sportsDrag) return;
      const cursor = screen.getCursorScreenPoint(), bounds = window.getBounds();
      const point = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
      const geometry = getGeometry();
      if (!inRoundedRectangle(point, geometry.timerHandle, 8)) return;
      menuOpen = false;
      outsideSince = 0;
      timerDrag = { startY: cursor.y, lastY: cursor.y, startHeight: geometry.timers.height, height: geometry.timers.height };
      setMouseIgnored(false);
      snapshot();
      return;
    }
    if (action.type === 'timers-drag-move') { if (timerDrag) updatePointer(); return; }
    if (action.type === 'timers-drag-end') return finishTimerDrag();
    if (action.type === 'timers-drag-cancel') return finishTimerDrag(true);
    if (action.type === 'timers-settings') {
      if (timersSelected() && timerMode !== 'tucked' && !timerDrag) onTimersSettings?.();
      return;
    }
    if (action.type === 'timers-open') {
      if (timersSelected() && timerMode !== 'tucked' && !timerDrag) onOpenTimers?.();
      return;
    }
    if (action.type === 'sports-drag-start') {
      if (!sportsSelected() || sportsDrag || timerDrag) return;
      const cursor = screen.getCursorScreenPoint(), bounds = window.getBounds();
      const point = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
      if (!inRoundedRectangle(point, getGeometry().sportsHandle, 8)) return;
      menuOpen = false;
      outsideSince = 0;
      sportsDrag = { startY: cursor.y, lastY: cursor.y, startOffset: sportsOffset, startCollapsed: sportsCollapsed };
      setMouseIgnored(false);
      snapshot();
      return;
    }
    if (action.type === 'sports-drag-move') { if (sportsDrag) updatePointer(); return; }
    if (action.type === 'sports-drag-end') return finishSportsDrag();
    if (action.type === 'sports-drag-cancel') return finishSportsDrag(true);
    if (action.type === 'sports-toggle') { setSportsCollapsed(!sportsCollapsed); return; }
    if (action.type === 'sports-set-collapsed') { setSportsCollapsed(action.collapsed); return; }
    if (action.type === 'sports-settings') {
      if (sportsSelected() && getGeometry().sportsHandle && !sportsDrag) onSportsSettings?.();
      return;
    }
    if (action.type === 'sports-refresh') {
      if (sportsSelected() && !sportsCollapsed && !sportsDrag && getGeometry().sportsVisible?.height > 0) {
        Promise.resolve().then(() => {
          // Hiding or disabling the card between delivery and dispatch cancels it.
          if (sportsActive && sportsSelected() && !sportsCollapsed && !sportsDrag) return onSportsRefresh?.();
        }).catch(error => console.error('[Status overlay] Sports refresh failed:', error.message));
      }
      return;
    }
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
        backgroundThrottling: true, webSecurity: true,
        partition: 'olanga-side-light', zoomFactor: 1
      }
    });
    window.setMenuBarVisibility(false);
    // On Windows 'floating' sits above apps but below the taskbar. moveTop()
    // would undo that ordering when Start or a shell flyout is open.
    window.setAlwaysOnTop(true, platform === 'win32' ? 'floating' : 'screen-saver');
    window.setIgnoreMouseEvents(true, { forward: true });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('render-process-gone', () => {
      cancelSportsDrag();
      cancelTimerDrag();
      ready = false;
      menuOpen = false;
      setMouseIgnored(true);
      if (alive()) window.hide();
      syncPointerPolling();
      syncSportsActive();
    });
    window.on('blur', () => {
      // A queued blur may arrive after a new click has already reactivated us.
      if (alive() && !window.isFocused()) { finishSportsDrag(true); finishTimerDrag(true); closeMenu(); }
    });
    window.on('closed', () => {
      cancelSportsDrag();
      cancelTimerDrag();
      window = null;
      ready = false;
      menuOpen = false;
      hovered = false;
      clearInterval(pollTimer);
      pollTimer = null;
      syncSportsActive();
    });
    position();
    window.loadFile(filePath);
    return window;
  }

  function destroy() {
    disposed = true;
    cancelSportsDrag();
    cancelTimerDrag();
    syncSportsActive();
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
    setSports: (value) => {
      if (disposed || !value || typeof value !== 'object' || Array.isArray(value)) return;
      const wasEnabled = sports.enabled;
      const wasShown = sportsShown();
      const previousCard = selectedCard;
      sports = { ...value, enabled: value.enabled === true };
      selectAvailableCard();
      if (!sportsShown()) cancelSportsDrag();
      if (!sports.enabled) { cancelSportsDrag(); sportsCollapsed = false; sportsOffset = 0; }
      if (sports.enabled !== wasEnabled || sportsShown() !== wasShown || selectedCard !== previousCard) { position(); syncVisibility(); }
      else snapshot();
    },
    setTimers: (value) => {
      if (disposed) return;
      const previousCard = selectedCard;
      const previousCount = timers.timers.length;
      const wasShown = timersShown();
      timers = timerOverlay.normalizeSnapshot(value);
      selectAvailableCard();
      if (!timersSelected()) cancelTimerDrag();
      if (previousCard !== selectedCard || previousCount !== timers.timers.length || wasShown !== timersShown()) {
        position();
        syncVisibility();
      } else snapshot();
    },
    setReducedMotion: (value) => { if (typeof value === 'boolean') { reducedMotion = value; snapshot(); } },
    setMainWindowActive: (value) => { if (typeof value === 'boolean') { mainWindowActive = value; syncVisibility(); } },
    setSuspended: (value) => { suspended = value === true; syncVisibility(); }
  };
}

module.exports = { createStatusOverlay, overlayGeometry, pointerTarget };
