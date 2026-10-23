'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const prefs = require('../../shared/prefs-schema');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const initial = { ...prefs.defaults(), microphoneDeviceId: 'mic-one' };
  const values = new Map(), writes = [], errors = [], timers = new Map(), controls = { write: null, capture: null };
  let timerSequence = 0;
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  prefs.writeToStorage(storage, initial);
  let saved = JSON.stringify(initial);
  const context = vm.createContext({
    OlangaPrefs: prefs, OlangaStatusLight: require('../../shared/status-light'), OlangaShortcuts: require('../../shared/shortcuts'),
    OlangaNvidiaKey: require('../../shared/nvidia-key'), OlangaGeminiKeys: require('../../shared/gemini-keys'),
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: { electronAPI: { async secureStoreSet(_key, value) { const candidate = JSON.parse(value); writes.push(candidate); await controls.write?.(candidate, writes.length); saved = value; } } },
    localStorage: storage, navigator: { mediaDevices: { async enumerateDevices() { return ['mic-one','mic-two'].map(deviceId => ({ kind:'audioinput',deviceId })); } } },
    mainScreen: null, setupScreen: null, customWakeWordGroups: [], CUSTOM_WAKE_WORDS_KEY: 'olanga_custom_wake_words', persistCustomWakeWordGroups() {},
    statusLightMode: initial.statusLightMode, statusLightSize: initial.statusLightSize, quickActions: initial.quickActions,
    cityInput: { value: 'Original city' }, stateInput: { value: '' }, countryInput: { value: '' }, rotationToggle: { checked: false },
    ttsEngineSelect: null, ttsRateInput: null, nvidiaVoiceSelect: null, nvidiaVoiceName: prefs.DEFAULT_NVIDIA_VOICE,
    ttsEngine: 'windows', ttsRate: 1.05, apiKeyRotation: false, userCity: '', userState: '', userCountry: '',
    micStream: null, audioContext: null, analyser: null, scriptNode: null, voskRecognizer: null, voskModel: null, isVoskReady: false, currentRMS: 0,
    isMicMuted: false, isTtsMuted: false, isRecording: false, isWakeWordCapturing: false, currentState: 'idle',
    State: { IDLE: 'idle', THINKING: 'thinking', LISTENING: 'listening', SPEAKING: 'speaking' },
    bargeInEnabled: true, streamRepliesEnabled: true, endOfSpeechMs: 1500, SILENCE_DURATION: 1500,
    console: { log() {}, warn() {}, error() {} }, clearTimeout: id => timers.delete(id),
    setTimeout(callback, delay) { const id = ++timerSequence; timers.set(id, { callback, delay }); return id; },
    showError: message => errors.push(message)
  });
  for (const file of ['js/voice.js', 'js/settings.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'), context);
  context.initializeMicrophoneResources = options => controls.capture?.(options) ?? Promise.resolve(true);
  context.discardLocalSpeechCapture = () => {};
  return { context, controls, writes, errors, timers, saved: () => JSON.parse(saved), mirror: () => prefs.load(storage),
    api: context.window.OlangaAudioInput,
    active() { vm.runInContext('microphoneRequested = true; microphoneResources = {context:{state:"running"},recognizer:{}}; micStream = {active:true,getAudioTracks:()=>[{label:"Original microphone"}]};', context); }
  };
}

test('an ordinary preference save queued during device persistence retains the explicit device choice', async () => {
  const f = fixture(), save = deferred();
  f.controls.write = (_value, index) => index === 1 ? save.promise : undefined;
  const changing = f.api.choose('mic-two'); await settle();
  assert.equal(f.writes.length, 1); assert.equal(f.api.snapshot().preferredDeviceId, 'mic-one');
  f.context.cityInput.value = 'Latest city'; const editing = f.context.saveAppSettings();
  save.resolve(); await changing; assert.equal(await editing, true);
  assert.equal(f.api.snapshot().preferredDeviceId, 'mic-two');
  assert.equal(f.saved().microphoneDeviceId, 'mic-two'); assert.equal(f.mirror().microphoneDeviceId, 'mic-two');
  assert.equal(f.saved().city, 'Latest city');
});

test('a successful save does not publish a selected device before its capture graph is ready', async () => {
  const f = fixture(), capture = deferred(); f.active();
  f.controls.capture = () => capture.promise;
  const changing = f.api.choose('mic-two'); await settle();
  assert.equal(f.saved().microphoneDeviceId, 'mic-two');
  assert.equal(f.api.snapshot().preferredDeviceId, 'mic-one');
  f.context.cityInput.value = 'Edited during capture'; await f.context.saveAppSettings();
  assert.equal(f.saved().microphoneDeviceId, 'mic-two');
  assert.equal(f.api.snapshot().preferredDeviceId, 'mic-one');
  capture.resolve(true); await changing;
  assert.equal(f.api.snapshot().preferredDeviceId, 'mic-two'); assert.equal(f.saved().city, 'Edited during capture');
});

test('a failed device save rolls back its device while retaining edits made during the delayed write', async () => {
  const f = fixture(), save = deferred();
  f.controls.write = (_value, index) => index === 1 ? save.promise : undefined;
  const changing = f.api.choose('mic-two'); const rejected = assert.rejects(changing, /Fixture save failed/); await settle();
  f.context.cityInput.value = 'Edit made while saving'; const editing = f.context.saveAppSettings();
  save.reject(Error('Fixture save failed')); await rejected; await editing;
  assert.equal(f.api.snapshot().preferredDeviceId, 'mic-one'); assert.equal(f.saved().microphoneDeviceId, 'mic-one');
  assert.equal(f.saved().city, 'Edit made while saving');
  assert.equal(f.writes[1].city, 'Edit made while saving', 'Rollback must not temporarily write an obsolete copy over newer user edits');
});

test('capture failure restores the saved device and retains ordinary edits queued during capture', async () => {
  const f = fixture(), capture = deferred(); f.active(); f.controls.capture = () => capture.promise;
  const changing = f.api.choose('mic-two'); const rejected = assert.rejects(changing, /previous microphone is still selected/); await settle();
  f.context.cityInput.value = 'Keep this edit'; await f.context.saveAppSettings();
  capture.resolve(false); await rejected;
  assert.equal(f.api.snapshot().preferredDeviceId, 'mic-one'); assert.equal(f.saved().microphoneDeviceId, 'mic-one');
  assert.equal(f.saved().city, 'Keep this edit'); assert.equal(f.mirror().microphoneDeviceId, 'mic-one');
});

test('ordinary writes preceding an explicit choice do not persist that choice early', async () => {
  const f = fixture(), save = deferred();
  f.controls.write = (_value, index) => index === 1 ? save.promise : undefined;
  f.context.cityInput.value = 'Before selection'; const editing = f.context.saveAppSettings(); await settle();
  const changing = f.api.choose('mic-two'); await settle();
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].microphoneDeviceId, 'mic-one');
  save.resolve(); await editing; await changing;
  assert.equal(f.saved().microphoneDeviceId, 'mic-two'); assert.equal(f.saved().city, 'Before selection');
});


test('an ordinary edit queued during capture rollback retains the restored device', async () => {
  const f = fixture(), capture = deferred(), rollback = deferred(); f.active();
  f.controls.capture = () => capture.promise;
  f.controls.write = (_value, index) => index === 3 ? rollback.promise : undefined;
  const changing = f.api.choose('mic-two'); const rejected = assert.rejects(changing, /previous microphone is still selected/); await settle();
  f.context.cityInput.value = 'During capture'; await f.context.saveAppSettings();
  capture.resolve(false); await settle(); assert.equal(f.writes.length, 3);
  f.context.cityInput.value = 'During rollback'; const editing = f.context.saveAppSettings();
  rollback.resolve(); await rejected; assert.equal(await editing, true);
  assert.equal(f.api.snapshot().preferredDeviceId, 'mic-one'); assert.equal(f.saved().microphoneDeviceId, 'mic-one');
  assert.equal(f.saved().city, 'During rollback'); assert.equal(f.mirror().city, 'During rollback');
});

test('a portable preference restore cannot overwrite the device selected while its write was pending', async () => {
  const f = fixture(), capture = deferred(), restored = deferred(); f.active();
  f.controls.capture = () => capture.promise;
  f.controls.write = (_value, index) => index === 2 ? restored.promise : undefined;
  const changing = f.api.choose('mic-two'); await settle();
  const portable = f.context.window.OlangaPortablePreferences;
  const restoring = portable.apply({ ...portable.snapshot(), responseStyle: 'concise' }); await settle();
  assert.equal(f.writes[1].microphoneDeviceId, 'mic-two');
  assert.equal(f.api.snapshot().preferredDeviceId, 'mic-one');
  capture.resolve(true); await changing; restored.resolve(); await restoring;
  assert.equal(f.api.snapshot().preferredDeviceId, 'mic-two'); assert.equal(f.saved().microphoneDeviceId, 'mic-two');
  assert.equal(f.saved().responseStyle, 'concise');
});

test('a failed device rollback reports the recovery failure and leaves the previous runtime choice intact', async () => {
  const f = fixture();
  f.controls.write = (_value, index) => Promise.reject(Error(index === 1 ? 'Fixture device write failed' : 'Fixture rollback failed'));
  await assert.rejects(f.api.choose('mic-two'), /Fixture device write failed.*selection could not be restored: Fixture rollback failed/);
  assert.equal(f.api.snapshot().preferredDeviceId, 'mic-one');
  f.controls.write = null; f.context.cityInput.value = 'Retry after failure';
  assert.equal(await f.context.saveAppSettings(), true);
  assert.equal(f.saved().microphoneDeviceId, 'mic-one'); assert.equal(f.saved().city, 'Retry after failure');
});


test('microphone selection flushes a pending settings edit into runtime before saving the device', async () => {
  const f = fixture(), save = deferred(); f.context.userCity = 'Original city';
  f.controls.write = (_value, index) => index === 1 ? save.promise : undefined;
  f.context.cityInput.value = 'City edited before device'; f.context.scheduleSaveAppSettings();
  assert.equal(f.timers.size, 1);
  const changing = f.api.choose('mic-two'); await settle();
  const during = { city: f.context.userCity, device: f.api.snapshot().preferredDeviceId, timers: f.timers.size };
  save.resolve(); await changing;
  assert.deepEqual(during, { city: 'City edited before device', device: 'mic-one', timers: 0 });
  assert.deepEqual(f.writes.map(value => value.microphoneDeviceId), ['mic-one', 'mic-two']);
  assert.equal(f.saved().city, 'City edited before device'); assert.equal(f.saved().microphoneDeviceId, 'mic-two');
});

test('capture rollback flushes pending non-device edits without publishing the failed device', async () => {
  const f = fixture(), capture = deferred(); f.active(); f.context.userCity = 'Original city';
  f.controls.capture = () => capture.promise;
  const changing = f.api.choose('mic-two'); const rejected = assert.rejects(changing, /previous microphone is still selected/); await settle();
  f.context.cityInput.value = 'City edited before rollback'; f.context.scheduleSaveAppSettings();
  capture.resolve(false); await rejected;
  assert.equal(f.timers.size, 0); assert.equal(f.context.userCity, 'City edited before rollback');
  assert.equal(f.saved().city, 'City edited before rollback'); assert.equal(f.saved().microphoneDeviceId, 'mic-one');
  assert.equal(f.api.snapshot().preferredDeviceId, 'mic-one');
});
