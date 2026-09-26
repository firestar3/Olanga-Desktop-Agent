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
    driverFactory: () => ({ request: async data => { requests.push(data); if (options.request) { const answer = await options.request(data); if (answer !== undefined) return answer; } return data.kind === 'inspect' ? structuredClone(snapshot) : null; }, dispose() {} })
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

const fullReplacement = [{ type: 'hotkey', keys: ['CTRL', 'A'] }, { type: 'type', text: 'The new complete text.' }];
function undoHarness(options = {}) {
  let current = { handle: '100', processId: 321, processStart: '123', runtimeId: 'editor-1', automationId: 'text', controlType: 'ControlType.Edit', className: 'Edit', nativeHandle: 200, parentRuntimeId: 'parent-1', windowTitle: 'Notes', text: 'Original complete text.' };
  const h = harness({ request: async data => {
    if (options.request) { const result = await options.request(data); if (result !== undefined) return result; }
    if (data.kind === 'capture-edit') return { supported: true, checkpoint: { ...current } };
    if (data.kind === 'replace-edit') {
      if (JSON.stringify(data.checkpoint) !== JSON.stringify(current)) throw new Error('Undo conflict: text or editor changed. No text was restored.');
      current = { ...current, text: data.text }; return { ...current };
    }
  } });
  return { ...h, current: () => current, change: values => { current = { ...current, ...values }; } };
}

test('full-field replacement produces a local checkpoint and verified single-use undo', async () => {
  const h = undoHarness();
  const { result } = await prepare(h, fullReplacement);
  const delivered = await h.invoke('run', result.planId);
  assert.equal(delivered.undo.available, true);
  assert.equal(delivered.undo.before, 'Original complete text.');
  assert.equal(delivered.undo.after, fullReplacement[1].text);
  assert.equal(h.requests.filter(r => ['type', 'hotkey'].includes(r.kind)).length, 0);
  assert.equal(h.current().text, fullReplacement[1].text);
  assert.deepEqual(await h.invoke('undo', delivered.undo.undoId), { ok: true, verified: true, message: 'The original text was restored and verified.' });
  assert.equal(h.current().text, delivered.undo.before);
  const count = h.requests.length;
  assert.equal((await h.invoke('undo', delivered.undo.undoId)).reason, 'expired');
  assert.equal(h.requests.length, count);
  h.api.dispose();
});

test('undo refuses intervening text and each native identity change without overwriting', async () => {
  for (const change of [{ text: 'User typed after the edit.' }, { handle: '101' }, { processId: 322 }, { processStart: '456' }, { runtimeId: 'editor-2' }, { windowTitle: 'Other document' }, { parentRuntimeId: 'other-parent' }]) {
    const h = undoHarness();
    const { result } = await prepare(h, fullReplacement);
    const delivered = await h.invoke('run', result.planId);
    h.change(change);
    const text = h.current().text;
    const outcome = await h.invoke('undo', delivered.undo.undoId);
    assert.equal(outcome.ok, false); assert.equal(outcome.reason, 'conflict');
    assert.match(outcome.message, /No text was restored/);
    assert.equal(h.current().text, text);
    h.api.dispose();
  }
});

test('expired and forged undo IDs cannot focus or modify an editor', async () => {
  const h = undoHarness();
  const { result } = await prepare(h, fullReplacement);
  const delivered = await h.invoke('run', result.planId), count = h.requests.length;
  assert.equal((await h.invoke('undo', 'forged')).reason, 'expired');
  h.tick(300001);
  assert.equal((await h.invoke('undo', delivered.undo.undoId)).reason, 'expired');
  assert.equal(h.requests.length, count);
  await assert.rejects(h.invoke('undo', delivered.undo.undoId, { sender: {}, senderFrame: h.event.senderFrame }), /local Olanga/);
  h.api.dispose();
});

test('unsupported accessible editors keep normal input and report no undo', async () => {
  const h = harness({ request: data => data.kind === 'capture-edit' ? { supported: false, message: 'This editor exposes no writable value.' } : undefined });
  const { result } = await prepare(h, fullReplacement);
  const delivered = await h.invoke('run', result.planId);
  assert.equal(delivered.ok, true); assert.equal(delivered.undo.available, false);
  assert.match(delivered.undo.message, /no writable value/);
  assert.equal(h.requests.filter(r => r.kind === 'hotkey').length, 1);
  assert.ok(h.requests.some(r => r.kind === 'type'));
  assert.ok(!h.requests.some(r => r.kind === 'replace-edit'));
  h.api.dispose();
});

test('plans with partial edits or follow-on commands never advertise full-field undo', async () => {
  const { replacementIndex } = require('../../desktop/automation');
  assert.equal(replacementIndex(fullReplacement), 0);
  assert.equal(replacementIndex([{ type: 'focus' }, ...fullReplacement]), 1);
  assert.equal(replacementIndex([...fullReplacement, { type: 'hotkey', keys: ['CTRL', 'S'] }]), -1);
  assert.equal(replacementIndex([{ type: 'hotkey', keys: ['DELETE'] }, ...fullReplacement]), -1);
  assert.equal(replacementIndex([{ type: 'type', text: 'Partial.' }]), -1);
});

test('a writable provider that rejects replacement never falls back to unguarded typing', async () => {
  const h = undoHarness({ request: data => { if (data.kind === 'replace-edit') throw new Error('Provider rejected SetValue.'); } });
  const { result } = await prepare(h, fullReplacement);
  const delivered = await h.invoke('run', result.planId);
  assert.equal(delivered.ok, false); assert.equal(delivered.undo.available, false);
  assert.match(delivered.error, /rejected SetValue/);
  assert.equal(h.requests.filter(r => ['type', 'hotkey'].includes(r.kind)).length, 0);
  h.api.dispose();
});

test('cancellation after checkpoint capture prevents replacement', async () => {
  let h;
  h = undoHarness({ request: data => { if (data.kind === 'capture-edit') h.invoke('cancel'); } });
  const { result } = await prepare(h, fullReplacement);
  const delivered = await h.invoke('run', result.planId);
  assert.equal(delivered.cancelled, true);
  assert.ok(!h.requests.some(r => r.kind === 'replace-edit'));
  assert.equal(delivered.undo.available, false);
  h.api.dispose();
});

test('undo rechecks cancellation and expiry after focus before restoring text', async () => {
  for (const action of ['cancel', 'expire']) {
    let interrupt = false, h;
    h = undoHarness({ request: data => {
      if (interrupt && data.kind === 'focus') {
        if (action === 'cancel') h.invoke('cancel');
        else h.tick(300001);
      }
    } });
    const { result } = await prepare(h, fullReplacement);
    const delivered = await h.invoke('run', result.planId);
    interrupt = true;
    const restored = await h.invoke('undo', delivered.undo.undoId);
    assert.equal(restored.ok, false);
    assert.equal(h.requests.filter(r => r.kind === 'replace-edit').length, 1, 'Only the original replacement ran');
    assert.equal(h.current().text, fullReplacement[1].text);
    h.api.dispose();
  }
});
