const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(options = {}) {
  const calls = { stopped: 0, cancelled: 0, recordings: 0, errors: [], focused: 0, expanded: 0 };
  const node = () => ({ textContent: '', classList: { add() {}, remove() {} } });
  const context = vm.createContext({
    console: { log() {}, warn() {} }, window: { electronAPI: { expandWindow: () => calls.expanded++ }, OlangaDesktop: { isBusy: () => !!options.desktopBusy } },
    document: { getElementById: id => (id === 'textCommandInput' ? { focus: () => calls.focused++ } : null) },
    State: { IDLE: 'idle', LISTENING: 'listening', THINKING: 'thinking', SPEAKING: 'speaking' },
    currentState: options.state || 'speaking', isMicMuted: !!options.muted, isRecording: false, hasSpokenDuringRecording: false,
    micStream: options.noMic ? null : { active: true }, audioContext: { state: 'running' }, followUpTimer: null,
    bargeInEnabled: options.bargeIn !== false, voskRecognizer: { reset() {} }, lastIdleTime: 0, isVoskReady: true, isWakeWordCapturing: false,
    SILENCE_DURATION: 1500, endOfSpeechMs: options.endOfSpeechMs ?? 1500, OlangaIntents: require('../../shared/fast-intents'), Blob, ArrayBuffer, DataView,
    userText: node(), transcriptUser: node(), transcriptAi: node(),
    PRESET_WAKE_WORDS: ['hey', 'hail', 'hey olanga', 'hey alanga', 'a olanga', 'he olanga'],
    normalizeWakePhrase: text => String(text).toLowerCase().replace(/[^\w\s']/g, ' ').replace(/\s+/g, ' ').trim(),
    setState(value) { context.currentState = value; }, showError: message => calls.errors.push(message),
    stopAssistantSpeech: () => calls.stopped++, cancelAssistantRequest: () => { calls.cancelled++; calls.stopped++; }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/voice.js'), 'utf8'), context);
  const startRecording = context.startRecording;
  context.startRecording = () => { calls.recordings++; return startRecording(); };
  context.getCustomWakePhrases = () => options.custom || [];
  return { context, calls };
}

test('a multi-word wake phrase interrupts a reply and starts listening', () => {
  const { context, calls } = fixture();
  context.handleVoskResult('hey olanga', false);
  assert.equal(calls.cancelled, 1);
  assert.equal(calls.stopped, 1);
  assert.equal(context.currentState, 'listening');
  assert.equal(context.isRecording, true);
  assert.equal(context.userText.textContent, 'Listening...');
});

test('single generic words, unrelated speech and disabled interruption never stop a reply', () => {
  for (const heard of ['hey', 'hail', 'they said olanga was great', 'hey there boss', 'this version of a olanga', 'he olanga said']) {
    const { context, calls } = fixture();
    context.handleVoskResult(heard, true);
    assert.equal(calls.cancelled, 0, heard); assert.equal(context.currentState, 'speaking', heard);
  }
  const disabled = fixture({ bargeIn: false });
  disabled.context.handleVoskResult('hey olanga', true);
  assert.equal(disabled.calls.cancelled, 0);
  assert.equal(disabled.context.currentState, 'speaking');
  const custom = fixture({ custom: ['jarvis', 'okay computer'] });
  custom.context.handleVoskResult('jarvis', true);
  assert.equal(custom.calls.cancelled, 0, 'A one-word custom phrase could come from Olanga itself');
  custom.context.handleVoskResult('okay computer', true);
  assert.equal(custom.calls.cancelled, 1);
});

test('push-to-talk starts listening, interrupts replies, and a second press sends the request', () => {
  const idle = fixture({ state: 'idle' });
  idle.context.handlePushToTalk();
  assert.equal(idle.context.currentState, 'listening'); assert.equal(idle.calls.cancelled, 0);
  idle.context.handlePushToTalk();
  assert.equal(idle.context.currentState, 'idle', 'A press with no speech yet cancels quietly');
  const speaking = fixture({ state: 'speaking' });
  speaking.context.handlePushToTalk();
  assert.equal(speaking.calls.cancelled, 1); assert.equal(speaking.context.currentState, 'listening');
  let sent = 0;
  speaking.context.stopRecording = () => { sent++; };
  speaking.context.hasSpokenDuringRecording = true;
  speaking.context.handlePushToTalk();
  assert.equal(sent, 1);
});

test('the live transcript shortens the pause only for a complete local command and travels with the recording', () => {
  const { context } = fixture({ state: 'idle' });
  context.handlePushToTalk();
  assert.equal(context.endOfSpeechDelay(), 1500);
  context.handleVoskResult('open', false);
  assert.equal(context.endOfSpeechDelay(), 1500, 'An incomplete command keeps the full pause');
  context.handleVoskResult('open notepad', true);
  context.handleVoskResult('and', false);
  assert.equal(context.getLiveTranscript(), 'open notepad and');
  assert.equal(context.endOfSpeechDelay(), 1500, 'A trailing conjunction means more is coming');
  context.handleVoskResult('and pause the music', false);
  assert.equal(context.endOfSpeechDelay(), 900);
  context.endOfSpeechMs = 700;
  assert.equal(context.endOfSpeechDelay(), 600);
  context.handleVoskResult('what is the capital of', false);
  assert.equal(context.endOfSpeechDelay(), 700, 'Questions keep the chosen pause');
  let sent;
  context.processAudioBlobWithGemini = (blob, options) => { sent = { blob, options }; };
  context.pcmChunks = [new Float32Array(1600)]; context.audioContext = { state: 'running', sampleRate: 16000 };
  context.stopRecording();
  assert.equal(sent.options.rough, 'open notepad what is the capital of');
  assert.equal(context.getLiveTranscript(), '');
  assert.equal(sent.blob.type, 'audio/wav');
});

test('push-to-talk falls back to typing when voice is unavailable and waits for desktop work', () => {
  const muted = fixture({ state: 'idle', muted: true });
  muted.context.handlePushToTalk();
  assert.equal(muted.context.currentState, 'idle');
  assert.deepEqual([muted.calls.expanded, muted.calls.focused], [1, 1]);
  assert.match(muted.calls.errors[0], /muted/);
  const busy = fixture({ state: 'idle', desktopBusy: true });
  busy.context.handlePushToTalk();
  assert.equal(busy.context.currentState, 'idle'); assert.equal(busy.calls.recordings, 0);
});
