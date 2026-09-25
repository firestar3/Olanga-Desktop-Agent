const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(synthesize) {
  const context = {
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, atob, Blob, Uint8Array, ArrayBuffer, DataView,
    window: { electronAPI: { nvidiaTtsSynthesize: synthesize } },
    synthesis: { cancel() {} }, currentTTSAudio: null, nvidiaApiKey: 'test', defaultNvidiaVoiceName: 'Aria',
    isTtsMuted: false, ttsEngine: 'magpie', State: { IDLE: 'idle' }, setState() {}, speakingWatchdogTimer: null
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/tts.js'), 'utf8'), context);
  context.getSelectedNvidiaVoiceConfig = () => ({ voiceName: 'Aria', languageCode: 'en-US' });
  return context;
}

test('prepared confirmation is shared with playback and cached per voice', async () => {
  const requests = [];
  const context = fixture(async request => { requests.push(request); return { audioBase64: 'AAAAAA==' }; });
  const played = [];
  context.playSpeechChunk = async blob => { played.push(blob); return true; };
  context.prepareAssistantSpeech('Your liked songs are playing now.');
  assert.equal(played.length, 0);
  await context.speakWithNvidiaTts('Your liked songs are playing now.');
  await context.speakWithNvidiaTts('Your liked songs are playing now.');
  assert.equal(requests.length, 1);
  assert.equal(played.length, 2);
  context.getSelectedNvidiaVoiceConfig = () => ({ voiceName: 'Jason', languageCode: 'en-US' });
  await context.speakWithNvidiaTts('Your liked songs are playing now.');
  assert.equal(requests.length, 2);
});

test('failed speech synthesis is evicted so retry can recover', async () => {
  let attempts = 0;
  const context = fixture(async () => {
    if (++attempts === 1) throw new Error('Unavailable');
    return { audioBase64: 'AAAAAA==' };
  });
  const voice = { voiceName: 'Aria', languageCode: 'en-US' };
  await assert.rejects(context.getMagpieAudio('Playing.', voice), /Unavailable/);
  await context.getMagpieAudio('Playing.', voice);
  assert.equal(attempts, 2);
});

test('cancelled synthesis cannot play stale audio or start a fallback voice', async () => {
  let rejectAudio;
  const context = fixture(() => new Promise((_, reject) => { rejectAudio = reject; }));
  let fallback = 0;
  context.speakWithWindowsTts = async () => { fallback++; };
  context.playSpeechChunk = () => { throw new Error('Stale audio played'); };
  const pending = context.speakWithSelectedEngine('Playing.', () => { throw new Error('Stale callback ran'); });
  context.stopAssistantSpeech();
  rejectAudio(new Error('Cancelled request failed'));
  await pending;
  assert.equal(fallback, 0);
});

test('Windows voice initialization cannot speak a cancelled confirmation', async () => {
  const context = fixture(async () => ({ audioBase64: 'AAAAAA==' }));
  let retry;
  let spoken = 0;
  context.setTimeout = callback => { retry = callback; return 1; };
  context.clearTimeout = () => {};
  context.synthesis.getVoices = () => [];
  context.synthesis.addEventListener = () => {};
  context.synthesis.removeEventListener = () => {};
  context.synthesis.speak = () => { spoken++; };
  context.SpeechSynthesisUtterance = function () {};
  context.ttsRate = 1; context.isMuted = false; context.currentVolume = 1;
  const pending = context.speakWithWindowsTts('Playing.');
  context.stopAssistantSpeech();
  retry();
  await pending;
  assert.equal(spoken, 0);
});

test('a later synthesis failure speaks all remaining chunks locally without repeating the completed prefix', async () => {
  const chunks = ['Spotify is open.', 'System volume is 75%.', 'Your request is complete.'];
  const generated = [];
  const context = fixture(async request => {
    generated.push(request.text);
    if (request.text === chunks[1]) throw new Error('Magpie unavailable');
    return { audioBase64: 'AAAAAA==' };
  });
  context.splitIntoSpeechChunks = () => chunks;
  let played = 0;
  context.playSpeechChunk = async () => { played++; return true; };
  let fallbackStarted;
  const started = new Promise(resolve => { fallbackStarted = resolve; });
  let finishFallback;
  const spoken = [];
  context.speakWithWindowsTts = (text, callback) => {
    spoken.push(text);
    fallbackStarted();
    return new Promise(resolve => { finishFallback = () => { callback(); resolve(true); }; });
  };
  let finished = 0;
  const pending = context.speakWithSelectedEngine(chunks.join(' '), () => { finished++; });
  await started;
  assert.equal(played, 1);
  assert.deepEqual(generated, chunks.slice(0, 2));
  assert.deepEqual(spoken, [chunks.slice(1).join(' ')]);
  assert.equal(finished, 0, 'Do not finish until the remaining words are spoken');
  finishFallback();
  await pending;
  assert.equal(finished, 1);
  assert.ok(vm.runInContext('magpieUnavailableUntil > Date.now()', context), 'Recovery should retain the Magpie cooldown');
});

test('prefetch rejection is handled while the earlier chunk is still playing', async () => {
  const context = fixture(async request => {
    if (request.text === 'Second.') throw new Error('Prefetch failed');
    return { audioBase64: 'AAAAAA==' };
  });
  context.splitIntoSpeechChunks = () => ['First.', 'Second.'];
  let finishChunk;
  let playbackStarted;
  const started = new Promise(resolve => { playbackStarted = resolve; });
  context.playSpeechChunk = () => { playbackStarted(); return new Promise(resolve => { finishChunk = resolve; }); };
  let spoken = '';
  context.speakWithWindowsTts = async (text, callback) => { spoken = text; callback(); };
  const pending = context.speakWithNvidiaTts('First. Second.');
  await started;
  // Let the rejected prefetch sit for an event-loop turn, as it does during audio.
  await new Promise(resolve => setImmediate(resolve));
  finishChunk(true);
  await pending;
  assert.equal(spoken, 'Second.');
});

test('superseding a reply before its later synthesis failure prevents stale fallback and completion', async () => {
  let rejectSecond;
  const context = fixture(request => request.text === 'First.'
    ? Promise.resolve({ audioBase64: 'AAAAAA==' })
    : new Promise((_, reject) => { rejectSecond = reject; }));
  context.splitIntoSpeechChunks = () => ['First.', 'Second.'];
  let playbackStarted;
  const started = new Promise(resolve => { playbackStarted = resolve; });
  context.playSpeechChunk = async () => { playbackStarted(); return true; };
  context.speakWithWindowsTts = () => { throw new Error('Stale fallback ran'); };
  const pending = context.speakWithNvidiaTts('First. Second.', () => { throw new Error('Stale completion ran'); });
  await started;
  context.stopAssistantSpeech();
  rejectSecond(new Error('Late synthesis failure'));
  await pending;
  assert.equal(vm.runInContext('magpieUnavailableUntil', context), 0);
});

test('a superseded local recovery cannot finish the newer turn when its callback arrives late', async () => {
  const context = fixture(async request => {
    if (request.text === 'Second.') throw new Error('Synthesis failed');
    return { audioBase64: 'AAAAAA==' };
  });
  context.splitIntoSpeechChunks = () => ['First.', 'Second.'];
  context.playSpeechChunk = async () => true;
  let fallbackStarted;
  const started = new Promise(resolve => { fallbackStarted = resolve; });
  let lateCompletion;
  context.speakWithWindowsTts = (_text, callback) => {
    fallbackStarted();
    return new Promise(resolve => { lateCompletion = () => { callback(); resolve(true); }; });
  };
  const pending = context.speakWithNvidiaTts('First. Second.', () => { throw new Error('Superseded recovery changed the new turn'); });
  await started;
  context.stopAssistantSpeech();
  lateCompletion();
  await pending;
});

test('playback failure recovers only the failed and remaining chunks, announcing any repeated part', async () => {
  for (const speechStarted of [false, true]) {
    const context = fixture(async () => ({ audioBase64: 'AAAAAA==' }));
    context.splitIntoSpeechChunks = () => ['Completed prefix.', 'Failed part.', 'Remaining part.'];
    let played = 0;
    context.playSpeechChunk = async () => {
      if (++played === 2) throw Object.assign(new Error('Broken audio'), { speechStarted });
      return true;
    };
    let spoken;
    let finished = 0;
    context.speakWithWindowsTts = async (text, callback) => { spoken = text; callback(); };
    await context.speakWithNvidiaTts('Reply.', () => { finished++; });
    assert.equal(spoken, `${speechStarted ? 'The audio was interrupted. Repeating that part. ' : ''}Failed part. Remaining part.`);
    assert.equal(finished, 1);
  }
});

test('deliberate playback interruption does not restart speech in the fallback voice', async () => {
  const context = fixture(async () => ({ audioBase64: 'AAAAAA==' }));
  context.splitIntoSpeechChunks = () => ['First.', 'Second.'];
  context.playSpeechChunk = async () => false;
  context.speakWithWindowsTts = () => { throw new Error('Interrupted speech restarted'); };
  await context.speakWithNvidiaTts('Reply.', () => { throw new Error('Interrupted speech finished'); });
});

test('audio errors reject for recovery, while cancellation resolves as interruption and releases playback resources', async () => {
  for (const mode of ['error', 'playing-error', 'autoplay', 'timeout', 'pause', 'cancel-without-event']) {
    const { context, timers } = acknowledgementFixture();
    const listeners = new Map();
    let audio;
    let revoked = 0;
    context.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: () => { revoked++; } };
    context.Audio = function () {
      audio = this;
      this.currentTime = 0;
      this.addEventListener = (name, callback) => listeners.set(name, callback);
      this.removeEventListener = name => listeners.delete(name);
      this.pause = () => { if (mode !== 'cancel-without-event') listeners.get('pause')?.(); };
      this.play = () => mode === 'autoplay' ? Promise.reject(new Error('Cannot play')) : Promise.resolve();
    };
    const pending = context.playSpeechChunk(new Blob(['audio']), { isFinal: true, onFinal: () => { throw new Error('Failed playback finished'); } });
    if (mode === 'pause' || mode === 'cancel-without-event') {
      if (mode === 'pause') listeners.get('pause')();
      else context.stopAssistantSpeech();
      assert.equal(await pending, false);
    } else {
      const rejection = assert.rejects(pending, error => {
        assert.equal(error.speechStarted, mode === 'playing-error');
        return /Speech audio|Cannot play/.test(error.message);
      });
      if (mode === 'playing-error') { audio.currentTime = 1; listeners.get('playing')(); }
      if (mode === 'error' || mode === 'playing-error') listeners.get('error')({});
      if (mode === 'timeout') [...timers.values()][0].callback();
      await rejection;
    }
    assert.equal(revoked, 1);
    assert.equal(listeners.size, 0);
    assert.equal(context.currentTTSAudio, null);
    if (mode !== 'timeout') assert.equal(timers.size, 0);
  }
});

function acknowledgementFixture() {
  const calls = { spoken: [], cancelled: 0, remote: 0, states: [] };
  const context = fixture(async () => {
    calls.remote++;
    throw new Error('An acknowledgement must not use network synthesis');
  });
  const timers = new Map();
  let timerId = 0;
  context.setTimeout = (callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  };
  context.clearTimeout = id => timers.delete(id);
  context.synthesis = {
    cancel() { calls.cancelled++; },
    getVoices: () => [{ name: 'Microsoft Zira', lang: 'en-US' }],
    speak(utterance) { calls.spoken.push(utterance); }
  };
  context.SpeechSynthesisUtterance = function (text) { this.text = text; };
  context.ttsRate = 1;
  context.isMuted = false;
  context.currentVolume = 0.75;
  context.currentState = 'thinking';
  context.setState = state => { calls.states.push(state); context.currentState = state; };
  return { context, calls, timers };
}

test('acknowledgement starts local speech synchronously and settles only when it ends', async () => {
  const { context, calls, timers } = acknowledgementFixture();
  let settled = false;
  const pending = context.speakAssistantAcknowledgement('On it.').then(result => { settled = true; return result; });
  assert.equal(calls.spoken.length, 1);
  assert.equal(calls.spoken[0].text, 'On it.');
  assert.equal(calls.spoken[0].voice.name, 'Microsoft Zira');
  assert.equal(calls.spoken[0].volume, 0.75);
  assert.equal(calls.remote, 0);
  await Promise.resolve();
  assert.equal(settled, false, 'Final speech must wait for the acknowledgement to finish');
  calls.spoken[0].onend();
  assert.equal(await pending, true);
  assert.equal(timers.size, 0);
  assert.equal(context.currentState, 'thinking');
  assert.deepEqual(calls.states, []);
});

test('acknowledgement does not wait for the Windows voice catalog to load', async () => {
  const { context, calls } = acknowledgementFixture();
  context.synthesis.getVoices = () => [];
  const pending = context.speakAssistantAcknowledgement('On it.');
  assert.equal(calls.spoken.length, 1);
  calls.spoken[0].onend();
  assert.equal(await pending, true);
});

test('stopping speech settles acknowledgement without relying on a Windows cancellation event', async () => {
  const { context, calls, timers } = acknowledgementFixture();
  const pending = context.speakAssistantAcknowledgement('On it.');
  const staleEnd = calls.spoken[0].onend;
  context.stopAssistantSpeech();
  assert.equal(await pending, false);
  assert.equal(timers.size, 0);
  assert.equal(calls.spoken[0].onend, null);
  staleEnd();
  assert.deepEqual(calls.states, []);
});

test('aborting acknowledgement stops it immediately and resolves its promise', async () => {
  const { context, calls, timers } = acknowledgementFixture();
  const controller = new AbortController();
  const pending = context.speakAssistantAcknowledgement('On it.', controller.signal);
  const beforeAbort = calls.cancelled;
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(calls.cancelled, beforeAbort + 1);
  assert.equal(timers.size, 0);
  assert.deepEqual(calls.states, []);
});

test('superseded acknowledgement callbacks and aborts cannot interrupt the newer speech', async () => {
  const { context, calls, timers } = acknowledgementFixture();
  const controller = new AbortController();
  const first = context.speakAssistantAcknowledgement('Old request.', controller.signal);
  const staleEnd = calls.spoken[0].onend;
  const staleError = calls.spoken[0].onerror;
  const staleWatchdog = [...timers.values()][0].callback;
  const second = context.speakAssistantAcknowledgement('New request.');
  assert.equal(await first, false);
  const beforeStaleEvents = calls.cancelled;
  controller.abort();
  staleEnd();
  staleError();
  staleWatchdog();
  assert.equal(await context.speakAssistantAcknowledgement('Old request again.', controller.signal), false);
  assert.equal(calls.cancelled, beforeStaleEvents);
  assert.equal(calls.spoken.length, 2);
  assert.equal(timers.size, 1);
  calls.spoken[1].onend();
  assert.equal(await second, true);
  assert.deepEqual(calls.states, []);
});

test('acknowledgement watchdog releases the final reply if Windows never emits completion', async () => {
  const { context, calls, timers } = acknowledgementFixture();
  const pending = context.speakAssistantAcknowledgement('On it.');
  const watchdog = [...timers.values()][0];
  assert.equal(watchdog.delay, 5000);
  const beforeTimeout = calls.cancelled;
  watchdog.callback();
  assert.equal(await pending, false);
  assert.equal(calls.cancelled, beforeTimeout + 1);
  assert.equal(timers.size, 0);
  assert.deepEqual(calls.states, []);
});

test('muted, empty, or already aborted acknowledgements settle without speech', async () => {
  for (const { settings, text } of [
    { settings: { isTtsMuted: true }, text: 'On it.' },
    { settings: { isMuted: true }, text: 'On it.' },
    { settings: { currentVolume: 0 }, text: 'On it.' },
    { settings: {}, text: '' }
  ]) {
    const { context, calls, timers } = acknowledgementFixture();
    Object.assign(context, settings);
    assert.equal(await context.speakAssistantAcknowledgement(text), false);
    assert.equal(calls.spoken.length, 0);
    assert.equal(calls.cancelled, 0);
    assert.equal(timers.size, 0);
  }
  const { context, calls } = acknowledgementFixture();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await context.speakAssistantAcknowledgement('On it.', controller.signal), false);
  assert.equal(calls.spoken.length, 0);
  assert.equal(calls.cancelled, 0);
});

test('acknowledgement speech failures settle cleanly without changing request state', async () => {
  for (const throwOnSpeak of [false, true]) {
    const { context, calls, timers } = acknowledgementFixture();
    if (throwOnSpeak) context.synthesis.speak = () => { throw new Error('No voice available'); };
    const pending = context.speakAssistantAcknowledgement('On it.');
    if (!throwOnSpeak) calls.spoken[0].onerror({ error: 'synthesis-failed' });
    assert.equal(await pending, false);
    assert.equal(timers.size, 0);
    assert.deepEqual(calls.states, []);
  }
});
