const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const endpoint = require('../../shared/voice-endpoint');
function fixture({ workletFailure = false } = {}) {
  const calls = { fallback: 0, records: [], errors: [], acks: 0, flushes: [], requests: 0 }, nodes = [], listeners = new Map();
  const track = { enabled: true, stop() {}, addEventListener(name, fn) { this[name] = fn; }, removeEventListener(name) { delete this[name]; } };
  const stream = { active: true, getTracks: () => [track] };
  const node = () => ({ connect() {}, disconnect() {} });
  class Context {
    constructor() { this.sampleRate = 16000; this.state = 'running'; this.audioWorklet = { addModule: async () => { if (workletFailure) throw new Error('Unsupported'); } }; }
    createAnalyser() { return node(); } createMediaStreamSource() { return node(); } createGain() { return { ...node(), gain: {} }; }
    createScriptProcessor() { calls.fallback++; return node(); } close() { this.state = 'closed'; }
  }
  class Worklet {
    constructor() { Object.assign(this, node()); this.port = { postMessage: message => { if (message === 'ack') calls.acks++; else calls.flushes.push(message); } }; nodes.push(this); }
  }
  const context = vm.createContext({ window: {}, navigator: { mediaDevices: { getUserMedia: async () => { calls.requests++; return stream; }, addEventListener: (name, fn) => listeners.set(name, fn) } },
    AudioContext: Context, AudioWorkletNode: Worklet, Float32Array, OlangaVoiceEndpoint: endpoint, Blob, setTimeout, clearTimeout,
    console: { log() {}, error() {} }, micStream: null, audioContext: null, analyser: null, scriptNode: null, voskRecognizer: null,
    voskModel: { ready: false }, isVoskReady: false, isMicMuted: false, isRecording: false, isWakeWordCapturing: false,
    currentState: 'idle', State: { IDLE: 'idle', THINKING: 'thinking', LISTENING: 'listening', SPEAKING: 'speaking' }, followUpTimer: null,
    SILENCE_DURATION: 1500, endOfSpeechMs: 1500, pcmChunks: [], currentRMS: 0, hasSpokenDuringRecording: false,
    setState: value => { context.currentState = value; }, cancelAnimationFrame() {}, showError: value => calls.errors.push(value),
    processAudioBlobWithGemini: value => calls.records.push(value) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/voice.js'), 'utf8'), context);
  context.monitorAudio = () => {};
  return { context, calls, nodes, track, listeners };
}
test('worklet capture ends a complete recording without an animation frame and retains the trailing audio', async () => {
  const f = fixture(); await f.context.initMicrophone(); assert.equal(f.calls.fallback, 0);
  f.context.currentState = 'listening'; f.context.startRecording();
  const feed = samples => f.nodes[0].port.onmessage({ data: { samples } });
  feed(new Float32Array(3200).fill(.1)); feed(new Float32Array(24000));
  assert.equal(f.calls.records.length, 1); assert.equal(f.calls.records[0].size, 44 + 27200 * 2);
  assert.equal(f.calls.acks, 2); assert.equal(f.context.currentState, 'thinking');
});

test('chunked WAV encoding matches contiguous PCM byte for byte without a merged float allocation', async () => {
  const f = fixture();
  const input = Float32Array.from([0, 1, -1, .25, -.25, 1.2, -1.2, NaN, Infinity, -Infinity, 1 / 32768]);
  const chunks = [input.subarray(0, 3), new Float32Array(0), input.subarray(3, 7), input.subarray(7)];
  for (const rate of [8000, 16000, 44100, 48000]) {
    const contiguous = new Uint8Array(await f.context.encodeWAV(input, rate).arrayBuffer());
    const chunked = new Uint8Array(await f.context.encodeWAVChunks(chunks, rate).arrayBuffer());
    assert.deepEqual(chunked, contiguous);
    const view = new DataView(chunked.buffer);
    assert.equal(view.getUint32(24, true), rate);
    assert.equal(view.getUint32(40, true), input.length * 2);
    const expected = [0, 32767, -32768, 8191, -8192, 32767, -32768, 0, 32767, -32768, 0];
    assert.deepEqual(expected.map((_, index) => view.getInt16(44 + index * 2, true)), expected);
  }
  const empty = await f.context.encodeWAVChunks([], 16000).arrayBuffer();
  assert.equal(empty.byteLength, 44);
});

test('recording submission encodes the original owned packets without allocating a merged float recording', async () => {
  const f = fixture(); await f.context.initMicrophone();
  f.context.currentState = 'listening'; f.context.startRecording();
  f.nodes[0].port.onmessage({ data: { samples: new Float32Array(3200).fill(.1) } });
  f.nodes[0].port.onmessage({ data: { samples: new Float32Array(1000).fill(.2) } });
  const owned = vm.runInContext('pcmChunks.slice()', f.context);
  let encoded;
  const encode = f.context.encodeWAVChunks;
  f.context.encodeWAVChunks = (chunks, rate, length) => { encoded = { chunks, rate, length }; return encode(chunks, rate, length); };
  f.context.stopRecording();
  assert.equal(encoded.rate, 16000); assert.equal(encoded.length, 4200);
  assert.equal(encoded.chunks.length, 2);
  assert.equal(encoded.chunks[0], owned[0]); assert.equal(encoded.chunks[1], owned[1]);
  assert.equal(f.calls.records.length, 1); assert.equal(f.calls.records[0].size, 44 + 8400);
});
test('worklet startup and processor failures use the original capture path without submitting partial speech', async () => {
  const fallback = fixture({ workletFailure: true }); await fallback.context.initMicrophone(); assert.equal(fallback.calls.fallback, 1);
  const f = fixture(); await f.context.initMicrophone(); f.context.currentState = 'listening'; f.context.startRecording();
  f.nodes[0].port.onmessage({ data: { samples: new Float32Array(3200).fill(.1) } });
  f.nodes[0].onprocessorerror();
  assert.equal(f.calls.fallback, 1); assert.equal(f.calls.records.length, 0); assert.equal(f.context.isRecording, false);
});
test('capture gaps cancel instead of sending damaged audio and device recovery never unmutes', async () => {
  const f = fixture(); await f.context.initMicrophone(); f.context.currentState = 'listening'; f.context.startRecording();
  f.nodes[0].port.onmessage({ data: { gap: true } }); assert.equal(f.context.isRecording, false); assert.equal(f.calls.records.length, 0);
  f.context.isMicMuted = true; f.track.ended(); f.listeners.get('devicechange')(); await Promise.resolve();
  assert.equal(f.calls.requests, 1); assert.equal(f.context.isMicMuted, true);
  f.context.isMicMuted = false; f.listeners.get('devicechange')(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.requests, 2); assert.equal(f.context.currentState, 'idle');
});
test('worklet batches samples in order and bounds unacknowledged data', () => {
  let Processor; const messages = [];
  const context = vm.createContext({ Float32Array, AudioWorkletProcessor: class { constructor() { this.port = { postMessage: message => messages.push(message) }; } }, registerProcessor: (_name, ctor) => { Processor = ctor; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/audio-capture-worklet.js'), 'utf8'), context);
  const processor = new Processor();
  for (let i = 0; i < 100; i++) processor.process([[new Float32Array(1024).fill(i)]]);
  assert.equal(messages.length, 8); assert.equal(messages[0].samples[0], 0); assert.equal(messages[7].samples[0], 7);
  processor.port.onmessage({ data: 'ack' }); processor.process([[new Float32Array(1024).fill(100)]]);
  assert.equal(messages[8].gap, true); assert.equal(messages[9].samples[0], 100);
});

test('worklet transfers each full packet once, reuses dropped storage, and clears queued speech on flush', () => {
  let Processor, allocations = 0, views = 0; const messages = [], transferred = [];
  class CountedFloat32Array extends Float32Array {
    constructor(...args) { super(...args); if (!(args[0] instanceof ArrayBuffer)) allocations++; }
    subarray(...args) { views++; return super.subarray(...args); }
  }
  const context = vm.createContext({ Float32Array: CountedFloat32Array, AudioWorkletProcessor: class {
    constructor() { this.port = { postMessage: (message, transfer = []) => {
      if (message.samples) { assert.equal(transfer.length, 1); assert.equal(transfer[0], message.samples.buffer); transferred.push(transfer[0]); }
      messages.push(structuredClone(message, { transfer }));
    } }; }
  }, registerProcessor: (_name, ctor) => { Processor = ctor; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/audio-capture-worklet.js'), 'utf8'), context);
  const processor = new Processor(), quantum = new CountedFloat32Array(128).fill(.25), before = allocations;
  for (let index = 0; index < 160; index++) processor.process([[quantum]]);
  assert.equal(messages.length, 8); assert.equal(allocations - before, 8, 'Only the eight transferred packets need replacement storage');
  assert.equal(views, 0, 'Complete render quanta create no subarray views');
  assert.ok(transferred.every(buffer => buffer.byteLength === 0), 'The sender no longer owns transferred buffers');
  assert.ok(messages.every(message => message.samples.length === 1024 && message.samples.every(value => value === .25)));
  processor.port.onmessage({ data: 'ack' });
  const varied = Float32Array.from({ length: 1100 }, (_, index) => index / 2000);
  processor.process([[varied]]);
  assert.equal(messages[8].gap, true);
  assert.deepEqual([...messages[9].samples], [...varied.subarray(0, 1024)]);
  assert.equal(processor.offset, 76);
  const owned = processor.buffer;
  processor.port.onmessage({ data: { type: 'flush', id: 4 } });
  assert.equal(processor.buffer, owned); assert.equal(processor.offset, 0); assert.ok(owned.every(value => value === 0));
  assert.equal(messages[10].flushed, 4);
  processor.port.onmessage({ data: 'ack' });
  for (let index = 0; index < 8; index++) processor.process([[new Float32Array(128).fill(.5)]]);
  assert.equal(messages[11].samples.length, 1024); assert.ok(messages[11].samples.every(value => value === .5));
});

test('local speaker playback never enters wake recognition or microphone pre-roll', async () => {
  const f = fixture(); let accepted = 0, active = true;
  f.context.window.OlangaLocalSpeech = { isActive: () => active };
  f.context.voskModel = { ready: true, KaldiRecognizer: class { setWords() {} on() {} remove() {} acceptWaveformFloat() { accepted++; } } };
  f.context.isVoskReady = true; await f.context.initMicrophone();
  f.nodes[0].port.onmessage({ data: { samples: new Float32Array(1024).fill(.1) } });
  assert.equal(accepted, 0); assert.equal(vm.runInContext('microphoneResources.preRoll.after(0).length', f.context), 0);
  active = false; f.nodes[0].port.onmessage({ data: { samples: new Float32Array(1024).fill(.1) } });
  assert.equal(accepted, 1); assert.equal(f.calls.acks, 2); assert.equal(f.context.isMicMuted, false);
});

test('a worklet flush discards its partial speaker batch before acknowledging the boundary', () => {
  let Processor; const messages = [];
  const context = vm.createContext({ Float32Array, AudioWorkletProcessor: class { constructor() { this.port = { postMessage: message => messages.push(message) }; } }, registerProcessor: (_name, ctor) => { Processor = ctor; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/audio-capture-worklet.js'), 'utf8'), context);
  const processor = new Processor(); processor.process([[new Float32Array(512).fill(.1)]]);
  processor.port.onmessage({ data: { type: 'flush', id: 7 } });
  processor.process([[new Float32Array(1024).fill(.2)]]);
  assert.equal(messages.length, 2); assert.equal(messages[0].flushed, 7);
  assert.ok(messages[1].samples.every(value => Math.abs(value - .2) < .0001));
});

test('queued speaker PCM, stale flush acknowledgements and old recognition callbacks cannot escape the local playback boundary', async () => {
  const f = fixture(), recognizers = []; let results = 0, accepted = 0, active = true;
  f.context.window.OlangaLocalSpeech = { isActive: () => active };
  f.context.voskModel = { ready: true, KaldiRecognizer: class {
    constructor() { this.handlers = {}; recognizers.push(this); } setWords() {} on(name, handler) { this.handlers[name] = handler; } remove() {}
    acceptWaveformFloat() { accepted++; }
  } }; f.context.isVoskReady = true; f.context.handleVoskResult = () => { results++; };
  await f.context.initMicrophone(); const old = recognizers[0], receive = f.nodes[0].port.onmessage;
  f.context.discardLocalSpeechCapture(); const first = f.calls.flushes.at(-1).id;
  active = false; const during = recognizers.at(-1); f.context.discardLocalSpeechCapture(); const second = f.calls.flushes.at(-1).id;
  old.handlers.result({ result: { text: 'hey olanga' } }); during.handlers.partialresult({ result: { partial: 'hey olanga' } });
  receive({ data: { flushed: first } }); receive({ data: { samples: new Float32Array(1024).fill(.1) } });
  assert.equal(accepted, 0); assert.equal(results, 0); assert.equal(vm.runInContext('microphoneResources.preRoll.after(0).length', f.context), 0);
  const waiting = recognizers.at(-1); receive({ data: { flushed: second } });
  waiting.handlers.result({ result: { text: 'hey olanga' } }); assert.equal(results, 0);
  receive({ data: { samples: new Float32Array(1024).fill(.2) } }); assert.equal(accepted, 1);
  recognizers.at(-1).handlers.result({ result: { text: 'fresh user speech' } }); assert.equal(results, 1);
  assert.equal(vm.runInContext('microphoneResources.preRoll.after(0).length', f.context), 1); assert.equal(f.context.isMicMuted, false);
});

test('a lost flush acknowledgement falls back safely and obsolete processor callbacks cannot reenter capture', async () => {
  const f = fixture(); await f.context.initMicrophone(); const oldReceive = f.nodes[0].port.onmessage;
  f.context.discardLocalSpeechCapture();
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(f.calls.fallback, 1); assert.equal(vm.runInContext('microphoneResources.captureBarrier', f.context), null);
  f.context.currentState = 'listening'; f.context.startRecording();
  oldReceive({ data: { samples: new Float32Array(3200).fill(.1) } });
  assert.equal(f.context.pcmChunks.length, 0);
  const processor = f.context.scriptNode, oldLegacy = processor.onaudioprocess;
  f.context.discardLocalSpeechCapture(); assert.equal(f.calls.fallback, 2);
  oldLegacy({ inputBuffer: { getChannelData: () => new Float32Array(3200).fill(.1) } }); assert.equal(f.context.pcmChunks.length, 0);
  f.context.scriptNode.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(3200).fill(.1) } });
  assert.equal(f.context.pcmChunks.length, 1); assert.equal(f.context.isMicMuted, false); assert.equal(f.calls.requests, 1);
});


function recognitionFixture() {
  const f = fixture(), recognizers = [], heard = [];
  f.context.voskModel = { ready: true, KaldiRecognizer: class {
    constructor() { this.handlers = {}; recognizers.push(this); }
    setWords() {} on(name, handler) { this.handlers[name] = handler; }
    remove() { this.removed = true; } acceptWaveformFloat() {}
  } };
  f.context.isVoskReady = true;
  f.context.handleVoskResult = text => heard.push(text);
  return { ...f, recognizers, heard };
}

test('processor recovery replaces recognition and ignores obsolete processor errors and audio', async () => {
  const f = recognitionFixture(); await f.context.initMicrophone();
  f.context.currentState = 'listening'; f.context.startRecording();
  const before = f.recognizers.at(-1), failed = f.nodes[0];
  const oldFailure = failed.onprocessorerror, oldReceive = failed.port.onmessage;
  oldReceive({ data: { samples: new Float32Array(3200).fill(.1) } });
  oldFailure();
  assert.notEqual(f.recognizers.at(-1), before, 'Recovered capture must own a new recognizer');
  assert.equal(before.removed, true);
  before.handlers.result({ result: { text: 'old wake phrase' } });
  before.handlers.partialresult({ result: { partial: 'old partial speech' } });
  assert.deepEqual(f.heard, []);
  f.recognizers.at(-1).handlers.result({ result: { text: 'fresh speech' } });
  assert.deepEqual(f.heard, ['fresh speech']);
  assert.equal(f.calls.records.length, 0); assert.equal(f.context.isRecording, false);
  assert.equal(f.calls.fallback, 1); const errors = f.calls.errors.length;
  oldFailure();
  assert.equal(f.calls.fallback, 1, 'A queued error from the obsolete processor must be ignored');
  assert.equal(f.calls.errors.length, errors);
  f.context.currentState = 'listening'; f.context.startRecording();
  oldReceive({ data: { samples: new Float32Array(3200).fill(.1) } });
  assert.equal(f.context.pcmChunks.length, 0);
  f.context.scriptNode.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(3200).fill(.1) } });
  assert.equal(f.context.pcmChunks.length, 1); assert.equal(f.calls.requests, 1);
});

test('processor failure stops Live before recovered capture can stream across its discontinuity', async () => {
  const f = fixture(); let active = true, streamed = 0; const stopped = [];
  f.context.window.OlangaLiveConversation = {
    isActive: () => active, acceptSamples() { streamed++; },
    stop(message) { stopped.push(message); active = false; }
  };
  await f.context.initMicrophone(); f.context.currentState = 'listening';
  f.nodes[0].port.onmessage({ data: { samples: new Float32Array(1024).fill(.1) } });
  assert.equal(streamed, 1);
  f.nodes[0].onprocessorerror();
  assert.equal(active, false);
  assert.deepEqual(stopped, ['Audio capture was interrupted. Start again when ready.']);
  assert.equal(f.context.currentState, 'idle'); assert.equal(f.calls.fallback, 1);
  f.context.scriptNode.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(1024).fill(.1) } });
  assert.equal(streamed, 1); assert.equal(f.calls.records.length, 0);
});

test('a phrase check interrupted by processor failure rejects instead of reporting a healthy microphone', async () => {
  const f = recognitionFixture(); await f.context.initMicrophone();
  const phrase = f.context.window.OlangaAudioInput.testPhrase();
  // A complete phrase before the discontinuity must not conceal the failure.
  vm.runInContext("audioPhraseTest.finals.push('olanga audio check')", f.context);
  const outcome = phrase.then(value => ({ value }), error => ({ error }));
  try {
    f.nodes[0].onprocessorerror();
    const result = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve({ pending: true }), 100))]);
    assert.match(result.error?.message || '', /audio capture was interrupted/i);
    assert.equal(vm.runInContext('audioPhraseTest', f.context), null);
    assert.equal(f.calls.records.length, 0); assert.equal(f.context.isMicMuted, false);
  } finally { f.context.cancelAudioPhraseTest('Fixture finished.'); await outcome; }
});
