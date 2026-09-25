const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createStatusOverlay, overlayGeometry, pointerTarget } = require('../../desktop/status-overlay');

function fixture(t) {
  const ipcMain = new EventEmitter();
  const screen = new EventEmitter();
  let cursor = { x: 0, y: 0 };
  screen.getPrimaryDisplay = () => ({ workArea: { x: -1920, y: 0, width: 1920, height: 1040 } });
  screen.getCursorScreenPoint = () => cursor;
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.visible = false; this.destroyed = false; this.focused = false; this.snapshots = [];
      this.focusable = options.focusable !== false; this.skipTaskbar = options.skipTaskbar === true; this.blurCalls = 0; this.focusableCalls = 0;
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: pathToFileURL(path.join(__dirname, '../../status-indicator.html')).href };
      this.webContents.send = (_channel, value) => this.snapshots.push(value);
      this.webContents.setWindowOpenHandler = (handler) => { this.newWindow = handler; };
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; }
    setMenuBarVisibility() {}
    setAlwaysOnTop(value, level) { this.top = { value, level }; }
    moveTop() { this.raised = (this.raised || 0) + 1; }
    setIgnoreMouseEvents(value) { this.ignored = value; }
    setSkipTaskbar(value) { this.skipTaskbar = value; }
    setFocusable(value) {
      // Electron 36 NativeWindowViews::SetFocusable on Windows changes taskbar
      // membership and calls Focus(false), including when enabling focus.
      this.focusableCalls++;
      this.focusable = value;
      this.setSkipTaskbar(!value);
      this.blur();
    }
    focus() { this.focused = true; this.emit('focus'); }
    blur() {
      this.blurCalls++;
      const wasFocused = this.focused;
      this.focused = false;
      if (wasFocused) this.emit('blur');
    }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    loadFile() {}
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const actions = [];
  let opens = 0;
  const overlay = createStatusOverlay({ BrowserWindow: FakeWindow, ipcMain, screen, basePath: path.join(__dirname, '../..'), onOpenApp: () => { opens++; }, onQuickAction: (action) => actions.push(action) });
  const window = overlay.create();
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const send = (type, extra = {}, sender = event) => ipcMain.emit('status-overlay-action', sender, { type, ...extra });
  t.after(() => overlay.destroy());
  return { overlay, window, screen, ipcMain, event, send, actions, opens: () => opens, cursor: (point) => { cursor = point; }, latest: () => window.snapshots.at(-1) };
}

test('only the orb and open rounded menu capture mouse input', () => {
  const geometry = overlayGeometry(292, 406, 'small');
  const { orb, menu, diameter } = geometry;
  const center = { x: orb.x + diameter / 2, y: orb.y + diameter / 2 };
  assert.equal(pointerTarget(center, geometry, false), 'orb');
  assert.equal(pointerTarget({ x: orb.x, y: orb.y }, geometry, false), null, 'transparent corner outside the circle');
  assert.equal(pointerTarget({ x: menu.x + 20, y: menu.y + 20 }, geometry, false), null, 'closed menu is click-through');
  assert.equal(pointerTarget({ x: menu.x + 20, y: menu.y + 20 }, geometry, true), 'menu');
  assert.equal(pointerTarget({ x: menu.x, y: menu.y }, geometry, true), null, 'rounded menu corner is click-through');
  assert.equal(pointerTarget({ x: 0, y: 100 }, geometry, true), null, 'window margin is click-through');
  assert.equal(pointerTarget({ x: center.x + diameter / 2 + 1, y: center.y }, geometry, false, true), 'orb', 'expanded visible orb captures clicks');
  assert.equal(pointerTarget({ x: center.x + diameter / 2 + 3, y: center.y }, geometry, false, true), null, 'shadow remains click-through');
});

test('compact orb is anchored six pixels from the corner and menu fits small work areas', () => {
  for (const [width, height] of [[292, 406], [180, 260], [128, 128]]) {
    for (const size of ['small', 'normal', 'large']) {
      const geometry = overlayGeometry(width, height, size);
      const { orb, menu } = geometry;
      assert.equal(orb.x + orb.width, width - 6);
      assert.equal(orb.y + orb.height, height - 6);
      for (const rect of [orb, menu]) {
        assert.ok(rect.x >= 0 && rect.y >= 0);
        assert.ok(rect.x + rect.width <= width && rect.y + rect.height <= height);
      }
      assert.ok(menu.y + menu.height <= orb.y - 8);
      assert.ok(orb.x - orb.width * .06 >= 0 && orb.x + orb.width * 1.06 <= width, 'hover stays on screen');
    }
  }
});

test('controller construction never touches screen before Electron is ready', () => {
  const ipcMain = new EventEmitter();
  const screen = new Proxy({}, { get() { throw new Error('screen used before app.whenReady'); } });
  const overlay = createStatusOverlay({ BrowserWindow: null, ipcMain, screen, basePath: path.join(__dirname, '../..') });
  assert.equal(ipcMain.listenerCount('status-overlay-action'), 1);
  overlay.setState('listening');
  overlay.setMode('all');
  overlay.setSize('large');
  overlay.destroy();
  assert.equal(ipcMain.listenerCount('status-overlay-action'), 0);
});

test('overlay uses sandboxed window, applies modes, and stays above ordinary windows without focus', (t) => {
  const f = fixture(t);
  assert.equal(f.window.options.webPreferences.sandbox, true);
  assert.equal(f.window.options.webPreferences.partition, 'olanga-side-light', 'main-app zoom and storage cannot affect the light');
  assert.equal(f.window.options.webPreferences.zoomFactor, 1);
  assert.deepEqual(f.window.newWindow(), { action: 'deny' });
  f.send('ready');
  assert.equal(f.window.visible, false, 'active mode hides idle');
  f.overlay.setState('listening');
  assert.equal(f.window.visible, true);
  assert.equal(f.window.focused, false);
  assert.equal(f.window.focusable, true, 'clickable without native focusability transitions');
  assert.equal(f.window.skipTaskbar, true);
  assert.equal(f.window.focusableCalls, 0, 'showing the orb must not alter Windows activation styles');
  assert.deepEqual(f.window.top, { value: true, level: 'screen-saver' });
  assert.ok(f.window.raised);
  assert.equal(f.window.bounds.x + f.window.bounds.width, 0, 'negative-coordinate monitor anchoring');
  f.overlay.setMode('off');
  assert.equal(f.window.visible, false);
  assert.equal(f.window.ignored, true);
  f.overlay.setMode('all');
  f.overlay.setState('idle');
  assert.equal(f.window.visible, true);
  f.overlay.setSuspended(true);
  f.overlay.setState('thinking');
  assert.equal(f.window.visible, false, 'screenshot suspension survives assistant state changes');
  f.overlay.setSuspended(false);
  assert.equal(f.window.visible, true);
});

test('overlay IPC rejects other windows, subframes, wrong URLs, unconfigured IDs and prompt substitution', async (t) => {
  const f = fixture(t);
  f.overlay.setMode('all'); f.send('ready');
  for (const event of [
    { sender: {}, senderFrame: f.event.senderFrame },
    { sender: f.event.sender, senderFrame: { url: f.event.senderFrame.url } }
  ]) f.send('toggle', {}, event);
  assert.equal(f.latest().menuOpen, false);
  const originalURL = f.event.senderFrame.url;
  f.event.senderFrame.url = 'https://untrusted.example';
  f.send('toggle');
  assert.equal(f.latest().menuOpen, false);
  f.event.senderFrame.url = originalURL;
  f.send('quick-action', { id: 'slot-1' });
  assert.equal(f.actions.length, 0, 'closed-menu commands ignored');
  f.overlay.setQuickActions([{ label: 'My action', prompt: 'Only saved prompt' }]);
  f.send('toggle');
  assert.equal(f.latest().menuOpen, true);
  assert.equal(f.window.focusable, true);
  f.send('quick-action', { id: 'slot-6' });
  assert.equal(f.latest().menuOpen, true);
  f.send('quick-action', { id: 'slot-1', prompt: 'Malicious replacement' });
  await Promise.resolve();
  assert.deepEqual(f.actions, [{ id: 'slot-1', label: 'My action', prompt: 'Only saved prompt' }]);
  assert.equal(f.latest().menuOpen, false);
  assert.equal(f.window.focused, false);
  assert.equal(f.window.focusableCalls, 0);
});

test('menu opens the main app, closes on blur, and returns native input to transparent space', (t) => {
  const f = fixture(t);
  f.overlay.setMode('all'); f.send('ready');
  const bounds = f.window.bounds;
  const geometry = f.latest().geometry;
  f.cursor({ x: bounds.x + geometry.orb.x + geometry.diameter / 2, y: bounds.y + geometry.orb.y + geometry.diameter / 2 });
  f.send('pointer');
  assert.equal(f.window.ignored, false);
  assert.equal(f.latest().hovered, true);
  f.send('toggle'); f.send('open-app');
  assert.equal(f.opens(), 1);
  assert.equal(f.latest().menuOpen, false);
  f.send('toggle'); f.window.focused = false; f.window.emit('blur');
  assert.equal(f.latest().menuOpen, false);
  f.cursor({ x: bounds.x + 5, y: bounds.y + 5 });
  f.send('pointer');
  assert.equal(f.window.ignored, true);
});

test('opening survives native activation before click IPC and remains out of the taskbar', (t) => {
  const f = fixture(t);
  f.overlay.setMode('all'); f.send('ready');
  for (let cycle = 0; cycle < 3; cycle++) {
    // A click can activate the native window before its renderer click IPC is
    // delivered. setFocusable(true) must not close the newly opening menu.
    f.window.focus();
    f.send('toggle');
    assert.equal(f.latest().menuOpen, true, `opening cycle ${cycle + 1}`);
    assert.equal(f.window.focused, true, 'open menu accepts keyboard input');
    assert.equal(f.window.skipTaskbar, true, 'shortcut menu never creates a taskbar button');
    f.send('close');
    assert.equal(f.latest().menuOpen, false);
    assert.equal(f.window.visible, true, 'closing preserves the orb');
    assert.equal(f.window.focused, false);
    assert.equal(f.window.focusableCalls, 0, 'repeated clicks never churn native activation styles');
  }
});

test('outside focus changes preserve the clicked app and the next orb click reopens', (t) => {
  const f = fixture(t);
  f.overlay.setMode('all'); f.send('ready');
  for (let cycle = 0; cycle < 3; cycle++) {
    f.send('toggle');
    assert.equal(f.latest().menuOpen, true);
    const blurCalls = f.window.blurCalls;
    // Windows has already handed focus to the clicked application before
    // Electron notifies us. Another native blur can activate a different app.
    f.window.focused = false;
    f.window.emit('blur');
    assert.equal(f.latest().menuOpen, false);
    assert.equal(f.window.blurCalls, blurCalls, 'closing an inactive menu does not move native focus again');
    assert.equal(f.window.visible, true);
  }
});

test('a delayed blur notification cannot close a newly focused menu', (t) => {
  const f = fixture(t);
  f.overlay.setMode('all'); f.send('ready');
  f.send('toggle'); f.send('close'); f.send('toggle');
  assert.equal(f.window.focused, true);
  // A notification queued during the previous focus transition must not
  // override the current native focus state after the user opens the menu.
  f.window.emit('blur');
  assert.equal(f.latest().menuOpen, true);
  assert.equal(f.window.focused, true);
  f.window.focused = false;
  f.window.emit('blur');
  assert.equal(f.latest().menuOpen, false, 'real outside blur still dismisses');
});

test('five-second hide restores the light but still respects mode changes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10000 });
  const f = fixture(t);
  f.overlay.setMode('all'); f.send('ready'); f.send('toggle'); f.send('hide', { duration: '5-seconds' });
  assert.equal(f.window.visible, false);
  t.mock.timers.tick(4999);
  assert.equal(f.window.visible, false);
  t.mock.timers.tick(1);
  assert.equal(f.window.visible, true);
  f.send('toggle'); f.send('hide', { duration: '5-seconds' }); f.overlay.setMode('off');
  t.mock.timers.tick(5000);
  assert.equal(f.window.visible, false);
  f.overlay.destroy();
  assert.equal(f.ipcMain.listenerCount('status-overlay-action'), 0);
  assert.equal(f.screen.listenerCount('display-metrics-changed'), 0);
});

test('one-hour hide survives state changes, rejects arbitrary durations, and restores at the deadline', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10000 });
  const f = fixture(t);
  f.overlay.setMode('all'); f.send('ready'); f.send('toggle');
  for (const duration of [undefined, null, 3600000, '3600000', 'forever', '__proto__', { toString: null }]) {
    f.send('hide', { duration });
    assert.equal(f.window.visible, true, 'unsupported duration ignored');
    assert.equal(f.latest().menuOpen, true);
  }
  f.send('hide', { duration: '1-hour' });
  assert.equal(f.window.visible, false);
  assert.equal(f.latest().menuOpen, false);
  f.overlay.setState('thinking');
  t.mock.timers.tick(3599999);
  assert.equal(f.window.visible, false);
  t.mock.timers.tick(1);
  assert.equal(f.window.visible, true);
  assert.equal(f.latest().state, 'thinking');
  assert.equal(f.latest().menuOpen, false, 'restoration never steals focus by reopening the menu');
});

test('leaving the menu dismisses it after the recovery delay without trapping input', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10000 });
  const f = fixture(t);
  f.overlay.setMode('all'); f.send('ready');
  const { x, y } = f.window.bounds;
  const { orb, diameter } = f.latest().geometry;
  f.cursor({ x: x + orb.x + diameter / 2, y: y + orb.y + diameter / 2 });
  f.send('pointer'); f.send('toggle');
  f.cursor({ x: x - 40, y: y - 40 }); f.send('pointer');
  assert.equal(f.window.ignored, true);
  t.mock.timers.tick(1199);
  assert.equal(f.latest().menuOpen, true);
  t.mock.timers.tick(51);
  assert.equal(f.latest().menuOpen, false);
  assert.equal(f.window.focused, false);
});
