const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createStatusOverlay, overlayGeometry, pointerTarget } = require('../../desktop/status-overlay');

function timerSnapshot(count = 5) {
  return { enabled: true, timers: Array.from({ length: count }, (_, index) => ({
    id: 'timer-' + index, label: 'Timer ' + index, endTime: 100000 + index * 1000
  })) };
}

function fixture(t, callbacks = {}, display = {
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 0, width: 1920, height: 1040 }
}) {
  const ipcMain = new EventEmitter();
  const screen = new EventEmitter();
  let cursor = { x: 0, y: 0 }, pointerReads = 0;
  screen.getPrimaryDisplay = () => display;
  screen.getCursorScreenPoint = () => { pointerReads++; return cursor; };
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
    showInactive() { this.visible = true; this.showCount = (this.showCount || 0) + 1; }
    hide() { this.visible = false; }
    loadFile() {}
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const actions = [];
  let opens = 0;
  const overlay = createStatusOverlay({ BrowserWindow: FakeWindow, ipcMain, screen, platform: 'win32', basePath: path.join(__dirname, '../..'), onOpenApp: () => { opens++; }, onQuickAction: (action) => actions.push(action), ...callbacks });
  const window = overlay.create();
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const send = (type, extra = {}, sender = event) => ipcMain.emit('status-overlay-action', sender, { type, ...extra });
  t.after(() => overlay.destroy());
  return { overlay, window, screen, ipcMain, event, send, actions, opens: () => opens, pointerReads: () => pointerReads, cursor: (point) => { cursor = point; }, latest: () => window.snapshots.at(-1) };
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
  overlay.setReducedMotion(true);
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
  assert.deepEqual(f.window.top, { value: true, level: 'floating' });
  assert.equal(f.window.raised, undefined, 'ordinary Windows presentation does not reorder the overlay above the shell');
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

test('hidden overlay stops native pointer polling and resumes the fallback when shown', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10000 });
  const f = fixture(t);
  assert.equal(f.window.options.webPreferences.backgroundThrottling, true);
  f.send('ready');
  t.mock.timers.tick(5000);
  assert.equal(f.pointerReads(), 0);
  f.overlay.setMode('all');
  t.mock.timers.tick(100);
  assert.ok(f.pointerReads() > 0);
  f.overlay.setSuspended(true);
  const reads = f.pointerReads();
  assert.equal(f.latest().visible, false);
  t.mock.timers.tick(5000);
  assert.equal(f.pointerReads(), reads);
  f.overlay.setSuspended(false);
  assert.equal(f.latest().visible, true);
  t.mock.timers.tick(100);
  assert.ok(f.pointerReads() > reads);
});

test('unchanged overlay state does not repeatedly send and repaint its snapshot', (t) => {
  const f = fixture(t);
  f.overlay.setMode('all'); f.send('ready');
  const before = f.window.snapshots.length;
  f.overlay.setState('idle'); f.overlay.setMode('all'); f.overlay.setSuspended(false);
  assert.equal(f.window.snapshots.length, before);
  f.send('ready');
  assert.equal(f.window.snapshots.length, before + 1, 'a fresh renderer always receives its initial snapshot');
});


test('reduced motion survives readiness and renderer replacement without altering status or menu behavior', (t) => {
  const f = fixture(t);
  f.overlay.setMode('all'); f.send('ready');
  assert.equal(f.latest().reducedMotion, false);
  f.overlay.setState('thinking'); f.send('toggle');
  f.overlay.setReducedMotion(true);
  assert.equal(f.latest().reducedMotion, true);
  assert.equal(f.latest().state, 'thinking');
  assert.equal(f.latest().menuOpen, true);
  assert.equal(f.window.focused, true);
  const sent = f.window.snapshots.length;
  for (const value of [true, undefined, null, 1, 'false', {}]) f.overlay.setReducedMotion(value);
  assert.equal(f.window.snapshots.length, sent, 'Unchanged and non-boolean updates cannot repaint or disable the preference');
  f.window.destroy();
  const replacement = f.overlay.create();
  f.ipcMain.emit('status-overlay-action', { sender: replacement.webContents, senderFrame: replacement.webContents.mainFrame }, { type: 'ready' });
  assert.equal(replacement.snapshots.at(-1).reducedMotion, true);
  assert.equal(replacement.snapshots.at(-1).state, 'thinking');
  f.overlay.setReducedMotion(false);
  assert.equal(replacement.snapshots.at(-1).reducedMotion, false);
  assert.equal(replacement.visible, true);
});

test('restored overlay synchronizes native hit testing before the first polling tick', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10000 });
  const f = fixture(t);
  f.overlay.setMode('all'); f.send('ready');
  const { x, y } = f.window.bounds;
  const { orb, diameter } = f.latest().geometry;
  f.cursor({ x: x + orb.x + diameter / 2, y: y + orb.y + diameter / 2 });
  f.send('pointer'); f.send('toggle'); f.send('hide', { duration: '5-seconds' });
  assert.equal(f.window.visible, false);
  assert.equal(f.window.ignored, true);
  t.mock.timers.tick(5000);
  assert.equal(f.window.visible, true);
  assert.equal(f.window.ignored, false, 'the restored orb accepts the stationary pointer without waiting for polling');
  assert.equal(f.latest().hovered, true);
  assert.equal(f.window.focused, false, 'restoration never steals focus');
  assert.equal(f.latest().menuOpen, false);
  f.overlay.setSuspended(true); f.overlay.setSuspended(false);
  assert.equal(f.window.ignored, false, 'screenshot restoration is immediately clickable');
  f.overlay.setMode('off'); f.overlay.setMode('all');
  assert.equal(f.window.ignored, false, 'mode restoration is immediately clickable');
  f.overlay.setSuspended(true);
  f.cursor({ x: x - 20, y: y - 20 });
  f.overlay.setSuspended(false);
  assert.equal(f.window.ignored, true, 'transparent space still passes input through');
  assert.equal(f.latest().hovered, false);
});

test('pinned sports fits beside every orb size and keeps the menu above the card', () => {
  for (const [width, height] of [[298, 486], [180, 260], [128, 128]]) {
    for (const size of ['small', 'normal', 'large']) {
      const geometry = overlayGeometry(width, height, size, true);
      const { sports, orb, menu } = geometry;
      assert.ok(sports);
      assert.ok(sports.width <= 190 && sports.height <= 96);
      if (width >= 292) assert.deepEqual({ width: sports.width, height: sports.height }, { width: 190, height: 96 }, 'normal display uses the compact readable card size');
      assert.equal(sports.x + sports.width + 8, orb.x);
      assert.equal(sports.y + sports.height, height - 6);
      assert.ok(menu.y + menu.height + 8 <= sports.y);
      for (const rect of [sports, orb, menu]) {
        assert.ok(rect.x >= 0 && rect.y >= 0);
        assert.ok(rect.x + rect.width <= width && rect.y + rect.height <= height);
      }
      const center = { x: sports.x + sports.width / 2, y: sports.y + sports.height / 2 };
      assert.equal(pointerTarget(center, geometry, false, false, false), 'sports');
      assert.equal(pointerTarget({ x: sports.x, y: sports.y }, geometry, false), null, 'rounded corners stay click-through');
      assert.equal(pointerTarget({ x: sports.x + sports.width + 4, y: sports.y + 12 }, geometry, false), null, 'gap stays click-through');
    }
  }
  assert.equal(overlayGeometry(292, 406, 'small').sports, undefined, 'disabled layout is unchanged');
});

test('pinned sports remains visible while idle or lights are off without creating a phantom orb target', (t) => {
  const active = [];
  const f = fixture(t, { onSportsActive: value => active.push(value) });
  f.overlay.setSports({ enabled: true, team: 'GSW', game: null });
  assert.deepEqual(active, [], 'do not poll before the renderer is ready');
  f.send('ready');
  assert.equal(f.window.visible, true);
  assert.equal(f.latest().state, 'off');
  assert.equal(f.window.focused, false);
  assert.deepEqual(active, [true]);
  const { sports, orb } = f.latest().geometry, bounds = f.window.bounds;
  f.cursor({ x: bounds.x + sports.x + 30, y: bounds.y + sports.y + 30 }); f.send('pointer');
  assert.equal(f.window.ignored, false);
  f.cursor({ x: bounds.x + orb.x + orb.width / 2, y: bounds.y + orb.y + orb.height / 2 }); f.send('pointer');
  assert.equal(f.window.ignored, true, 'invisible orb never intercepts the underlying app');
  f.send('toggle');
  assert.equal(f.latest().menuOpen, false);
  f.overlay.setMode('all'); f.send('toggle');
  assert.equal(f.latest().menuOpen, true);
  f.overlay.setMode('off');
  assert.equal(f.latest().menuOpen, false, 'hiding the orb dismisses its menu');
  assert.equal(f.window.visible, true, 'score card is independent of light mode');
  assert.deepEqual(active, [true], 'light state changes do not restart sports polling');
  f.overlay.setSports({ enabled: false });
  assert.equal(f.window.visible, false);
  assert.deepEqual(active, [true, false]);
});

test('sports polling follows hide and screenshot suspension without changing focus', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10000 });
  const active = [];
  const f = fixture(t, { onSportsActive: value => active.push(value) });
  f.overlay.setSports({ enabled: true, team: 'GSW' });
  f.overlay.setMode('all'); f.send('ready');
  f.overlay.setSuspended(true); f.overlay.setState('thinking');
  assert.equal(f.window.visible, false);
  assert.deepEqual(active, [true, false]);
  f.overlay.setSuspended(false);
  assert.equal(f.window.visible, true);
  assert.equal(f.window.focused, false);
  f.send('toggle'); f.send('hide', { duration: '5-seconds' });
  assert.equal(f.window.visible, false);
  f.overlay.setSports({ enabled: true, team: 'GSW', updatedAt: 1234 });
  assert.equal(f.window.visible, false, 'a late score response cannot undo the hide');
  t.mock.timers.tick(5000);
  assert.equal(f.window.visible, true);
  assert.equal(f.window.focused, false);
  assert.deepEqual(active, [true, false, true, false, true]);
});

test('sports refresh requires the trusted visible card and cancels when hidden before dispatch', async (t) => {
  let refreshes = 0;
  const f = fixture(t, { onSportsRefresh: () => { refreshes++; } });
  f.overlay.setSports({ enabled: true, team: 'GSW' }); f.send('ready');
  f.send('sports-refresh', {}, { sender: {}, senderFrame: f.event.senderFrame });
  f.send('sports-refresh', {}, { sender: f.event.sender, senderFrame: { url: f.event.senderFrame.url } });
  await Promise.resolve();
  assert.equal(refreshes, 0);
  f.send('sports-refresh'); await Promise.resolve();
  assert.equal(refreshes, 1, 'refresh works without opening the shortcut menu');
  assert.equal(f.latest().menuOpen, false);
  f.send('sports-refresh'); f.overlay.setSuspended(true); await Promise.resolve();
  assert.equal(refreshes, 1);
  f.send('sports-refresh'); await Promise.resolve();
  assert.equal(refreshes, 1);
  f.overlay.setSuspended(false); f.overlay.setSports({ enabled: false });
  f.overlay.setMode('all'); f.send('sports-refresh'); await Promise.resolve();
  assert.equal(refreshes, 1, 'visible orb alone cannot refresh disabled sports');
});

test('sports polling pauses for renderer failure, window closure and disposal and resumes once', (t) => {
  const active = [];
  const f = fixture(t, { onSportsActive: value => active.push(value) });
  f.overlay.setSports({ enabled: true, team: 'GSW' }); f.send('ready'); f.send('ready');
  assert.deepEqual(active, [true]);
  f.window.webContents.emit('render-process-gone');
  assert.deepEqual(active, [true, false]);
  f.overlay.setSports({ enabled: true, team: 'GSW', stale: true });
  assert.equal(f.window.visible, false);
  f.send('ready');
  assert.deepEqual(active, [true, false, true]);
  f.window.destroy();
  assert.deepEqual(active, [true, false, true, false]);
  const replacement = f.overlay.create();
  f.ipcMain.emit('status-overlay-action', { sender: replacement.webContents, senderFrame: replacement.webContents.mainFrame }, { type: 'ready' });
  assert.deepEqual(active, [true, false, true, false, true]);
  f.overlay.destroy(); f.overlay.destroy();
  assert.deepEqual(active, [true, false, true, false, true, false]);
});

test('score snapshots do not resize, refocus or repaint unchanged content', (t) => {
  const active = [];
  let f;
  f = fixture(t, { onSportsActive: value => {
    active.push(value);
    if (value) f.overlay.setSports({ enabled: true, team: 'GSW', refreshing: true });
  } });
  f.overlay.setSports({ enabled: true, team: 'GSW' }); f.send('ready');
  assert.deepEqual(active, [true], 'synchronous service snapshots do not recurse activation');
  const previous = f.window.snapshots.length, raised = f.window.raised, bounds = f.window.bounds;
  f.overlay.setSports({ enabled: true, team: 'GSW', refreshing: true });
  assert.equal(f.window.snapshots.length, previous);
  f.overlay.setSports({ enabled: true, team: 'GSW', refreshing: false, updatedAt: 1234 });
  assert.equal(f.window.snapshots.length, previous + 1);
  assert.equal(f.window.bounds, bounds);
  assert.equal(f.window.raised, raised);
  assert.equal(f.window.focused, false);
});

function beginHandleDrag(f) {
  const { sportsHandle: handle } = f.latest().geometry, bounds = f.window.bounds;
  const point = { x: bounds.x + handle.x + handle.width / 2, y: bounds.y + handle.y + handle.height / 2 };
  f.cursor(point);
  f.send('sports-drag-start');
  return point;
}

test('tucked card leaves only its handle interactive and all geometry stays bounded while dragging', () => {
  for (const [width, height] of [[298, 510], [180, 260], [128, 128]]) {
    const initial = overlayGeometry(width, height, 'small', true);
    assert.ok(initial.menu.y + initial.menu.height + 8 <= initial.sportsHandle.y);
    assert.equal(initial.sportsHandle.width, Math.min(52, initial.sports.width));
    const expectedHandleHeight = initial.sports.width <= 172 ? 16 : 24;
    assert.equal(initial.sportsHandle.height, expectedHandleHeight, 'narrow cards reserve room below the grip for their controls');
    assert.equal(initial.sportsHandle.y, initial.sports.y, 'the grip sits inside the card without protruding');
    assert.equal(initial.sportsMaxOffset, initial.sports.height - initial.sportsHandle.height);
    for (const offset of [0, 20, 48, 72, 999]) {
      const geometry = overlayGeometry(width, height, 'small', true, offset);
      const handle = geometry.sportsHandle, visible = geometry.sportsVisible;
      assert.ok(handle.x >= 0 && handle.y >= 0 && handle.x + handle.width <= width && handle.y + handle.height <= height - 6);
      assert.ok(visible.y + visible.height <= height - 6);
      assert.equal(pointerTarget({ x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, geometry, false, false, false), 'sports-handle');
      assert.equal(pointerTarget({ x: visible.x + visible.width / 2, y: height - 3 }, geometry, false, false, false), null, 'bottom transparent margin cannot catch input');
    }
    const collapsed = overlayGeometry(width, height, 'small', true, initial.sportsMaxOffset);
    assert.equal(collapsed.sportsVisible.height, expectedHandleHeight);
    assert.equal(collapsed.sportsTucked, true);
    assert.equal(collapsed.sportsHandle.y + collapsed.sportsHandle.height, height - 6);
    assert.equal(pointerTarget({ x: collapsed.sports.x + (collapsed.sportsHandle.x - collapsed.sports.x) / 2, y: collapsed.sports.y + expectedHandleHeight / 2 }, collapsed, false, false, false), null, 'the visible tucked strip outside the grip stays click-through');
    assert.equal(pointerTarget({ x: collapsed.sports.x + collapsed.sports.width / 2, y: collapsed.sports.y + 25 }, collapsed, false, false, false), null, 'off-screen card is not a click target');
  }
});

test('sports handle follows only the OS pointer and snaps down then up without stopping live updates', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10000 });
  const active = [];
  const f = fixture(t, { onSportsActive: value => active.push(value) });
  f.overlay.setSports({ enabled: true, team: 'GSW' }); f.send('ready');
  const start = beginHandleDrag(f);
  assert.equal(f.latest().sportsPresentation.dragging, true);
  f.send('sports-drag-move', { x: start.x, y: start.y + 5000, offset: 72 });
  assert.equal(f.latest().sportsPresentation.offset, 0, 'renderer coordinates cannot move the card');
  f.cursor({ ...start, y: start.y + 45 }); t.mock.timers.tick(50);
  assert.equal(f.latest().sportsPresentation.offset, 45, 'fallback pointer polling animates the drag');
  f.overlay.setSports({ enabled: true, team: 'GSW', updatedAt: 1234 });
  assert.equal(f.latest().sportsPresentation.offset, 45, 'score refresh does not interrupt dragging');
  f.cursor({ x: start.x - 1000, y: start.y + 70 }); f.send('sports-drag-move');
  assert.equal(f.window.ignored, false, 'pointer capture persists outside the visible handle while dragging');
  f.send('sports-drag-end');
  assert.deepEqual(f.latest().sportsPresentation, { collapsed: true, dragging: false, offset: 72 });
  assert.equal(f.window.ignored, true, 'release returns transparent space to the underlying app');
  assert.deepEqual(active, [true], 'tucking never pauses automatic live updates');
  const tucked = beginHandleDrag(f);
  f.cursor({ ...tucked, y: tucked.y - 40 }); f.send('sports-drag-end');
  assert.deepEqual(f.latest().sportsPresentation, { collapsed: false, dragging: false, offset: 0 });
  assert.equal(f.window.focused, false, 'controller never focuses the app during a drag');
});

test('short handle motions restore the starting state and keyboard tuck persists across resize', (t) => {
  const f = fixture(t);
  f.overlay.setSports({ enabled: true, team: 'GSW' }); f.send('ready');
  let start = beginHandleDrag(f);
  f.cursor({ ...start, y: start.y + 19 }); f.send('sports-drag-end');
  assert.equal(f.latest().sportsPresentation.collapsed, false);
  f.send('sports-set-collapsed', { collapsed: true });
  for (const value of [undefined, null, 1, 'false', {}, []]) f.send('sports-set-collapsed', { collapsed: value });
  assert.equal(f.latest().sportsPresentation.collapsed, true, 'only booleans can change tuck state');
  start = beginHandleDrag(f);
  f.cursor({ ...start, y: start.y - 19 }); f.send('sports-drag-end');
  assert.equal(f.latest().sportsPresentation.collapsed, true);
  f.overlay.setSize('large');
  f.screen.emit('display-metrics-changed');
  assert.deepEqual(f.latest().sportsPresentation, { collapsed: true, dragging: false, offset: 72 });
  f.send('sports-toggle');
  assert.equal(f.latest().sportsPresentation.collapsed, false);
  f.send('sports-toggle');
  f.overlay.setSports({ enabled: false }); f.overlay.setSports({ enabled: true, team: 'GSW' });
  assert.equal(f.latest().sportsPresentation.collapsed, false, 'unpinning resets the temporary presentation');
});

test('drag cancellation, lost focus, display changes and screenshot suspension restore the starting state', (t) => {
  const f = fixture(t);
  f.overlay.setSports({ enabled: true, team: 'GSW' }); f.send('ready');
  for (const collapsed of [false, true]) {
    for (const interrupt of [
      () => f.send('sports-drag-cancel'),
      () => f.send('close'),
      () => { f.window.focused = false; f.window.emit('blur'); },
      () => f.screen.emit('display-metrics-changed'),
      () => f.overlay.setSuspended(true)
    ]) {
      f.overlay.setSuspended(false);
      f.send('sports-set-collapsed', { collapsed });
      const start = beginHandleDrag(f);
      f.cursor({ ...start, y: start.y + (collapsed ? -50 : 50) }); f.send('sports-drag-move');
      assert.equal(f.latest().sportsPresentation.dragging, true);
      interrupt();
      assert.deepEqual(f.latest().sportsPresentation, { collapsed, dragging: false, offset: collapsed ? 72 : 0 });
      f.send('sports-drag-end');
      assert.equal(f.latest().sportsPresentation.collapsed, collapsed, 'late release cannot override cancellation');
    }
  }
});

test('sports handle controls require trusted visible content and a drag must begin on the actual handle', async (t) => {
  let refreshes = 0;
  const f = fixture(t, { onSportsRefresh: () => { refreshes++; } });
  f.overlay.setSports({ enabled: true, team: 'GSW' }); f.send('ready');
  f.cursor({ x: -9999, y: -9999 });
  f.send('sports-drag-start', { x: 10, y: 10 });
  assert.equal(f.latest().sportsPresentation.dragging, false);
  for (const type of ['sports-drag-start', 'sports-drag-move', 'sports-drag-end', 'sports-toggle', 'sports-set-collapsed']) {
    f.send(type, { collapsed: true }, { sender: {}, senderFrame: f.event.senderFrame });
  }
  assert.deepEqual(f.latest().sportsPresentation, { collapsed: false, dragging: false, offset: 0 });
  f.send('sports-toggle'); f.send('sports-refresh'); await Promise.resolve();
  assert.equal(refreshes, 0, 'off-screen refresh button cannot issue a request');
  f.overlay.setSuspended(true); f.send('sports-toggle');
  assert.equal(f.latest().sportsPresentation.collapsed, true);
  f.overlay.setSuspended(false); f.send('sports-toggle');
  assert.equal(f.latest().sportsPresentation.collapsed, false);
});

test('live-only scores keep polling while hidden and appear automatically at tip-off without focus', (t) => {
  const active = [];
  let settings = 0;
  const f = fixture(t, { onSportsActive: value => active.push(value), onSportsSettings: () => { settings++; } });
  const watched = { enabled: true, liveOnly: true, team: 'GSW', game: null };
  f.overlay.setSports(watched); f.send('ready');
  assert.equal(f.window.visible, false);
  assert.equal(f.latest().geometry.sports, undefined);
  assert.deepEqual(active, [true], 'hidden off-day card still watches for tip-off');
  f.send('sports-settings'); assert.equal(settings, 0);
  f.overlay.setSports({ ...watched, game: { state: 'pre' } });
  assert.equal(f.window.visible, false);
  f.overlay.setSports({ ...watched, game: { state: 'live', detail: 'Q1 12:00' } });
  assert.equal(f.window.visible, true);
  assert.equal(f.window.focused, false);
  assert.ok(f.latest().geometry.sportsHandle);
  const start = beginHandleDrag(f);
  f.cursor({ ...start, y: start.y + 30 }); f.send('sports-drag-move');
  f.overlay.setSports({ ...watched, game: { state: 'final' } });
  assert.equal(f.window.visible, false);
  assert.equal(f.latest().sportsPresentation.dragging, false, 'game ending safely cancels an active drag');
  assert.equal(f.latest().geometry.sports, undefined);
  assert.deepEqual(active, [true], 'final score hides the card without stopping the next-game watcher');
  f.overlay.setSuspended(true); assert.deepEqual(active, [true, false]);
  f.overlay.setSuspended(false); assert.deepEqual(active, [true, false, true]);
  f.overlay.setSports({ ...watched, enabled: false });
  assert.deepEqual(active, [true, false, true, false]);
});

test('sports settings opens only from the trusted visible card or tucked handle', (t) => {
  let settings = 0;
  const f = fixture(t, { onSportsSettings: () => { settings++; } });
  f.overlay.setMode('all'); f.send('ready'); f.send('sports-settings');
  assert.equal(settings, 0);
  f.overlay.setSports({ enabled: true, team: 'GSW', liveOnly: true, game: { state: 'live' } });
  for (const event of [{ sender: {}, senderFrame: f.event.senderFrame }, { sender: f.event.sender, senderFrame: { url: f.event.senderFrame.url } }]) f.send('sports-settings', {}, event);
  assert.equal(settings, 0);
  f.send('sports-settings'); assert.equal(settings, 1);
  f.send('sports-toggle'); f.send('sports-settings'); assert.equal(settings, 2);
  beginHandleDrag(f); f.send('sports-settings'); assert.equal(settings, 2, 'drag does not unexpectedly open the main window');
  f.send('sports-drag-cancel'); f.overlay.setSuspended(true); f.send('sports-settings'); assert.equal(settings, 2);
  f.overlay.setSuspended(false); f.overlay.setSports({ enabled: true, team: 'GSW', liveOnly: true, game: { state: 'pre' } });
  assert.equal(f.window.visible, true, 'the ordinary orb can remain visible');
  f.send('sports-settings'); assert.equal(settings, 2, 'visible orb does not authorize hidden-card actions');
});

test('focused main window hides the entire overlay but keeps sports updates active for the in-app rail', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10000 });
  const active = [];
  const f = fixture(t, { onSportsActive: value => active.push(value) });
  f.overlay.setSports({ enabled: true, liveOnly: true, team: 'GSW', game: { state: 'live' } });
  f.overlay.setMode('all'); f.send('ready'); f.send('toggle');
  assert.equal(f.latest().menuOpen, true);
  // Windows has already focused the main app when its focus event arrives.
  f.window.focused = false;
  const blurs = f.window.blurCalls;
  f.overlay.setMainWindowActive(true);
  assert.equal(f.window.visible, false);
  assert.equal(f.window.ignored, true);
  assert.equal(f.latest().visible, false);
  assert.equal(f.latest().menuOpen, false);
  assert.equal(f.window.blurCalls, blurs, 'hiding an inactive overlay cannot disturb main-window focus');
  const reads = f.pointerReads();
  t.mock.timers.tick(500);
  assert.equal(f.pointerReads(), reads, 'no pointer polling while main-window rail owns the visible scores');
  f.overlay.setState('listening');
  f.overlay.setSports({ enabled: true, liveOnly: true, team: 'GSW', game: { state: 'live', detail: 'Q2 4:00' }, updatedAt: 1234 });
  for (const value of [null, undefined, 0, 1, 'false']) f.overlay.setMainWindowActive(value);
  assert.equal(f.window.visible, false, 'state changes, score updates and invalid visibility values cannot reshow the overlay');
  assert.deepEqual(active, [true], 'the rail continues receiving the shared sports feed');
  f.overlay.setMainWindowActive(false);
  assert.equal(f.window.visible, true);
  assert.equal(f.window.focused, false);
  assert.equal(f.latest().menuOpen, false, 'restoration never reopens the shortcut menu');
  assert.deepEqual(active, [true]);
});

test('main-window focus cancels an in-progress sports drag and preserves its settled tuck state', (t) => {
  const f = fixture(t);
  f.overlay.setSports({ enabled: true, team: 'GSW' }); f.send('ready');
  f.send('sports-set-collapsed', { collapsed: true });
  const start = beginHandleDrag(f);
  f.cursor({ ...start, y: start.y - 50 }); f.send('sports-drag-move');
  assert.equal(f.latest().sportsPresentation.offset, 22);
  f.overlay.setMainWindowActive(true);
  assert.deepEqual(f.latest().sportsPresentation, { collapsed: true, dragging: false, offset: 72 });
  assert.equal(f.window.ignored, true);
  f.send('sports-drag-end');
  f.overlay.setMainWindowActive(false);
  assert.deepEqual(f.latest().sportsPresentation, { collapsed: true, dragging: false, offset: 72 });
  assert.equal(f.window.visible, true);
  const handle = f.latest().geometry.sportsHandle, bounds = f.window.bounds;
  f.cursor({ x: bounds.x + handle.x + handle.width / 2, y: bounds.y + handle.y + handle.height / 2 }); f.send('pointer');
  assert.equal(f.window.ignored, false, 'the preserved tucked handle accepts input after restoring');
});

test('leaving the main window respects screenshot suspension, hide deadlines and live-only visibility', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10000 });
  const f = fixture(t);
  f.overlay.setMode('all'); f.overlay.setSports({ enabled: true, team: 'GSW' }); f.send('ready');
  f.send('toggle'); f.send('hide', { duration: '5-seconds' });
  f.overlay.setMainWindowActive(true); f.overlay.setMainWindowActive(false);
  assert.equal(f.window.visible, false, 'main-window focus changes cannot bypass a requested hide');
  f.overlay.setMainWindowActive(true); t.mock.timers.tick(5000);
  assert.equal(f.window.visible, false, 'expired hide cannot show over an active main window');
  f.overlay.setMainWindowActive(false);
  assert.equal(f.window.visible, true);
  f.overlay.setSuspended(true); f.overlay.setMainWindowActive(true); f.overlay.setMainWindowActive(false);
  assert.equal(f.window.visible, false, 'screenshot suspension still owns overlay visibility');
  f.overlay.setSuspended(false);
  assert.equal(f.window.visible, true);
  f.overlay.setMainWindowActive(true);
  f.overlay.setMode('off'); f.overlay.setSports({ enabled: true, liveOnly: true, team: 'GSW', game: { state: 'final' } });
  f.overlay.setMainWindowActive(false);
  assert.equal(f.window.visible, false, 'a finished live-only game stays hidden after leaving Olanga');
});

test('a renderer becoming ready while the main window is focused starts the feed without showing the overlay', (t) => {
  const active = [];
  const f = fixture(t, { onSportsActive: value => active.push(value) });
  f.overlay.setMainWindowActive(true);
  f.overlay.setMode('all'); f.overlay.setSports({ enabled: true, team: 'GSW' });
  f.send('ready');
  assert.equal(f.window.visible, false);
  assert.equal(f.latest().visible, false);
  assert.deepEqual(active, [true]);
  f.overlay.setMainWindowActive(false);
  assert.equal(f.window.visible, true);
  assert.deepEqual(active, [true]);
});

test('timer layouts grow upward, share the compact score footprint and have bounded native targets', () => {
  for (const [width, height] of [[292, 662], [180, 260], [128, 128]]) {
    for (const mode of ['expanded', 'compact', 'tucked']) {
      const geometry = overlayGeometry(width, height, 'small', false, 0, { mode, count: 5 });
      const { timers, timerHandle, orb, menu } = geometry;
      assert.equal(timers.x + timers.width + 8, orb.x);
      assert.equal(timers.y + timers.height, height - 6);
      assert.ok(menu.y + menu.height + 8 <= Math.min(timers.y, orb.y));
      for (const rect of [timers, timerHandle, orb, menu]) {
        assert.ok(rect.x >= 0 && rect.y >= 0);
        assert.ok(rect.x + rect.width <= width && rect.y + rect.height <= height);
      }
      const grip = { x: timerHandle.x + timerHandle.width / 2, y: timerHandle.y + timerHandle.height / 2 };
      assert.equal(pointerTarget(grip, geometry, false, false, false), 'timers-handle');
      const besideGrip = { x: timers.x + 10, y: timers.y + timers.height / 2 };
      assert.equal(pointerTarget(besideGrip, geometry, false, false, false), mode === 'tucked' ? null : 'timers');
      assert.equal(pointerTarget({ x: timers.x + timers.width + 4, y: timers.y + 20 }, geometry, false), null);
      if (width === 292) assert.equal(timers.height, { expanded: 288, compact: 96, tucked: 24 }[mode]);
    }
  }
  const compact = overlayGeometry(292, 470, 'small', false, 0, { mode: 'compact', count: 1 });
  assert.deepEqual(compact.timers, overlayGeometry(292, 470, 'small', true).sports);
});

test('timers are opt-in and empty collections leave no card, while an active timer can outlive orb visibility', (t) => {
  const f = fixture(t);
  f.send('ready');
  assert.equal(f.window.visible, false);
  f.overlay.setTimers({ ...timerSnapshot(), enabled: false });
  assert.equal(f.latest().companion.hasTimers, false);
  f.overlay.setTimers({ enabled: true, timers: [] });
  assert.equal(f.latest().geometry.timers, undefined);
  f.overlay.setTimers(timerSnapshot(1));
  assert.equal(f.window.visible, true);
  assert.equal(f.window.focused, false);
  assert.equal(f.latest().state, 'off');
  assert.equal(f.latest().companion.selected, 'timers');
  assert.equal(f.latest().timerPresentation.mode, 'compact');
  assert.equal(f.latest().geometry.sports, undefined);
  f.overlay.setTimers({ enabled: true, timers: [] });
  assert.equal(f.window.visible, false);
  assert.equal(f.latest().companion.selected, null);
  assert.equal(f.latest().geometry.timers, undefined);
});

test('timer handle cycles three views and preserves its selection when the main app hides and restores it', (t) => {
  const f = fixture(t);
  f.overlay.setTimers(timerSnapshot(7)); f.send('ready');
  assert.equal(f.latest().timers.timers.length, 5);
  assert.equal(f.latest().timers.total, 7);
  const absoluteOrb = () => ({ x: f.window.bounds.x + f.latest().geometry.orb.x, y: f.window.bounds.y + f.latest().geometry.orb.y });
  const corner = absoluteOrb();
  for (const mode of ['tucked', 'expanded', 'compact']) {
    f.send('timers-toggle-mode');
    assert.equal(f.latest().timerPresentation.mode, mode);
    assert.deepEqual(absoluteOrb(), corner, 'changing card height does not move the orb');
  }
  f.send('timers-set-mode', { mode: 'expanded' });
  f.overlay.setMainWindowActive(true);
  assert.equal(f.window.visible, false);
  f.send('timers-toggle-mode');
  f.overlay.setMainWindowActive(false);
  assert.equal(f.window.visible, true);
  assert.equal(f.latest().timerPresentation.mode, 'expanded');
  f.send('timers-set-mode', { mode: 'invalid' });
  assert.equal(f.latest().timerPresentation.mode, 'expanded');
});

test('switching timers and sports keeps exactly one card and the game feed stays active', async (t) => {
  const activity = [];
  let refreshes = 0;
  const f = fixture(t, { onSportsActive: value => activity.push(value), onSportsRefresh: () => { refreshes++; } });
  f.overlay.setTimers(timerSnapshot());
  f.overlay.setSports({ enabled: true, liveOnly: true, game: { state: 'live' } });
  f.send('ready');
  assert.equal(f.latest().companion.selected, 'timers');
  assert.equal(f.latest().geometry.sports, undefined);
  f.send('sports-refresh'); await Promise.resolve();
  assert.equal(refreshes, 0);
  f.send('companion-select', { card: 'sports' });
  assert.equal(f.latest().geometry.timers, undefined);
  assert.ok(f.latest().geometry.sports);
  f.send('sports-refresh');
  f.send('companion-select', { card: 'timers' });
  await Promise.resolve();
  assert.equal(refreshes, 0, 'a refresh queued by a card that was switched away is cancelled');
  assert.deepEqual(activity, [true], 'switching cards does not stop the live-game feed');
  f.overlay.setTimers({ enabled: true, timers: [] });
  assert.equal(f.latest().companion.selected, 'sports');
  f.overlay.setTimers(timerSnapshot(1));
  assert.equal(f.latest().companion.selected, 'sports', 'new timers preserve the current available card');
  f.overlay.setSports({ enabled: true, liveOnly: true, game: { state: 'final' } });
  assert.equal(f.latest().companion.selected, 'timers');
  assert.equal(f.latest().geometry.sports, undefined);
  assert.deepEqual(activity, [true], 'live-only feed keeps checking after the final score disappears');
});

test('timer mutation and fallback respect five-second and one-hour hiding deadlines', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10000 });
  const f = fixture(t);
  f.overlay.setMode('all'); f.overlay.setTimers(timerSnapshot()); f.send('ready');
  for (const [duration, milliseconds] of [['5-seconds', 5000], ['1-hour', 3600000]]) {
    f.send('toggle'); f.send('hide', { duration });
    f.overlay.setTimers(timerSnapshot(2));
    f.overlay.setSports({ enabled: true, game: { state: 'live' } });
    f.overlay.setTimers({ enabled: true, timers: [] });
    assert.equal(f.window.visible, false);
    t.mock.timers.tick(milliseconds - 1);
    assert.equal(f.window.visible, false);
    t.mock.timers.tick(1);
    assert.equal(f.window.visible, true);
    assert.equal(f.latest().companion.selected, 'sports');
  }
});

test('timer drags use the OS cursor, snap one mode per gesture, and cancel without changing the mode', (t) => {
  const f = fixture(t);
  f.overlay.setTimers(timerSnapshot()); f.send('ready');
  const begin = () => {
    const grip = f.latest().geometry.timerHandle, bounds = f.window.bounds;
    const point = { x: bounds.x + grip.x + grip.width / 2, y: bounds.y + grip.y + grip.height / 2 };
    f.cursor(point); f.send('timers-drag-start');
    return point;
  };
  f.cursor({ x: 0, y: 0 }); f.send('timers-drag-start', { x: -90, y: 950 });
  assert.equal(f.latest().timerPresentation.dragging, false, 'renderer coordinates cannot start the drag');
  for (const [delta, mode] of [[-50, 'expanded'], [60, 'compact'], [60, 'tucked'], [-50, 'compact']]) {
    const point = begin();
    assert.equal(f.latest().timerPresentation.dragging, true);
    f.cursor({ x: point.x, y: point.y + delta }); f.send('timers-drag-move');
    assert.equal(f.window.ignored, false);
    f.send('timers-drag-end');
    assert.equal(f.latest().timerPresentation.mode, mode);
    assert.equal(f.latest().timerPresentation.dragging, false);
  }
  const point = begin();
  f.cursor({ x: point.x, y: point.y - 100 }); f.send('timers-drag-move');
  f.overlay.setSuspended(true);
  f.overlay.setSuspended(false);
  assert.equal(f.latest().timerPresentation.mode, 'compact');
  assert.equal(f.latest().timerPresentation.dragging, false);
  begin();
  f.overlay.setMainWindowActive(true); f.overlay.setMainWindowActive(false);
  assert.equal(f.latest().timerPresentation.dragging, false);
});

test('timer settings and open actions reject untrusted, hidden, switched and tucked surfaces', (t) => {
  let settings = 0, opened = 0;
  const f = fixture(t, { onTimersSettings: () => { settings++; }, onOpenTimers: () => { opened++; } });
  f.overlay.setTimers(timerSnapshot()); f.send('ready');
  f.send('timers-settings', {}, { sender: {}, senderFrame: f.event.senderFrame });
  assert.equal(settings, 0);
  f.send('timers-settings'); f.send('timers-open');
  assert.equal(settings, 1); assert.equal(opened, 1);
  f.send('timers-set-mode', { mode: 'tucked' });
  f.send('timers-settings'); f.send('timers-open');
  f.overlay.setMainWindowActive(true); f.send('timers-open');
  f.overlay.setMainWindowActive(false);
  f.overlay.setSports({ enabled: true }); f.send('companion-select', { card: 'sports' });
  f.send('timers-settings'); f.send('timers-open');
  assert.equal(settings, 1); assert.equal(opened, 1);
});

test('unchanged timer snapshots stay quiet and existing timers survive overlay renderer replacement', (t) => {
  const f = fixture(t);
  f.overlay.setTimers(timerSnapshot()); f.send('ready');
  const count = f.window.snapshots.length, bounds = f.window.bounds, raised = f.window.raised;
  f.overlay.setTimers(timerSnapshot());
  assert.equal(f.window.snapshots.length, count);
  assert.equal(f.window.bounds, bounds);
  assert.equal(f.window.raised, raised);
  f.window.webContents.emit('render-process-gone');
  assert.equal(f.window.visible, false);
  f.send('ready');
  assert.equal(f.window.visible, true);
  assert.equal(f.latest().timers.timers.length, 5);
});

test('Windows taskbar entry dismisses the menu, releases input and preserves the selected timer view', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 10000 });
  const activity = [];
  const f = fixture(t, { onSportsActive: value => activity.push(value) });
  f.overlay.setMode('all');
  f.overlay.setSports({ enabled: true, game: { state: 'live' } });
  f.overlay.setTimers(timerSnapshot(3));
  f.send('ready');
  f.send('companion-select', { card: 'timers' });
  f.send('timers-set-mode', { mode: 'expanded' });
  const { orb } = f.latest().geometry;
  const x = f.window.bounds.x + orb.x + orb.width / 2;
  f.cursor({ x, y: f.window.bounds.y + orb.y + orb.height / 2 });
  f.send('pointer');
  assert.equal(f.window.ignored, false, 'the orb still accepts a click above the taskbar');
  f.send('toggle');
  assert.equal(f.latest().menuOpen, true);

  f.cursor({ x, y: 1038 }); // Two DIPs above the reserved strip.
  t.mock.timers.tick(250);
  assert.equal(f.window.visible, false);
  assert.equal(f.window.ignored, true);
  assert.equal(f.latest().menuOpen, false);
  const shows = f.window.showCount;
  f.cursor({ x, y: 1060 });
  f.overlay.setTimers(timerSnapshot(4));
  t.mock.timers.tick(250);
  assert.equal(f.window.showCount, shows, 'a card resize cannot flash the overlay over the taskbar');
  f.send('toggle');
  assert.equal(f.latest().menuOpen, false, 'queued renderer actions are ignored while yielded');

  f.cursor({ x, y: 940 });
  t.mock.timers.tick(250);
  assert.equal(f.window.visible, true);
  assert.equal(f.window.focused, false);
  assert.equal(f.latest().menuOpen, false);
  assert.equal(f.latest().companion.selected, 'timers');
  assert.equal(f.latest().timerPresentation.mode, 'expanded');
  assert.equal(f.latest().timers.timers.length, 4);
  assert.deepEqual(activity, [true], 'the shared sports feed stayed active');
  assert.equal(f.window.raised, undefined, 'taskbar exit does not raise Olanga over the shell');
});

test('auto-hide taskbar yields on first show, stays clear of its expanded surface and tracks the primary display', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 10000 });
  const bounds = { x: -1920, y: -300, width: 1920, height: 1080 };
  const display = { bounds, workArea: { ...bounds }, scaleFactor: 1.5 };
  const f = fixture(t, {}, display);
  const bottom = bounds.y + bounds.height;
  const x = -22;
  f.cursor({ x, y: bottom - 2 });
  f.overlay.setMode('all');
  f.send('ready');
  assert.equal(f.window.visible, false);
  assert.equal(f.window.showCount, undefined, 'readiness does not briefly show the orb over an exposed taskbar');
  f.cursor({ x, y: bottom - 47 });
  t.mock.timers.tick(250);
  assert.equal(f.window.visible, false, 'moving onto an expanded taskbar button keeps it clear');
  f.cursor({ x, y: bottom - 100 });
  t.mock.timers.tick(250);
  assert.equal(f.window.visible, true);

  f.cursor({ x: 0, y: bottom - 1 }); // First DIP of the monitor to the right.
  t.mock.timers.tick(250);
  assert.equal(f.window.visible, true, 'a neighboring monitor has its own bottom edge');
  f.cursor({ x, y: bottom - 30 });
  t.mock.timers.tick(250);
  assert.equal(f.window.visible, true, 'approaching an unexpanded auto-hide taskbar keeps the orb usable');
  display.workArea = { ...bounds, height: bounds.height - 48 };
  f.screen.emit('display-metrics-changed');
  assert.equal(f.window.visible, false, 'a changed work area can put the taskbar under a stationary pointer');
  display.bounds = { ...bounds, x: 0 };
  display.workArea = { ...display.workArea, x: 0 };
  f.screen.emit('display-metrics-changed');
  assert.equal(f.window.visible, true, 'moving the overlay to another primary monitor clears the yield');
});

test('taskbar recovery polls only while the desktop overlay is eligible', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10000 });
  const f = fixture(t);
  const bar = { x: -220, y: 1055 };
  const desktop = { x: -220, y: 900 };
  f.cursor(desktop);
  f.overlay.setMode('all');
  f.send('ready');
  f.send('toggle');
  f.send('hide', { duration: '5-seconds' });
  f.cursor(bar);
  const reads = f.pointerReads();
  const shows = f.window.showCount;
  t.mock.timers.tick(4999);
  assert.equal(f.pointerReads(), reads, 'a manual hide disables cursor polling');
  t.mock.timers.tick(1);
  assert.equal(f.window.showCount, shows, 'a hide deadline cannot flash the overlay over the taskbar');
  for (const block of [f.overlay.setMainWindowActive, f.overlay.setSuspended]) {
    block(true);
    const blockedReads = f.pointerReads();
    f.cursor(desktop);
    t.mock.timers.tick(500);
    assert.equal(f.pointerReads(), blockedReads);
    assert.equal(f.window.visible, false);
    f.cursor(bar);
    block(false);
    assert.equal(f.window.showCount, shows);
  }
  f.cursor(desktop);
  t.mock.timers.tick(250);
  assert.equal(f.window.visible, true);
});

test('unreserved bottom edges stay usable on non-Windows systems and with a side-docked Windows taskbar', (t) => {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const mac = fixture(t, { platform: 'darwin' }, { bounds, workArea: { ...bounds } });
  mac.cursor({ x: 1900, y: 1079 });
  mac.overlay.setMode('all');
  mac.send('ready');
  assert.equal(mac.window.visible, true);
  assert.deepEqual(mac.window.top, { value: true, level: 'screen-saver' });

  const win = fixture(t, {}, { bounds, workArea: { ...bounds, width: 1872 } });
  win.cursor({ x: 1850, y: 1079 });
  win.overlay.setMode('all');
  win.send('ready');
  assert.equal(win.window.visible, true);
});

for (const card of ['sports', 'timers']) {
  test('Windows taskbar allows an active ' + card + ' handle drag to finish before yielding', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 10000 });
    const f = fixture(t);
    if (card === 'sports') f.overlay.setSports({ enabled: true });
    else f.overlay.setTimers(timerSnapshot());
    f.send('ready');
    const { sportsHandle, timerHandle } = f.latest().geometry;
    const handle = sportsHandle || timerHandle;
    const x = f.window.bounds.x + handle.x + handle.width / 2;
    const y = f.window.bounds.y + handle.y + handle.height / 2;
    f.cursor({ x, y });
    f.send(card + '-drag-start');
    f.cursor({ x, y: 1050 });
    t.mock.timers.tick(250);
    assert.equal(f.window.visible, true);
    assert.equal(f.window.ignored, false, 'the drag retains pointer capture over the taskbar');
    f.send(card + '-drag-end');
    t.mock.timers.tick(250);
    assert.equal(f.window.visible, false);
    assert.equal(f.window.ignored, true);
    f.cursor({ x, y: 940 });
    t.mock.timers.tick(250);
    assert.equal(f.window.visible, true);
    if (card === 'sports') assert.equal(f.latest().sportsPresentation.collapsed, true);
    else assert.equal(f.latest().timerPresentation.mode, 'tucked');
  });
}
