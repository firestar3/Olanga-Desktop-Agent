// Production renderer, assistant, controls and TTS orchestration. Only external
// IPC results and audible playback are fixtures; no real device or provider runs.
const { app, BrowserWindow, ipcMain, session, net } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../build/qa/assistant-efficiency');
fs.mkdirSync(output, { recursive: true });
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(output, 'profile-')));
if (!process.argv.includes('--hidden')) process.argv.push('--hidden');
const report = { passed: false, runtime: process.versions.electron, checks: [], forbidden: [], errors: [], coverage: { productionRenderer: true, mockedNativeActions: true, mockedProviders: true, audibleSpeech: false, physicalMicrophone: false, realCredentials: false } };
const blocked = new Set(['provider-generate', 'provider-stream', 'nvidia-tts-config', 'nvidia-tts-synthesize', 'open-app', 'close-app', 'arrange-app', 'play-spotify', 'reload-spotify', 'media-control', 'desktop-capture', 'desktop-prepare', 'desktop-run', 'desktop-undo', 'request-screenshot', 'fetch-news-bundle', 'check-release', 'update-download', 'update-install', 'set-open-at-login', 'terminal-session-create', 'terminal-session-execute']);
let scenario = {}, main, finished = false, heldAction;
const calls = { native: [], completed: [], providers: [], tts: [] };
const rejectUnexpected = name => { report.forbidden.push(name); throw Error('Fixture blocked ' + name); };
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, async (event, ...args) => {
  if (channel === 'provider-cancel') return { ok: true };
  if (channel === 'open-app' || channel === 'media-control') {
    if (channel === 'open-app' ? !/^spotify$/i.test(args[0]) : !['MEDIA_PLAY', 'VOLUME_SET'].includes(args[0])) return rejectUnexpected(channel + ':arguments');
    if (channel === 'media-control' && args[0] === 'VOLUME_SET' && args[2] !== 75) return rejectUnexpected('unexpected-volume');
    if (channel === 'media-control' && args[0] === 'MEDIA_PLAY' && args[1] !== true) return rejectUnexpected('non-Spotify-playback');
    const call = { channel, args }; calls.native.push(call);
    if (scenario.holdFirst && calls.native.length === 1) await new Promise(resolve => { heldAction = resolve; });
    calls.completed.push(call);
    if (channel === 'open-app') return { ok: true, verified: true, message: 'Spotify is open.' };
    if (args[0] === 'VOLUME_SET') return { ok: true, verified: true, level: 75, message: 'System volume is 75%.' };
    return scenario.spotifyFailure
      ? { ok: false, verified: false, source: 'spotify', code: 'not-playing', message: 'Spotify playback could not be verified.' }
      : { ok: true, verified: true, source: 'spotify', message: 'Playback resumed.' };
  }
  if (channel === 'provider-generate' || channel === 'provider-stream') {
    const payload = args[0], system = payload?.body?.system_instruction?.parts?.[0]?.text || '';
    calls.providers.push({ channel, body: payload?.body });
    if (channel === 'provider-generate' && system.startsWith('Transcribe the spoken words exactly.') && typeof scenario.transcript === 'string') return { ok: true, text: scenario.transcript, keyIndex: 0 };
    if (channel === 'provider-stream' && scenario.search && payload?.body?.tools?.some(tool => tool.google_search)) {
      const text = 'Seattle has a cool forecast today.';
      event.sender.send('provider-stream-chunk', { requestId: payload.requestId, text });
      return { ok: true, text, keyIndex: 0 };
    }
    return rejectUnexpected(channel + ':unplanned-request');
  }
  if (channel === 'nvidia-tts-synthesize') {
    if (args[0]?.apiKey !== 'fixture-tts-key-never-saved') return rejectUnexpected('unexpected-tts-credential');
    calls.tts.push({ text: args[0].text, completedActions: calls.completed.length });
    return { audioBase64: 'AAAAAA==' };
  }
  if (blocked.has(channel)) return rejectUnexpected(channel);
  return callback(event, ...args);
});
const on = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, callback) => on(channel, channel === 'provider-warm' ? () => {} : callback);
globalThis.fetch = net.fetch = async () => rejectUnexpected('network');
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, _file, error) => report.errors.push(error.message));
  contents.on('render-process-gone', (_event, details) => report.errors.push(details.reason));
});
app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, reply) => { report.forbidden.push('permission:' + permission); reply(false); });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, reply) => { report.forbidden.push('renderer-network'); reply({ cancel: true }); });
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(fn, ...args) {
  const result = await main.webContents.executeJavaScript('(() => { try { return Promise.resolve((' + fn.toString() + ')(...' + JSON.stringify(args) + ')).then(value => ({ value }), error => ({ fixtureError: error.stack || error.message })); } catch (error) { return { fixtureError: error.stack || error.message }; } })()', true);
  if (result?.fixtureError) throw Error(result.fixtureError);
  return result?.value;
}
async function until(fn, label) { for (let i = 0; i < 240; i++) { if (await fn()) return; await pause(25); } throw Error(label); }
async function check(name, fn) { await fn(); report.checks.push(name); }
async function reset(next = {}) {
  await evaluate(() => { cancelAssistantRequest(); conversationHistory = []; conversationLastActivity = 0; spotifyContextUntil = 0; document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); fixture.utterances = []; fixture.played = 0; fixture.holdAck = false; fixture.releaseAck = null; fixture.pending = null; aiText.textContent = ''; userText.textContent = ''; magpieAudioCache.clear(); magpieUnavailableUntil = 0; ttsEngine = 'magpie'; setState(State.IDLE); });
  scenario = next; heldAction = null;
  for (const values of Object.values(calls)) values.length = 0;
}
async function state() {
  return evaluate(() => ({ text: aiText.textContent, user: userText.textContent, visible: !transcriptAi.classList.contains('hidden'), state: currentState, turn: OlangaTurns.snapshot(), activity: OlangaWorkspace.snapshot().activity.at(-1), utterances: fixture.utterances, played: fixture.played }));
}
async function say(text, spoken = false, rough = text) {
  await evaluate(async (text, spoken, rough) => {
    if (spoken) await processAudioBlobWithGemini(new Blob(['synthetic fixture recording'], { type: 'audio/wav' }), { rough });
    else await processTextCommandWithGemini(text);
  }, text, spoken, rough);
  return state();
}
function finish(code) {
  if (finished) return; finished = true; report.passed = code === 0;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); app.exit(code);
}
setTimeout(() => { report.error = 'Assistant efficiency fixture exceeded 120 seconds'; finish(1); }, 120000).unref();
process.on('uncaughtException', error => { report.error = error.stack; finish(1); });
process.on('unhandledRejection', error => { report.error = error.stack; finish(1); });
require('../main');
app.whenReady().then(async () => { try {
  await until(() => { main = BrowserWindow.getAllWindows().find(win => /index\.html$/.test(win.webContents.getURL())); return main && !main.webContents.isLoading(); }, 'Production renderer missing');
  await until(() => evaluate(() => window.OlangaAppInitialized === true && !!window.OlangaWorkspace && !!window.OlangaConversationalControls && !!window.OlangaTurns), 'Assistant controls missing');
  await evaluate(() => {
    window.fixture = { utterances: [], played: 0, holdAck: false, releaseAck: null, errors: [] };
    window.addEventListener('error', event => fixture.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => fixture.errors.push(String(event.reason?.message || event.reason)));
    isMicMuted = true; isTtsMuted = false; isMuted = false; currentVolume = 1;
    apiKey = 'fixture-key-never-saved'; apiKeys = [apiKey]; currentKeyIndex = 0; nvidiaApiKey = 'fixture-tts-key-never-saved'; streamRepliesEnabled = true;
    document.getElementById('startLocalBtn').click();
    window.SpeechSynthesisUtterance = function (text) { this.text = text; };
    synthesis = { cancel() {}, getVoices: () => [{ name: 'Fixture Windows voice', lang: 'en-US' }], speak(utterance) {
      fixture.utterances.push(utterance.text); utterance.onstart?.();
      if (fixture.holdAck) fixture.releaseAck = () => { fixture.holdAck = false; utterance.onend?.(); };
      else queueMicrotask(() => utterance.onend?.());
    } };
    // Retain production TTS preparation, chunking, cancellation and completion.
    // Only the device-facing audio element is replaced by a silent sink.
    playSpeechChunk = async (_blob, options) => { fixture.played++; options.onStart?.(); if (options.isFinal) options.onFinal?.(); return true; };
  });
  await check('Typed and final-transcript Spotify commands execute both steps once and render verified receipts', async () => {
    for (const spoken of [false, true]) for (const verb of ['Open', 'Play']) {
      const text = verb + ' Spotify and raise the volume to 75%'; await reset({ transcript: spoken ? text : undefined });
      const result = await say(text, spoken, 'Open Notepad and set volume to 25%');
      assert.deepEqual(calls.native.map(call => call.channel === 'open-app' ? 'OPEN_APP' : call.args[0]), [verb === 'Open' ? 'OPEN_APP' : 'MEDIA_PLAY', 'VOLUME_SET']);
      assert.equal(calls.native[1].args[2], 75); assert.equal(result.user, text); assert.equal(result.visible, true);
      assert.match(result.text, verb === 'Open' ? /Spotify is open\./ : /Playback resumed\./); assert.match(result.text, /System volume is 75%\./);
      assert.equal(result.turn.outcome, 'completed'); assert.deepEqual(result.activity.steps.map(step => step.state), ['completed', 'completed']);
      assert.equal(calls.providers.length, spoken ? 1 : 0, 'Local commands need only the final transcript when spoken');
    }
  });
  await check('An unverified Spotify failure still executes the independent explicit volume and remains failed', async () => {
    await reset({ spotifyFailure: true }); const result = await say('Play Spotify and raise the volume to 75%');
    assert.deepEqual(calls.native.map(call => call.args[0]), ['MEDIA_PLAY', 'VOLUME_SET']);
    assert.match(result.text, /Spotify playback could not be verified/); assert.match(result.text, /System volume is 75%/); assert.doesNotMatch(result.text, /Playback resumed/);
    assert.equal(result.turn.outcome, 'failed'); assert.deepEqual(result.activity.steps.map(step => step.state), ['failed', 'completed']); assert.equal(calls.providers.length, 0);
  });
  await check('Acknowledgment appears synchronously; verified text and synthesis precede acknowledgment completion', async () => {
    await reset({ holdFirst: true });
    const immediate = await evaluate(() => { fixture.holdAck = true; fixture.pending = processTextCommandWithGemini('Open Spotify and raise the volume to 75%'); return { text: aiText.textContent, visible: !transcriptAi.classList.contains('hidden'), state: currentState, utterances: [...fixture.utterances] }; });
    assert.equal(immediate.visible, true); assert.equal(immediate.state, 'thinking'); assert.match(immediate.text, /open Spotify.*75 percent/i); assert.deepEqual(immediate.utterances, [immediate.text]);
    await until(() => !!heldAction, 'First action was not held'); assert.equal(calls.native.length, 1); assert.equal(calls.tts.length, 0, 'An unfinished action cannot prefetch a success receipt');
    heldAction(); heldAction = null;
    await until(async () => calls.tts.length === 1 && /System volume is 75%/.test((await state()).text), 'Verified result did not render and prefetch');
    const waiting = await state(); assert.equal(waiting.visible, true); assert.equal(waiting.played, 0); assert.equal(waiting.utterances.length, 1); assert.match(waiting.text, /Spotify is open\. System volume is 75%\./);
    assert.equal(calls.tts[0].completedActions, 2); assert.equal(calls.tts[0].text, waiting.text);
    await evaluate(async () => { fixture.releaseAck(); await fixture.pending; });
    const complete = await state(); assert.equal(complete.turn.outcome, 'completed'); assert.equal(complete.played, 1); assert.equal(calls.tts.length, 1, 'Prepared speech must be reused');
  });
  await check('Supported memory recall reads current saved facts without a generation request', async () => {
    await reset(); await evaluate(() => { ttsEngine = 'windows'; });
    await say('My name is Aarav'); const typed = await say("What's my name?");
    assert.equal(typed.text, 'Your name is Aarav.'); assert.equal(calls.providers.length, 0); assert.equal(calls.native.length, 0);
    await reset({ transcript: "What's my name?" }); await evaluate(() => { ttsEngine = 'windows'; });
    const spoken = await say("What's my name?", true); assert.equal(spoken.text, 'Your name is Aarav.');
    assert.equal(calls.providers.length, 1); assert.equal(calls.providers[0].channel, 'provider-generate'); assert.match(calls.providers[0].body.system_instruction.parts[0].text, /^Transcribe/);
    assert.equal(calls.native.length, 0); assert.equal(calls.tts.length, 0);
  });
  await check('A fact followed by weather learns locally and uses exactly one grounded search', async () => {
    await reset({ search: true }); await evaluate(() => { ttsEngine = 'windows'; });
    const result = await say('I live in Seattle. What is the weather here?');
    assert.equal(result.text, 'Seattle has a cool forecast today.'); assert.equal(result.turn.outcome, 'completed');
    assert.equal(calls.providers.length, 1); assert.equal(calls.providers[0].channel, 'provider-stream'); assert.deepEqual(calls.providers[0].body.tools, [{ google_search: {} }]);
    const request = JSON.parse(calls.providers[0].body.contents[0].parts[0].text); assert.ok(request.memories.includes('I live in Seattle')); assert.equal(request.goal, 'I live in Seattle. What is the weather here?');
    assert.equal(await evaluate(() => OlangaWorkspace.snapshot().facts.some(fact => fact.text === 'I live in Seattle')), true); assert.equal(calls.native.length, 0);
  });
  await check('Cancellation during the first native result prevents a late second action and stale success speech', async () => {
    await reset({ holdFirst: true });
    await evaluate(() => { fixture.holdAck = true; fixture.pending = processTextCommandWithGemini('Open Spotify and raise the volume to 75%'); });
    await until(() => !!heldAction, 'Cancellable first action was not held'); await evaluate(() => cancelAssistantRequest());
    heldAction(); heldAction = null; await evaluate(async () => { await fixture.pending; });
    const result = await state(); assert.equal(calls.native.length, 1); assert.equal(calls.tts.length, 0); assert.equal(result.played, 0); assert.equal(result.turn.outcome, 'cancelled'); assert.doesNotMatch(result.text, /Spotify is open|System volume is 75%/);
  });
  report.rendererErrors = await evaluate(() => fixture.errors);
  assert.deepEqual(report.rendererErrors, []); assert.deepEqual(report.errors, []); assert.deepEqual(report.forbidden, []); finish(0);
} catch (error) { report.error = error.stack; report.calls = calls; try { report.state = await state(); } catch (_) {} finish(1); } });
