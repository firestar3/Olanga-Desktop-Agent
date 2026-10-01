// Live Windows smoke: launches/verifies Spotify, changes system volume, and uses
// the actual Windows voice. Always restores the original volume/mute state.
// Default: typed request; --live-audio: synthetic WAV + real Gemini transcription.
// Neither mode exercises a physical microphone or the wake-word detector.
const { app, BrowserWindow, session, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { observeMediaControllerFactory } = require('./helpers/media-smoke-observer');
const { playbackState, restoreSpotifyPlayback } = require('./helpers/spotify-smoke-state');

const playSpotify = process.argv.includes('--play-spotify');
const command = playSpotify ? 'Play Spotify and raise the volume to 75%' : 'Open Spotify and raise the volume to 75%';
const liveAudio = process.argv.includes('--live-audio');
const output = path.resolve(__dirname, '../build/qa');
const basename = `${playSpotify ? 'spotify-resume' : 'voice-command'}${liveAudio ? '-audio' : ''}-smoke`;
const reportPath = path.join(output, `${basename}.json`);
const screenshotPath = path.join(output, `${basename}.png`);
const normalProfile = path.join(app.getPath('appData'), 'olanga-control');
const normalStorePath = path.join(normalProfile, 'secure-store.json');
const normalLocalStatePath = path.join(normalProfile, 'Local State');
fs.mkdirSync(output, { recursive: true });
app.disableHardwareAcceleration();
const isolatedProfile = fs.mkdtempSync(path.join(output, 'voice-smoke-profile-'));
app.setPath('userData', isolatedProfile);

const report = {
  command, mode: liveAudio ? 'synthetic-wav-live-transcription' : 'typed',
  startedAt: new Date().toISOString(), passed: false,
  coverage: {
    productionMain: true, productionPreload: true, productionAssistant: true,
    realWindowsMedia: true, realWindowsSpeech: true,
    realGeminiTranscription: liveAudio, physicalMicrophone: false, wakeWord: false,
    speechEvidence: 'Native speech start/end/error events; no acoustic loopback recording.',
  },
  checks: [], rendererErrors: [], network: [], nativeMediaCommands: [], restoration: { attempted: false },
};
const redact = value => String(value).replace(/AIza[A-Za-z0-9_-]{20,}/g, '[redacted]');
const saveReport = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let main;
let originalVolume;
let originalPlayback;
let assistantCommandStarted = false;
let cleanupFinished = false;
let verificationAborted = false;
let credentialSetupError;
let volumeSampler;
let volumePhase = 'startup';
function assertVerificationActive() {
  if (verificationAborted) throw new Error('Verification stopped before cleanup.');
}

// Observe the default render endpoint from a separate process. This helper has
// no volume setters and never calls production IPC; each sample acquires and
// releases its own Core Audio COM objects so an endpoint switch is visible.
async function startVolumeSampler() {
  const helperSource = fs.readFileSync(path.join(__dirname, '../desktop/media-helper.ps1'), 'utf8');
  const nativeBlock = helperSource.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/);
  if (!nativeBlock) throw new Error('Could not locate the production Core Audio interop for independent sampling.');
  const nativeReader = nativeBlock[1].replace(/  public void SetLevel\([\s\S]*?(?=  public void Dispose\()/, '');
  if (/public void Set(?:Level|Muted)\(/.test(nativeReader) || !nativeReader.includes('public OlangaVolumeState Read()')) throw new Error('Independent sampler must expose only native volume reads.');
  const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
  const stopPath = path.join(isolatedProfile, 'volume-sampler.stop');
  const scriptPath = path.join(isolatedProfile, 'volume-sampler.ps1');
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
${nativeReader}
'@
$volumeSamplerWatch = [Diagnostics.Stopwatch]::StartNew()
$volumeSamplerParent = [Diagnostics.Process]::GetProcessById(${process.pid})
$volumeSamplerReads = 0
$volumeSamplerReleased = 0
$volumeSamplerReason = 'deadline'
try {
  while ($volumeSamplerWatch.ElapsedMilliseconds -lt 240000) {
    if ([IO.File]::Exists(${quote(stopPath)})) { $volumeSamplerReason = 'requested'; break }
    $volumeSamplerParent.Refresh()
    if ($volumeSamplerParent.HasExited) { $volumeSamplerReason = 'parent-exited'; break }
    $volumeSamplerAudio = $null
    try {
      $volumeSamplerAudio = [OlangaSystemAudio]::new()
      $volumeSamplerReads++
      $volumeSamplerState = $volumeSamplerAudio.Read()
      @{ type = 'sample'; epochMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); elapsedMs = $volumeSamplerWatch.ElapsedMilliseconds; volume = $volumeSamplerState.Level; muted = $volumeSamplerState.Muted } | ConvertTo-Json -Compress | ForEach-Object { [Console]::WriteLine($_) }
    } finally {
      if ($null -ne $volumeSamplerAudio) { $volumeSamplerAudio.Dispose(); $volumeSamplerReleased++ }
    }
    Start-Sleep -Milliseconds 100
  }
} catch {
  @{ type = 'error'; message = $_.Exception.GetBaseException().Message } | ConvertTo-Json -Compress | ForEach-Object { [Console]::WriteLine($_) }
  $volumeSamplerReason = 'error'
} finally {
  $volumeSamplerParent.Dispose()
  @{ type = 'stopped'; reason = $volumeSamplerReason; reads = $volumeSamplerReads; released = $volumeSamplerReleased } | ConvertTo-Json -Compress | ForEach-Object { [Console]::WriteLine($_) }
}`;
  fs.writeFileSync(scriptPath, script, 'utf8');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const timeline = report.volumeTimeline = { source: 'Separate hidden PowerShell process, native Core Audio default render endpoint read, no setters', intervalMs: 100, pid: child.pid, samples: [], errors: [], transitions: [] };
  let resolveReady, rejectReady, pending = '', stderr = '';
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const startupTimeout = setTimeout(() => rejectReady(new Error('Independent volume sampler did not produce a sample within 8 seconds.')), 8000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    pending += data;
    const lines = pending.split(/\r?\n/); pending = lines.pop();
    for (const line of lines.filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'sample' && Number.isFinite(entry.volume) && Number.isFinite(entry.epochMs)) {
          const sample = { ...entry, phase: volumePhase, receivedAt: Date.now() };
          delete sample.type;
          const previous = timeline.samples.at(-1);
          if (!previous || previous.volume !== sample.volume || previous.muted !== sample.muted) timeline.transitions.push(sample);
          timeline.samples.push(sample); clearTimeout(startupTimeout); resolveReady();
        } else if (entry.type === 'stopped') timeline.cleanup = entry;
        else if (entry.type === 'error') { timeline.errors.push(redact(entry.message)); rejectReady(new Error(entry.message)); }
        else timeline.errors.push('Unexpected sampler output.');
      } catch (error) { timeline.errors.push(redact(error.message)); rejectReady(error); }
    }
  });
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
  const closed = new Promise(resolve => {
    child.once('error', error => { timeline.errors.push(redact(error.message)); clearTimeout(startupTimeout); rejectReady(error); resolve(); });
    child.once('close', (code, signal) => {
      timeline.exit = { code, signal, at: Date.now(), ...(stderr ? { stderr: redact(stderr) } : {}) };
      clearTimeout(startupTimeout);
      if (!timeline.samples.length) rejectReady(new Error('Independent volume sampler exited before its first sample. ' + redact(stderr)));
      resolve();
    });
  });
  let stopping;
  volumeSampler = {
    async stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        try { fs.writeFileSync(stopPath, 'stop', 'utf8'); }
        catch (error) { timeline.errors.push(redact(error.message)); timeline.forcedTermination = true; child.kill(); }
        let killTimeout;
        try {
          await Promise.race([closed, new Promise(resolve => { killTimeout = setTimeout(() => { timeline.forcedTermination = true; child.kill(); resolve(); }, 2500); })]);
          if (timeline.forcedTermination) await Promise.race([closed, pause(500)]);
        } finally { clearTimeout(killTimeout); clearTimeout(startupTimeout); }
      })();
      return stopping;
    },
    kill() { timeline.forcedTermination = true; child.kill(); },
  };
  await ready;
  check('Independent volume sampler started before the request', timeline.samples.length > 0 && timeline.errors.length === 0);
}

function summarizeVolumeTimeline() {
  const timeline = report.volumeTimeline;
  if (!timeline) return;
  timeline.speechWindows = (report.turn?.speeches || []).map(speech => {
    const start = report.turn.timeOrigin + speech.startedAt;
    const end = report.turn.timeOrigin + speech.endedAt;
    const samples = timeline.samples.filter(sample => sample.epochMs >= start && sample.epochMs <= end);
    return { role: speech.role, startEpochMs: start, endEpochMs: end, samples: samples.length,
      levels: [...new Set(samples.map(sample => sample.volume))], muted: [...new Set(samples.map(sample => sample.muted))] };
  });
}

// Windows safeStorage ciphertext depends on this profile's DPAPI-wrapped AES
// key. Seed only its encrypted os_crypt metadata before Chromium initializes;
// the normal profile and its encrypted credential file are never modified.
if (liveAudio) {
  try {
    if (app.isReady()) throw new Error('Encryption metadata must be prepared before Electron is ready.');
    if (!fs.existsSync(normalLocalStatePath)) throw new Error(`Live audio encryption metadata is missing at ${normalLocalStatePath}`);
    let localStateText;
    try { localStateText = fs.readFileSync(normalLocalStatePath, 'utf8'); } catch {
      throw new Error(`Live audio cannot read encryption metadata at ${normalLocalStatePath}`);
    }
    let localState;
    try { localState = JSON.parse(localStateText); } catch {
      throw new Error('Live audio cannot parse the normal profile Local State JSON.');
    }
    const metadata = localState?.os_crypt;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || typeof metadata.encrypted_key !== 'string' || !metadata.encrypted_key) {
      throw new Error('Live audio requires os_crypt.encrypted_key in the normal profile Local State.');
    }
    fs.writeFileSync(path.join(isolatedProfile, 'Local State'), JSON.stringify({ os_crypt: metadata }), { encoding: 'utf8', mode: 0o600 });
    report.credentials = { encryptionMetadataCopied: true, copiedSection: 'os_crypt', plaintextPersisted: false };
  } catch (error) {
    credentialSetupError = error;
    report.credentials = { encryptionMetadataCopied: false, error: redact(error.message), plaintextPersisted: false };
  }
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event, ...legacy) => {
    const details = event?.message ? event : { level: legacy[0], message: legacy[1] };
    if (['error', 3].includes(details.level) && !/ERR_INTERNET_DISCONNECTED|ERR_BLOCKED_BY_CLIENT/.test(details.message)) report.rendererErrors.push(redact(details.message));
  });
  contents.on('preload-error', (_event, _file, error) => report.rendererErrors.push(redact(error.message)));
  contents.on('render-process-gone', (_event, details) => report.rendererErrors.push(`Renderer stopped: ${details.reason}`));
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (details, callback) => {
    const url = new URL(details.url);
    const allowed = liveAudio && url.protocol === 'https:' && url.hostname === 'generativelanguage.googleapis.com';
    report.network.push({ time: Date.now(), host: url.hostname, path: url.pathname, allowed });
    callback({ cancel: !allowed });
  });
});

function check(name, condition, detail) {
  report.checks.push({ name, passed: Boolean(condition), ...(detail === undefined ? {} : { detail }) });
  if (!condition) throw new Error(name + (detail === undefined ? '' : ': ' + JSON.stringify(detail)));
}

function loadExistingGeminiKey() {
  if (!fs.existsSync(normalStorePath)) throw new Error(`Live audio needs saved Gemini credentials; secure store is missing at ${normalStorePath}`);
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Live audio cannot decrypt the saved Gemini credential: Windows safeStorage is unavailable.');
  let storeText;
  try { storeText = fs.readFileSync(normalStorePath, 'utf8'); } catch {
    throw new Error(`Live audio cannot read the encrypted credential store at ${normalStorePath}`);
  }
  let store;
  try { store = JSON.parse(storeText); } catch {
    throw new Error('Live audio cannot parse secure-store.json; the encrypted credential store is not valid JSON.');
  }
  const encrypted = store?.gemini_api_keys;
  if (typeof encrypted !== 'string' || !encrypted) throw new Error('Live audio cannot run: gemini_api_keys is missing from the encrypted credential store.');
  let plaintext;
  try { plaintext = safeStorage.decryptString(Buffer.from(encrypted, 'base64')); } catch {
    throw new Error('Live audio could not decrypt gemini_api_keys with Windows safeStorage and the copied profile encryption metadata.');
  }
  let keys;
  try { keys = JSON.parse(plaintext); } catch {
    throw new Error('Live audio decrypted gemini_api_keys, but its contents are not valid JSON.');
  } finally { plaintext = ''; }
  if (!Array.isArray(keys)) throw new Error('Live audio decrypted gemini_api_keys, but it is not a key list.');
  const key = keys.find(value => typeof value === 'string' && value.trim());
  if (!key) throw new Error('Live audio cannot run: the saved Gemini key list is empty.');
  report.credentials.decryptionSucceeded = true;
  return key.trim();
}

async function createSyntheticWav() {
  const filename = path.join(output, 'voice-command-fixture.wav');
  const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -AssemblyName System.Speech\n$voiceSmokeSpeaker = New-Object System.Speech.Synthesis.SpeechSynthesizer\ntry { $voiceSmokeSpeaker.SetOutputToWaveFile(${quote(filename)}); $voiceSmokeSpeaker.Speak(${quote(command)}) } finally { $voiceSmokeSpeaker.Dispose() }`;
  await new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Synthetic speech fixture generation timed out.')); }, 8000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Synthetic speech fixture generation failed (${code}): ${stderr.slice(0, 500)}`));
    });
  });
  const bytes = fs.readFileSync(filename);
  check('Synthetic fixture is a nonempty WAV', bytes.length > 44 && bytes.subarray(0, 4).toString() === 'RIFF');
  report.fixture = { path: filename, bytes: bytes.length, source: 'Windows System.Speech.Synthesis; no physical microphone' };
  return bytes.toString('base64');
}

// These wrappers observe the real functions and native speech events; every
// action and utterance still goes through the production implementation.
function installRendererObservers() {
  setTtsEngine('windows');
  isTtsMuted = false;
  isMuted = false;
  currentVolume = 0.8;
  document.getElementById('setupScreen').classList.add('hidden');
  document.getElementById('mainScreen').classList.remove('hidden');
  const data = window.__voiceCommandSmoke = { events: [], actions: [], speeches: [], turnDone: false, timeOrigin: performance.timeOrigin };
  const event = (type, extra = {}) => {
    const entry = { type, at: performance.now(), ...extra };
    data.events.push(entry);
    return entry;
  };
  const acknowledge = speakAssistantAcknowledgement;
  speakAssistantAcknowledgement = function (text, signal) {
    data.acknowledgementText = text;
    event('acknowledgement-called', { text });
    return acknowledge(text, signal).then(completed => {
      event('acknowledgement-settled', { completed });
      return completed;
    });
  };
  const apply = applyAssistantCommands;
  applyAssistantCommands = async function (text, request) {
    const action = { command: text, startedAt: performance.now() };
    data.actions.push(action);
    event('action-started', { command: text });
    try {
      const result = await apply(text, request);
      action.results = result.results;
      action.completedAt = performance.now();
      event('action-completed', { command: text });
      return result;
    } catch (error) {
      action.error = error.message;
      throw error;
    }
  };
  const respond = speakResponse;
  speakResponse = function (text, options) {
    event('final-response-called', { text });
    data.finalText = text;
    return respond(text, options);
  };
  const nativeSpeak = synthesis.speak.bind(synthesis);
  synthesis.speak = function (utterance) {
    const speech = {
      role: utterance.text === data.acknowledgementText && !data.speeches.some(item => item.role === 'acknowledgement') ? 'acknowledgement' : 'final', text: utterance.text,
      queuedAt: performance.now(), voice: utterance.voice?.name || 'platform default',
      lang: utterance.lang, volume: utterance.volume,
    };
    data.speeches.push(speech);
    event('speech-queued', { role: speech.role, text: speech.text });
    utterance.addEventListener('start', () => {
      speech.startedAt = performance.now();
      event('speech-started', { role: speech.role });
    }, { once: true });
    utterance.addEventListener('end', () => {
      speech.endedAt = performance.now();
      event('speech-ended', { role: speech.role });
    }, { once: true });
    utterance.addEventListener('error', error => {
      speech.error = error.error || 'unknown';
      event('speech-error', { role: speech.role, error: speech.error });
    }, { once: true });
    return nativeSpeak(utterance);
  };
  data.start = async (text, wavBase64) => {
    data.startedAt = performance.now();
    event('turn-started');
    try {
      if (wavBase64) {
        const bytes = Uint8Array.from(atob(wavBase64), character => character.charCodeAt(0));
        await processAudioBlobWithGemini(new Blob([bytes], { type: 'audio/wav' }));
      } else {
        await processTextCommandWithGemini(text);
      }
      data.transcript = userText.textContent;
      data.transcriptResponse = aiText.textContent;
    } catch (error) {
      data.error = error.message;
    } finally {
      data.turnDone = true;
      data.completedAt = performance.now();
      event('turn-returned');
    }
  };
  return { engine: ttsEngine, voices: synthesis.getVoices().map(voice => ({ name: voice.name, lang: voice.lang })) };
}

async function runVerification() {
  assertVerificationActive();
  if (credentialSetupError) throw credentialSetupError;
  if (process.platform !== 'win32') throw new Error('This live smoke requires Windows.');
  for (let attempt = 0; attempt < 100; attempt++) {
    main = BrowserWindow.getAllWindows().find(window => /[\\/]index\.html$/.test(window.webContents.getURL()));
    if (main && !main.webContents.isLoading()) break;
    await pause(100);
    assertVerificationActive();
  }
  check('Production main window loaded', main && !main.webContents.isLoading());
  await pause(700);
  assertVerificationActive();
  const boot = await main.webContents.executeJavaScript(`({ process: typeof processTextCommandWithGemini, ack: typeof speakAssistantAcknowledgement, media: typeof window.electronAPI?.mediaControl, slots: document.querySelectorAll('#quickActionsEditor fieldset').length })`);
  assertVerificationActive();
  check('Production renderer and preload initialized', boot.process === 'function' && boot.ack === 'function' && boot.media === 'function' && boot.slots === 5, boot);

  let wavBase64 = '';
  if (liveAudio) {
    let key = loadExistingGeminiKey();
    wavBase64 = await createSyntheticWav();
    assertVerificationActive();
    await main.webContents.executeJavaScript(`(async () => { apiKey = ${JSON.stringify(key)}; apiKeys = [apiKey]; currentKeyIndex = 0; apiKeyRotation = false; await window.electronAPI.secureStoreSet('gemini_api_keys', JSON.stringify(apiKeys)); })()`);
    key = '';
    assertVerificationActive();
  }
  originalVolume = await main.webContents.executeJavaScript(`window.electronAPI.mediaControl('VOLUME_STATUS')`);
  assertVerificationActive();
  report.originalVolume = originalVolume;
  check('Original system volume and mute state read', originalVolume.ok && originalVolume.verified && Number.isFinite(originalVolume.volume) && typeof originalVolume.muted === 'boolean', originalVolume);
  if (playSpotify) {
    originalPlayback = await main.webContents.executeJavaScript(`window.electronAPI.mediaControl('MEDIA_STATUS', true)`);
    assertVerificationActive();
    report.originalPlayback = originalPlayback;
    check('Original Spotify playback state is confirmed before any action', playbackState(originalPlayback) !== 'unknown', originalPlayback);
  }
  volumePhase = 'baseline';
  await startVolumeSampler();
  assertVerificationActive();
  const independentBaseline = report.volumeTimeline.samples.at(-1);
  check('Separate process baseline agrees with production readback', Math.abs(independentBaseline.volume - originalVolume.volume) <= 0.5 && independentBaseline.muted === originalVolume.muted, independentBaseline);
  report.voice = await main.webContents.executeJavaScript(`(${installRendererObservers.toString()})()`);
  assertVerificationActive();
  volumePhase = 'assistant-request';
  assistantCommandStarted = true;
  await main.webContents.executeJavaScript(`void window.__voiceCommandSmoke.start(${JSON.stringify(command)}, ${JSON.stringify(wavBase64)});`, true);
  assertVerificationActive();
  for (;;) {
    const state = await main.webContents.executeJavaScript(`JSON.parse(JSON.stringify(window.__voiceCommandSmoke))`);
    assertVerificationActive();
    report.turn = state;
    if (state.error) throw new Error(state.error);
    const finalSpeech = state.speeches.find(speech => speech.role === 'final');
    if (state.turnDone && !state.finalText) throw new Error('The assistant returned without speaking a final result.');
    if (state.turnDone && report.rendererErrors.length) throw new Error('The renderer reported an error: ' + report.rendererErrors.join('; '));
    if (state.turnDone && (finalSpeech?.endedAt || finalSpeech?.error)) break;
    await pause(100);
    assertVerificationActive();
  }
  const turn = report.turn;
  const ack = turn.events.find(event => event.type === 'acknowledgement-called');
  const ackSpeech = turn.speeches.find(speech => speech.role === 'acknowledgement');
  const ackSettled = turn.events.find(event => event.type === 'acknowledgement-settled' && event.completed === true);
  const finalSpeech = turn.speeches.find(speech => speech.role === 'final');
  const finalCall = turn.events.find(event => event.type === 'final-response-called');
  report.timings = {
    acknowledgementCalledMs: ack?.at - turn.startedAt,
    acknowledgementStartedMs: ackSpeech?.startedAt - turn.startedAt,
    finalSpeechStartedMs: finalSpeech?.startedAt - turn.startedAt,
    finalSpeechEndedMs: finalSpeech?.endedAt - turn.startedAt,
  };
  check('Acknowledgement called within 100ms', ack && ack.at - turn.startedAt <= 100, report.timings);
  check('Both ordered actions executed', turn.actions.length === 2 && (playSpotify ? turn.actions[0].command === '[MEDIA_PLAY]' : /^\[OPEN_APP: spotify\]$/i.test(turn.actions[0].command)) && turn.actions[1].command === '[VOLUME_SET: 75]', turn.actions);
  check('Acknowledgement queued before app launch', ackSpeech && ack.at <= ackSpeech.queuedAt && ackSpeech.queuedAt <= turn.actions[0].startedAt);
  check('Both actions returned verified native receipts', turn.actions.every(action => action.results?.length === 1 && action.results[0].ok === true && action.results[0].verified === true), turn.actions);
  const spotify = turn.actions[0].results[0];
  if (playSpotify) {
    check('Spotify playback is verified with a playing track, not just an opened window', spotify.source === 'spotify' && spotify.status === 'Playing' && typeof spotify.title === 'string' && !!spotify.title.trim(), spotify);
    report.playbackReadback = await main.webContents.executeJavaScript(`window.electronAPI.mediaControl('MEDIA_STATUS', true)`);
    assertVerificationActive();
    check('Fresh Spotify session readback confirms a track is still playing', playbackState(report.playbackReadback) === 'playing', report.playbackReadback);
    report.trackChangedDuringTurn = report.playbackReadback.title !== spotify.title;
  } else check('Spotify window receipt includes its process ID', spotify.source === 'spotify' && Number.isInteger(spotify.processId) && spotify.processId > 0, spotify);
  check('Windows acknowledgement actually started and ended', ackSpeech?.startedAt && ackSpeech?.endedAt && !ackSpeech.error, ackSpeech);
  // The production onend handler resolves its promise before this smoke's
  // later end listener runs. Promise settlement proves semantic completion;
  // native speech start/end events separately prove the audio did not overlap.
  check('Final response waited for acknowledgement completion and all actions', finalCall && ackSettled && finalCall.at >= ackSettled.at && turn.actions.every(action => finalCall.at >= action.completedAt));
  check('Final audio started after acknowledgement audio ended', finalSpeech?.startedAt >= ackSpeech.endedAt);
  check('Final response includes both concrete outcomes', (playSpotify ? /playing|resumed/i.test(turn.finalText) : /spotify/i.test(turn.finalText)) && /75\s*%/.test(turn.finalText), turn.finalText);
  check('Final Windows speech actually started and ended without interruption', finalSpeech?.startedAt && finalSpeech?.endedAt && !finalSpeech.error && turn.speeches.length === 2, turn.speeches);
  const volumeCommands = report.nativeMediaCommands.filter(entry => entry.phase === 'assistant-request' && entry.command.action.startsWith('VOLUME_') && entry.command.action !== 'VOLUME_STATUS');
  check('Native helper received exactly one volume change during the assistant turn', volumeCommands.length === 1 && volumeCommands[0].command.action === 'VOLUME_SET' && volumeCommands[0].command.level === 75, volumeCommands);
  volumePhase = 'post-speech-observation';
  await pause(1000);
  assertVerificationActive();
  report.volumeReadback = await main.webContents.executeJavaScript(`window.electronAPI.mediaControl('VOLUME_STATUS')`);
  assertVerificationActive();
  check('Production Windows readback is 75% and unmuted', report.volumeReadback.ok && report.volumeReadback.verified && Math.abs(report.volumeReadback.volume - 75) <= 0.5 && report.volumeReadback.muted === false, report.volumeReadback);
  const confirmedAt = turn.timeOrigin + turn.actions[1].completedAt;
  const confirmedSamples = report.volumeTimeline.samples.filter(sample => sample.epochMs >= confirmedAt);
  check('Separate native sampler stayed at 75% and unmuted from receipt through final speech and one second afterward', confirmedSamples.length >= 8 && confirmedSamples.every(sample => Math.abs(sample.volume - 75) <= 0.5 && sample.muted === false), { samples: confirmedSamples.length, levels: [...new Set(confirmedSamples.map(sample => sample.volume))], muted: [...new Set(confirmedSamples.map(sample => sample.muted))] });
  check('Separate native sampler reported no errors', report.volumeTimeline.errors.length === 0 && !report.volumeTimeline.exit, report.volumeTimeline.errors);
  check('No renderer errors', report.rendererErrors.length === 0, report.rendererErrors);
  report.provider = await main.webContents.executeJavaScript(`window.electronAPI.providerStatus()`);
  if (liveAudio) check('Live audio used exactly one successful main-process Gemini transcription request', report.provider.totals.requests === 1 && report.provider.totals.attempts === 1 && report.provider.totals.succeeded === 1, report.provider.totals);
  else check('Typed command made no Gemini model requests', report.provider.totals.requests === 0, report.provider.totals);

  // Exercise desired-state mute twice in each direction through production IPC,
  // then read the endpoint separately. Finally always restores the baseline.
  report.muteChecks = [];
  volumePhase = 'mute-repetition-checks';
  for (const action of ['VOLUME_MUTE_ON', 'VOLUME_MUTE_ON', 'VOLUME_MUTE_OFF', 'VOLUME_MUTE_OFF']) {
    assertVerificationActive();
    const result = await main.webContents.executeJavaScript(`window.electronAPI.mediaControl(${JSON.stringify(action)})`);
    assertVerificationActive();
    const readback = await main.webContents.executeJavaScript(`window.electronAPI.mediaControl('VOLUME_STATUS')`);
    assertVerificationActive();
    report.muteChecks.push({ action, result, readback });
    check(`${action} preserves its requested state and volume on every repetition`, result.ok && result.verified && readback.ok && readback.verified && readback.muted === (action === 'VOLUME_MUTE_ON') && Math.abs(readback.volume - 75) <= 0.5, readback);
  }
}

async function restoreVolume() {
  volumePhase = 'restoration';
  if (!main || main.isDestroyed()) {
    if (assistantCommandStarted) throw new Error('The test window closed before system volume could be restored.');
    return;
  }
  await main.webContents.executeJavaScript(`cancelAssistantRequest(); apiKey = ''; apiKeys = []; void 0;`);
  if (liveAudio) await main.webContents.executeJavaScript(`window.electronAPI.secureStoreSet('gemini_api_keys', null)`);
  if (!assistantCommandStarted || !originalVolume?.ok || !originalVolume.verified) return;
  report.restoration.attempted = true;
  report.restoration.set = await main.webContents.executeJavaScript(`window.electronAPI.mediaControl('VOLUME_SET', false, ${JSON.stringify(originalVolume.volume)})`);
  let status = await main.webContents.executeJavaScript(`window.electronAPI.mediaControl('VOLUME_STATUS')`);
  if (status.ok && status.muted !== originalVolume.muted) {
    report.restoration.mute = await main.webContents.executeJavaScript(`window.electronAPI.mediaControl('VOLUME_MUTE')`);
    status = await main.webContents.executeJavaScript(`window.electronAPI.mediaControl('VOLUME_STATUS')`);
  }
  report.restoration.readback = status;
  check('Original system volume and mute state restored', status.ok && status.verified && Math.abs(status.volume - originalVolume.volume) <= 0.5 && status.muted === originalVolume.muted, status);
}

async function restorePlayback() {
  if (!playSpotify) return;
  if (!main || main.isDestroyed()) {
    if (assistantCommandStarted && playbackState(originalPlayback) === 'not-playing') throw new Error('The test window closed before Spotify playback could be restored.');
    return;
  }
  report.playbackRestoration = await restoreSpotifyPlayback({
    baseline: originalPlayback, commandStarted: assistantCommandStarted, settleMs: 5000,
    control: action => main.webContents.executeJavaScript(`window.electronAPI.mediaControl(${JSON.stringify(action)}, true)`),
  });
  if (assistantCommandStarted && playbackState(originalPlayback) === 'not-playing')
    check('Test playback stopped when Spotify was not originally playing', report.playbackRestoration.verified, report.playbackRestoration);
}

saveReport();
function exitOnDeadline(message) {
  report.error ||= message;
  report.passed = false;
  report.cleanupFinished = cleanupFinished;
  report.finishedAt = new Date().toISOString();
  volumeSampler?.kill();
  summarizeVolumeTimeline();
  saveReport();
  console.error(`Voice command smoke timed out. Report: ${reportPath}`);
  app.exit(1);
}
let hardTimeout = setTimeout(() => exitOnDeadline('Live smoke exceeded its startup/verification deadline.'), 60000);
hardTimeout.unref();

const stopObservingFactory = observeMediaControllerFactory(require('../desktop/media-controller'), spawn, command => {
  report.nativeMediaCommands.push({ epochMs: Date.now(), phase: volumePhase, command });
});
try { require('../main'); } catch (error) {
  report.error = redact(error.message);
  saveReport();
  console.error('Voice command smoke failed at startup:', report.error);
  app.exit(1);
} finally { stopObservingFactory(); }

app.whenReady().then(async () => {
  let workTimeout;
  try {
    await Promise.race([
      runVerification(),
      new Promise((_, reject) => { workTimeout = setTimeout(() => reject(new Error('Verification exceeded 45 seconds; cancelling and restoring system volume.')), 45000); }),
    ]);
    report.passed = true;
  } catch (error) {
    report.error = redact(error.message);
  } finally {
    clearTimeout(workTimeout);
    // Fence the losing verification promise before cancelling its production
    // request, so no delayed await can dispatch another action during cleanup.
    verificationAborted = true;
    // Cleanup gets a separate bounded budget for sequential native calls;
    // it must not inherit only the tail of the verification deadline.
    clearTimeout(hardTimeout);
    hardTimeout = setTimeout(() => exitOnDeadline('Live smoke cleanup exceeded 180 seconds; restoration is incomplete.'), 180000);
    hardTimeout.unref();
    try { if (main && !main.isDestroyed()) await main.webContents.executeJavaScript('cancelAssistantRequest(); void 0'); } catch (_) { /* Both restoration paths still run. */ }
    try { await restorePlayback(); } catch (error) {
      report.playbackRestorationError = redact(error.message);
      report.passed = false;
    }
    try { await restoreVolume(); } catch (error) {
      report.restoration.error = redact(error.message);
      report.passed = false;
    }
    try {
      if (volumeSampler) {
        await pause(250);
        report.restoration.independentReadback = report.volumeTimeline.samples.at(-1);
        await volumeSampler.stop();
        summarizeVolumeTimeline();
        const cleanup = report.volumeTimeline.cleanup;
        check('Independent sampler stopped and released every Core Audio handle', !report.volumeTimeline.forcedTermination && report.volumeTimeline.exit?.code === 0 && cleanup?.reason === 'requested' && cleanup.reads === cleanup.released, cleanup);
        if (report.restoration.attempted) {
          const observed = report.restoration.independentReadback;
          check('Separate sampler confirms restored volume and mute state', observed?.phase === 'restoration' && Math.abs(observed.volume - originalVolume.volume) <= 0.5 && observed.muted === originalVolume.muted, observed);
        }
      }
    } catch (error) { report.volumeSamplerCleanupError = redact(error.message); report.passed = false; }
    cleanupFinished = true;
    if (main && !main.isDestroyed()) {
      try {
        fs.writeFileSync(screenshotPath, (await main.webContents.capturePage()).toPNG());
        report.screenshot = screenshotPath;
      } catch (error) { report.screenshotError = redact(error.message); }
    }
    report.finishedAt = new Date().toISOString();
    report.cleanupFinished = cleanupFinished;
    saveReport();
    clearTimeout(hardTimeout);
    console.log(`Voice command smoke ${report.passed ? 'passed' : 'failed'} (${report.mode}). Report: ${reportPath}`);
    if (report.error) console.error(report.error);
    app.exit(report.passed ? 0 : 1);
  }
});
