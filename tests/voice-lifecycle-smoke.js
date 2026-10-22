'use strict';
// Production voice code, real bundled Vosk and Chromium's fake capture device.
// Private profile; blocked providers/native actions; no physical mic/playback.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../build/qa/voice-lifecycle');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'profile-'));
const wave = Buffer.alloc(44 + 16000 * 2 * 10);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
const waveFile = path.join(profile, 'silence.wav'); fs.writeFileSync(waveFile, wave);
app.setPath('userData', profile);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', waveFile);
if (!process.argv.includes('--hidden')) process.argv.push('--hidden');
const report = { passed: false, profile, checks: [], forbiddenCalls: [], errors: [], coldResumes: [],
  coverage: { productionVoice: true, bundledModel: true, syntheticMicrophone: true, physicalMicrophone: false, providerCalls: false, desktopActions: false, playback: false } };
let main, finished = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = fn => main.webContents.executeJavaScript('(' + fn.toString() + ')()', true);
async function waitFor(fn, label, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(fn)) return; await pause(25); }
  throw new Error(label);
}
async function check(name, action) { await action(); report.checks.push({ name, passed: true }); }
const forbidden = new Set(['provider-generate', 'nvidia-tts-synthesize', 'nvidia-tts-config', 'media-control', 'open-app', 'close-app', 'arrange-app', 'play-spotify', 'desktop-capture', 'desktop-run', 'desktop-undo']);
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, (event, ...args) => {
  if (forbidden.has(channel)) { report.forbiddenCalls.push(channel); throw new Error('Disabled in voice lifecycle fixture: ' + channel); }
  return callback(event, ...args);
});
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, _file, error) => report.errors.push(error.message));
  contents.on('render-process-gone', (_event, details) => report.errors.push(details.reason));
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
});
require('../main');
const deadline = setTimeout(() => finish(new Error('Voice lifecycle fixture exceeded 90 seconds.')), 90000); deadline.unref();
function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline);
  if (error) { report.error = error.stack; report.passed = false; }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); app.exit(report.passed ? 0 : 1);
}
function ready() {
  return !isMicMuted && isVoskReady && !!voskRecognizer && audioContext?.state === 'running' &&
    micStream?.active && micStream.getAudioTracks().some(track => track.enabled && track.readyState === 'live');
}
app.whenReady().then(async () => {
  try {
    for (let index = 0; index < 200; index++) {
      main = BrowserWindow.getAllWindows().find(window => /index\.html$/.test(window.webContents.getURL()));
      if (main && await evaluate(() => document.readyState === 'complete' && typeof initVosk === 'function')) break;
      await pause(25);
    }
    assert(main, 'Production renderer did not load');
    await waitFor(() => window.OlangaAppInitialized === true, 'Production initialization did not complete', 15000);
    await evaluate(() => { document.getElementById('startLocalBtn').click(); muteTts(); });
    await evaluate(async () => { await initVosk({ microphone: true }); });
    await check('A real fake-device track ending before publication is rejected and cleaned up', async () => {
      const state = await evaluate(async () => {
        const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async options => {
          const stream = await capture(options); stream.getTracks().forEach(track => track.stop()); return stream;
        };
        try {
          const initialized = await initMicrophone();
          return { initialized, mic: !!micStream, context: !!audioContext, recognizer: !!voskRecognizer, registered: voskModel.recognizers.size };
        } finally { navigator.mediaDevices.getUserMedia = capture; }
      });
      assert.deepEqual(state, { initialized: false, mic: false, context: false, recognizer: false, registered: 0 });
      report.disconnectedStartup = state;
    });
    await evaluate(async () => { await initMicrophone(); });
    await waitFor(ready, 'Initial voice capture failed', 45000);
    await check('Short mute reuses live native capture and its warm model', async () => {
      await evaluate(() => {
        window.voiceFixture = { graph: audioContext, track: micStream.getAudioTracks()[0], model: voskModel };
        muteMic();
      });
      await pause(150); const start = Date.now(); await evaluate(() => unmuteMic());
      await waitFor(ready, 'Short mute failed to resume'); report.warmResumeMs = Date.now() - start;
      assert.deepEqual(await evaluate(() => ({ graph: audioContext === voiceFixture.graph, track: micStream.getAudioTracks()[0] === voiceFixture.track,
        model: voskModel === voiceFixture.model, live: voiceFixture.track.readyState })), { graph: true, track: true, model: true, live: 'live' });
    });
    await check('Real native recognizer replacement rejects old wake results and accepts the new rough transcript', async () => {
      const state = await evaluate(() => {
        const old = voskRecognizer, graph = audioContext; setState(State.LISTENING); const recording = startRecording();
        const emit = (recognizer, text) => recognizer.dispatchEvent(new CustomEvent('partialresult', { detail: { result: { partial: text } } }));
        emit(old, 'old wake words'); const stale = getLiveTranscript(); emit(voskRecognizer, 'fresh request');
        const result = { recording, replaced: old !== voskRecognizer, oldRegistered: voskModel.recognizers.has(old.id),
          recognizers: voskModel.recognizers.size, stale, fresh: getLiveTranscript(), sameGraph: graph === audioContext };
        cancelRecording(); setState(State.IDLE); return result;
      });
      assert.deepEqual(state, { recording: true, replaced: true, oldRegistered: false, recognizers: 1, stale: '', fresh: 'fresh request', sameGraph: true });
      report.nativeRecognizerBoundary = state;
    });
    for (let repetition = 0; repetition < 3; repetition++) {
      await check('Sustained mute closes capture and cold resume restores voice, cycle ' + (repetition + 1), async () => {
        await evaluate(() => { voiceFixture.graph = audioContext; voiceFixture.track = micStream.getAudioTracks()[0]; muteMic(); });
        await waitFor(() => !micStream && !audioContext && !voskModel && !isVoskReady, 'Sustained mute retained audio resources');
        assert.deepEqual(await evaluate(() => ({ track: voiceFixture.track.readyState, context: voiceFixture.graph.state, recording: isRecording })),
          { track: 'ended', context: 'closed', recording: false });
        const start = Date.now(); await evaluate(() => unmuteMic()); await waitFor(ready, 'Cold voice capture did not recover', 45000);
        report.coldResumes.push({ elapsedMs: Date.now() - start, ...await evaluate(() => ({ freshGraph: audioContext !== voiceFixture.graph,
          freshTrack: micStream.getAudioTracks()[0] !== voiceFixture.track, nativeRecognizers: voskModel.recognizers.size })) });
        assert.equal(report.coldResumes.at(-1).freshGraph, true); assert.equal(report.coldResumes.at(-1).freshTrack, true);
        assert.equal(report.coldResumes.at(-1).nativeRecognizers, 1, 'Recognition cannot accumulate across resumes');
      });
    }
    await check('Fixture made no provider or desktop action calls and recorded no renderer failures', async () => {
      assert.deepEqual(report.forbiddenCalls, []); assert.deepEqual(report.errors, []);
    });
    await evaluate(() => { muteMic(false); releaseMicrophoneResources(microphoneResources); });
    report.passed = true; finish();
  } catch (error) { finish(error); }
});
