const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const endpoint = require('../../shared/voice-endpoint');

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name, detail) { for (const callback of [...(this.listeners.get(name) || [])]) callback({ type: name, detail }); }
}

function fixture({ muted = false, legacy = false, workletSetup } = {}) {
  const calls = { models: [], recognizers: [], contexts: [], requests: 0, terminated: 0, removed: 0, errors: [], analyses: [], waveWrites: 0, accepted: 0 };
  const timers = new Map(), frames = new Map(); let sequence = 0, visible = true, visibilityListener, screenHidden = false, screenListener;
  const node = () => ({ connect() {}, disconnect() {} });
  class Context {
    constructor() { this.sampleRate = 16000; this.state = 'running'; if (workletSetup) this.audioWorklet = { addModule: () => workletSetup }; calls.contexts.push(this); }
    createAnalyser() { return { ...node(), getByteTimeDomainData: samples => { calls.analyses.push(samples); samples.fill(128); } }; }
    createScriptProcessor() { return node(); }
    createMediaStreamSource() { return node(); }
    createGain() { return { ...node(), gain: {} }; }
    close() { this.state = 'closed'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    resume() { this.state = 'running'; return Promise.resolve(); }
  }
  class Recognizer {
    constructor() { this.handlers = {}; calls.recognizers.push(this); }
    setWords() {} on(name, handler) { this.handlers[name] = handler; }
    remove() { calls.removed++; }
    acceptWaveformFloat() { calls.accepted++; }
  }
  class Model extends Events {
    constructor() {
      super(); this.ready = false; this.KaldiRecognizer = Recognizer;
      this.worker = Object.assign(new Events(), { terminate: () => { calls.terminated++; } });
      calls.models.push(this);
    }
    load() { this.ready = true; this.emit('load', { result: true }); }
  }
  const track = { enabled: true, stop() {}, addEventListener(name, callback) { this[name] = callback; }, removeEventListener(name) { delete this[name]; } };
  const stream = { active: true, getTracks: () => [track] };
  const context = vm.createContext({
    window: { Vosk: { Model }, OlangaVisibility: { isVisible: () => visible, subscribe: listener => { visibilityListener = listener; listener(); return () => {}; } } },
    console: { log() {}, error() {} }, Float32Array, Uint8Array, AudioContext: Context,
    AudioWorkletNode: class { constructor() { Object.assign(this, node()); this.port = { postMessage() {} }; } },
    navigator: { mediaDevices: { getUserMedia: async () => { calls.requests++; return stream; }, addEventListener() {} } },
    mainScreen: { classList: { contains: () => screenHidden } },
    MutationObserver: class { constructor(callback) { screenListener = callback; } observe() {} },
    setTimeout: (callback, ms) => { timers.set(++sequence, { callback, ms }); return sequence; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: callback => { frames.set(++sequence, callback); return sequence; }, cancelAnimationFrame: id => frames.delete(id),
    isMicMuted: muted, isVoskReady: false, voskModel: null, voskRecognizer: null, micStream: null, audioContext: null, analyser: null, scriptNode: null,
    isRecording: false, isWakeWordCapturing: false, pcmChunks: [], currentRMS: 0, hasSpokenDuringRecording: false, followUpTimer: null, SILENCE_DURATION: 1500, SPEECH_THRESHOLD: 6,
    currentState: 'idle', State: { IDLE: 'idle', LISTENING: 'listening', THINKING: 'thinking', SPEAKING: 'speaking' },
    waveBarEls: [{ style: { value: '', get height() { return this.value; }, set height(value) { this.value = value; calls.waveWrites++; } } }],
    setState: value => { context.currentState = value; context.refreshMicrophoneMonitor?.(); }, showError: message => calls.errors.push(message),
    ...(legacy ? {} : { OlangaVoiceEndpoint: endpoint })
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/voice.js'), 'utf8'), context);
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { context, calls, timers, frames, track, settle,
    async start() { const pending = context.initVosk({ microphone: true }); calls.models.at(-1)?.load(); await pending; await context.initMicrophone(); },
    mute(value) { context.isMicMuted = value; track.enabled = !value; context.refreshMicrophoneActivity(); },
    expireIdle() { for (const [id, timer] of [...timers]) if (timer.ms === 5000) { timers.delete(id); timer.callback(); } },
    visible(value) { visible = value; visibilityListener?.(); },
    screen(value) { screenHidden = !value; screenListener?.(); },
    frame() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); }
  };
}

test('muted startup loads no model or microphone and unmute initializes one reusable graph', async () => {
  const f = fixture({ muted: true }); await f.start();
  assert.equal(f.calls.models.length, 0); assert.equal(f.calls.requests, 0); assert.equal(f.frames.size, 0);
  f.mute(false); f.mute(false);
  assert.equal(f.calls.models.length, 1); f.calls.models[0].load(); await f.settle();
  assert.equal(f.calls.requests, 1); assert.equal(f.calls.contexts.length, 1);
  assert.equal(f.context.isMicMuted, false); assert.equal(f.context.audioContext.state, 'running');
  assert.equal(f.frames.size, 0); assert.deepEqual(f.calls.errors, []);
});

test('mute suspends capture immediately, unloads the unused model, and unmute reloads without another permission request', async () => {
  const f = fixture(); await f.start(); const graph = f.context.audioContext;
  f.mute(true);
  assert.equal(graph.state, 'suspended'); assert.equal(f.context.voskRecognizer, null); assert.equal(f.frames.size, 0);
  f.expireIdle(); assert.equal(f.calls.terminated, 1); assert.equal(f.context.voskModel, null); assert.equal(f.context.isVoskReady, false);
  f.mute(false); assert.equal(f.calls.models.length, 2); f.calls.models[1].load(); await f.settle();
  assert.equal(f.context.audioContext, graph); assert.equal(graph.state, 'running'); assert.equal(f.calls.requests, 1);
  assert.equal(f.context.isVoskReady, true); assert.equal(f.frames.size, 0); assert.deepEqual(f.calls.errors, []);
});

test('push-to-talk preserves the first words while the wake model reloads after a sustained mute', async () => {
  const f = fixture(); await f.start(); f.mute(true); f.expireIdle();
  f.mute(false); await f.settle();
  assert.equal(f.context.audioContext.state, 'running'); assert.equal(f.context.isVoskReady, false);
  f.context.currentState = 'listening'; assert.equal(f.context.startRecording(), true);
  const samples = new Float32Array(1024).fill(.1);
  f.context.scriptNode.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
  assert.equal(f.context.pcmChunks.length, 1); assert.deepEqual(f.context.pcmChunks[0], samples);
  f.calls.models[1].load(); await f.settle();
  assert.equal(f.context.currentState, 'listening'); assert.equal(f.context.isRecording, true); assert.equal(f.context.pcmChunks.length, 1);
  assert.equal(f.context.isVoskReady, true); assert.notEqual(f.context.voskRecognizer, null); assert.deepEqual(f.calls.errors, []);
});

test('short mute toggles retain the warm model and offline users prevent worker termination until released', async () => {
  const f = fixture(); await f.start();
  f.mute(true); f.mute(false); await f.settle(); f.expireIdle();
  assert.equal(f.calls.models.length, 1); assert.equal(f.calls.terminated, 0);
  const release = f.context.retainVoskModel(); f.mute(true); f.expireIdle();
  assert.equal(f.calls.terminated, 0);
  release(); release(); f.expireIdle();
  assert.equal(f.calls.terminated, 1); assert.equal(vm.runInContext('voskModelUsers', f.context), 0);
});

test('muting during model reload never opens or resumes the microphone and the unused result can be released', async () => {
  const f = fixture({ muted: true }); await f.start(); f.mute(false); f.mute(true);
  f.calls.models[0].load(); await f.settle();
  assert.equal(f.calls.requests, 0); assert.equal(f.context.isMicMuted, true);
  f.expireIdle(); assert.equal(f.calls.terminated, 1); assert.deepEqual(f.calls.errors, []);
});

test('mute wins a pending AudioContext resume and stale recognizer callbacks remain inert', async () => {
  const f = fixture(); await f.start(); const old = f.calls.recognizers[0]; let complete, heard = 0;
  f.context.handleVoskResult = () => { heard++; };
  f.mute(true);
  f.context.audioContext.resume = () => new Promise(resolve => { complete = () => { f.context.audioContext.state = 'running'; resolve(); }; });
  f.mute(false); await f.settle(); assert.equal(typeof complete, 'function'); f.mute(true); complete(); await f.settle();
  old.handlers.result({ result: { text: 'old command' } });
  assert.equal(heard, 0); assert.equal(f.context.audioContext.state, 'suspended'); assert.equal(f.context.isMicMuted, true);
});

test('unmute waits for an in-flight suspension before resuming so a late suspend cannot strand capture', async () => {
  const f = fixture(); await f.start(); let complete;
  f.context.audioContext.suspend = () => new Promise(resolve => { complete = () => { f.context.audioContext.state = 'suspended'; resolve(); }; });
  f.mute(true); f.mute(false); await f.settle();
  assert.equal(typeof complete, 'function'); complete(); await f.settle();
  assert.equal(f.context.audioContext.state, 'running'); assert.equal(f.context.isMicMuted, false); assert.deepEqual(f.calls.errors, []);
});

test('a microphone disconnected during pending resume cannot be reused or overwrite the disconnect error', async () => {
  const f = fixture(); await f.start(); const graph = f.context.audioContext; let complete;
  f.mute(true); graph.resume = () => new Promise(resolve => { complete = resolve; });
  f.mute(false); await f.settle(); f.track.ended(); complete(); await f.settle();
  assert.equal(f.context.micStream, null); assert.equal(graph.state, 'closed'); assert.equal(f.frames.size, 0);
  assert.equal(f.calls.errors.length, 1); assert.match(f.calls.errors[0], /disconnected/);
});

test('mute during delayed worklet setup is applied to the published track and suspended graph', async () => {
  let complete;
  const f = fixture({ workletSetup: new Promise(resolve => { complete = resolve; }) });
  const pending = f.start(); await f.settle(); assert.equal(f.context.micStream, null);
  f.context.isMicMuted = true; f.context.refreshMicrophoneActivity();
  complete(); await pending;
  assert.equal(f.track.enabled, false); assert.equal(f.context.audioContext.state, 'suspended'); assert.equal(f.context.voskRecognizer, null);
  assert.equal(f.frames.size, 0); assert.deepEqual(f.calls.errors, []);
});

test('a cancelled offline lease releases a late model even when microphone voice was never requested', async () => {
  const f = fixture(); const release = f.context.retainVoskModel(), pending = f.context.initVosk();
  release(); f.calls.models[0].load(); await pending; f.expireIdle();
  assert.equal(f.calls.terminated, 1); assert.equal(f.context.voskModel, null); assert.equal(f.calls.requests, 0);
});

test('a replacement offline lease protects a late model after an earlier consumer cancelled', async () => {
  const f = fixture(); const release = f.context.retainVoskModel(), pending = f.context.initVosk();
  release(); const replacement = f.context.retainVoskModel();
  f.calls.models[0].load(); await pending; f.expireIdle(); assert.equal(f.calls.terminated, 0);
  replacement(); f.expireIdle(); assert.equal(f.calls.terminated, 1);
});

test('hidden microphone waveform stops frames without stopping capture, and visible waveform reuses capture RMS', async () => {
  const f = fixture(); await f.start(); const graph = f.context.audioContext;
  assert.equal(f.context.analyser, null); f.visible(false); f.context.setState('listening'); const writes = f.calls.waveWrites;
  f.frame(); assert.equal(f.frames.size, 0); assert.equal(f.calls.waveWrites, writes); assert.equal(graph.state, 'running');
  f.context.scriptNode.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(1024).fill(.1) } });
  assert.ok(f.context.currentRMS > 9); assert.equal(f.calls.waveWrites, writes);
  f.visible(true); assert.equal(f.frames.size, 1); assert.ok(f.calls.waveWrites > writes); assert.equal(f.calls.analyses.length, 0);
});

test('idle, thinking, speaking and other screens do no microphone visual work while capture remains available', async () => {
  const f = fixture(); await f.start();
  f.context.bargeInEnabled = true;
  const feed = () => f.context.scriptNode.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(1024).fill(.1) } });
  assert.equal(f.frames.size, 0); assert.equal(f.calls.waveWrites, 0);
  feed(); assert.equal(f.calls.accepted, 1);
  for (const state of ['thinking', 'speaking', 'idle']) {
    f.context.setState(state); f.frame(); feed();
    assert.equal(f.frames.size, 0); assert.equal(f.calls.waveWrites, 0);
  }
  assert.equal(f.calls.accepted, 4, 'Wake and interruption samples do not depend on waveform rendering');
  f.context.setState('listening'); assert.equal(f.frames.size, 1);
  f.screen(false); const writes = f.calls.waveWrites; f.frame(); feed();
  assert.equal(f.frames.size, 0); assert.equal(f.calls.waveWrites, writes);
  f.screen(true); assert.equal(f.frames.size, 1);
  f.context.setState('thinking'); assert.equal(f.frames.size, 0);
  assert.equal(f.context.audioContext.state, 'running');
});

test('silent waveform frames do not repeat identical DOM writes and retain immediate level updates', async () => {
  const f = fixture(); await f.start(); f.context.setState('listening');
  const first = f.calls.waveWrites;
  for (let index = 0; index < 120; index++) f.frame();
  assert.equal(first, 1); assert.equal(f.calls.waveWrites, first);
  f.context.Date = { now: () => 0 };
  f.context.updateWaveBars(100);
  assert.ok(f.calls.waveWrites > first);
  f.context.updateWaveBars(0);
  assert.equal(f.context.waveBarEls[0].style.height, '4px');
});

test('legacy endpoint analyser reuses its sample buffer and retains endpoint frames when hidden', async () => {
  const f = fixture({ legacy: true }); await f.start(); f.frame(); f.frame();
  assert.ok(f.calls.analyses.length >= 3); assert.ok(f.calls.analyses.every(samples => samples === f.calls.analyses[0]));
  f.visible(false); f.frame(); assert.equal(f.frames.size, 1); assert.equal(f.context.audioContext.state, 'running');
});

test('legacy no-speech timeout keeps exactly one monitor after its state transition', async () => {
  const f = fixture({ legacy: true }); await f.start();
  let now = 1000; f.context.Date = { now: () => now };
  f.context.setState('listening'); f.context.startRecording(); f.visible(false);
  now = 6000; f.frame();
  assert.equal(f.context.isRecording, false); assert.equal(f.context.currentState, 'idle');
  assert.equal(f.frames.size, 1);
});

function libraryFixture() {
  const scripts = [], models = [], timers = new Map(); let sequence = 0;
  class Model extends Events {
    constructor() { super(); this.worker = new Events(); models.push(this); }
    load() { this.ready = true; this.emit('load', { result: true }); }
  }
  const context = vm.createContext({ window: {}, voskModel: null, isVoskReady: false, isMicMuted: false,
    document: { createElement: name => ({ tagName: name, remove() { this.removed = true; } }), head: { appendChild: script => scripts.push(script) } },
    console: { log() {} }, setTimeout: (callback, ms) => { timers.set(++sequence, { callback, ms }); return sequence; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/voice.js'), 'utf8'), context);
  return { context, scripts, models, timers, Model, async settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); } };
}

test('parallel voice consumers load one fixed local library and one shared model, while existing library stubs bypass DOM loading', async () => {
  const f = libraryFixture();
  const first = f.context.initVosk(), second = f.context.initVosk();
  assert.equal(f.scripts.length, 1); assert.equal(f.scripts[0].tagName, 'script');
  assert.equal(f.scripts[0].src, './node_modules/vosk-browser/dist/vosk.js');
  f.context.window.Vosk = { Model: f.Model }; f.scripts[0].onload(); await f.settle();
  assert.equal(f.models.length, 1); f.models[0].load();
  assert.equal(await first, f.models[0]); assert.equal(await second, f.models[0]);
  assert.equal(await f.context.initVosk(), f.models[0]); assert.equal(f.scripts.length, 1); assert.equal(f.timers.size, 0);
});

test('library failures and timeout remove the failed script, settle all waiters and allow a clean retry', async () => {
  for (const failure of ['error', 'missing-export', 'timeout']) {
    const f = libraryFixture(), first = f.context.initVosk(), second = f.context.initVosk();
    const rejected = Promise.all([assert.rejects(first, /offline speech library/), assert.rejects(second, /offline speech library/)]);
    if (failure === 'error') f.scripts[0].onerror();
    else if (failure === 'missing-export') f.scripts[0].onload();
    else [...f.timers.values()].find(timer => timer.ms === 15000).callback();
    await rejected; assert.equal(f.scripts[0].removed, true); assert.equal(f.timers.size, 0); assert.equal(f.models.length, 0);
    const retry = f.context.initVosk(); assert.equal(f.scripts.length, 2);
    f.context.window.Vosk = { Model: f.Model }; f.scripts[1].onload(); await f.settle(); f.models[0].load();
    assert.equal(await retry, f.models[0]); assert.equal(f.timers.size, 0);
  }
});

test('mute during lazy script loading prevents a late library completion from allocating a microphone model', async () => {
  const f = libraryFixture(); const pending = f.context.initVosk({ microphone: true });
  f.context.isMicMuted = true; f.context.window.Vosk = { Model: f.Model }; f.scripts[0].onload();
  assert.equal(await pending, null); assert.equal(f.models.length, 0); assert.equal(f.timers.size, 0);
});

test('an offline cancellation during lazy library loading also releases its subsequently loaded model', async () => {
  const f = libraryFixture(); let terminated = 0;
  const release = f.context.retainVoskModel(), pending = f.context.initVosk(); release();
  f.context.window.Vosk = { Model: f.Model }; f.scripts[0].onload(); await f.settle();
  f.models[0].worker.terminate = () => { terminated++; }; f.models[0].load(); await pending;
  [...f.timers.values()].find(timer => timer.ms === 5000).callback();
  assert.equal(terminated, 1); assert.equal(f.context.voskModel, null);
});
