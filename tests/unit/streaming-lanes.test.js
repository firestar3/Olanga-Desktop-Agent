const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// A real assistant.js with scripted provider streams, a recording speech
// stream and no network. Replies arrive in small chunks like SSE updates.
function harness({ interrupted = false, failedSpeech = false, truncated = false, replies = [] } = {}) {
  const calls = { streams: [], generates: [], opened: [], acks: [], followUps: 0, states: [], errors: [], transcriptions: 0, audioRouter: 0, router: 0 };
  const speech = { pushed: [], ended: null, cancelled: 0 };
  const node = () => ({ textContent: '', classList: { add() {}, remove() {} } });
  const storage = new Map();
  const context = vm.createContext({
    AbortController, DOMException, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} },
    OlangaGemini: require('../../shared/gemini-request'), OlangaIntents: require('../../shared/fast-intents'), OlangaConversation: require('../../shared/conversation'),
    window: { electronAPI: {
      openApp: async name => { calls.opened.push(name); return { ok: true, verified: true, message: `${name} is open.` }; },
      providerStream: async (payload, onText) => {
        calls.streams.push(payload);
        const chunks = replies.shift() || ['I have no scripted reply.'];
        for (const chunk of chunks) { await Promise.resolve(); onText(chunk); }
        return { ok: true, text: chunks.join(''), keyIndex: 0, truncated };
      },
      providerGenerate: async payload => { calls.generates.push(payload); return { ok: true, text: 'unused', keyIndex: 0 }; }
    } },
    apiKey: 'test-key', apiKeys: ['test-key'], currentKeyIndex: 0, streamRepliesEnabled: true,
    State: { THINKING: 'thinking', IDLE: 'idle', LISTENING: 'listening', SPEAKING: 'speaking' },
    setState(state) { calls.states.push(state); context.currentState = state; }, currentState: 'idle',
    isMicMuted: false, micStream: null, activeTasks: [], conversationHistory: [], isRecording: false, followUpTimer: null,
    userText: node(), aiText: node(), transcriptUser: node(), transcriptAi: node(), hint: node(), userCity: 'Seattle', userState: '', userCountry: '',
    speakAssistantAcknowledgement: async text => { calls.acks.push(text); return true; },
    speakResponse: message => { calls.spoken = [...(calls.spoken || []), message]; },
    speakResponseAndThen: async (message, callback) => { calls.spoken = [...(calls.spoken || []), message]; callback(); },
    showError: message => calls.errors.push(message),
    createSpeechStream: () => ({ failed: failedSpeech, push: text => speech.pushed.push(text), end: async text => { speech.ended = text; return !interrupted && !failedSpeech; }, cancel: () => { speech.cancelled++; } }),
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/assistant.js'), 'utf8'), context);
  const store = require('../../shared/productivity').createStore(context.localStorage);
  context.window.OlangaWorkspace = context.window.OlangaActivity = store;
  context.enterAiFollowUpMode = () => { calls.followUps++; };
  context.blobToBase64 = async () => 'YWJj';
  context.transcribeAssistantAudio = async () => { calls.transcriptions++; return 'transcribed request'; };
  context.sendAudioToGemini = async () => { calls.audioRouter++; return 'USER_SAID: put on some jazz\nRESPONSE: [SPOTIFY_PLAYLIST: jazz]'; };
  context.sendTextToGemini = async () => { calls.router++; return 'RESPONSE: Routed answer.'; };
  return { context, calls, speech, store };
}
const history = context => context.recentConversation().map(message => `${message.role}: ${message.text}`);
// Values created inside the vm context have their own prototypes.
const plain = value => JSON.parse(JSON.stringify(value));

test('a typed question streams a spoken answer without the router or a spoken acknowledgment', async () => {
  const { context, calls, speech, store } = harness({ replies: [['Canberra is ', 'the capital of Australia.']] });
  await context.processTextCommandWithGemini('What is the capital of Australia?');
  assert.equal(calls.streams.length, 1);
  assert.equal(calls.streams[0].model, 'gemini-3.5-flash-lite');
  assert.match(calls.streams[0].body.system_instruction.parts[0].text, /reply with exactly \[ROUTE\]/);
  assert.equal(calls.streams[0].body.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
  assert.deepEqual(speech.pushed, ['Canberra is ', 'the capital of Australia.']);
  assert.equal(speech.ended, 'Canberra is the capital of Australia.');
  assert.deepEqual(calls.acks, []);
  assert.equal(calls.router, 0);
  assert.deepEqual(history(context), ['user: What is the capital of Australia?', 'model: Canberra is the capital of Australia.']);
  assert.equal(calls.states.at(-1), 'idle');
  assert.equal(store.snapshot().activity.at(-1).state, 'completed');
});

test('answer-lane escapes speak nothing, acknowledge late, and continue in the router or Google Search', async () => {
  const routed = harness({ replies: [['RES', 'PONSE: [RO', 'UTE]']] });
  await routed.context.processTextCommandWithGemini('Could you tell me how to reorganize my week?');
  assert.deepEqual(routed.speech.pushed, []);
  assert.equal(routed.calls.router, 1);
  assert.deepEqual(routed.calls.acks, ['On it.']);
  const searched = harness({ replies: [['[SEARCH]'], ['Sunny and ', '72 degrees.']] });
  await searched.context.processTextCommandWithGemini('How warm is it in Paris right now?');
  assert.equal(searched.calls.streams.length, 2);
  assert.deepEqual(plain(searched.calls.streams[1].body.tools), [{ google_search: {} }]);
  assert.equal(searched.speech.ended, 'Sunny and 72 degrees.');
  assert.equal(searched.calls.router, 0);
});

test('truncated typed and spoken streams fail without replaying their already delivered prefix', async () => {
  for (const spoken of [false, true]) {
    const prefix = 'A black hole forms when a massive star collapses. ';
    const chunks = spoken ? ['USER_SAID: How does a black hole form?\nRESPONSE: ', prefix, 'The next step is'] : [prefix, 'The next step is'];
    const { context, calls, speech, store } = harness({ truncated: true, replies: [chunks] });
    if (spoken) await context.processAudioBlobWithGemini({}, { rough: 'how does a black hole form' });
    else await context.processTextCommandWithGemini('How does a black hole form?');
    assert.deepEqual(speech.pushed, [prefix, 'The next step is']);
    assert.equal(speech.ended, null, 'The incomplete stream cannot finish as a successful answer');
    assert.equal(speech.cancelled, 1);
    assert.equal(calls.streams.length, 1);
    assert.equal(calls.router, 0, 'A truncated answer must not replay the request through another model');
    assert.equal(store.snapshot().activity.at(-1).state, 'failed');
    assert.match(context.aiText.textContent, /answer was cut off at the response limit/);
    assert.equal(calls.spoken.length, 1);
    assert.doesNotMatch(calls.spoken[0], /massive star|next step/);
    assert.match(calls.spoken[0], /answer was cut off/);
    assert.equal(calls.followUps, 0);
    assert.ok(history(context).every(message => !message.includes('The next step is')));
  }
});

test('speech playback failure preserves the answer text and reports failed without retry or follow-up', async () => {
  const text = 'Canberra is the capital. Anything else?';
  const { context, calls, speech, store } = harness({ failedSpeech: true, replies: [[text]] });
  await context.processTextCommandWithGemini('What is the capital of Australia?');
  assert.equal(context.aiText.textContent, text);
  assert.equal(speech.ended, text);
  assert.equal(store.snapshot().activity.at(-1).state, 'failed');
  assert.match(calls.errors.at(-1), /Speech stopped before the answer finished/);
  assert.equal(calls.spoken, undefined, 'Do not replay the text or a voice error through a failed engine');
  assert.equal(calls.states.at(-1), 'idle');
  assert.equal(calls.followUps, 0);
});

test('live questions go straight to streamed Google Search and follow-up questions keep the microphone open', async () => {
  const { context, calls, speech } = harness({ replies: [['Rain is likely today. ', 'Want the hourly forecast?']] });
  await context.processTextCommandWithGemini("What's the weather today?");
  assert.equal(calls.streams.length, 1);
  assert.deepEqual(plain(calls.streams[0].body.tools), [{ google_search: {} }]);
  assert.deepEqual(calls.acks, ['On it.'], 'Search keeps the spoken acknowledgment while it looks things up');
  assert.equal(speech.ended, 'Rain is likely today. Want the hourly forecast?');
  assert.equal(calls.followUps, 1);
  assert.equal(calls.router, 0);
});

test('a spoken question skips transcription and speaks only after its transcript is verified', async () => {
  const { context, calls, speech } = harness({ replies: [['USER_SAID: What is the capital', ' of Australia?\nRESPONSE: Canberra', ' is the capital.']] });
  await context.processAudioBlobWithGemini({}, { rough: 'what is the capital of australia' });
  assert.equal(calls.transcriptions, 0); assert.equal(calls.router, 0);
  assert.equal(calls.streams[0].body.contents[0].parts[0].inline_data.mime_type, 'audio/wav');
  assert.equal(context.userText.textContent, 'What is the capital of Australia?');
  assert.deepEqual(speech.pushed, ['Canberra', ' is the capital.']);
  assert.deepEqual(calls.acks, []);
  assert.deepEqual(history(context), ['user: What is the capital of Australia?', 'model: Canberra is the capital.']);
});

test('a spoken transcript that turns out to be a local command leaves the lane and runs locally once', async () => {
  const { context, calls, speech } = harness({ replies: [['USER_SAID: open notepad\nRESPONSE: Sure, opening it.']] });
  await context.processAudioBlobWithGemini({}, { rough: 'how do i get notepad' });
  assert.deepEqual(calls.opened, ['notepad']);
  assert.deepEqual(speech.pushed, []);
  assert.equal(calls.transcriptions, 0); assert.equal(calls.router, 0);
  assert.deepEqual(history(context), ['user: open notepad', 'model: notepad is open.']);
  const silent = harness({ replies: [['USER_SAID: [SILENCE]']] });
  await silent.context.processAudioBlobWithGemini({}, { rough: 'who is he' });
  assert.equal(silent.context.aiText.textContent, 'I didn’t catch that. Please try again.');
  assert.deepEqual(silent.speech.pushed, []);
});

test('spoken tool requests use one router call on the recording, and local commands keep transcription first', async () => {
  const routed = harness();
  let dispatched = null;
  routed.context.respondToAssistantInput = async (response, goal) => { dispatched = [response, goal]; };
  await routed.context.processAudioBlobWithGemini({}, { rough: 'put on some jazz' });
  assert.equal(routed.calls.audioRouter, 1);
  assert.equal(routed.calls.transcriptions, 0); assert.equal(routed.calls.router, 0);
  assert.deepEqual(dispatched, ['[SPOTIFY_PLAYLIST: jazz]', 'put on some jazz']);
  const local = harness();
  await local.context.processAudioBlobWithGemini({}, { rough: 'open notepad' });
  assert.equal(local.calls.transcriptions, 1);
  assert.equal(local.calls.streams.length + local.calls.audioRouter, 0);
});

test('pending clarifications, disabled streaming and interrupted replies keep their existing behavior', async () => {
  const pending = harness();
  vm.runInContext("pendingActionClarification = { goal: 'x', allowedNames: ['COMPLETE_TASK'], question: 'Which?' }", pending.context);
  await pending.context.processTextCommandWithGemini('What is the capital of France?');
  assert.equal(pending.calls.streams.length, 0); assert.equal(pending.calls.router, 1);
  const disabled = harness();
  disabled.context.streamRepliesEnabled = false;
  await disabled.context.processTextCommandWithGemini('What is the capital of France?');
  await disabled.context.processAudioBlobWithGemini({}, { rough: 'what is the capital of france' });
  assert.equal(disabled.calls.streams.length, 0); assert.equal(disabled.calls.transcriptions, 1);
  const interrupted = harness({ interrupted: true, replies: [['A long answer. ']] });
  await interrupted.context.processTextCommandWithGemini('Tell me about Rome');
  assert.notEqual(interrupted.calls.states.at(-1), 'idle', 'A barge-in owns the state after an interrupted reply');
  assert.equal(interrupted.calls.followUps, 0);
});

function routed(response, specialistCommands = []) {
  const fixture = harness();
  const { context, calls } = fixture;
  calls.spotify = []; calls.media = []; calls.specialist = 0;
  context.sendTextToGemini = async () => `RESPONSE: ${response}`;
  const proposal = specialistCommands.length ? { kind: 'commands', commands: specialistCommands } : { kind: 'clarify', question: 'Which one do you mean?', commands: [] };
  context.callGeminiSpecialist = async purpose => { if (purpose === 'reasoning') calls.specialist++; return purpose === 'reasoning' ? JSON.stringify(proposal) : 'Which one do you mean?'; };
  Object.assign(context.window.electronAPI, {
    playSpotify: async (type, term) => { calls.spotify.push(`${type}: ${term}`); return { ok: true, verified: true, source: 'spotify', message: `Playing ${term}.` }; },
    mediaControl: async (command, _spotify, level) => { calls.media.push(level === undefined ? command : `${command} ${level}`); return { ok: true, verified: true, message: `Volume is ${level}%.` }; }
  });
  return fixture;
}

test('grounded, low-risk router actions dispatch without the second model call', async () => {
  const artist = routed('Sure! [SPOTIFY_ARTIST: Radiohead]');
  await artist.context.processTextCommandWithGemini('Put on some Radiohead');
  assert.deepEqual(artist.calls.spotify, ['ARTIST: Radiohead']);
  assert.equal(artist.calls.specialist, 0);
  const song = routed('[SPOTIFY_SONG: Shape of You by Ed Sheeran]');
  await song.context.processTextCommandWithGemini('put on shape of you');
  assert.deepEqual(song.calls.spotify, ['SONG: Shape of You by Ed Sheeran']);
  assert.equal(song.calls.specialist, 0);
  const pair = routed('[OPEN_APP: Spotify] [VOLUME_SET: 75]');
  await pair.context.processTextCommandWithGemini('Please launch my Spotify application and set system audio to 75 percent');
  assert.deepEqual(pair.calls.opened, ['Spotify']); assert.deepEqual(pair.calls.media, ['VOLUME_SET 75']);
  assert.equal(pair.calls.specialist, 0);
  const status = routed('[TASK_STATUS]');
  await status.context.processTextCommandWithGemini('Anything left on my list?');
  assert.equal(status.calls.specialist, 0);
  assert.match(status.calls.spoken.at(-1), /checklist is empty/);
});

test('paraphrased, unknown, destructive or follow-up router actions still consult the specialist', async () => {
  for (const [response, goal] of [
    ['[SPOTIFY_PLAYLIST: Chill Vibes]', 'play something relaxing'],
    ['[OPEN_APP: browser]', 'bring up the browser'],
    ['[CLOSE_APP: Discord]', 'shut Discord down'],
    ['[VOLUME_SET: 30]', 'make it a bit quieter'],
    ['[MEDIA_PAUSE]', 'hold the music for a sec'],
    ['[SPOTIFY_ARTIST: Radiohead] [FOLLOW_UP]', 'put on Radiohead or something']
  ]) {
    const { context, calls } = routed(response, []);
    await context.processTextCommandWithGemini(goal);
    assert.equal(calls.specialist, 1, goal);
    assert.deepEqual([calls.spotify, calls.opened, calls.media].flat(), [], goal);
  }
});

test('the router system prompt keeps a long static prefix so repeated requests can reuse the cache', () => {
  const { context } = harness();
  const first = context.buildOlangaSystemInstruction('text');
  context.userCity = 'Portland';
  const second = context.buildOlangaSystemInstruction('audio');
  let shared = 0;
  while (shared < first.length && first[shared] === second[shared]) shared++;
  assert.ok(shared / first.length > 0.9, `Only ${shared} of ${first.length} characters are shared`);
  assert.match(first.slice(-400), /current local time for the user/);
});
