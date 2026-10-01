const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createPhoneDispatch } = require('../../desktop/phone-dispatch');
const source = file => fs.readFileSync(path.join(__dirname, '../../', file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const command = (text = 'open Spotify', canonical = '[OPEN_APP: Spotify]') => ({ requestId: randomUUID(), text, command: canonical });

function fixture({ claim = async () => true, persist = true } = {}) {
  const calls = { claims: [], completed: [], opened: [], media: [], errors: [], spoken: [] }, memory = new Map(); let handler, cancel, dialog = false, desktopBusy = false, live = false;
  const node = () => ({ textContent: '', classList: { add() {}, remove() {} } });
  const api = {
    onPhoneCommand: callback => { handler = callback; }, onPhoneCancel: callback => { cancel = callback; },
    phoneClaim: async id => { calls.claims.push(id); return claim(id); }, phoneComplete: async value => { calls.completed.push(value); return true; },
    openApp: async name => { calls.opened.push(name); return { ok: true, verified: true, message: 'Spotify is open.' }; }, mediaControl: async (...args) => { calls.media.push(args); return { ok: true, verified: true, message: 'Volume is set.' }; }, cancelMedia() {}
  };
  const context = vm.createContext({
    AbortController, DOMException, Date, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    console: { log() {}, warn() {}, error() {} }, OlangaGemini: require('../../shared/gemini-request'), OlangaIntents: require('../../shared/fast-intents'), OlangaTurnLifecycle: require('../../shared/turn-lifecycle'), OlangaTurnCorrections: require('../../shared/turn-corrections'),
    window: { electronAPI: api, OlangaDesktop: { cancel() {}, isBusy: () => desktopBusy }, OlangaLiveConversation: { isActive: () => live, stop: async () => { live = false; } } },
    document: { querySelector: () => dialog ? {} : null, getElementById: () => null },
    State: { IDLE: 'idle', THINKING: 'thinking', SPEAKING: 'speaking', LISTENING: 'listening' }, currentState: 'idle',
    setState: value => { context.currentState = value; }, activeTimers: [], activeTasks: [], timersContainer: null, alarmIntervalId: null,
    localStorage: { getItem: key => memory.get(key) || null, setItem: (key, value) => { if (!persist) throw new Error('Disk full'); memory.set(key, value); } },
    userText: node(), aiText: node(), transcriptUser: node(), transcriptAi: node(), hint: node(),
    isRecording: false, followUpTimer: null, conversationHistory: [], userCity: '', userState: '', userCountry: '',
    speakResponse: async text => { calls.spoken.push(text); }, showError: text => calls.errors.push(text), apiKey: ''
  });
  vm.runInContext(source('js/assistant.js'), context); vm.runInContext(source('js/timers-tasks.js'), context); vm.runInContext(source('js/phone-controller.js'), context);
  return { context, calls, api, memory, send: payload => handler(payload), cancel: id => cancel(id), dialog: value => { dialog = value; }, desktop: value => { desktopBusy = value; }, live: value => { live = value; } };
}

test('a valid phone command uses local execution, returns its receipt and stays silent', async () => {
  const f = fixture(); const payload = command(); await f.send(payload);
  assert.deepEqual(f.calls.opened, ['Spotify']); assert.equal(f.calls.completed[0].result.ok, true); assert.equal(f.calls.completed[0].result.verified, true);
  assert.equal(f.context.currentState, 'idle'); assert.deepEqual(f.calls.spoken, []); assert.equal(f.context.userText.textContent, 'Phone: open Spotify');
});

test('busy desktop states claim before refusing and settle the real main-process handoff', async () => {
  for (const condition of ['thinking', 'dialog', 'desktop', 'live']) {
    const f = fixture(); if (condition === 'thinking') f.context.currentState = 'thinking'; else f[condition](true);
    const window = { isDestroyed: () => false, webContents: { send: (channel, payload) => { if (channel === 'phone-command') void f.send(payload); } } };
    const dispatch = createPhoneDispatch({ getWindow: () => window }); f.api.phoneClaim = async id => dispatch.claim(id); f.api.phoneComplete = async value => dispatch.complete(value);
    const result = await dispatch.execute({ ...command(), signal: new AbortController().signal });
    assert.equal(result.ok, false); assert.match(result.message, /busy|review/); assert.deepEqual(f.calls.opened, []);
  }
});

test('a desktop or Live conversation that starts during claim prevents dispatch', async () => {
  for (const condition of ['thinking', 'dialog', 'desktop', 'live']) {
    let finish; const f = fixture({ claim: () => new Promise(resolve => { finish = resolve; }) });
    const pending = f.send(command()); if (condition === 'thinking') f.context.currentState = 'thinking'; else f[condition](true);
    finish(true); await pending; assert.equal(f.calls.opened.length, 0); assert.equal(f.calls.completed[0].result.ok, false);
  }
});

test('revocation during an in-flight claim cannot execute when the claim response arrives late', async () => {
  let finish; const f = fixture({ claim: () => new Promise(resolve => { finish = resolve; }) }), payload = command();
  const pending = f.send(payload); f.cancel(payload.requestId); finish(true); await pending;
  assert.equal(f.calls.opened.length, 0); assert.equal(f.calls.completed[0].result.ok, false);
});

test('duplicate event cannot clear the active owner or prevent cancellation of its late result', async () => {
  const f = fixture(); let finish;
  f.api.openApp = name => { f.calls.opened.push(name); return new Promise(resolve => { finish = resolve; }); };
  const payload = command(), pending = f.send(payload); await tick(); await f.send(payload); f.cancel(payload.requestId);
  finish({ ok: true, verified: true, message: 'Late success' }); await pending;
  assert.equal(f.calls.opened.length, 1); assert.equal(f.calls.claims.length, 1); assert.equal(f.calls.completed.at(-1).result.ok, false);
  assert.equal(f.context.window.OlangaTurns.snapshot().outcome, 'cancelled');
});

test('a late phone result cannot overwrite a newer desktop turn or reset its state', async () => {
  const f = fixture(); let finish;
  f.api.openApp = () => new Promise(resolve => { finish = resolve; }); const pending = f.send(command()); await tick();
  const next = f.context.beginAssistantRequest(); f.context.currentState = 'thinking'; f.context.aiText.textContent = 'New request';
  finish({ ok: true, verified: true, message: 'Old request' }); await pending;
  assert.equal(f.context.aiText.textContent, 'New request'); assert.equal(f.context.currentState, 'thinking'); assert.equal(f.context.window.OlangaTurns.snapshot().id, next.turnId);
  f.context.cancelAssistantRequest();
});

test('mismatched, unsupported and malformed command proposals never dispatch', async () => {
  const f = fixture();
  for (const payload of [command('open Spotify', '[OPEN_APP: powershell]'), command('open powershell', '[OPEN_APP: powershell]'), command('set volume to 101', '[VOLUME_SET: 101]'), command('set a timer for zero minutes', '[SET_TIMER: 0, Timer]'), command('close Spotify', '[CLOSE_APP: Spotify]'), command('open Spotify and set volume to 30', '[OPEN_APP: Spotify]'), command('[OPEN_APP: Spotify]', '[OPEN_APP: Spotify]')]) await f.send(payload);
  await f.send(null); assert.equal(f.calls.opened.length, 0); assert.equal(f.calls.media.length, 0); assert.ok(f.calls.completed.every(item => item.result.ok === false));
});

test('verified timer receipts require the exact newly created record to be persisted', async () => {
  for (const persist of [true, false]) {
    const f = fixture({ persist }); await f.send(command('set a timer for five minutes', '[SET_TIMER: 300, Timer]'));
    const result = f.calls.completed[0].result; assert.equal(result.ok, true); assert.equal(result.verified, persist); assert.equal(f.context.activeTimers.length, 1);
    if (persist) assert.equal(JSON.parse(f.memory.get('olanga_timers'))[0].id, f.context.activeTimers[0].id);
    else assert.match(result.message, /could not be saved/);
  }
});

test('an unrelated new timer cannot verify the requested duration and label', async () => {
  const f = fixture(); f.context.applyAssistantCommands = async () => { f.context.activeTimers.push({ id: 'other', label: 'Wrong', endTime: Date.now() + 1000 }); f.memory.set('olanga_timers', JSON.stringify(f.context.activeTimers)); return { results: [{ ok: true, message: 'Timer added.' }], spokenResponse: 'Timer added.' }; };
  await f.send(command('set a timer for five minutes', '[SET_TIMER: 300, Timer]')); assert.equal(f.calls.completed[0].result.verified, false);
});
