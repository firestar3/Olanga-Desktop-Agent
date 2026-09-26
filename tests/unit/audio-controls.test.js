const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(options = {}) {
  const callbacks = new Map(), track = { enabled: true }, errors = [];
  const button = name => ({ classList: { add() {}, remove() {} }, addEventListener(event, callback) {
    const key = name + event; callbacks.set(key, [...(callbacks.get(key) || []), callback]);
  } });
  const context = vm.createContext({
    console: { log() {}, warn() {} }, window: {},
    localStorage: {
      getItem(key) { if (options.readFails) throw new Error('Storage blocked'); return options.saved?.[key] ?? null; },
      setItem() { if (options.writeFails) throw new Error('Storage full'); }
    },
    isMicMuted: false, isTtsMuted: false, isRecording: true, pcmChunks: [new Float32Array([.2])],
    speechStartTime: 1, silenceStartTime: 1, hasSpokenDuringRecording: true,
    micStream: { getTracks: () => [track] }, currentState: 'listening', State: { IDLE: 'idle', LISTENING: 'listening', SPEAKING: 'speaking' },
    micToggleBtn: button('mic'), ttsToggleBtn: button('tts'), micIconOn: { style: {} }, micIconOff: { style: {} }, ttsIconOn: { style: {} }, ttsIconOff: { style: {} },
    followUpTimer: 23, cancelFollowUpWindow() { context.followUpTimer = null; },
    setState(value) { context.currentState = value; }, showError: message => errors.push(message), stopAssistantSpeech() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/voice.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/audio-controls.js'), 'utf8'), context);
  return { context, callbacks, track, errors };
}

test('microphone mute discards captured audio and disables tracks even when preferences cannot be saved', () => {
  const { context, track, errors } = fixture({ writeFails: true });
  assert.doesNotThrow(() => context.muteMic());
  assert.equal(context.isMicMuted, true); assert.equal(track.enabled, false);
  assert.equal(context.isRecording, false); assert.equal(context.pcmChunks.length, 0);
  assert.equal(context.hasSpokenDuringRecording, false); assert.equal(context.followUpTimer, null);
  assert.equal(context.currentState, 'idle'); assert.equal(errors.length, 1);
  context.unmuteMic();
  assert.equal(track.enabled, true); assert.equal(context.isRecording, false);
});

test('unavailable storage cannot prevent mute restoration or leave audio buttons unbound', () => {
  const { context, callbacks, track } = fixture({ readFails: true, writeFails: true });
  context.isMicMuted = true; context.isTtsMuted = true;
  context.initAudioControls(); context.initAudioControls();
  assert.equal(context.isMicMuted, true); assert.equal(context.isTtsMuted, true);
  assert.equal(track.enabled, false);
  assert.equal(callbacks.get('micclick').length, 1); assert.equal(callbacks.get('ttsclick').length, 1);
  callbacks.get('micclick')[0](); callbacks.get('ttsclick')[0]();
  assert.equal(context.isMicMuted, false); assert.equal(context.isTtsMuted, false);
});

test('saved audio mute settings load without requiring a startup write', () => {
  const { context, errors } = fixture({ saved: { olanga_mic_muted: 'true', olanga_tts_muted: 'true' }, writeFails: true });
  context.initAudioControls();
  assert.equal(context.isMicMuted, true); assert.equal(context.isTtsMuted, true);
  assert.equal(errors.length, 0);
});
