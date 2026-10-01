const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function wav(seconds = 1, sampleRate = 16000) {
  const bytes = new ArrayBuffer(44 + Math.ceil(seconds * sampleRate) * 2);
  const view = new DataView(bytes);
  const tag = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  tag(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, bytes.byteLength - 44, true);
  return { size: bytes.byteLength, arrayBuffer: async () => bytes };
}

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name, detail) { for (const callback of [...(this.listeners.get(name) || [])]) callback({ type: name, detail }); }
  get listenerCount() { return [...this.listeners.values()].reduce((total, callbacks) => total + callbacks.size, 0); }
}

function fixture(options = {}) {
  const calls = { decoders: 0, closed: 0, modelLoads: 0, recognizers: [], chunks: [], final: 0, removed: 0 };
  const length = options.length || 8193;
  const decoded = options.decoded || { length, duration: length / 16000, sampleRate: 16000, numberOfChannels: 1, getChannelData: () => new Float32Array(length).fill(0.25) };
  const timers = new Map();
  let nextTimer = 0;
  class Recognizer extends Events {
    constructor(sampleRate, grammar) { super(); this.sampleRate = sampleRate; this.grammar = grammar; calls.recognizers.push(this); options.onRecognizer?.(this); }
    acceptWaveformFloat(samples, rate) {
      calls.chunks.push({ samples: Array.from(samples), rate });
      if (options.holdRecognition) return;
      const message = options.messages?.shift() || { event: 'partialresult', result: { partial: 'ignore partial' } };
      queueMicrotask(() => this.emit(message.event, message));
    }
    retrieveFinalResult() { calls.final++; queueMicrotask(() => this.emit('result', { event: 'result', result: { text: options.final ?? 'raise the volume to seventy five percent' } })); }
    remove() { calls.removed++; }
  }
  const model = Object.assign(new Events(), { ready: true, KaldiRecognizer: Recognizer, worker: new Events() });
  const context = {
    AbortController, DOMException, Float32Array, ArrayBuffer, DataView, Uint8Array, console,
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: id => timers.delete(id),
    voskModel: model, voskModelLoadPromise: null,
    initVosk: async () => { calls.modelLoads++; return model; },
    window: { AudioContext: class {
      constructor(config) { assert.equal(config.sampleRate, 16000); calls.decoders++; }
      decodeAudioData() { return options.decodePromise || Promise.resolve(decoded); }
      close() { calls.closed++; return options.close?.(calls.closed) || Promise.resolve(); }
    } }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/offline-speech.js'), 'utf8'), context);
  return { api: context.window.OlangaOfflineSpeech, context, calls, timers, model };
}

test('offline transcription joins finalized segments and flushes the tail without duplicated partials', async () => {
  const { api, calls, timers } = fixture({ messages: [{ event: 'result', result: { text: 'open spotify and' } }] });
  const text = await api.transcribe(wav());
  assert.equal(text, 'open spotify and raise the volume to seventy five percent');
  assert.deepEqual(calls.chunks.map(chunk => chunk.samples.length), [4096, 4096, 1]);
  assert.ok(calls.chunks.every(chunk => chunk.rate === 16000 && chunk.samples.every(sample => sample === 0.25)));
  assert.equal(calls.final, 1);
  assert.equal(calls.removed, 1);
  assert.equal(calls.closed, 1);
  assert.equal(calls.recognizers[0].listenerCount, 0);
  assert.equal(timers.size, 0);
  assert.equal(api.getStatus().busy, false);
  assert.equal(api.getStatus().recognizers, 0);
  const commands = require('../../shared/fast-intents').parse(text);
  assert.deepEqual(commands.map(action => action.command), ['[OPEN_APP: spotify]', '[VOLUME_SET: 75]']);
});

test('stereo channels are averaged before recognition and silence stays empty', async () => {
  const decoded = { length: 4, duration: 4 / 16000, sampleRate: 16000, numberOfChannels: 2,
    getChannelData: channel => new Float32Array(4).fill(channel ? -0.2 : 0.8) };
  const { api, calls } = fixture({ decoded, final: '' });
  assert.equal(await api.transcribe(wav()), '');
  assert.ok(calls.chunks[0].samples.every(sample => Math.abs(sample - 0.3) < 0.00001));
});

test('command grammar is explicit, covers the complete percentage range, and retains unknown words', async () => {
  const { api, calls } = fixture({ final: 'open [unk]' });
  assert.equal(await api.transcribe(wav()), 'open [unk]');
  assert.equal(calls.recognizers[0].grammar, undefined, 'General transcription remains the default');
  assert.equal(await api.transcribe(wav(), { mode: 'commands' }), 'open [unk]', 'Unknown tokens must not be silently repaired');
  const grammar = JSON.parse(calls.recognizers[1].grammar);
  assert.ok(grammar.includes('[unk]'));
  for (const phrase of ['open spotify', 'launch notepad', 'next track', 'pause the music', 'resume playback', 'and then',
    'set the volume to zero percent', 'raise the volume to seventy five percent', 'set the volume to one hundred percent',
    'set a timer for seven minutes', 'start a ninety seconds timer']) assert.ok(grammar.includes(phrase), phrase);
  assert.equal(grammar.filter(phrase => /^set the volume to .+ percent$/.test(phrase)).length, 101);
  assert.ok(calls.recognizers[1].grammar.length < 120000);
  assert.equal(api.getStatus().lastRun.mode, 'commands');
  await assert.rejects(api.transcribe(wav(), { mode: 'automatic' }), /Unknown offline/);
});

test('invalid, oversized, or overlong recordings are rejected before audio decode or model work', async () => {
  const { api, calls } = fixture();
  for (const input of [null, { size: 0, arrayBuffer() {} }, { size: 9 * 1024 * 1024, arrayBuffer() { throw new Error('Should not read'); } },
    { size: 44, arrayBuffer: async () => new ArrayBuffer(44) }, wav(61)]) {
    await assert.rejects(api.transcribe(input), /recording|WAV|60 seconds/);
  }
  assert.equal(calls.decoders, 0);
  assert.equal(calls.modelLoads, 0);
  assert.equal(calls.recognizers.length, 0);
});

test('cancellation while decoding settles promptly and never allocates a recognizer when decode returns late', async () => {
  let finishDecode;
  const { api, calls } = fixture({ decodePromise: new Promise(resolve => { finishDecode = resolve; }) });
  const controller = new AbortController();
  const pending = api.transcribe(wav(), { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejected;
  finishDecode({});
  await Promise.resolve();
  assert.equal(calls.closed, 1);
  assert.equal(calls.recognizers.length, 0);
  assert.equal(api.getStatus().busy, false);
});

test('decode failures release their context and do not load a model', async () => {
  const failure = Promise.reject(new Error('Unsupported audio encoding'));
  failure.catch(() => {});
  const { api, calls } = fixture({ decodePromise: failure });
  await assert.rejects(api.transcribe(wav()), /Unsupported audio encoding/);
  assert.equal(calls.closed, 1);
  assert.equal(calls.modelLoads, 0);
  assert.match(api.getStatus().lastError, /Unsupported audio encoding/);
  assert.equal(api.getStatus().busy, false);
});

test('a failed decoder close is retried during cleanup and cannot continue with a leaked audio context', async () => {
  const { api, calls } = fixture({ close: attempt => attempt === 1 ? Promise.reject(new Error('Decoder close failed')) : Promise.resolve() });
  await assert.rejects(api.transcribe(wav()), /Decoder close failed/);
  assert.equal(calls.closed, 2); assert.equal(calls.modelLoads, 0); assert.equal(calls.recognizers.length, 0);
  assert.equal(api.getStatus().busy, false); assert.equal(api.getStatus().decoding, false);
});

test('conflicting WAV headers cannot bypass pre-decode duration and format validation', async () => {
  for (const malformed of ['size', 'byteRate', 'duplicateFormat']) {
    let bytes = await wav().arrayBuffer();
    if (malformed === 'size') new DataView(bytes).setUint32(4, 12, true);
    if (malformed === 'byteRate') new DataView(bytes).setUint32(28, 1, true);
    if (malformed === 'duplicateFormat') {
      const extended = new Uint8Array(bytes.byteLength + 24);
      extended.set(new Uint8Array(bytes)); extended.set(new Uint8Array(bytes, 12, 24), bytes.byteLength);
      bytes = extended.buffer;
      new DataView(bytes).setUint32(4, bytes.byteLength - 8, true);
    }
    const { api, calls } = fixture();
    await assert.rejects(api.transcribe({ size: bytes.byteLength, arrayBuffer: async () => bytes }), /WAV|PCM/);
    assert.equal(calls.decoders, 0); assert.equal(calls.modelLoads, 0);
  }
});

test('cancellation releases an active recognizer and a late worker result cannot complete the request', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { api, calls } = fixture({ holdRecognition: true, onRecognizer: started });
  const pending = api.transcribe(wav());
  const recognizer = await ready;
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  api.cancel();
  await rejected;
  recognizer.emit('result', { event: 'result', result: { text: 'stale command' } });
  assert.equal(calls.removed, 1);
  assert.equal(recognizer.listenerCount, 0);
  assert.equal(calls.final, 0);
});

test('a newer transcription supersedes the old request without the old cleanup clearing its status', async () => {
  const options = { holdRecognition: true };
  const { api, calls } = fixture(options);
  const old = api.transcribe(wav());
  const rejected = assert.rejects(old, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  options.holdRecognition = false;
  const text = await api.transcribe(wav());
  await rejected;
  assert.equal(text, 'raise the volume to seventy five percent');
  assert.equal(calls.recognizers.length, 2);
  assert.equal(calls.removed, 2);
  assert.equal(api.getStatus().busy, false);
});

test('an already-aborted stale call does not cancel the current recognition', async () => {
  const { api, calls } = fixture({ holdRecognition: true });
  const pending = api.transcribe(wav());
  const cancellation = assert.rejects(pending, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.transcribe(wav(), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.removed, 0);
  assert.equal(api.getStatus().busy, true);
  api.cancel();
  await cancellation;
});

test('worker failure and missing results both settle and release resources', async () => {
  for (const timeout of [false, true]) {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const { api, calls, timers } = fixture({ holdRecognition: true, onRecognizer: started });
    const pending = api.transcribe(wav());
    const rejected = assert.rejects(pending, timeout ? /too long/ : /native recognition failed/);
    const recognizer = await ready;
    if (timeout) [...timers.values()][0]();
    else recognizer.emit('error', { error: 'native recognition failed' });
    await rejected;
    assert.equal(calls.removed, 1);
    assert.equal(calls.closed, 1);
    assert.equal(timers.size, 0);
    assert.equal(api.getStatus().busy, false);
  }
});

test('fatal worker and model errors settle active transcription without waiting for its deadline', async () => {
  for (const source of ['worker-error', 'worker-messageerror', 'model-error']) {
    const { api, model, calls, timers } = fixture({ holdRecognition: true });
    const pending = api.transcribe(wav());
    const rejected = assert.rejects(pending, /offline speech worker stopped|model crashed/);
    await new Promise(resolve => setImmediate(resolve));
    if (source === 'model-error') model.emit('error', { error: 'model crashed' });
    else model.worker.emit(source.slice(7), {});
    await rejected;
    assert.equal(calls.removed, 1); assert.equal(model.listenerCount, 0); assert.equal(model.worker.listenerCount, 0);
    assert.equal(timers.size, 0); assert.equal(api.getStatus().busy, false);
  }
});

test('shared model loading is keyless, deduplicated, and failure leaves a retryable loader', async () => {
  const models = [];
  const timers = new Map();
  let nextTimer = 0;
  class Model extends Events {
    constructor(url) { super(); this.url = url; this.worker = Object.assign(new Events(), { terminate: () => { this.terminated = true; } }); models.push(this); }
  }
  const context = { window: { Vosk: { Model } }, voskModel: null, isVoskReady: false,
    console: { log() {} }, setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id) };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/voice.js'), 'utf8'), context);
  const first = context.initVosk(), second = context.initVosk();
  assert.equal(models.length, 1);
  assert.equal(models[0].url, 'olanga-asset://local/vosk-model-v2.tar.gz');
  const failures = Promise.all([assert.rejects(first, /missing model/), assert.rejects(second, /missing model/)]);
  models[0].emit('error', { error: 'missing model' });
  await failures;
  assert.equal(models[0].terminated, true);
  assert.equal(models[0].listenerCount, 0);
  const retry = context.initVosk();
  models[1].ready = true;
  models[1].emit('load', { result: true });
  assert.equal(await retry, models[1]);
  assert.equal(await context.initVosk(), models[1]);
  assert.equal(context.isVoskReady, true);
  assert.equal(models.length, 2);
  assert.equal(timers.size, 0);
  models[1].worker.emit('error', {});
  assert.equal(context.voskModel, null); assert.equal(context.isVoskReady, false);
  assert.equal(models[1].terminated, true); assert.equal(models[1].listenerCount, 0); assert.equal(models[1].worker.listenerCount, 0);
  const failedRetry = context.initVosk();
  const rejected = assert.rejects(failedRetry, /offline speech worker stopped/);
  models[2].worker.emit('messageerror', {});
  await rejected;
  assert.equal(models[2].terminated, true); assert.equal(models[2].listenerCount, 0); assert.equal(models[2].worker.listenerCount, 0);
  assert.equal(timers.size, 0);
});

function microphoneFixture(options = {}) {
  const calls = { requests: 0, contexts: 0, stopped: 0, closed: 0, recognizers: 0, removed: 0, fed: 0, monitors: 0, errors: [], instances: [], recordings: [] };
  const track = { enabled: true, listeners: new Map(), stop() { calls.stopped++; }, addEventListener(name, callback) { this.listeners.set(name, callback); }, removeEventListener(name) { this.listeners.delete(name); } };
  const stream = { active: true, getTracks: () => [track] };
  const node = () => ({ connect() {}, disconnect() {} });
  class AudioContext {
    constructor() { calls.contexts++; this.sampleRate = 16000; this.state = 'running'; }
    createAnalyser() { return node(); }
    createScriptProcessor() { return node(); }
    createMediaStreamSource() { return node(); }
    createGain() { if (options.failGraph) throw new Error('Audio graph unavailable'); return { ...node(), gain: {} }; }
    close() { calls.closed++; this.state = 'closed'; return Promise.resolve(); }
  }
  const context = {
    window: {}, console: { log() {}, error() {}, warn() {} }, navigator: { mediaDevices: { getUserMedia() { calls.requests++; return options.streamPromise || Promise.resolve(stream); } } },
    AudioContext, Float32Array, Blob, setTimeout, clearTimeout, micStream: null, audioContext: null, analyser: null, scriptNode: null, voskRecognizer: null,
    voskModel: { ready: true, KaldiRecognizer: class {
      constructor() { calls.recognizers++; this.handlers = {}; calls.instances.push(this); }
      setWords() {} on(name, callback) { this.handlers[name] = callback; } remove() { calls.removed++; }
      acceptWaveformFloat() { if (options.failFeed) throw new Error('Recognizer failed'); calls.fed++; }
    } },
    isVoskReady: true, isMicMuted: false, isWakeWordCapturing: false, isRecording: false, pcmChunks: [], currentState: 'thinking',
    State: { IDLE: 'idle', THINKING: 'thinking', SPEAKING: 'speaking', LISTENING: 'listening' }, setState: state => { context.currentState = state; },
    showError: error => calls.errors.push(error), cancelAnimationFrame() {}, processAudioBlobWithGemini: blob => calls.recordings.push(blob)
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/voice.js'), 'utf8'), context);
  context.monitorAudio = () => { calls.monitors++; };
  return { context, calls, stream, track };
}

test('a crashed shared worker releases wake recognition and an explicit retry reuses the microphone graph', async () => {
  const { context, calls } = microphoneFixture();
  const Recognizer = context.voskModel.KaldiRecognizer;
  const models = [];
  class Model extends Events {
    constructor() {
      super(); this.ready = false; this.KaldiRecognizer = Recognizer;
      this.worker = Object.assign(new Events(), { terminate: () => { this.terminated = true; } });
      models.push(this);
    }
  }
  context.window.Vosk = { Model }; context.voskModel = null; context.isVoskReady = false;
  context.setTimeout = setTimeout; context.clearTimeout = clearTimeout;
  const first = context.initVosk(); models[0].ready = true; models[0].emit('load', { result: true }); await first;
  await context.initMicrophone();
  models[0].worker.emit('error', {});
  assert.equal(context.voskModel, null); assert.equal(context.voskRecognizer, null); assert.equal(context.isVoskReady, false);
  assert.equal(calls.removed, 1); assert.equal(calls.stopped, 0); assert.match(calls.errors[0], /Select your speech input again/);
  const retry = context.initVosk(); models[1].ready = true; models[1].emit('load', { result: true }); await retry;
  await context.initMicrophone();
  assert.equal(calls.requests, 1); assert.equal(calls.contexts, 1); assert.equal(calls.recognizers, 2);
  assert.equal(calls.monitors, 1); assert.equal(context.currentState, 'thinking');
});

test('concurrent and repeated microphone initialization reuses resources without changing an active request', async () => {
  let allowMicrophone;
  const { context, calls, stream } = microphoneFixture({ streamPromise: new Promise(resolve => { allowMicrophone = resolve; }) });
  const first = context.initMicrophone(), second = context.initMicrophone();
  assert.equal(calls.requests, 1);
  allowMicrophone(stream);
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(await context.initMicrophone(), true);
  assert.equal(calls.contexts, 1);
  assert.equal(calls.recognizers, 1);
  assert.equal(calls.monitors, 1);
  assert.equal(context.currentState, 'thinking');
  const event = { inputBuffer: { getChannelData: () => new Float32Array([0.25]) } };
  context.currentState = 'idle'; context.isMicMuted = true; context.isRecording = true;
  context.scriptNode.onaudioprocess(event);
  assert.equal(calls.fed, 0);
  assert.equal(context.pcmChunks.length, 0);
  context.isMicMuted = false;
  context.scriptNode.onaudioprocess(event);
  assert.equal(calls.fed, 1);
  assert.equal(context.pcmChunks.length, 1);
});

test('microphone initialization failure releases partial resources and a retry starts exactly one working graph', async () => {
  const options = { failGraph: true };
  const { context, calls } = microphoneFixture(options);
  assert.equal(await context.initMicrophone(), false);
  assert.equal(calls.stopped, 1);
  assert.equal(calls.closed, 1);
  assert.equal(calls.removed, 1);
  assert.equal(calls.monitors, 0);
  assert.equal(context.micStream, null);
  assert.equal(context.audioContext, null);
  assert.equal(context.voskRecognizer, null);
  options.failGraph = false;
  assert.equal(await context.initMicrophone(), true);
  assert.equal(await context.initMicrophone(), true);
  assert.equal(calls.requests, 2);
  assert.equal(calls.contexts, 2);
  assert.equal(calls.recognizers, 2);
  assert.equal(calls.monitors, 1);
  assert.equal(calls.errors.length, 1);
  assert.equal(context.currentState, 'thinking');
});

test('microphone permission resolving after mute leaves its track disabled and creates no wake recognizer', async () => {
  let permit;
  const { context, calls, stream, track } = microphoneFixture({ streamPromise: new Promise(resolve => { permit = resolve; }) });
  const pending = context.initMicrophone();
  context.isMicMuted = true; permit(stream); await pending;
  assert.equal(track.enabled, false); assert.equal(calls.recognizers, 0);
  assert.equal(context.currentState, 'thinking');
});

test('replaced wake recognizer callbacks cannot inject old input after mute or recovery', async () => {
  const { context, calls } = microphoneFixture(); const heard = [];
  context.handleVoskResult = text => heard.push(text);
  await context.initMicrophone(); const first = calls.instances[0];
  context.isMicMuted = true; context.resetMicrophoneRecognition();
  context.isMicMuted = false; context.resetMicrophoneRecognition();
  first.handlers.result({ result: { text: 'stale command' } });
  first.handlers.partialresult({ result: { partial: 'stale wake word' } });
  calls.instances[1].handlers.result({ result: { text: 'fresh command' } });
  assert.deepEqual(heard, ['fresh command']); assert.equal(calls.removed, 1);
});

test('wake recognizer errors release the failed instance and allow an explicit retry', async () => {
  for (const synchronous of [false, true]) {
    const options = { failFeed: synchronous };
    const { context, calls } = microphoneFixture(options); await context.initMicrophone();
    if (synchronous) {
      context.currentState = 'idle';
      context.scriptNode.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array([.1]) } });
    } else calls.instances[0].handlers.error({ error: 'Worker recognition failed' });
    assert.equal(calls.removed, 1); assert.equal(context.voskRecognizer, null); assert.equal(calls.errors.length, 1);
    options.failFeed = false; context.resetMicrophoneRecognition();
    assert.equal(calls.recognizers, 2); assert.notEqual(context.voskRecognizer, null);
  }
});

test('microphone disconnection discards recording data, releases the graph, and cannot submit stale audio', async () => {
  const { context, calls, track } = microphoneFixture(); await context.initMicrophone();
  context.currentState = 'listening'; assert.equal(context.startRecording(), true);
  context.scriptNode.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array([.1, .2]) } });
  track.listeners.get('ended')();
  assert.equal(context.isRecording, false); assert.equal(context.pcmChunks.length, 0);
  assert.equal(context.audioContext, null); assert.equal(context.micStream, null);
  assert.equal(calls.closed, 1); assert.equal(calls.removed, 1); assert.equal(track.listeners.size, 0);
  context.stopRecording(); assert.equal(calls.recordings.length, 0); assert.equal(context.currentState, 'idle');
});

test('continuous input submits one bounded 60-second recording and releases its PCM buffer', async () => {
  const { context, calls } = microphoneFixture(); await context.initMicrophone();
  context.currentState = 'listening'; context.startRecording();
  const samples = new Float32Array(16000).fill(.1);
  for (let second = 0; second < 65; second++) context.scriptNode.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
  assert.equal(calls.recordings.length, 1); assert.equal(calls.recordings[0].size, 44 + 60 * 16000 * 2);
  assert.equal(context.isRecording, false); assert.equal(context.pcmChunks.length, 0); assert.equal(context.currentState, 'thinking');
  const wav = new DataView(await calls.recordings[0].arrayBuffer());
  assert.equal(wav.getUint32(24, true), 16000); assert.equal(wav.getUint32(40, true), 60 * 16000 * 2);
});

test('muted or disconnected recording paths never submit retained audio', async () => {
  const { context, calls, stream } = microphoneFixture(); await context.initMicrophone();
  context.currentState = 'listening'; context.isMicMuted = true;
  assert.equal(context.startRecording(), false); assert.equal(context.isRecording, false);
  context.isMicMuted = false; context.currentState = 'listening'; context.startRecording();
  context.pcmChunks = [new Float32Array([.1])]; stream.active = false;
  context.stopRecording();
  assert.equal(calls.recordings.length, 0); assert.equal(context.pcmChunks.length, 0); assert.equal(context.currentState, 'idle');
});

test('wake enrollment cancels the prior request and does not treat typed-phrase setup as wake listening', () => {
  const { context } = microphoneFixture(); let cancelled = 0, recordings = 0;
  Object.assign(context, {
    cancelAssistantRequest() { cancelled++; }, document: { getElementById: () => null, querySelector: () => null },
    lastIdleTime: 0, PRESET_WAKE_WORDS: ['hey'], userText: {}, transcriptUser: { classList: { remove() {} } }, transcriptAi: { classList: { add() {} } }
  });
  context.startRecording = () => { recordings++; return true; };
  context.openWakeWordCaptureScreen(); context.handleVoskResult('hey', true);
  assert.equal(cancelled, 1); assert.equal(recordings, 0);
  context.cancelWakeWordCapture({ returnToSettings: false }); context.handleVoskResult('hey', true);
  assert.equal(recordings, 1);
});

test('a failed custom wake-word save cannot leave an unsaved active phrase behind', () => {
  const { context, calls } = microphoneFixture();
  Object.assign(context, { customWakeWordGroups: [], normalizeWakePhrase: text => text.trim().toLowerCase(),
    addCustomWakeWordGroup(phrases) { context.customWakeWordGroups.push({ phrases }); throw new Error('Storage full'); }
  });
  vm.runInContext("wakeCaptureIntended = 'hello assistant'; wakeCaptureSamples = ['hello assistant']; isWakeWordCapturing = true;", context);
  context.finishWakeWordCapture();
  assert.equal(context.customWakeWordGroups.length, 0); assert.equal(context.isWakeWordCapturing, true);
  assert.match(calls.errors[0], /could not be saved/);
});
