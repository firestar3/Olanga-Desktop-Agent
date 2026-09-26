// Live latency benchmark: the same requests through the classic pipeline and
// through streamed replies, in the production app with the saved Gemini key
// copied into an isolated profile, plus a probe of the action specialist on
// each model. Spends roughly 50 Gemini requests, paced under the key's
// per-minute limit. Speech is replaced by timing probes, so nothing is spoken,
// and native app, media, volume, screen and terminal channels are blocked in
// the main process. Runs that hit a Gemini 429 or 503 are reported but left
// out of the medians.
// Run: npm run bench:latency
// Parts: BENCH_PARTS=scenarios,specialist,cache (cache is off by default).
const { app, BrowserWindow, ipcMain, session, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const output = path.resolve(__dirname, '../build/qa');
const reportPath = path.join(output, 'latency-benchmark.json');
const normalProfile = path.join(app.getPath('appData'), 'olanga-control');
const PARTS = new Set((process.env.BENCH_PARTS || 'scenarios,specialist').split(',').map(part => part.trim()).filter(Boolean));
const REPS = Number(process.env.BENCH_REPS) || 3, GAP_MS = 2500, CACHE_ROUNDS = 4, CALLS_PER_MINUTE = 8;
const QUESTION = 'What is the capital of Australia, and why was it chosen?';
const SCENARIOS = [
  { name: 'typed question', kind: 'typed', goal: QUESTION },
  { name: 'spoken question', kind: 'spoken', goal: QUESTION, rough: 'what is the capital of australia and why was it chosen' },
  { name: 'live question', kind: 'typed', goal: "What's the weather in Seattle today?" },
  { name: 'model-routed action', kind: 'typed', goal: 'Put on some Radiohead' }
];
// The specialist sees the router's proposal and the user's words, exactly as
// in handleSimpleActionWithSpecialists; only the model and thinking level vary.
const SPECIALIST_VARIANTS = [
  { model: 'gemini-3.5-flash', thinkingLevel: 'LOW' },
  { model: 'gemini-3.5-flash', thinkingLevel: 'MINIMAL' },
  { model: 'gemini-3.5-flash-lite', thinkingLevel: 'LOW' }
];
const SPECIALIST_GOALS = [
  { goal: 'Put on some Radiohead', routed: 'Putting on some Radiohead, Boss. [SPOTIFY_ARTIST: Radiohead]', expected: ['[SPOTIFY_ARTIST: Radiohead]'] },
  { goal: 'Pause the music and set a timer for 20 minutes for the laundry', routed: 'You got it. [MEDIA_PAUSE] [SET_TIMER: 1200, laundry]', expected: ['[MEDIA_PAUSE]', '[SET_TIMER: 1200, *]'] }
];
const SPECIALIST_REPS = 2;
const BLOCKED = new Set(['open-app', 'close-app', 'arrange-app', 'play-spotify', 'reload-spotify', 'media-control', 'desktop-capture', 'desktop-prepare', 'desktop-run', 'desktop-undo', 'request-screenshot', 'execute-command', 'terminal-session-create', 'terminal-session-execute', 'fetch-news-bundle', 'nvidia-tts-synthesize']);
fs.mkdirSync(output, { recursive: true });
app.disableHardwareAcceleration();
const isolatedProfile = fs.mkdtempSync(path.join(output, 'latency-profile-'));
app.setPath('userData', isolatedProfile);
const report = { startedAt: new Date().toISOString(), passed: false, parts: [...PARTS], reps: REPS, question: QUESTION, runs: [], skipped: [], specialist: [], cache: [], summary: [], blockedNative: [], rendererErrors: [],
  coverage: { liveGemini: true, speech: 'Timing probes mark when the first complete sentence is ready to speak; nothing is spoken.', nativeActions: 'Blocked in the main process.', microphone: false, roughTranscript: 'Supplied for spoken runs, standing in for the on-device recognizer.' } };
const redact = value => String(value).replace(/AIza[A-Za-z0-9_-]{20,}/g, '[redacted]');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
let setupError = null;

// Windows safeStorage in this profile needs only the encrypted os_crypt
// metadata; the normal profile and its credential file are never modified.
try {
  const localState = JSON.parse(fs.readFileSync(path.join(normalProfile, 'Local State'), 'utf8'));
  if (!localState?.os_crypt?.encrypted_key) throw new Error('The normal profile has no os_crypt metadata.');
  fs.writeFileSync(path.join(isolatedProfile, 'Local State'), JSON.stringify({ os_crypt: localState.os_crypt }), { encoding: 'utf8', mode: 0o600 });
} catch (error) { setupError = error; }

const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, (event, ...args) => {
  if (BLOCKED.has(channel)) { report.blockedNative.push(channel); throw new Error('Native actions are blocked in the latency benchmark.'); }
  return callback(event, ...args);
});
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event, ...legacy) => {
    const details = event?.message ? event : { level: legacy[0], message: legacy[1] };
    if (['error', 3].includes(details.level) && !/ERR_BLOCKED_BY_CLIENT|Processing error|blocked in the latency benchmark/i.test(details.message)) report.rendererErrors.push(redact(details.message).slice(0, 400));
  });
});
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (details, callback) => callback({ cancel: new URL(details.url).hostname !== 'generativelanguage.googleapis.com' }));
});
// main.js registers its privileged asset scheme at load, before app ready.
try { if (!setupError) require('../main'); } catch (error) { setupError = error; }

function savedGeminiKey() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows safeStorage is unavailable.');
  const store = JSON.parse(fs.readFileSync(path.join(normalProfile, 'secure-store.json'), 'utf8'));
  let plaintext = safeStorage.decryptString(Buffer.from(store.gemini_api_keys, 'base64'));
  try { return JSON.parse(plaintext).find(key => typeof key === 'string' && key.trim()).trim(); } finally { plaintext = ''; }
}

async function questionWav() {
  const filename = path.join(output, 'latency-question.wav');
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -AssemblyName System.Speech\n$benchVoice = New-Object System.Speech.Synthesis.SpeechSynthesizer\ntry { $benchVoice.SetOutputToWaveFile(${quote(filename)}); $benchVoice.Speak(${quote(QUESTION)}) } finally { $benchVoice.Dispose() }`;
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, shell: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`WAV generation failed (${code}).`))));
  });
  return fs.readFileSync(filename).toString('base64');
}

// Runs in the renderer. Replaces speech with probes that mark when the first
// complete sentence is ready, exactly where the real speech stream would start.
function installProbes() {
  const bench = window.__bench = { run: null };
  const mark = (type, extra = {}) => { if (bench.run && !bench.run.marks.some(item => item.type === type)) bench.run.marks.push({ type, at: Math.round(performance.now() - bench.run.started), ...extra }); };
  const pick = item => ({ model: item.model, outcome: item.outcome, status: item.status, attempts: item.attempts, durationMs: item.durationMs, inputTokens: item.inputTokens, cachedTokens: item.cachedTokens, outputTokens: item.outputTokens, thoughtTokens: item.thoughtTokens, ...(item.rateLimit ? { rateLimit: item.rateLimit, retryMs: item.retryMs } : {}) });
  const callsSince = async epoch => (await window.electronAPI.providerStatus()).recent.filter(item => item.at >= epoch).map(pick);
  // Each turn starts a fresh conversation so earlier answers cannot shape it.
  const resetConversation = () => { conversationHistory = []; conversationLastActivity = 0; pendingActionClarification = null; screenConversation = null; };
  window.__groundedRouterCommands = groundedRouterCommands;
  speakAssistantAcknowledgement = async () => { mark('ack'); return true; };
  speakResponse = async text => { mark('speech', { streamed: false, chars: text.length }); setState(State.IDLE); };
  speakResponseAndThen = async (text, callback) => { mark('speech', { streamed: false, chars: text.length }); callback?.(); };
  createSpeechStream = () => {
    const splitter = OlangaConversation.createSentenceSplitter();
    let received = '';
    const ready = pieces => { if (pieces.length) mark('speech', { streamed: true, chars: pieces[0].length }); };
    return {
      push(text) { mark('text'); received += text; ready(splitter.push(text)); },
      end: async finalText => { if (typeof finalText === 'string' && finalText.startsWith(received)) ready(splitter.push(finalText.slice(received.length))); ready(splitter.flush()); return true; },
      cancel() {}
    };
  };
  window.__benchTurn = async ({ mode, kind, goal, rough, wav }) => {
    streamRepliesEnabled = mode !== 'classic';
    groundedRouterCommands = mode === 'classic' ? () => null : window.__groundedRouterCommands;
    resetConversation();
    userText.textContent = ''; aiText.textContent = '';
    const epoch = Date.now();
    bench.run = { started: performance.now(), marks: [] };
    const observer = new MutationObserver(() => { if (kind === 'spoken' && userText.textContent) mark('transcript'); });
    observer.observe(userText, { childList: true, characterData: true, subtree: true });
    let error = null;
    try {
      if (kind === 'spoken') {
        const bytes = Uint8Array.from(atob(wav), character => character.charCodeAt(0));
        await processAudioBlobWithGemini(new Blob([bytes], { type: 'audio/wav' }), { rough: mode === 'classic' ? '' : rough });
      } else await processTextCommandWithGemini(goal);
    } catch (caught) { error = caught.message; }
    const run = bench.run; bench.run = null; observer.disconnect();
    const total = Math.round(performance.now() - run.started);
    return { marks: run.marks, total, error, transcript: kind === 'spoken' ? userText.textContent : null, answer: aiText.textContent.slice(0, 160), calls: await callsSince(epoch) };
  };
  // Runs the real specialist step on a fixed router proposal. The plan is
  // captured instead of dispatched, and the grounded shortcut is disabled.
  window.__benchSpecialist = async ({ model, thinkingLevel, goal, routed }) => {
    resetConversation();
    const build = OlangaGemini.buildRequest, specialist = callGeminiSpecialist, dispatch = dispatchActionPlan, grounded = groundedRouterCommands;
    let plan = null, error = null;
    OlangaGemini.buildRequest = (messages, options) => { const body = build(messages, options); body.generationConfig.thinkingConfig = { thinkingLevel }; return body; };
    callGeminiSpecialist = (purpose, messages, options = {}) => specialist(purpose, messages, { ...options, model });
    dispatchActionPlan = async value => { plan = value; return { spokenResponse: '', wantsFollowUp: false }; };
    groundedRouterCommands = () => null;
    const request = beginAssistantRequest(), epoch = Date.now(), started = performance.now();
    try {
      const result = await handleSimpleActionWithSpecialists(routed, goal, request);
      if (!plan && result) plan = { kind: 'clarify', question: result.spokenResponse };
    } catch (caught) { error = caught.message; }
    finally { OlangaGemini.buildRequest = build; callGeminiSpecialist = specialist; dispatchActionPlan = dispatch; groundedRouterCommands = grounded; }
    const ms = Math.round(performance.now() - started);
    return { ms, plan, error, calls: await callsSince(epoch) };
  };
  // The previous router prompt order put the time near the top; rebuild it
  // from the current prompt so both orders carry identical instructions.
  window.__benchCache = async variant => {
    const current = buildOlangaSystemInstruction('text');
    const input = 'The user will provide a text message. Respond to their request.';
    const cut = current.lastIndexOf(`\n\n${input}`);
    const dynamic = current.slice(cut + 2 + input.length);
    const anchor = 'Use Fahrenheit unless the user asks for Celsius.';
    const system = variant === 'current' ? current : current.slice(0, cut).replace(anchor, `${anchor}${dynamic}\n${input}`);
    const epoch = Date.now();
    await callGeminiGenerate(OlangaGemini.RESPONSE_MODEL, {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: 'Context: \nThe user typed: "What is the capital of France?". Please respond.' }] }],
      generationConfig: { temperature: 0.7, topP: 0.95, topK: 40, maxOutputTokens: 1500, thinkingConfig: { thinkingLevel: 'LOW' } }
    }, { timeoutMs: 60000 });
    const call = (await callsSince(epoch)).at(-1);
    return { variant, promptChars: system.length, durationMs: call?.durationMs, inputTokens: call?.inputTokens, cachedTokens: call?.cachedTokens };
  };
  return true;
}

const median = values => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null; };
function summarize() {
  for (const scenario of SCENARIOS) {
    const row = { scenario: scenario.name };
    for (const mode of ['classic', 'streamed']) {
      const runs = report.runs.filter(run => run.scenario === scenario.name && run.mode === mode && !run.error);
      const at = type => median(runs.map(run => run.marks.find(item => item.type === type)?.at));
      row[mode] = { runs: runs.length, firstSpeechMs: at('speech'), transcriptMs: at('transcript'), totalMs: median(runs.map(run => run.total)), providerCalls: median(runs.map(run => run.calls.length)) };
    }
    if (row.classic.firstSpeechMs && row.streamed.firstSpeechMs) row.firstSpeechSavedMs = row.classic.firstSpeechMs - row.streamed.firstSpeechMs;
    report.summary.push(row);
  }
  const cache = variant => report.cache.filter(item => item.variant === variant);
  report.cacheSummary = Object.fromEntries(['legacy', 'current'].map(variant => [variant, { medianMs: median(cache(variant).map(item => item.durationMs)), medianCachedTokens: median(cache(variant).map(item => item.cachedTokens)), medianInputTokens: median(cache(variant).map(item => item.inputTokens)) }]));
}

app.whenReady().then(async () => {
  let main;
  try {
    if (setupError) throw setupError;
    for (let attempt = 0; attempt < 100 && !(main && !main.webContents.isLoading()); attempt++) { main = BrowserWindow.getAllWindows().find(win => /index\.html$/.test(win.webContents.getURL())); await pause(100); }
    if (!main) throw new Error('The main renderer did not load.');
    await pause(1200);
    const run = code => main.webContents.executeJavaScript(code, true);
    let key = savedGeminiKey();
    await run(`(async () => { apiKey = ${JSON.stringify(key)}; apiKeys = [apiKey]; currentKeyIndex = 0; apiKeyRotation = false; await window.electronAPI.secureStoreSet('gemini_api_keys', JSON.stringify(apiKeys)); })()`);
    key = '';
    await run(`(${installProbes.toString()})()`);
    const wav = await questionWav();
    await run('warmProviderConnection()');
    await pause(1500);
    for (const scenario of SCENARIOS) {
      for (let rep = 0; rep < REPS; rep++) {
        for (const mode of rep % 2 ? ['streamed', 'classic'] : ['classic', 'streamed']) {
          const result = await run(`window.__benchTurn(${JSON.stringify({ mode, kind: scenario.kind, goal: scenario.goal, rough: scenario.rough || '', wav: scenario.kind === 'spoken' ? wav : '' })})`);
          report.runs.push({ scenario: scenario.name, mode, rep, ...result, error: result.error && redact(result.error) });
          save();
          await pause(GAP_MS);
        }
      }
    }
    for (let round = 0; round < CACHE_ROUNDS; round++) {
      for (const variant of ['legacy', 'current']) {
        try { report.cache.push(await run(`window.__benchCache(${JSON.stringify(variant)})`)); }
        catch (error) { report.cache.push({ variant, error: redact(error.message) }); }
        save();
        await pause(GAP_MS);
      }
    }
    summarize();
    report.passed = report.runs.every(item => !item.error || /blocked in the latency benchmark/i.test(item.error)) && report.runs.length === SCENARIOS.length * REPS * 2;
  } catch (error) {
    report.error = redact(error.stack || error.message);
  } finally {
    try { if (main && !main.isDestroyed()) await main.webContents.executeJavaScript(`cancelAssistantRequest(); apiKey = ''; apiKeys = []; window.electronAPI.secureStoreSet('gemini_api_keys', null)`, true); } catch (_) {}
    report.finishedAt = new Date().toISOString();
    report.isolatedProfile = isolatedProfile;
    save();
    console.log(JSON.stringify({ passed: report.passed, error: report.error, summary: report.summary, cacheSummary: report.cacheSummary, blockedNative: [...new Set(report.blockedNative)], rendererErrors: report.rendererErrors.length }, null, 2));
    app.exit(report.passed ? 0 : 1);
  }
});
setTimeout(() => { report.error = 'Latency benchmark timed out.'; save(); app.exit(1); }, 15 * 60 * 1000).unref();
