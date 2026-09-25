const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerDesktopAutomation } = require('../../desktop/automation');

function harness(options = {}) {
  let time = 1000, visible = true, screenshotCount = 0, registered = false;
  const handlers = {}, requests = [], prompts = [], sent = [], suspended = [];
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const target = { handle: '100', processId: 321, processName: 'notepad', title: 'Notes', bounds: { x: 10, y: 10, width: 1200, height: 800 } };
  const snapshot = { foreground: target, windows: [target], primaryBounds: bounds };
  const frame = { url: pathToFileURL(path.resolve(__dirname, '../../index.html')).href };
  const webContents = { mainFrame: frame, send: (channel, message) => sent.push({ channel, message }) };
  const win = { webContents, isDestroyed: () => false, isVisible: () => visible, isFocused: () => true, hide: () => { visible = false; }, show: () => { visible = true; }, showInactive: () => { visible = true; }, focus() {} };
  const event = { sender: webContents, senderFrame: frame };
  const display = { id: 1, size: { width: 1920, height: 1080 }, scaleFactor: 1, bounds };
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => display });
  const app = new EventEmitter();
  const api = registerDesktopAutomation({
    ipcMain: { handle: (channel, handler) => { handlers[channel] = handler; }, removeHandler: channel => { delete handlers[channel]; } },
    dialog: { showMessageBox: async (_, prompt) => { prompts.push(prompt); return { response: options.response ? await options.response(prompts.length, prompt) : 1 }; } },
    desktopCapturer: { getSources: async () => { screenshotCount++; return [{ display_id: '1', thumbnail: { isEmpty: () => false, getSize: () => ({ width: 1920, height: 1080 }), toDataURL: () => 'data:image/png;base64,AA==' } }]; } },
    screen, globalShortcut: { register: (_, callback) => { registered = options.escapeUnavailable ? false : callback; return !!registered; }, unregister: () => { registered = false; } },
    getMainWindow: () => win, setOverlaySuspended: value => suspended.push(value), app, platform: 'win32', now: () => time, sleep: async () => {},
    driverFactory: () => ({ request: async data => { requests.push(data); if (options.request) await options.request(data); return data.kind === 'inspect' ? structuredClone(snapshot) : null; }, dispose() {} })
  });
  const invoke = (name, arg, sender = event) => handlers[`desktop-${name}`](sender, arg);
  return { invoke, api, event, handlers, requests, prompts, sent, suspended, screen, snapshot, target, get visible() { return visible; }, get screenshotCount() { return screenshotCount; }, get registered() { return registered; }, tick: ms => { time += ms; } };
}
async function prepare(h, steps = [{ type: 'type', text: 'Hello' }], scope) {
  const capture = await h.invoke('capture');
  const input = { captureId: capture.captureId, summary: 'Edit notes', scope: scope || { mode: 'window', handle: '100' }, steps };
  const result = h.invoke('prepare', input);
  return { input, result };
}

test('rejects foreign senders, subframes and unexpected URLs before capture or input', async () => {
  const h = harness();
  for (const event of [{ sender: {}, senderFrame: h.event.senderFrame }, { sender: h.event.sender, senderFrame: { ...h.event.senderFrame } }]) await assert.rejects(h.invoke('capture', undefined, event), /local Olanga/);
  h.event.senderFrame.url = 'https://example.com/';
  await assert.rejects(h.invoke('capture'), /local Olanga/);
  assert.equal(h.screenshotCount, 0);
  assert.equal(h.requests.length, 0);
  h.api.dispose();
});

test('capture permission is independent and denial captures nothing', async () => {
  const h = harness({ response: () => 0 });
  await assert.rejects(h.invoke('capture'), /cancelled/);
  assert.equal(h.screenshotCount, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.visible, true);
  h.api.dispose();
});

test('immutable plans require both edit confirmations and are single use', async () => {
  const h = harness();
  const { input, result } = await prepare(h);
  input.steps[0].text = 'Unapproved replacement';
  const outcome = await h.invoke('run', result.planId);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.completedSteps, 1);
  assert.equal(h.screenshotCount, 2, 'captures fresh evidence only after approved input');
  assert.ok(outcome.verificationCapture.imageDataUrl);
  assert.match(h.prompts[2].detail, /sends it to Google Gemini to verify/);
  assert.equal(h.prompts.length, 3);
  assert.match(h.prompts[1].detail, /Type exactly: "Hello"/);
  assert.equal(h.requests.find(r => r.kind === 'type').text, 'Hello');
  assert.equal(h.visible, true);
  assert.equal(h.registered, false);
  assert.deepEqual(h.suspended, [true, false, true, false]);
  await assert.rejects(h.invoke('run', result.planId), /expired or was replaced/);
  h.api.dispose();
});

test('denying either native edit confirmation prevents all input', async () => {
  for (const denied of [2, 3]) {
    const h = harness({ response: index => index === denied ? 0 : 1 });
    const { result } = await prepare(h);
    const outcome = await h.invoke('run', result.planId);
    assert.equal(outcome.cancelled, true);
    assert.ok(h.requests.every(r => r.kind === 'inspect'));
    assert.equal(h.screenshotCount, 1, 'denial grants no post-action capture');
    h.api.dispose();
  }
});

test('a different foreground window after input prevents verification capture', async () => {
  let inspectCount=0,h;
  h=harness({request:async data=>{if(data.kind==='inspect'&&++inspectCount===4)h.snapshot.foreground={...h.target,handle:'999'};}});
  const {result}=await prepare(h);
  const outcome=await h.invoke('run',result.planId);
  assert.equal(outcome.ok,true,'input completion is distinct from verification');
  assert.equal(outcome.verificationCapture,undefined);
  assert.match(outcome.verificationError,/target changed/);
  assert.equal(h.screenshotCount,1);
  h.api.dispose();
});

test('expired captures, replaced plans, and display changes revoke authority', async () => {
  const h = harness();
  const { input, result } = await prepare(h);
  const newer = h.invoke('prepare', input);
  await assert.rejects(h.invoke('run', result.planId), /replaced/);
  h.tick(300001);
  assert.throws(() => h.invoke('prepare', input), /expired/);
  await assert.rejects(h.invoke('run', newer.planId), /expired/);
  const fresh = await prepare(h);
  h.screen.emit('display-metrics-changed');
  await assert.rejects(h.invoke('run', fresh.result.planId), /expired/);
  h.api.dispose();
});

test('unavailable Escape shortcut fails before focusing or input', async () => {
  const h = harness({ escapeUnavailable: true });
  const { result } = await prepare(h);
  const outcome = await h.invoke('run', result.planId);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /Escape/);
  assert.ok(h.requests.every(r => r.kind === 'inspect'));
  h.api.dispose();
});

test('cancellation between text chunks stops subsequent input', async () => {
  let h;
  h = harness({ request: data => { if (data.kind === 'type') h.invoke('cancel'); } });
  const { result } = await prepare(h, [{ type: 'type', text: 'A'.repeat(100) }, { type: 'hotkey', keys: ['CTRL', 'S'] }]);
  const outcome = await h.invoke('run', result.planId);
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.completedSteps, 0);
  assert.equal(h.requests.filter(r => r.kind === 'type').length, 1);
  assert.equal(h.requests.filter(r => r.kind === 'hotkey').length, 0);
  assert.equal(h.visible, true);
  h.api.dispose();
});

test('native target rejection stops the plan and restores Olanga', async () => {
  const h = harness({ request: data => { if (data.kind === 'type') throw new Error('The foreground window changed.'); } });
  const { result } = await prepare(h, [{ type: 'type', text: 'Hello' }, { type: 'hotkey', keys: ['CTRL', 'S'] }]);
  const outcome = await h.invoke('run', result.planId);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /foreground/);
  assert.equal(h.requests.filter(r => r.kind === 'hotkey').length, 0);
  assert.equal(h.visible, true);
  h.api.dispose();
});

test('native region bounds are derived inward from the user-selected normalized region', async () => {
  const h = harness();
  const scope = { mode: 'region', handle: '100', region: { x: 0.1234, y: 0.1111, width: 0.5678, height: 0.6789 } };
  const { result } = await prepare(h, [{ type: 'type', text: 'const x = 1;' }], scope);
  await h.invoke('run', result.planId);
  const region = h.requests.find(r => r.kind === 'type').region;
  assert.ok(region.x >= scope.region.x * 1920);
  assert.ok(region.y >= scope.region.y * 1080);
  assert.ok(region.x + region.width <= (scope.region.x + scope.region.width) * 1920);
  assert.ok(region.y + region.height <= (scope.region.y + scope.region.height) * 1080);
  assert.match(h.prompts[1].detail, /ONLY the approved editor region/);
  h.api.dispose();
});

test('cancelling while capture permission is open cannot create a later capture', async () => {
  let release;
  const h = harness({ response: () => new Promise(resolve => { release = resolve; }) });
  const pending = h.invoke('capture');
  h.invoke('cancel');
  release(1);
  await assert.rejects(pending, /cancelled/);
  assert.equal(h.screenshotCount, 0);
  h.api.dispose();
});
