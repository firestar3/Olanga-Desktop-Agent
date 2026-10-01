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
