const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function fixture(options = {}) {
  const calls = { starts: 0, stops: [], audio: [], closed: 0, playback: 0, interrupted: 0 }, listeners = new Map(), intervals = new Map();
  let receive;
  class AudioContext {
    constructor() { this.currentTime = 0; } resume() { return options.resumePromise || Promise.resolve(); } close() { calls.closed++; return Promise.resolve(); }
    createBuffer(_channels, length, rate) { return { duration: length / rate, copyToChannel() {} }; }
    createBufferSource() { return { connect() {}, disconnect() {}, start() { calls.playback++; }, stop() { calls.interrupted++; } }; }
  }
  const context = vm.createContext({ window: { addEventListener() {}, electronAPI: {
    conversationLiveStart: async () => { calls.starts++; return options.startPromise || { ok: true, sessionId: 'fixture' }; },
    conversationLiveStop: async value => calls.stops.push(value),
    conversationLiveAudio: async value => { calls.audio.push(value); },
    onConversationLiveEvent: fn => { receive = fn; return () => { receive = null; }; }
  } }, document: { addEventListener: (name, fn) => listeners.set(name, fn) }, AudioContext,
    setInterval: fn => { const key = {}; intervals.set(key, fn); return key; }, clearInterval: key => intervals.delete(key),
    Float32Array, Uint8Array, DataView, btoa: value => Buffer.from(value, 'binary').toString('base64'), atob: value => Buffer.from(value, 'base64').toString('binary'),
    isMicMuted: false, isTtsMuted: false, micStream: { active: true }, currentState: 'idle', State: { IDLE: 'idle', LISTENING: 'listening', SPEAKING: 'speaking' },
    setState: state => { context.currentState = state; }, resetMicrophoneRecognition() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/live-conversation.js'), 'utf8'), context);
  return { context, api: context.window.OlangaLiveConversation, calls, listeners, intervals, event: value => receive?.({ sessionId: 'fixture', ...value }) };
}
test('Live sends no audio before explicit start and stops on Escape without dispatching desktop actions', async () => {
  const f = fixture(); f.api.acceptSamples(new Float32Array(20), 16000); assert.equal(f.calls.starts, 0); assert.equal(f.calls.audio.length, 0);
  await f.api.start({ model: 'gemini-3.8-live' }); f.api.acceptSamples(new Float32Array([.5, -.5]), 16000); await Promise.resolve();
  assert.equal(f.calls.audio.length, 1); assert.equal(f.calls.audio[0].audioBase64, '/z8AwA==');
  f.event({ type: 'audio', sampleRate: 24000, audioBase64: 'AAA=' }); assert.equal(f.calls.playback, 1);
  f.listeners.get('keydown')({ key: 'Escape' }); assert.equal(f.api.isActive(), false); assert.equal(f.calls.interrupted, 1);
  assert.equal(f.calls.stops.length, 1); f.api.acceptSamples(new Float32Array(20), 16000); assert.equal(f.calls.audio.length, 1);
});
test('Live cancellation during setup cannot reactivate recording and late events cannot play', async () => {
  let ready; const f = fixture({ startPromise: new Promise(resolve => { ready = resolve; }) });
  const pending = f.api.start({ model: 'gemini-3.8-live' }); await Promise.resolve();
  f.api.stop(); ready({ ok: true, sessionId: 'fixture' }); await pending;
  assert.equal(f.api.isActive(), false); assert.equal(f.context.currentState, 'idle');
  f.event({ type: 'audio', sampleRate: 24000, audioBase64: 'AAA=' }); assert.equal(f.calls.playback, 0);
});
test('Live preserves mute settings and clears queued speech when output is muted', async () => {
  const f = fixture(); f.context.isMicMuted = true; await assert.rejects(f.api.start({ model: 'gemini-3.8-live' }), /Unmute/); assert.equal(f.calls.starts, 0);
  f.context.isMicMuted = false; await f.api.start({ model: 'gemini-3.8-live' });
  f.event({ type: 'audio', sampleRate: 24000, audioBase64: 'AAA=' });
  f.context.isTtsMuted = true; for (const fn of f.intervals.values()) fn(); assert.equal(f.calls.interrupted, 1);
  f.event({ type: 'audio', sampleRate: 24000, audioBase64: 'AAA=' }); assert.equal(f.calls.playback, 1);
  f.context.isMicMuted = true; for (const fn of f.intervals.values()) fn(); assert.equal(f.api.isActive(), false);
  assert.equal(f.context.isMicMuted, true); assert.equal(f.context.isTtsMuted, true);
});
test('stopping an inactive preview never interrupts a normal assistant turn', async () => {
  const f = fixture(); f.context.currentState = 'speaking'; await f.api.stop();
  assert.equal(f.context.currentState, 'speaking'); assert.equal(f.calls.stops.length, 0);
});

test('cancellation while audio playback initializes cannot open a late Live connection', async () => {
  let resume; const f = fixture({ resumePromise: new Promise(resolve => { resume = resolve; }) });
  const pending = f.api.start({ model: 'gemini-3.8-live' }); await Promise.resolve();
  await f.api.stop(); resume(); await pending;
  assert.equal(f.calls.starts, 0); assert.equal(f.api.isActive(), false); assert.equal(f.context.currentState, 'idle');
});
