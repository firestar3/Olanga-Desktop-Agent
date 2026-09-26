// Local-only quality check: bundled Vosk + a Windows-generated WAV. No cloud
// request, microphone, playback, app launch, or system volume change occurs.
// Run: electron tests/offline-speech-smoke.js [--compare-grammar]
const { app, BrowserWindow, protocol, net, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build', 'qa');
const command = 'Open Spotify and raise the volume to 75%';
const compareGrammar = process.argv.includes('--compare-grammar');
const reportName = compareGrammar ? 'offline-speech-grammar-comparison' : 'offline-speech-smoke';
const examples = compareGrammar ? [command,
  'Launch Notepad and set the volume to 23 percent',
  'Pause the music',
  'Resume playback and lower the volume to forty two percent',
  'Set a timer for seven minutes',
  'Open calculator then start a timer for ninety seconds',
  'Next track and open Firefox',
  'What is the weather in Seattle tomorrow?'
] : [command];
fs.mkdirSync(output, { recursive: true });
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(output, 'offline-speech-profile-')));
protocol.registerSchemesAsPrivileged([{ scheme: 'olanga-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const report = { command, compareGrammar, startedAt: new Date().toISOString(), passed: false, network: [], checks: [],
  coverage: { bundledModel: true, realAudioDecode: true, physicalMicrophone: false, providerCalls: false, desktopActions: false, speechPlayback: false } };
let browser;
function check(name, passed, detail) {
  report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) });
}
async function makeWav(text, index) {
  const filename = path.join(output, compareGrammar ? `offline-command-fixture-${index}.wav` : 'offline-speech-fixture.wav');
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -AssemblyName System.Speech\n$offlineFixtureVoice = New-Object System.Speech.Synthesis.SpeechSynthesizer\ntry { $offlineFixtureVoice.SetOutputToWaveFile(${quote(filename)}); $offlineFixtureVoice.Speak(${quote(text)}) } finally { $offlineFixtureVoice.Dispose() }`;
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('WAV generation timed out.')); }, 15000);
    child.once('error', reason => { clearTimeout(timer); reject(reason); });
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`WAV generation failed (${code}): ${error.slice(0, 300)}`)); });
  });
  report.fixture = { path: filename, bytes: fs.statSync(filename).size, source: 'Windows System.Speech.Synthesis; no microphone' };
  (report.fixtures ||= []).push({ command: text, ...report.fixture });
  return fs.readFileSync(filename).toString('base64');
}

app.whenReady().then(async () => {
  try {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      report.network.push({ url: details.url, blocked: true }); callback({ cancel: true });
    });
    protocol.handle('olanga-asset', async request => {
      if (new URL(request.url).pathname !== '/vosk-model-v2.tar.gz') return new Response('Not found', { status: 404 });
      const response = await net.fetch(pathToFileURL(path.join(root, 'vosk-model-v2.tar.gz')).href);
      const headers = new Headers(response.headers); headers.set('Access-Control-Allow-Origin', '*');
      return new Response(response.body, { status: response.status, headers });
    });
    const fixtures = [];
    for (const [index, text] of examples.entries()) fixtures.push({ command: text, audio: await makeWav(text, index),
      expectedActions: require('../shared/fast-intents').parse(text)?.map(action => action.command.toLowerCase()) || null });
    const filename = path.join(output, 'offline-speech-smoke.html');
    const script = relative => `<script src="${pathToFileURL(path.join(root, relative)).href}"></script>`;
    fs.writeFileSync(filename, `<!doctype html><title>Offline speech verification</title><script>let voskModel = null; let isVoskReady = false;</script>${script('node_modules/vosk-browser/dist/vosk.js')}${script('shared/fast-intents.js')}${script('js/voice.js')}${script('js/offline-speech.js')}`);
    browser = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    browser.webContents.on('console-message', (event, ...legacy) => {
      const message = event?.message || legacy[1];
      if (message && /error|failed/i.test(message)) (report.rendererMessages ||= []).push(String(message).slice(0, 1000));
    });
    await browser.loadFile(filename);
    const result = await browser.webContents.executeJavaScript(`(async () => {
      const fixtures = ${JSON.stringify(fixtures)};
      const blobs = fixtures.map(fixture => new Blob([Uint8Array.from(atob(fixture.audio), character => character.charCodeAt(0))], {type: 'audio/wav'}));
      const decoders = [];
      const NativeAudioContext = window.AudioContext;
      window.AudioContext = function(config) { const decoder = new NativeAudioContext(config); decoders.push(decoder); return decoder; };
      const runs = [];
      let modelLoadMs;
      if (${compareGrammar}) { const started = performance.now(); await initVosk(); modelLoadMs = performance.now() - started; }
      for (const [index, fixture] of fixtures.entries()) {
        const variants = ${compareGrammar} ? [{mode:'general'}, {mode:'commands'}] : [{mode:'general',temperature:'cold'}, {mode:'general',temperature:'warm'}];
        for (const variant of variants) {
          const started = performance.now();
          const transcript = await window.OlangaOfflineSpeech.transcribe(blobs[index], {mode:variant.mode});
          runs.push({ ...variant, command: fixture.command, expectedActions: fixture.expectedActions, transcript, elapsedMs: performance.now() - started,
            actions: OlangaIntents.parse(transcript)?.map(action => action.command.toLowerCase()) || null,
            status: window.OlangaOfflineSpeech.getStatus(), nativeRecognizerCount: voskModel.recognizers.size });
        }
      }
      const controller = new AbortController();
      const pending = window.OlangaOfflineSpeech.transcribe(blobs[0], {signal: controller.signal}).then(() => 'unexpected-success', error => error.name);
      controller.abort();
      const cancellation = await pending;
      return { runs, modelLoadMs, cancellation, finalStatus: window.OlangaOfflineSpeech.getStatus(), nativeRecognizerCount: voskModel.recognizers.size,
        decoderStates: decoders.map(decoder => decoder.state) };
    })()`);
    Object.assign(report, result);
    check('Cold and warm recognition produced text', result.runs.every(run => !!run.transcript.trim()));
    for (const run of result.runs) run.actionsMatch = JSON.stringify(run.actions) === JSON.stringify(run.expectedActions);
    if (compareGrammar) {
      report.comparison = ['general', 'commands'].map(mode => {
        const runs = result.runs.filter(run => run.mode === mode && run.expectedActions);
        return { mode, correctCommands: runs.filter(run => run.actionsMatch).length, totalCommands: runs.length,
          meanMs: runs.reduce((sum, run) => sum + run.elapsedMs, 0) / runs.length,
          outOfScope: result.runs.filter(run => run.mode === mode && !run.expectedActions).map(run => ({ transcript: run.transcript, actions: run.actions })) };
      });
      check('Command grammar preserves every held-out command and rejects out-of-scope actions', result.runs.filter(run => run.mode === 'commands').every(run => run.actionsMatch), report.comparison);
    } else {
      check('Exact Spotify and 75 percent actions survive recognition', result.runs.every(run => run.actionsMatch), result.runs.map(run => ({ temperature: run.temperature, transcript: run.transcript, actions: run.actions })));
    }
    check('Recognizers are removed after both recordings and cancellation', result.nativeRecognizerCount === 0 && result.runs.every(run => run.nativeRecognizerCount === 0));
    check('All audio decoding contexts are closed', result.decoderStates.every(state => state === 'closed'));
    check('Cancellation settles without leaving work active', result.cancellation === 'AbortError' && !result.finalStatus.busy);
    check('No remote network request was attempted', report.network.length === 0);
    // Compare with already-recorded cloud evidence only. This harness never
    // reads credentials or submits a recording to the provider.
    const priorCloud = path.join(output, 'voice-command-audio-smoke.json');
    if (fs.existsSync(priorCloud)) {
      const baseline = JSON.parse(fs.readFileSync(priorCloud, 'utf8'));
      if (baseline.command === command && baseline.passed && baseline.turn?.transcript) {
        const firstAction = baseline.turn.events?.find(event => event.type === 'action-started');
        report.previousCloudEvidence = { source: priorCloud, recordedAt: baseline.finishedAt || baseline.startedAt, transcript: baseline.turn.transcript,
          turnToFirstActionMs: firstAction ? firstAction.at - baseline.turn.startedAt : null,
          note: 'Prior run; turn-to-first-action includes routing overhead and is not a pure transcription benchmark.' };
      }
    }
    report.passed = report.checks.every(item => item.passed);
  } catch (error) {
    report.error = error.message;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, `${reportName}.json`), JSON.stringify(report, null, 2));
    if (browser && !browser.isDestroyed()) browser.destroy();
    console.log(JSON.stringify(report, null, 2));
    app.exit(report.passed ? 0 : 1);
  }
});
setTimeout(() => { report.error = 'Offline speech smoke timed out.'; fs.writeFileSync(path.join(output, `${reportName}.json`), JSON.stringify(report, null, 2)); app.exit(1); }, 180000).unref();
