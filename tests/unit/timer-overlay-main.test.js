'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const timerOverlay = require('../../shared/timer-overlay');
const { isTrustedMainFrame } = require('../../shared/ipc-policy');
const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const ipcMain = new EventEmitter(), window = new EventEmitter(), updates = [];
  const contents = new EventEmitter();
  contents.mainFrame = { url: pathToFileURL(path.join(root, 'index.html')).href };
  let destroyed = false;
  window.isDestroyed = () => destroyed;
  window.webContents = contents;
  const context = vm.createContext({
    ipcMain, mainWindow: window, path, __dirname: root, timerOverlay, isTrustedMainFrame,
    statusOverlay: { setTimers: value => updates.push(plain(value)) }
  });
  const start = source.indexOf('const trustedMainIpc = {');
  const end = source.indexOf('// Size to the current display', start);
  assert.ok(start >= 0 && end > start);
  const bridge = source.split(/\r?\n/).find(line => line.startsWith("trustedMainIpc.on('timer-overlay-set-snapshot'"));
  const resetBindings = source.split(/\r?\n/).filter(line =>
    /mainWindow(?:\.webContents)?\.(?:on|once)\(/.test(line) && line.includes('statusOverlay.setTimers('));
  assert.ok(bridge);
  assert.equal(resetBindings.length, 3);
  vm.runInContext(source.slice(start, end) + '\n' + bridge + '\n' + resetBindings.join('\n'), context);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return {
    context, updates, window, contents, event,
    send: (snapshot, sender = event) => ipcMain.emit('timer-overlay-set-snapshot', sender, snapshot),
    destroy() { destroyed = true; window.emit('closed'); }
  };
}

const sample = { enabled: true, timers: [{ id: 'tea', label: 'Tea', endTime: 10000, intervalId: 25 }] };

test('only the actual main document can publish a normalized timer card snapshot', () => {
  const f = fixture();
  f.send(sample);
  assert.deepEqual(f.updates, [timerOverlay.normalizeSnapshot(sample)]);
  f.send(sample, { ...f.event, sender: {} });
  f.send(sample, { ...f.event, senderFrame: { ...f.contents.mainFrame } });
  f.contents.mainFrame.url = 'https://example.com/';
  f.send(sample);
  f.contents.mainFrame.url = pathToFileURL(path.join(root, 'status-indicator.html')).href;
  f.send(sample);
  assert.equal(f.updates.length, 1, 'other windows, child frames, remote pages and the overlay cannot supply timers');
});

test('renderer reload and crash remove stale countdowns and a fresh publication restores them', () => {
  const f = fixture();
  for (const event of ['did-start-loading', 'render-process-gone']) {
    f.send(sample);
    assert.equal(f.updates.at(-1).timers[0].label, 'Tea');
    f.contents.emit(event);
    assert.equal(f.updates.at(-1).enabled, false, event);
    f.send(sample);
    assert.deepEqual(f.updates.at(-1), timerOverlay.normalizeSnapshot(sample));
  }
  f.destroy();
  assert.equal(f.updates.at(-1).enabled, false);
  const count = f.updates.length;
  f.send(sample);
  assert.equal(f.updates.length, count, 'a destroyed main window cannot reintroduce its last timers');
});

test('the preload publishes timer snapshots and releases settings and timer navigation subscriptions', () => {
  const ipcRenderer = new EventEmitter(), messages = [];
  ipcRenderer.send = (channel, value) => messages.push({ channel, value });
  let api;
  const context = vm.createContext({
    require: name => {
      assert.equal(name, 'electron');
      return { ipcRenderer, contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'electronAPI'); api = value; } } };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'preload.js'), 'utf8'), context);
  api.setTimerOverlaySnapshot(sample);
  assert.deepEqual(messages, [{ channel: 'timer-overlay-set-snapshot', value: sample }]);
  for (const [method, channel] of [
    ['onOpenTimerOverlaySettings', 'timer-overlay-open-settings'], ['onOpenTimers', 'timers-open']
  ]) {
    let calls = 0;
    const unsubscribe = api[method](() => { calls++; });
    ipcRenderer.emit(channel, {});
    assert.equal(calls, 1);
    unsubscribe();
    ipcRenderer.emit(channel, {});
    assert.equal(calls, 1);
    assert.equal(ipcRenderer.listenerCount(channel), 0);
  }
});
