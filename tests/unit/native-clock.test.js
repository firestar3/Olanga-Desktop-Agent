const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

test('native clock bridge delivers WM_TIMECHANGE and resume without polling, then releases its listener on close', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  const code = main.slice(main.indexOf('function watchAppClock('), main.indexOf('let tray = null;'));
  for (const platform of ['win32', 'darwin']) {
    const powerMonitor = new EventEmitter(), window = new EventEmitter(), messages = [], hooks = new Map();
    let destroyed = false, rendererGone = false;
    window.isDestroyed = () => destroyed;
    window.webContents = { isDestroyed: () => rendererGone, send: (channel, payload) => messages.push([channel, payload.reason]) };
    window.hookWindowMessage = (id, callback) => hooks.set(id, callback);
    const context = vm.createContext({ process: { platform }, powerMonitor, window });
    vm.runInContext(code + '\nwatchAppClock(window);', context);
    assert.equal(powerMonitor.listenerCount('resume'), 1);
    assert.equal(hooks.has(0x001E), platform === 'win32');
    hooks.get(0x001E)?.();
    powerMonitor.emit('resume');
    assert.deepEqual(messages, platform === 'win32' ? [['app-clock-changed', 'system-time'], ['app-clock-changed', 'resume']] : [['app-clock-changed', 'resume']]);
    const before = messages.length;
    rendererGone = true; powerMonitor.emit('resume');
    rendererGone = false; destroyed = true; powerMonitor.emit('resume');
    assert.equal(messages.length, before, 'closed windows and crashed renderers are never messaged');
    window.emit('closed');
    assert.equal(powerMonitor.listenerCount('resume'), 0);
  }
});
