const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ engine = 'windows', synthesize = async () => ({ audioBase64: 'AAAAAA==' }), hold = false, windowsResult = true } = {}) {
  const spoken = [], played = [], states = [], pending = [];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, atob, Blob, Uint8Array, ArrayBuffer, DataView,
    window: { electronAPI: { nvidiaTtsSynthesize: synthesize } }, OlangaConversation: require('../../shared/conversation'),
    synthesis: { cancel() {} }, currentTTSAudio: null, nvidiaApiKey: 'test', defaultNvidiaVoiceName: 'Aria', ttsRate: 1,
    isTtsMuted: false, ttsEngine: engine, State: { IDLE: 'idle', SPEAKING: 'speaking' }, setState: value => states.push(value)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/tts.js'), 'utf8'), context);
  context.getSelectedNvidiaVoiceConfig = () => ({ voiceName: 'Aria', languageCode: 'en-US' });
  // Windows speech settles when finished or when stopAssistantSpeech cancels it.
  context.__spoken = text => new Promise(resolve => {
    spoken.push(text);
    const finish = () => resolve(windowsResult);
    context.__cancel = () => resolve(false);
    if (hold) pending.push(finish); else setImmediate(finish);
  });
  vm.runInContext('speakWithWindowsTts = (text, callback, options) => { const running = __spoken(text); options?.onStart?.(); cancelAssistantPlayback = () => __cancel(); return running; };', context);
  context.playSpeechChunk = async (blob, options) => { played.push(blob); options?.onStart?.(); return true; };
  return { context, spoken, played, states, pending };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a streamed reply speaks each sentence in order as soon as it is complete', async () => {
  const { context, spoken, states } = fixture();
  let starts = 0;
  const stream = context.createSpeechStream({ onStart: () => starts++ });
  stream.push('Canberra is the capital. It was ');
  await tick();
  assert.deepEqual(spoken, ['Canberra is the capital.']);
  stream.push('chosen in 1908! Anything **else**?');
  assert.equal(await stream.end('Canberra is the capital. It was chosen in 1908! Anything **else**? Just ask.'), true);
  assert.deepEqual(spoken, ['Canberra is the capital.', 'It was chosen in 1908!', 'Anything else?', 'Just ask.']);
  assert.equal(starts, 1);
  assert.deepEqual(states, ['speaking']);
});

test('stopping speech ends the stream without speaking later sentences', async () => {
  const { context, spoken, pending } = fixture({ hold: true });
  const stream = context.createSpeechStream();
  stream.push('First sentence. Second sentence. ');
  await tick();
  assert.deepEqual(spoken, ['First sentence.']);
  context.stopAssistantSpeech();
  assert.equal(await stream.done, false);
  assert.equal(stream.failed, false, 'A user interruption is distinct from a playback failure');
  stream.push('Third sentence. ');
  pending.forEach(finish => finish());
  await tick();
  assert.deepEqual(spoken, ['First sentence.']);
  assert.equal(await stream.end('First sentence. Second sentence. Third sentence.'), false);
});

test('failed Windows playback settles false and never sends queued or later sentences', async () => {
  for (const rejected of [false, true]) {
    const { context, spoken } = fixture({ windowsResult: false });
    if (rejected) context.__spoken = async text => { spoken.push(text); throw new Error('Speech failed'); };
    const stream = context.createSpeechStream();
    stream.push('First sentence. Second sentence. ');
    assert.equal(await stream.done, false);
    assert.equal(stream.failed, true);
    stream.push('Third sentence. ');
    assert.equal(await stream.end('First sentence. Second sentence. Third sentence.'), false);
    await tick();
    assert.deepEqual(spoken, ['First sentence.']);
    assert.equal(vm.runInContext('speakingWatchdog', context), null);
  }
});

test('interrupted Magpie playback cannot count as a completed stream or replay in Windows', async () => {
  const { context, spoken, played } = fixture({ engine: 'magpie' });
  context.playSpeechChunk = async blob => { played.push(blob); return false; };
  const stream = context.createSpeechStream();
  stream.push('First sentence. Second sentence. ');
  assert.equal(await stream.end('First sentence. Second sentence.'), false);
  assert.equal(stream.failed, true);
  assert.equal(played.length, 1);
  assert.deepEqual(spoken, []);
});

test('a muted voice completes silently and a newer reply supersedes an older stream', async () => {
  const muted = fixture();
  muted.context.isTtsMuted = true;
  const silent = muted.context.createSpeechStream();
  silent.push('Nothing to hear. ');
  assert.equal(await silent.end('Nothing to hear.'), true);
  assert.deepEqual(muted.spoken, []);
  const { context, spoken } = fixture({ hold: true });
  const older = context.createSpeechStream();
  older.push('Old reply. ');
  const newer = context.createSpeechStream();
  assert.equal(await older.done, false);
  newer.push('New reply. ');
  await tick();
  assert.deepEqual(spoken, ['Old reply.', 'New reply.']);
});

test('Magpie sentences synthesize ahead of playback and a failure continues in the Windows voice', async () => {
  const requests = [];
  const { context, played, spoken } = fixture({ engine: 'magpie', synthesize: async ({ text }) => { requests.push(text); if (text.startsWith('Second')) throw new Error('Unavailable'); return { audioBase64: 'AAAAAA==' }; } });
  const stream = context.createSpeechStream();
  stream.push('First part. Second part. Third part. ');
  assert.deepEqual(requests, ['First part.', 'Second part.', 'Third part.'], 'All complete sentences start synthesizing immediately');
  assert.equal(await stream.end('First part. Second part. Third part.'), true);
  assert.equal(played.length, 1);
  assert.deepEqual(spoken, ['Second part.', 'Third part.']);
  assert.ok(vm.runInContext('magpieUnavailableUntil', context) > Date.now());
});
