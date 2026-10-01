const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../js/workbench.js'), 'utf8');
const helper = source.slice(source.indexOf('  function stopLocalSpeech()'), source.indexOf('  function showMessage'));
const block = source.slice(source.indexOf("  const conversation = page('conversation'"), source.indexOf('  for (const value of pages.values())'));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const buttons = new Map(), fields = new Map(), messages = [], intervals = [], keydowns = [], audio = [], cancelled = [];
  let live = false, recognizerResets = 0;
  const node = () => ({ append() {}, setAttribute() {} });
  class Audio {
    constructor() { this.paused = false; this.playing = deferred(); audio.push(this); }
    play() { return options.deferPlay ? this.playing.promise : Promise.resolve(); }
    pause() { this.paused = true; }
  }
  const context = vm.createContext({ window: { addEventListener() {}, OlangaLiveConversation: {
    start: async () => { live = true; return options.live?.promise || { ok: true }; }, stop: async () => { live = false; }, isActive: () => live, onChange() {} } },
    document: { addEventListener: (name, callback) => { if (name === 'keydown') keydowns.push(callback); } },
    api: { conversationLocalReply: async () => options.reply?.promise || { ok: true, text: 'Fixture local answer.' }, conversationLocalSpeech: async () => options.speech?.promise || { ok: true, audioBase64: 'AAAA', mimeType: 'audio/wav' }, conversationLocalCancel: async id => cancelled.push(id) },
    page: node, detail() {}, node, field: (_parent, label) => { const input = { value: '' }; fields.set(label, input); return input; },
    button: (label, action) => { buttons.set(label, action); return node(); }, actions() {}, report() {}, showMessage: message => messages.push(message), checked: value => value,
    Audio, URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} }, Blob, Uint8Array,
    atob: value => Buffer.from(value, 'base64').toString('binary'), crypto: require('node:crypto'),
    setInterval: callback => { intervals.push(callback); return 1; }, clearInterval() {}, closeHandlers: new Set(),
    discardLocalSpeechCapture: () => { recognizerResets++; },
    generation: 0, localRequestId: null, speechRequestId: null, localReplyText: '', localAudio: null, localAudioUrl: null,
    isTtsMuted: false, currentState: 'idle', State: { IDLE: 'idle' } });
  vm.runInContext(helper + block, context);
  return { context, buttons, fields, messages, intervals, keydowns, audio, cancelled, resets: () => recognizerResets };
}
test('cancelled local answer rejects quietly and cannot overwrite the cancellation message', async () => {
  const reply = deferred(), f = fixture({ reply }); const pending = f.buttons.get('Ask local model')();
  await f.buttons.get('Stop local answer')(); reply.reject(new Error('late cancelled request'));
  await assert.doesNotReject(pending); assert.equal(f.messages.at(-1), 'Local request cancelled.');
});
test('muting or normal assistant activity cancels pending local synthesis before it can play', async () => {
  for (const reason of ['mute', 'assistant']) {
    const speech = deferred(), f = fixture({ speech }); await f.buttons.get('Ask local model')();
    const pending = f.buttons.get('Speak local answer')();
    if (reason === 'mute') f.context.isTtsMuted = true; else f.context.currentState = 'speaking';
    f.intervals.forEach(callback => callback()); speech.resolve({ ok: true, audioBase64: 'AAAA', mimeType: 'audio/wav' }); await pending;
    assert.equal(f.audio.length, 0); assert.equal(f.cancelled.length, 1);
  }
});
test('late audio events and play completion from a stopped answer cannot stop a replacement', async () => {
  const f = fixture({ deferPlay: true }); await f.buttons.get('Ask local model')();
  const first = f.buttons.get('Speak local answer')(); await flush();
  const old = f.audio[0], oldError = old.onerror; f.buttons.get('Stop local speech')(); assert.equal(old.onerror, null);
  const second = f.buttons.get('Speak local answer')(); await flush();
  oldError(); assert.equal(f.audio[1].paused, false);
  old.playing.resolve(); await first; assert.notEqual(f.messages.at(-1), 'Playing the local answer.');
  f.audio[1].playing.resolve(); await second; assert.equal(f.messages.at(-1), 'Playing the local answer.');
  f.keydowns.forEach(callback => callback({ key: 'Escape' })); assert.equal(f.audio[1].paused, true);
});
test('cancelled Live setup never publishes a late active message and starting Live stops local audio', async () => {
  const live = deferred(), f = fixture({ live }); await f.buttons.get('Ask local model')(); await f.buttons.get('Speak local answer')();
  const pending = f.buttons.get('Start live conversation (preview)')(); assert.equal(f.audio[0].paused, true);
  await f.buttons.get('Stop live conversation')(); live.resolve(undefined); await pending;
  assert.equal(f.messages.at(-1), 'Live conversation stopped.');
});

test('local speech guards wake input before play resolves and releases it on every playback exit', async () => {
  for (const ending of ['stop', 'ended', 'error', 'rejected']) {
    const f = fixture({ deferPlay: true }), speech = f.context.window.OlangaLocalSpeech;
    assert.equal(speech.isActive(), false); await f.buttons.get('Ask local model')();
    const pending = f.buttons.get('Speak local answer')(); await flush();
    assert.equal(speech.isActive(), true, ending); assert.equal(f.resets(), 1);
    if (ending === 'stop') speech.stop();
    else if (ending === 'ended') f.audio[0].onended();
    else if (ending === 'error') f.audio[0].onerror();
    else f.audio[0].playing.reject(new Error('Autoplay refused'));
    if (ending === 'rejected') await assert.rejects(pending, /Autoplay/);
    else { f.audio[0].playing.resolve(); await pending; }
    assert.equal(speech.isActive(), false, ending); assert.equal(f.resets(), 2);
    assert.equal(f.context.currentState, 'idle'); assert.equal(f.context.isTtsMuted, false);
  }
});
