const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const endpoint = require('../../shared/voice-endpoint');

function fixture() {
  const calls = { requests: [], saves: [], records: [], speech: [], errors: [], enumerations: 0 }, streams = [], recognizers = [], timers = new Map();
  let sequence = 0, now = 0, graphDevice = '';
  const control = { failGraph: '', failSave: null, enumerate: null, save: null, speech: null, open: null };
  const node = () => ({ connect() {}, disconnect() {} });
  class Context {
    constructor() { this.sampleRate = 16000; this.state = 'running'; this.device = graphDevice; }
    createMediaStreamSource() { return node(); }
    createScriptProcessor() { return node(); }
    createGain() { if (control.failGraph === this.device) throw new Error('Fixture: graph unavailable'); return { ...node(), gain: {} }; }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  class Recognizer {
    constructor() { this.handlers = {}; this.removed = false; this.accepted = 0; recognizers.push(this); }
    setWords() {} on(name, callback) { this.handlers[name] = callback; } remove() { this.removed = true; }
    acceptWaveformFloat() { this.accepted++; } reset() {}
  }
  const context = vm.createContext({
    window: {}, localStorage: { getItem: () => 'mic-one' }, navigator: { mediaDevices: {
      async enumerateDevices() { calls.enumerations++; if (control.enumerate) await control.enumerate(); return [{ kind: 'audioinput', deviceId: 'default', label: 'Default' }, { kind: 'audioinput', deviceId: 'mic-one', label: 'Desk mic' }, { kind: 'audioinput', deviceId: 'mic-two', label: 'Headset' }, { kind: 'videoinput', deviceId: 'camera', label: 'Camera' }]; },
      async getUserMedia(options) {
        calls.requests.push(options); graphDevice = options.audio.deviceId?.exact || '';
        const track = { label: graphDevice || 'Windows default', enabled: true, stopped: false, stop() { this.stopped = true; }, addEventListener(name, callback) { this[name] = callback; }, removeEventListener(name) { delete this[name]; } };
        const stream = { active: true, getTracks: () => [track], getAudioTracks: () => [track], track }; streams.push(stream); if (control.open) await control.open(); return stream;
      }, addEventListener() {}
    } },
    AudioContext: Context, OlangaVoiceEndpoint: endpoint, Float32Array, Blob, ArrayBuffer, DataView,
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; }, clearTimeout: id => timers.delete(id),
    console: { log() {}, error() {} }, micStream: null, audioContext: null, analyser: null, scriptNode: null, voskRecognizer: null,
    voskModel: { ready: true, KaldiRecognizer: Recognizer }, isVoskReady: true, isMicMuted: false, isTtsMuted: false, ttsEngine: 'windows',
    isRecording: false, isWakeWordCapturing: false, currentState: 'idle', State: { IDLE: 'idle', THINKING: 'thinking', LISTENING: 'listening', SPEAKING: 'speaking' },
    followUpTimer: null, SILENCE_DURATION: 1500, endOfSpeechMs: 1500, pcmChunks: [], currentRMS: 0, hasSpokenDuringRecording: false,
    cancelAnimationFrame() {}, showError: message => calls.errors.push(message), setState: value => { context.currentState = value; }, processAudioBlobWithGemini: value => calls.records.push(value),
    speakResponse: async text => { calls.speech.push(text); return control.speech ? control.speech() : { status: 'completed' }; }
  });
  context.window.OlangaMicrophonePreference = { async save(value) { calls.saves.push(value); if (control.failSave === value) throw new Error('Fixture: preferences unavailable'); if (control.save) await control.save(value); } };
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../js/voice.js'), 'utf8'), context);
  context.monitorAudio = () => {};
  function tick(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } }
  return { context, api: context.window.OlangaAudioInput, calls, streams, recognizers, control, tick, timers };
}

test('device listing and snapshots never open a microphone or activate speech', async () => {
  const f = fixture(), devices = await f.api.devices();
  assert.deepEqual(Array.from(devices, value => value.deviceId), ['mic-one', 'mic-two']);
  assert.equal(f.api.snapshot().active, false); assert.equal(f.calls.requests.length, 0); assert.equal(f.calls.speech.length, 0);
  f.context.micStream = { active: true, getTracks: () => [] };
  assert.equal(f.api.snapshot().active, false, 'A stray stream without the graph is not a ready input');
});

test('muted and never-enabled device selection saves the preference without opening input or unmuting', async () => {
  for (const muted of [false, true]) {
    const f = fixture(); f.context.isMicMuted = muted;
    await f.api.choose('mic-two');
    assert.equal(f.calls.requests.length, 0); assert.deepEqual(f.calls.saves, ['mic-two']);
    assert.equal(f.api.snapshot().preferredDeviceId, 'mic-two'); assert.equal(f.context.isMicMuted, muted);
  }
});

test('explicit selection recovers a disconnected microphone only when voice was already enabled', async () => {
  const f = fixture(); await f.context.initMicrophone(); f.streams[0].track.ended();
  assert.equal(f.api.snapshot().active, false);
  await f.api.choose('mic-two');
  assert.equal(f.calls.requests.length, 2); assert.equal(f.api.snapshot().active, true); assert.equal(f.api.snapshot().label, 'mic-two');
  f.streams[1].track.ended(); await f.api.choose('mic-two');
  assert.equal(f.calls.requests.length, 3); assert.equal(f.api.snapshot().active, true, 'Choosing the saved input can retry a failed graph');
});

test('an active selection swaps graphs only after setup succeeds and a failed graph preserves the old recognizer', async () => {
  const f = fixture(); await f.context.initMicrophone();
  const original = f.context.micStream, originalRecognizer = f.context.voskRecognizer;
  f.control.failGraph = 'mic-two';
  await assert.rejects(f.api.choose('mic-two'), /previous microphone is still selected/);
  assert.equal(f.context.micStream, original); assert.equal(original.track.stopped, false); assert.equal(f.context.voskRecognizer, originalRecognizer);
  assert.equal(f.api.snapshot().preferredDeviceId, 'mic-one'); assert.equal(f.api.snapshot().modelReady, true);
  assert.deepEqual(f.calls.saves, ['mic-two', 'mic-one']); assert.equal(f.streams[1].track.stopped, true);
  f.control.failGraph = ''; await f.api.choose('mic-two');
  assert.equal(original.track.stopped, true); assert.equal(f.api.snapshot().label, 'mic-two'); assert.equal(f.api.snapshot().modelReady, true);
});

test('a failed preference save never opens another graph and rollback failures remain truthful', async () => {
  const f = fixture(); await f.context.initMicrophone(); f.control.failSave = 'mic-two';
  await assert.rejects(f.api.choose('mic-two'), /preferences unavailable/);
  assert.equal(f.calls.requests.length, 1); assert.equal(f.api.snapshot().preferredDeviceId, 'mic-one');
  f.control.failSave = 'mic-one'; f.control.failGraph = 'mic-two';
  await assert.rejects(f.api.choose('mic-two'), /saved selection could not be restored/);
  assert.equal(f.api.snapshot().preferredDeviceId, 'mic-one'); assert.equal(f.streams[0].track.stopped, false);
});

test('concurrent switches are rejected before enumeration and a mute during preference save cannot open input', async () => {
  const f = fixture(); let release;
  f.control.enumerate = () => new Promise(resolve => { release = resolve; });
  const pending = f.api.choose('mic-two');
  await assert.rejects(f.api.choose(''), /Finish the current/);
  assert.equal(f.calls.enumerations, 1); release(); await pending;
  const active = fixture(); await active.context.initMicrophone(); let save;
  active.control.save = () => new Promise(resolve => { save = resolve; });
  const switching = active.api.choose('mic-two'); await new Promise(resolve => setImmediate(resolve));
  active.context.isMicMuted = true; active.context.refreshMicrophoneActivity(); save(); await switching;
  assert.equal(active.calls.requests.length, 1); assert.equal(active.context.isMicMuted, true);
});

test('a new recording while Windows opens another device retains its original capture and selected preference', async () => {
  const f = fixture(); await f.context.initMicrophone(); const original = f.context.micStream; let opened;
  f.control.open = () => new Promise(resolve => { opened = resolve; });
  const switching = f.api.choose('mic-two'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.requests.length, 2);
  f.context.currentState = 'listening'; f.context.startRecording(); opened();
  await assert.rejects(switching, /interrupted by another request/);
  assert.equal(f.context.micStream, original); assert.equal(original.track.stopped, false); assert.equal(f.streams[1].track.stopped, true);
  assert.equal(f.context.isRecording, true); assert.equal(f.api.snapshot().preferredDeviceId, 'mic-one');
  assert.deepEqual(f.calls.saves, ['mic-two', 'mic-one']); assert.equal(f.calls.records.length, 0);
});

test('a request beginning during device enumeration prevents saving or replacing its microphone', async () => {
  const f = fixture(); let listed; f.control.enumerate = () => new Promise(resolve => { listed = resolve; });
  const switching = f.api.choose('mic-two'); f.context.currentState = 'thinking'; listed();
  await assert.rejects(switching, /new request started/);
  assert.deepEqual(f.calls.saves, []); assert.equal(f.calls.requests.length, 0); assert.equal(f.context.currentState, 'thinking');
});

test('phrase checks intercept local recognition, verify only the exact phrase and clear trailing capture', async () => {
  const f = fixture(); await f.context.initMicrophone();
  const pending = f.api.testPhrase(); const during = f.recognizers.at(-1);
  during.handlers.result({ result: { text: 'olanga audio check' } });
  f.tick(5000); const result = await pending;
  assert.equal(result.verified, true); assert.equal(result.heard, 'olanga audio check'); assert.equal(result.deviceId, 'mic-one');
  assert.equal(f.context.currentState, 'idle'); assert.equal(f.context.isRecording, false); assert.equal(f.calls.records.length, 0); assert.equal(f.calls.speech.length, 0);
  assert.equal(during.removed, true); assert.equal(vm.runInContext('microphoneResources.preRoll.after(0).length', f.context), 0);
  const other = f.api.testPhrase(); f.context.handleVoskResult('hey olanga open Spotify', true); f.tick(5000);
  assert.equal((await other).verified, false); assert.equal(f.context.currentState, 'idle'); assert.equal(f.calls.records.length, 0);
});

test('phrase checks reject busy/off inputs and cancel on mute, disconnect and recognition failure', async () => {
  const off = fixture(); await assert.rejects(off.api.testPhrase(), /Enable and unmute/); assert.equal(off.calls.requests.length, 0);
  for (const mode of ['muted', 'disconnected', 'recognizer']) {
    const f = fixture(); await f.context.initMicrophone(); const pending = f.api.testPhrase();
    await assert.rejects(f.api.testPhrase(), /Finish the current/);
    await assert.rejects(f.api.choose('mic-two'), /Finish the current/);
    if (mode === 'muted') { f.context.isMicMuted = true; f.context.refreshMicrophoneActivity(); }
    else if (mode === 'disconnected') f.streams[0].track.ended();
    else f.recognizers.at(-1).handlers.error();
    await assert.rejects(pending, /muted|disconnected|recognition stopped/);
    assert.equal(vm.runInContext('audioPhraseTest', f.context), null); assert.equal(f.calls.records.length, 0);
  }
});

test('reply samples use explicit selected speech, reject overlap, and discard late recognizer callbacks', async () => {
  const f = fixture(); await f.context.initMicrophone(); let done;
  f.control.speech = () => new Promise(resolve => { done = resolve; });
  const pending = f.api.testReply(), stale = f.recognizers.at(-1);
  await assert.rejects(f.api.testReply(), /Finish the current/); await assert.rejects(f.api.testPhrase(), /Finish the current/);
  f.context.handleVoskResult('hey olanga open Spotify', true);
  done({ status: 'completed' }); const result = await pending;
  assert.equal(result.status, 'completed'); assert.equal(result.engine, 'windows'); assert.equal('heard' in result, false);
  assert.equal(f.calls.speech.length, 1); assert.equal(stale.removed, true); assert.equal(f.context.isRecording, false);
  f.context.isTtsMuted = true; await assert.rejects(f.api.testReply(), /Unmute spoken replies/); assert.equal(f.calls.speech.length, 1);
});
