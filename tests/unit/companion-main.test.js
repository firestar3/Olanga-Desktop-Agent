'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Exercise the production main-process functions without loading Electron,
// spawning Windows helpers, touching a profile, or opening a real player.
const source = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'production companion functions are available');
  return source.slice(first, last);
}
const observation = section('let mediaStatusController = null;', 'const { isTrustedMainFrame');
const presentation = section('let mainWindow;', 'function watchAppClock(');
const binding = source.match(/  for \(const event of \['show', 'hide', 'minimize', 'restore'\]\) mainWindow\.on\(event, publishAppVisibility\);\s*for \(const event of \['focus', 'blur'\]\) mainWindow\.on\(event, syncCompanionPresentation\);/)?.[0];
assert.ok(binding, 'production visibility and focus event bindings are available');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture() {
  const workers = [], actions = [], overlay = [], messages = [];
  const state = { visible: true, minimized: false, focused: true, destroyed: false, contentsDestroyed: false };
  const window = new EventEmitter();
  Object.assign(window, {
    isVisible: () => state.visible, isMinimized: () => state.minimized,
    isFocused: () => state.focused, isDestroyed: () => state.destroyed,
    webContents: { isDestroyed: () => state.contentsDestroyed, send: (channel, payload) => messages.push({ channel, payload: plain(payload) }) }
  });
  const context = vm.createContext({
    Promise, sportsSystemAwake: true,
    statusOverlay: { setMainWindowActive: value => overlay.push(value) },
    mediaController: { execute: payload => { actions.push(payload); throw Error('An observation must never use the action worker'); } },
    createMediaController: options => {
      const worker = { options: plain(options), requests: [], disposals: 0,
        execute(payload) { const request = deferred(); this.requests.push({ ...request, payload: plain(payload) }); return request.promise; },
        dispose() { this.disposals++; }
      };
      workers.push(worker); return worker;
    }
  });
  vm.runInContext(observation + '\n' + presentation + `
    globalThis.api = { read: readMediaSnapshot, stop: stopMediaObservation,
      sync: syncCompanionPresentation, publish: publishAppVisibility,
      setWindow: value => { mainWindow = value; }, bind: () => { ${binding} } };
  `, context, { filename: 'production-companion-main.js' });
  context.api.setWindow(window); context.api.bind();
  return { api: context.api, context, state, window, workers, actions, overlay, messages };
}

test('media observations coalesce, use STATUS only, and never occupy the action controller', async () => {
  const f = fixture();
  const first = f.api.read(), second = f.api.read();
  assert.equal(first, second);
  assert.equal(f.workers.length, 1);
  assert.deepEqual(f.workers[0].options, { timeoutMs: 5000 });
  assert.deepEqual(f.workers[0].requests.map(request => request.payload), [{ action: 'STATUS', spotifyOnly: true }]);
  assert.deepEqual(f.actions, []);
  const receipt = { ok: true, verified: true, status: 'Playing', title: 'Fixture song', message: 'Current media session' };
  f.workers[0].requests[0].resolve(receipt);
  assert.equal(await first, receipt); await Promise.resolve();
  const next = f.api.read();
  assert.notEqual(next, first);
  assert.equal(f.workers.length, 1, 'success reuses the read-only worker');
  assert.equal(f.workers[0].requests.length, 2);
  f.workers[0].requests[1].resolve(receipt); await next;
});

test('hidden, minimized, destroyed, absent and sleeping windows cannot create a media worker', async () => {
  for (const change of [
    f => { f.state.visible = false; }, f => { f.state.minimized = true; },
    f => { f.state.destroyed = true; }, f => f.api.setWindow(null),
    f => { f.context.sportsSystemAwake = false; }
  ]) {
    const f = fixture(); change(f);
    const result = await f.api.read();
    assert.equal(result.ok, false); assert.equal(result.reason, 'inactive');
    assert.equal(f.workers.length, 0); assert.deepEqual(f.actions, []);
  }
});

test('hiding or minimizing disposes observation once and a later visible read creates a fresh worker', async () => {
  for (const event of ['hide', 'minimize']) {
    const f = fixture(), old = f.api.read();
    if (event === 'hide') f.state.visible = false; else f.state.minimized = true;
    f.window.emit(event);
    assert.equal(f.workers[0].disposals, 1);
    assert.equal(f.overlay.at(-1), false);
    f.api.stop(); assert.equal(f.workers[0].disposals, 1, 'repeated stop is harmless');
    await f.api.read(); assert.equal(f.workers.length, 1);
    f.state.visible = true; f.state.minimized = false; f.window.emit('restore');
    const fresh = f.api.read();
    assert.equal(f.workers.length, 2); assert.notEqual(fresh, old);
    f.workers[0].requests[0].resolve({ ok: false });
    f.workers[1].requests[0].resolve({ ok: true });
    await Promise.all([old, fresh]);
  }
});

test('an old observation finalizer cannot clear the replacement in-flight request', async () => {
  const f = fixture(), old = f.api.read();
  f.api.stop();
  const fresh = f.api.read();
  assert.notEqual(old, fresh);
  f.workers[0].requests[0].resolve({ ok: false, reason: 'cancelled' });
  await old; await Promise.resolve();
  assert.equal(f.api.read(), fresh, 'late old cleanup preserves coalescing of the new request');
  assert.equal(f.workers[1].requests.length, 1);
  f.workers[1].requests[0].resolve({ ok: true }); await fresh;
});

test('a rejected read clears its request and permits retry without issuing a media action', async () => {
  const f = fixture(), pending = f.api.read();
  const rejected = assert.rejects(pending, /fixture timeout/);
  f.workers[0].requests[0].reject(Error('fixture timeout'));
  await rejected; await Promise.resolve();
  const retry = f.api.read();
  assert.notEqual(retry, pending); assert.equal(f.workers[0].requests.length, 2);
  assert.deepEqual(f.actions, []);
  f.workers[0].requests[1].resolve({ ok: false, reason: 'no_session' }); await retry;
});

test('real focus and visibility bindings hide the overlay only while the main window owns focus', async () => {
  const f = fixture(), pending = f.api.read();
  f.window.emit('focus'); assert.equal(f.overlay.at(-1), true);
  f.state.focused = false; f.window.emit('blur');
  assert.equal(f.overlay.at(-1), false);
  assert.equal(f.workers[0].disposals, 0, 'visible unfocused app can keep its music card current');
  f.state.focused = true; f.state.visible = false; f.window.emit('hide');
  assert.equal(f.overlay.at(-1), false, 'stale focused flag on a hidden window never hides the floating overlay');
  assert.equal(f.workers[0].disposals, 1);
  assert.deepEqual(f.messages.at(-1), { channel: 'app-visibility-changed', payload: { visible: false, revision: 1 } });
  f.state.visible = true; f.window.emit('show');
  assert.equal(f.overlay.at(-1), true);
  assert.equal(f.messages.at(-1).payload.revision, 2);
  f.state.destroyed = true; f.api.sync();
  assert.equal(f.overlay.at(-1), false);
  f.workers[0].requests[0].resolve({ ok: false }); await pending;
});

test('production media IPC and power-event wiring use observation and stop workers while suspended', async () => {
  const f = fixture(), power = new EventEmitter(), registrations = [];
  const powerBinding = source.match(/app\.whenReady\(\)\.then\(\(\) => \{\s*powerMonitor\.on\('suspend'[\s\S]*?\n\}\);/)?.[0];
  const readBinding = source.match(/trustedMainIpc\.handle\('media-get-snapshot', readMediaSnapshot\);/)?.[0];
  assert.ok(powerBinding && readBinding, 'production event bindings are available');
  Object.assign(f.context, { app: { whenReady: () => Promise.resolve() }, powerMonitor: power,
    syncSportsActivity() {}, trustedMainIpc: { handle: (channel, callback) => registrations.push({ channel, callback }) } });
  vm.runInContext(powerBinding + '\n' + readBinding, f.context); await Promise.resolve();
  assert.equal(registrations[0].channel, 'media-get-snapshot');
  assert.equal(registrations[0].callback, f.api.read);
  const pending = registrations[0].callback();
  power.emit('suspend');
  assert.equal(f.workers[0].disposals, 1);
  assert.equal((await f.api.read()).reason, 'inactive');
  assert.equal(f.workers.length, 1, 'suspend blocks worker recreation');
  power.emit('resume');
  const resumed = f.api.read(); assert.equal(f.workers.length, 2);
  f.workers[0].requests[0].resolve({ ok: false });
  f.workers[1].requests[0].resolve({ ok: true });
  await Promise.all([pending, resumed]);
});

test('scores have no timed-hide menu or API while existing Side Light duration controls still dispatch', () => {
  const read = name => fs.readFileSync(path.join(__dirname, '../..', name), 'utf8');
  const renderer = read('status-indicator.js'), html = read('status-indicator.html');
  for (const [name, content] of [
    ['main', source], ['overlay controller', read('desktop/status-overlay.js')],
    ['overlay preload', read('status-indicator-preload.js')], ['overlay renderer', renderer]
  ]) {
    assert.equal(/\b(?:openSportsHideMenu|onSportsHideMenu|hideSports)\b|sports-hide-menu/.test(content), false, name + ' must not retain the removed score-card hide API');
  }
  assert.doesNotMatch(html, /id=["']sportsHide["']/);
  assert.match(html, /id="hideLight"[^>]*>Hide Side Light for 5 seconds</);
  assert.match(html, /id="hideLightHour"[^>]*>Hide Side Light for 1 hour</);
  const bindings = renderer.match(/document\.getElementById\('hideLight(?:Hour)?'\)\.addEventListener\('click', [^\r\n]+/g);
  assert.equal(bindings?.length, 2, 'both existing Side Light buttons retain their production event bindings');
  const handlers = new Map(), durations = [];
  vm.runInNewContext(bindings.join('\n'), {
    document: { getElementById: id => ({ addEventListener: (event, handler) => {
      assert.equal(event, 'click'); handlers.set(id, handler);
    } }) },
    api: { hideLight: duration => durations.push(duration) }
  });
  handlers.get('hideLight')(); handlers.get('hideLightHour')();
  assert.deepEqual(durations, ['5-seconds', '1-hour']);
});
