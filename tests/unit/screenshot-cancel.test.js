const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function harness(options = {}) {
  const calls = { opened: 0, hidden: 0, restored: 0, cleared: 0, suspended: [] };
  let handler, poll;
  const context = vm.createContext({
    AbortController, Error, Promise, setTimeout: fn => { queueMicrotask(fn); return 1; },
    app: { on() {} },
    setInterval: fn => { poll = fn; return 1; }, clearInterval: () => calls.cleared++,
    trustedMainIpc: { handle: (_, fn) => { handler = fn; } },
    mainWindow: { isVisible: () => true, isDestroyed: () => false, hide: () => calls.hidden++ },
    dialog: { showMessageBox: (_window, config) => { calls.signal = config.signal; return options.approval?.() || Promise.resolve({ response: 1 }); } },
    clipboard: { readImage: () => { if (options.clipboardError && calls.opened) throw new Error('clipboard busy'); return { toPNG: () => Buffer.from('unchanged'), isEmpty: () => false }; } },
    statusOverlay: { setSuspended: state => calls.suspended.push(state) },
    shell: { openExternal: async () => { calls.opened++; } },
    showMainWindow: () => calls.restored++
  });
  const source = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('let screenshotRequest = null;'), source.indexOf("trustedMainIpc.handle('fetch-news-bundle'")), context);
  return { calls, request: () => handler(), cancel: () => vm.runInContext('screenshotRequest?.abort()', context), poll: () => poll?.() };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('cancelling pending screen permission prevents late screen selection dispatch', async () => {
  let resolve; const h = harness({ approval: () => new Promise(done => { resolve = done; }) });
  const pending = h.request(); h.cancel(); resolve({ response: 1 });
  assert.equal(await pending, null); assert.equal(h.calls.signal.aborted, true);
  assert.equal(h.calls.opened, 0); assert.equal(h.calls.hidden, 0);
});
test('cancelling clipboard wait settles immediately and releases the next screenshot request', async () => {
  const h = harness(); const pending = h.request(); await tick();
  assert.equal(h.calls.opened, 1); h.cancel();
  assert.equal(await pending, null); assert.equal(h.calls.cleared, 1);
  assert.equal(h.calls.restored, 1); assert.deepEqual(h.calls.suspended, [true, false]);
  const next = h.request(); await tick(); h.cancel(); assert.equal(await next, null);
  assert.equal(h.calls.opened, 2);
});
test('clipboard failures settle the selection and restore the window instead of throwing from the timer', async () => {
  const h = harness({ clipboardError: true }); const pending = h.request(); await tick();
  assert.doesNotThrow(h.poll); assert.equal(await pending, null); assert.equal(h.calls.restored, 1);
});
