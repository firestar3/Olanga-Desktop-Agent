const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(synthesize) {
  const context = {
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, atob, Blob, Uint8Array, ArrayBuffer, DataView, AbortController,
    window: { electronAPI: { nvidiaTtsSynthesize: synthesize } },
    synthesis: { cancel() {} }, currentTTSAudio: null, nvidiaApiKey: 'test', defaultNvidiaVoiceName: 'Aria',
    isTtsMuted: false, ttsEngine: 'magpie', State: { IDLE: 'idle', THINKING: 'thinking', LISTENING: 'listening', SPEAKING: 'speaking' }, setState() {}, speakingWatchdogTimer: null
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

test('Windows completion handles duplicate native end and error events only once', async () => {
  for (const firstEvent of ['end', 'error']) {
    const { context, calls } = acknowledgementFixture();
    let finished = 0;
    const pending = context.speakWithWindowsTts('Done.', () => { finished++; });
    const { onend, onerror } = calls.spoken[0];
    if (firstEvent === 'end') onend();
    else onerror({ error: 'synthesis-failed' });
    onend();
    onerror({ error: 'synthesis-failed' });
    await pending;
    assert.equal(finished, 1);
    assert.equal(calls.spoken[0].onend, null);
    assert.equal(calls.spoken[0].onerror, null);
  }
});

test('stopping a Windows reply settles without a native event or stale follow-up', async () => {
  const { context, calls, timers } = acknowledgementFixture();
  let finished = 0;
  let result = 'pending';
  const pending = context.speakWithWindowsTts('Done.', () => { finished++; }).then(value => { result = value; });
  const { onend, onerror } = calls.spoken[0];
  context.stopAssistantSpeech();
  await Promise.resolve();
  assert.equal(result, false);
  await pending;
  onend();
  onerror({ error: 'interrupted' });
  assert.equal(finished, 0);
  assert.equal(timers.size, 0);
  assert.equal(calls.spoken[0].onend, null);
  assert.equal(calls.spoken[0].onerror, null);
});

test('Windows cancellation removes pending voice initialization immediately', async () => {
  const { context, calls, timers } = acknowledgementFixture();
  const listeners = new Map();
  context.synthesis.getVoices = () => [];
  context.synthesis.addEventListener = (event, listener) => listeners.set(event, listener);
  context.synthesis.removeEventListener = event => listeners.delete(event);
  const pending = context.speakWithWindowsTts('Done.', () => { throw new Error('Cancelled speech started follow-up'); });
  const staleVoiceEvent = listeners.get('voiceschanged');
  const staleTimer = [...timers.values()][0].callback;
  context.stopAssistantSpeech();
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
  assert.equal(await pending, false);
  staleVoiceEvent();
  staleTimer();
  assert.equal(calls.spoken.length, 0);
});

test('late Windows events cannot settle or cancel the newer reply', async () => {
  const { context, calls } = acknowledgementFixture();
  const first = context.speakWithWindowsTts('Old reply.', () => { throw new Error('Stale follow-up'); });
  const staleEnd = calls.spoken[0].onend;
  const staleError = calls.spoken[0].onerror;
  context.stopAssistantSpeech();
  let finished = 0;
  const second = context.speakWithWindowsTts('New reply.', () => { finished++; });
  staleEnd();
  staleError({ error: 'interrupted' });
  assert.equal(await first, false);
  assert.equal(finished, 0);
  context.stopAssistantSpeech();
  assert.equal(await second, false, 'The new reply must still own its cancellation hook');
  assert.equal(finished, 0);
});

test('Windows fallback cancellation settles the selected-engine promise without follow-up', async () => {
  const { context, calls } = acknowledgementFixture();
  context.window.electronAPI.nvidiaTtsSynthesize = async () => { throw new Error('Unavailable'); };
  let finished = 0;
  const pending = context.speakWithSelectedEngine('Done.', () => { finished++; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.spoken.length, 1);
  context.stopAssistantSpeech();
  await pending;
  assert.equal(finished, 0);
});

test('a Windows watchdog settles the reply even when cancellation emits no native event', async () => {
  const { context, calls, timers } = acknowledgementFixture();
  context.ttsEngine = 'windows';
  context.State.SPEAKING = 'speaking';
  let finished = 0;
  const pending = context.speakResponseAndThen('Done.', () => { finished++; });
  assert.equal(calls.spoken.length, 1);
  const [timerId, timer] = [...timers.entries()][0];
  timers.delete(timerId);
  timer.callback();
  await pending;
  assert.equal(finished, 0);
  assert.equal(context.currentState, 'idle');
  assert.equal(calls.spoken[0].onend, null);
});

test('the Magpie recovery watchdog settles Windows fallback with one completion', async () => {
  const { context, calls, timers } = acknowledgementFixture();
  context.window.electronAPI.nvidiaTtsSynthesize = async request => {
    if (request.text === 'Second.') throw new Error('Unavailable');
    return { audioBase64: 'AAAAAA==' };
  };
  context.splitIntoSpeechChunks = () => ['First.', 'Second.'];
  context.playSpeechChunk = async () => true;
  let finished = 0;
  const pending = context.speakWithNvidiaTts('First. Second.', () => { finished++; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.spoken.length, 1);
  const staleEnd = calls.spoken[0].onend;
  const [timerId, timer] = [...timers.entries()][0];
  timers.delete(timerId);
  timer.callback();
  await pending;
  staleEnd();
  assert.equal(finished, 1);
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

test('contextual acknowledgement allows the selected slow speech rate and still has a bounded watchdog', async () => {
  const { context, calls, timers } = acknowledgementFixture();
  context.ttsRate = 0.8;
  let settled = false;
  const pending = context.speakAssistantAcknowledgement("I'll start Spotify and set the volume to 75 percent.").then(result => { settled = true; return result; });
  assert.equal(calls.spoken.length, 1, 'Context speech still starts synchronously');
  assert.equal(calls.spoken[0].rate, 0.8);
  const watchdog = [...timers.values()][0];
  assert.ok(watchdog.delay > 5000 && watchdog.delay <= 12000);
  await Promise.resolve(); assert.equal(settled, false);
  calls.spoken[0].onend(); assert.equal(await pending, true);
  assert.equal(timers.size, 0); assert.equal(calls.remote, 0);

  const stalled = context.speakAssistantAcknowledgement('word '.repeat(100));
  assert.equal([...timers.values()][0].delay, 12000);
  [...timers.values()][0].callback(); assert.equal(await stalled, false);
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

function addMuteControls(context) {
  Object.assign(context, {
    micToggleBtn: null, ttsToggleBtn: null, micIconOn: null, micIconOff: null, ttsIconOn: null, ttsIconOff: null,
    isMicMuted: false, micStream: null,
    localStorage: { getItem: () => null, setItem: () => { throw new Error('Storage full'); } }, showError() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/audio-controls.js'), 'utf8'), context);
}

test('muting speech cancels native playback immediately without relying on storage or end events', async () => {
  const { context, calls, timers } = acknowledgementFixture(); addMuteControls(context);
  context.ttsEngine = 'windows';
  let followUps = 0;
  const response = context.speakResponseAndThen('Which playlist?', () => { followUps++; });
  const lateEnd = calls.spoken[0].onend;
  context.muteTts(); await response;
  assert.equal(context.isTtsMuted, true); assert.equal(context.currentState, 'idle');
  assert.equal(followUps, 0); assert.equal(timers.size, 0);
  lateEnd(); assert.equal(followUps, 0);
  context.unmuteTts(); context.currentState = 'thinking';
  const acknowledgement = context.speakAssistantAcknowledgement('On it.');
  context.muteTts(); assert.equal(await acknowledgement, false);
  assert.equal(context.currentState, 'thinking', 'muting an acknowledgement must not stop the working request');
});

test('muting during pending Magpie synthesis settles immediately and discards its late audio', async () => {
  const { context, calls } = acknowledgementFixture(); addMuteControls(context);
  let finishAudio, played = 0;
  context.window.electronAPI.nvidiaTtsSynthesize = () => new Promise(resolve => { finishAudio = resolve; });
  context.playSpeechChunk = async () => { played++; return true; };
  let settled = false, followUps = 0;
  const response = context.speakResponseAndThen('The result is ready.', () => { followUps++; }).then(() => { settled = true; });
  context.muteTts();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true, 'cancellation must not wait for a provider response or timeout');
  finishAudio({ audioBase64: 'AAAAAA==' }); await response;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(played, 0); assert.equal(calls.spoken.length, 0); assert.equal(followUps, 0);
});

test('a stale speech wrapper failure cannot change the next request or start its old follow-up', async () => {
  for (const method of ['speakResponse', 'speakResponseAndThen']) {
    const { context, calls } = acknowledgementFixture();
    let fail, followUps = 0; const errors = [];
    context.showError = message => errors.push(message);
    context.speakWithSelectedEngine = () => new Promise((_, reject) => { fail = reject; });
    const pending = context[method]('Old reply', () => { followUps++; });
    context.stopAssistantSpeech(); context.currentState = 'thinking';
    fail(new Error('Old engine failure')); await pending;
    assert.equal(context.currentState, 'thinking'); assert.equal(followUps, 0);
    assert.equal(errors.length, 0); assert.deepEqual(calls.states, ['speaking']);
  }
});

test('failure constructing or configuring an audio element revokes its allocated object URL', async () => {
  for (const failure of ['constructor', 'volume']) {
    const { context } = acknowledgementFixture(); let revoked = 0;
    context.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: () => { revoked++; } };
    context.Audio = function () {
      if (failure === 'constructor') throw new Error('Player unavailable');
      Object.defineProperty(this, 'volume', { set() { throw new Error('Player unavailable'); } });
    };
    await assert.rejects(context.playSpeechChunk(new Blob(['audio']), { isFinal: false }), /Player unavailable/);
    assert.equal(revoked, 1); assert.equal(context.currentTTSAudio, null);
  }
});

test('a voice preference write failure preserves the selected engine and full voice catalog', () => {
  const { context } = acknowledgementFixture();
  const select = { options: [], value: '', appendChild(option) { this.options.push(option); }, set innerHTML(value) { this.options = []; } };
  Object.assign(context, {
    nvidiaVoiceSelect: select, nvidiaVoiceName: 'Magpie-Multilingual.EN-US.Jason', nvidiaVoiceCatalog: [],
    defaultNvidiaVoiceName: 'Magpie-Multilingual.EN-US.Sofia', ttsEngineSelect: { value: '' }, magpieVoiceSettings: { style: {} },
    document: { createElement: () => ({}) }, localStorage: { setItem() { throw new Error('Storage full'); } }
  });
  assert.doesNotThrow(() => context.refreshVoiceCatalog());
  assert.equal(select.options.length, 10); assert.equal(context.nvidiaVoiceName, 'Magpie-Multilingual.EN-US.Jason');
  assert.doesNotThrow(() => context.setTtsEngine('windows'));
  assert.equal(context.ttsEngine, 'windows'); assert.equal(context.ttsEngineSelect.value, 'windows');
});


test('Windows playback onset is emitted only by the first native start event', async () => {
  const { context, calls } = acknowledgementFixture(); let starts = 0;
  const pending = context.speakWithWindowsTts('Done.', null, { onStart: () => starts++ });
  assert.equal(starts, 0); const { onstart, onend } = calls.spoken[0];
  onstart(); onstart(); assert.equal(starts, 1); onend(); await pending; onstart(); assert.equal(starts, 1);
});

test('a cancelled native voice cannot emit stale playback onset', async () => {
  const { context, calls } = acknowledgementFixture(); let starts = 0;
  const pending = context.speakWithWindowsTts('Done.', null, { onStart: () => starts++ });
  const onset = calls.spoken[0].onstart; context.stopAssistantSpeech(); onset();
  assert.equal(await pending, false); assert.equal(starts, 0);
});

test('response wrapper distinguishes a failed voice from a completed response', async () => {
  const { context, calls } = acknowledgementFixture(); context.ttsEngine = 'windows'; context.showError = () => {};
  const pending = context.speakResponse('Done.'); calls.spoken[0].onerror({ error: 'synthesis-failed' });
  assert.equal((await pending).status, 'failed');
});


test('acknowledgment exposes actual voice start once and ignores late start after cancellation', async () => {
  const { context, calls } = acknowledgementFixture();
  const controller = new AbortController();
  let starts=0;
  const pending=context.speakAssistantAcknowledgement('Opening Spotify.',controller.signal,{onStart:()=>starts++});
  const utterance=calls.spoken[0], started=utterance.onstart;
  started(); started(); assert.equal(starts,1);
  controller.abort(); await pending;
  assert.equal(utterance.onstart,null);
  started(); assert.equal(starts,1);
});


test('a verified result prepares during acknowledgment and hands the same first audio to playback once', async () => {
  const { context, calls } = acknowledgementFixture();
  const requested = [], played = []; let finishAudio;
  context.window.electronAPI.nvidiaTtsSynthesize = request => { requested.push(request.text); return new Promise(resolve => { finishAudio = resolve; }); };
  context.playSpeechChunk = async (blob, options) => { played.push(blob); options.onStart?.(); if (options.isFinal) options.onFinal(); return true; };
  const controller = new AbortController();
  const acknowledgement = context.speakAssistantAcknowledgement('I will open Spotify and set volume.', controller.signal);
  const preparedSpeech = context.prepareAssistantResponseSpeech('Spotify is open. System volume is 75%.', { signal: controller.signal });
  assert.equal(requested.length, 1, 'Synthesis starts while the acknowledgment is pending');
  assert.equal(played.length, 0, 'Preparation never starts playback');
  assert.equal(calls.spoken.length, 1); assert.equal(typeof calls.spoken[0].onend, 'function');
  // Audio may be ready first; only the owner starts it after the acknowledgment.
  finishAudio({ audioBase64: 'AAAAAA==' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(played.length, 0); calls.spoken[0].onend(); await acknowledgement;
  assert.equal((await context.speakResponse('Spotify is open. System volume is 75%.', { preparedSpeech })).status, 'completed');
  assert.equal(requested.length, 1); assert.equal(played.length, 1);
  assert.equal((await context.speakResponse('Spotify is open. System volume is 75%.', { preparedSpeech })).status, 'cancelled');
  assert.equal(requested.length, 1, 'A consumed handle cannot synthesize or play again');
  assert.equal(vm.runInContext('pendingAssistantResponses.size', context), 0);
  assert.equal(vm.runInContext('magpieAudioCache.size', context), 1, 'Only this generic verified receipt enters the existing cache');
});

test('preparation covers a long first chunk without generating duplicate audio', async () => {
  const context = fixture(async request => { requests.push(request.text); return { audioBase64: 'AAAAAA==' }; });
  const requests = [], played = [];
  const first = 'Verified result '.repeat(15).trim() + '.', second = 'The next result is ready.';
  context.splitIntoSpeechChunks = () => [first, second];
  context.playSpeechChunk = async (blob, options) => { played.push(blob); if (options.isFinal) options.onFinal(); return true; };
  const text = first + ' ' + second, preparedSpeech = context.prepareAssistantResponseSpeech(text);
  assert.deepEqual(requests, [first]);
  assert.equal((await context.speakResponse(text, { preparedSpeech })).status, 'completed');
  assert.deepEqual(requests, [first, second]); assert.equal(played.length, 2);
});

test('a prefetch failure is reused for the normal Windows fallback without a second provider call', async () => {
  const { context, calls } = acknowledgementFixture(); let requests = 0;
  context.window.electronAPI.nvidiaTtsSynthesize = async () => { requests++; throw new Error('Unavailable'); };
  const preparedSpeech = context.prepareAssistantResponseSpeech('Playback resumed.');
  await new Promise(resolve => setImmediate(resolve));
  const pending = context.speakResponse('Playback resumed.', { preparedSpeech });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1); assert.equal(calls.spoken.length, 1);
  calls.spoken[0].onend(); assert.equal((await pending).status, 'completed');
  assert.equal(vm.runInContext('pendingAssistantResponses.size', context), 0);
});

test('cancelled, muted and superseded result preparations discard late audio and cannot replay', async () => {
  for (const mode of ['abort', 'stop', 'mute', 'supersede']) {
    const { context, calls, timers } = acknowledgementFixture(); let finishAudio, requests = 0, decoded = 0;
    context.window.electronAPI.nvidiaTtsSynthesize = () => { requests++; return new Promise(resolve => { finishAudio = resolve; }); };
    context.decodeBase64ToUint8Array = () => { decoded++; return new Uint8Array([0, 0]); };
    const controller = new AbortController(), preparedSpeech = context.prepareAssistantResponseSpeech('A private result with useful detail. '.repeat(7).trim(), { signal: controller.signal });
    if (mode === 'abort') controller.abort();
    else if (mode === 'stop') context.stopAssistantSpeech();
    else if (mode === 'mute') { context.isTtsMuted = true; context.stopAssistantSpeech(); }
    else context.speakAssistantAcknowledgement('The next task.');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(vm.runInContext('pendingAssistantResponses.size', context), 0, mode);
    finishAudio({ audioBase64: 'AAAAAA==' }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(decoded, 0, mode); assert.equal(requests, 1, mode);
    assert.equal((await context.speakResponse('A private result with useful detail. '.repeat(7).trim(), { preparedSpeech })).status, 'cancelled', mode);
    assert.equal(requests, 1, mode); context.stopAssistantSpeech();
    assert.equal(timers.size, 0, mode);
  }
});

test('cancellation while a prepared first chunk is awaiting synthesis never starts a fallback', async () => {
  const { context, calls } = acknowledgementFixture(); let finishAudio;
  context.window.electronAPI.nvidiaTtsSynthesize = () => new Promise(resolve => { finishAudio = resolve; });
  const controller = new AbortController(), preparedSpeech = context.prepareAssistantResponseSpeech('A private result with useful detail. '.repeat(7).trim(), { signal: controller.signal });
  const pending = context.speakResponse('A private result with useful detail. '.repeat(7).trim(), { preparedSpeech });
  controller.abort(); assert.equal((await pending).status, 'cancelled');
  finishAudio({ audioBase64: 'AAAAAA==' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.spoken.length, 0); assert.equal(vm.runInContext('magpieUnavailableUntil', context), 0);
});

test('voice or key changes cannot reuse preparation for the previous selection', async () => {
  for (const mode of ['voice', 'key']) {
    const { context } = acknowledgementFixture(); const requests = [];
    context.window.electronAPI.nvidiaTtsSynthesize = async request => { requests.push(request); return { audioBase64: 'AAAAAA==' }; };
    context.playSpeechChunk = async (_blob, options) => { if (options.isFinal) options.onFinal(); return true; };
    const text = 'A verified private result with context. '.repeat(7).trim();
    context.splitIntoSpeechChunks = () => [text];
    const preparedSpeech = context.prepareAssistantResponseSpeech(text);
    if (mode === 'voice') context.getSelectedNvidiaVoiceConfig = () => ({ voiceName: 'Jason', languageCode: 'en-US' });
    else context.nvidiaApiKey = 'replacement';
    const result = await context.speakResponse(text, { preparedSpeech });
    assert.equal(result.status, 'completed');
    assert.equal(requests.length, 2);
    assert.equal(mode === 'voice' ? requests[1].voiceName : requests[1].apiKey, mode === 'voice' ? 'Jason' : 'replacement');
  }
});

test('disabled or unconfigured Magpie preparation is a no-op', () => {
  for (const mode of ['windows', 'muted', 'no-key', 'aborted', 'empty']) {
    let requests = 0; const context = fixture(() => { requests++; throw new Error('Unexpected synthesis'); });
    const controller = new AbortController();
    if (mode === 'windows') context.ttsEngine = 'windows';
    if (mode === 'muted') context.isTtsMuted = true;
    if (mode === 'no-key') context.nvidiaApiKey = '';
    if (mode === 'aborted') controller.abort();
    assert.equal(context.prepareAssistantResponseSpeech(mode === 'empty' ? '' : 'Done.', { signal: controller.signal }), null, mode);
    assert.equal(requests, 0, mode);
  }
});


test('overlapping result synthesis removes acknowledgment time from the critical path', async () => {
  async function scenario(prefetch) {
    const { context, calls } = acknowledgementFixture();
    const timers = new Map(); let now = 0, nextId = 0, requests = 0, firstAudioAt = null;
    context.setTimeout = (callback, delay) => { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; };
    context.clearTimeout = id => timers.delete(id);
    context.window.electronAPI.nvidiaTtsSynthesize = () => { requests++; return new Promise(resolve => context.setTimeout(() => resolve({ audioBase64: 'AAAAAA==' }), 800)); };
    context.playSpeechChunk = async (_blob, options) => { firstAudioAt ??= now; if (options.isFinal) options.onFinal(); return true; };
    const acknowledgement = context.speakAssistantAcknowledgement('Opening Spotify.');
    context.setTimeout(() => calls.spoken[0].onend(), 500);
    const preparedSpeech = prefetch ? context.prepareAssistantResponseSpeech('Spotify is open.') : null;
    const complete = acknowledgement.then(() => context.speakResponse('Spotify is open.', { preparedSpeech }));
    async function advance(to) {
      now = to;
      for (;;) {
        const next = [...timers.entries()].filter(([, item]) => item.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); next[1].callback(); await new Promise(resolve => setImmediate(resolve));
      }
      await new Promise(resolve => setImmediate(resolve));
    }
    await advance(500); assert.equal(firstAudioAt, null, 'Result never overlaps acknowledgment playback');
    await advance(800); if (prefetch) assert.equal(firstAudioAt, 800); else assert.equal(firstAudioAt, null);
    await advance(1300); assert.equal((await complete).status, 'completed');
    assert.equal(requests, 1); assert.equal(timers.size, 0);
    return firstAudioAt;
  }
  assert.equal(await scenario(false), 1300);
  assert.equal(await scenario(true), 800);
});


test('explicit generic receipts retain one-call cache reuse across preparation and repeated commands', async () => {
  const { context } = acknowledgementFixture(); let requests = 0;
  context.window.electronAPI.nvidiaTtsSynthesize = async () => { requests++; return { audioBase64: 'AAAAAA==' }; };
  context.playSpeechChunk = async (_blob, options) => { if (options.isFinal) options.onFinal(); return true; };
  const text = 'Spotify is open. System volume is 75%.';
  for (let turn = 0; turn < 3; turn++) {
    context.stopAssistantSpeech();
    const preparedSpeech = context.prepareAssistantResponseSpeech(text, {});
    assert.equal((await context.speakResponse(text, { preparedSpeech })).status, 'completed');
  }
  assert.equal(requests, 1, 'Repeating a safe receipt keeps the existing cache benefit');
  assert.equal(vm.runInContext('magpieAudioCache.size', context), 1);
  // A preexisting normal-playback cache entry is also shared by preparation.
  await context.getMagpieAudio('System audio is muted.', { voiceName: 'Aria', languageCode: 'en-US' });
  const preparedSpeech = context.prepareAssistantResponseSpeech('System audio is muted.', {});
  assert.equal((await context.speakResponse('System audio is muted.', { preparedSpeech })).status, 'completed');
  assert.equal(requests, 2);
});

test('short nongeneric replies retain normal cache behavior and do not issue a prefetch', async () => {
  for (const text of ['You live in Boston.', 'Added "Call my doctor" to your checklist.', 'Your private playlist is playing now.', 'System volume is 75%. You live in Boston.', 'Secret project is open.']) {
    const { context } = acknowledgementFixture(); let requests = 0;
    context.window.electronAPI.nvidiaTtsSynthesize = async () => { requests++; return { audioBase64: 'AAAAAA==' }; };
    context.playSpeechChunk = async (_blob, options) => { if (options.isFinal) options.onFinal(); return true; };
    for (let turn = 0; turn < 2; turn++) {
      const preparedSpeech = context.prepareAssistantResponseSpeech(text);
      assert.equal(preparedSpeech, null, text);
      assert.equal((await context.speakResponse(text, { preparedSpeech })).status, 'completed');
    }
    assert.equal(requests, 1, text);
  }
});

test('memory-sensitive receipts never enter the prepared generic cache', () => {
  const { context } = acknowledgementFixture(); let requests = 0;
  context.window.electronAPI.nvidiaTtsSynthesize = async () => { requests++; return { audioBase64: 'AAAAAA==' }; };
  assert.equal(context.prepareAssistantResponseSpeech('System volume is 75%.', { memorySensitive: true }), null);
  assert.equal(requests, 0); assert.equal(vm.runInContext('magpieAudioCache.size', context), 0);
});

test('a long personal reply with an ordinarily cached short first chunk also preserves normal reuse', async () => {
  const { context } = acknowledgementFixture(); let requests = 0;
  const text = 'A short personal sentence. ' + 'Additional useful detail. '.repeat(15);
  context.splitIntoSpeechChunks = () => ['A short personal sentence.', 'Additional useful detail.'];
  context.window.electronAPI.nvidiaTtsSynthesize = async () => { requests++; return { audioBase64: 'AAAAAA==' }; };
  context.playSpeechChunk = async (_blob, options) => { if (options.isFinal) options.onFinal(); return true; };
  for (let turn = 0; turn < 2; turn++) {
    const preparedSpeech = context.prepareAssistantResponseSpeech(text);
    assert.equal(preparedSpeech, null);
    assert.equal((await context.speakResponse(text, { preparedSpeech })).status, 'completed');
  }
  assert.equal(requests, 2);
});


test('streamed confirmation suffix survives trailing whitespace without repeating the streamed answer', async () => {
  for (const whitespace of [' ', '  ', '\n', '\r\n', '\t', ' \n ']) {
    const context = fixture(async () => { throw new Error('Provider must not run'); });
    const spoken = [];
    context.OlangaConversation = require('../../shared/conversation');
    context.ttsEngine = 'windows'; context.ttsRate = 1;
    context.speakWithWindowsTts = async text => { spoken.push(text); return true; };
    const stream = context.createSpeechStream();
    stream.push('Boston grew around its harbor.' + whitespace);
    const answer = 'Boston grew around its harbor.\n\nShould I replace your saved city?';
    assert.equal(await stream.end(answer), true);
    assert.deepEqual(spoken, ['Boston grew around its harbor.', 'Should I replace your saved city?'], JSON.stringify(whitespace));
    assert.equal(await stream.end(answer), true);
    assert.equal(spoken.length, 2, 'Repeated completion must never replay either sentence');
  }
});

test('stream completion cannot reinterpret changed prefix text as an unheard suffix', async () => {
  const context = fixture(async () => { throw new Error('Provider must not run'); });
  const spoken = [];
  context.OlangaConversation = require('../../shared/conversation');
  context.ttsEngine = 'windows'; context.ttsRate = 1;
  context.speakWithWindowsTts = async text => { spoken.push(text); return true; };
  const stream = context.createSpeechStream();
  stream.push('Boston is warm. ');
  assert.equal(await stream.end('Boston is cold. Should I change your memory?'), true);
  assert.deepEqual(spoken, ['Boston is warm.']);
});
