const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = file => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function element() {
  return { children: [], value: '', disabled: false, textContent: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    set innerHTML(value) { this.markup = value; this.children = []; }, get innerHTML() { return this.markup || ''; },
    appendChild(child) { this.children.push(child); }, addEventListener() {}, querySelector() { return element(); }, querySelectorAll() { return []; } };
}
function settingsRenderer(options = {}) {
  const calls = { saves: [], model: 0, microphone: 0, errors: [] };
  const values = new Map(Object.entries(options.legacy || {})); let inputMode = 'cloud';
  const context = vm.createContext({
    OlangaPrefs: require('../../shared/prefs-schema'), OlangaNvidiaKey: require('../../shared/nvidia-key'), OlangaGeminiKeys: require('../../shared/gemini-keys'),
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: {
      OlangaWorkspace: { snapshot: () => ({ speechInput: inputMode }), preference: (_, value) => { inputMode = value; } },
      electronAPI: { secureStoreGet: key => options.get ? options.get(key) : Promise.resolve(options.stored?.[key] ?? null), secureStoreSet(key, value) { calls.saves.push({ key, value }); return options.save?.(key, value) || Promise.resolve(); } }
    },
    mainScreen: null, keyListContainer: null, apiKeys: [], apiKey: '', currentKeyIndex: 0, micStream: null,
    newKeyInput: { value: 'first-key' }, addKeyBtn: { disabled: false },
    apiKeyInput: { value: 'setup-key' }, nvidiaKeyInput: { value: '' }, saveKeyBtn: { disabled: false }, setupScreen: null,
    nvidiaApiKey: '', showMainScreen() {},
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => { if (options.removeError) throw new Error('storage unavailable'); values.delete(key); } },
    initVosk() { calls.model++; return options.model?.() || Promise.resolve(); },
    initMicrophone() { calls.microphone++; context.micStream = { active: true }; return Promise.resolve(true); },
    showError: message => calls.errors.push(message), console: { warn() {}, log() {} }
  });
  vm.runInContext(source('js/settings.js'), context);
  return { context, calls, values, mode: () => inputMode };
}

test('setup does not activate an unsaved key, and duplicate submits share the save guard', async () => {
  const failed = settingsRenderer({ save: () => Promise.reject(new Error('disk full')) });
  await failed.context.handleSaveKey();
  assert.equal(failed.context.apiKey, ''); assert.deepEqual(plain(failed.context.apiKeys), []);
  assert.equal(failed.context.saveKeyBtn.disabled, false);
  const saved = deferred(), h = settingsRenderer({ save: () => saved.promise });
  const pending = h.context.handleSaveKey(); await h.context.handleSaveKey();
  assert.equal(h.calls.saves.length, 1); assert.equal(h.context.apiKey, '');
  saved.resolve(); await pending;
  assert.equal(h.context.apiKey, 'setup-key');
});

test('key removal commits only after secure persistence and preserves the selected key index', async () => {
  for (const fail of [true, false]) {
    const h = settingsRenderer({ save: () => fail ? Promise.reject(new Error('disk full')) : Promise.resolve() });
    Object.assign(h.context, { apiKeys: ['one', 'two', 'three'], apiKey: 'three', currentKeyIndex: 2 });
    await h.context.removeGeminiKey(0);
    assert.deepEqual(plain(h.context.apiKeys), fail ? ['one', 'two', 'three'] : ['two', 'three']);
    assert.equal(h.context.apiKey, 'three'); assert.equal(h.context.currentKeyIndex, fail ? 2 : 1);
  }
});

test('legacy cleanup failure cannot turn a completed secure save into a reported failure', async () => {
  const h = settingsRenderer({ removeError: true });
  assert.equal(await h.context.persistGeminiKeys(['saved']), true);
  assert.equal(h.calls.errors.length, 0);
});

test('blocked obsolete NVIDIA preference cleanup does not interrupt startup', () => {
  const h = settingsRenderer({ removeError: true });
  const settings = source('js/settings.js');
  const start = settings.indexOf('  // The hosted Magpie model resolves its own function ID.');
  const end = settings.indexOf('  applyPrefsToSettingsUI({', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${settings.slice(start, end)}; startupContinued = true;`, h.context);
  assert.equal(h.context.startupContinued, true);
  assert.equal(h.calls.errors.length, 0);
});

test('stored credentials are read without rewriting and deleted keys do not resurrect from legacy storage', async () => {
  const loaded = settingsRenderer({ stored: { gemini_api_keys: '["one",{},"one","two"]' } });
  assert.deepEqual(plain((await loaded.context.loadStoredKeys()).geminiKeys), ['one', 'two']);
  assert.equal(loaded.calls.saves.length, 0);
  const deleted = settingsRenderer({ stored: { gemini_api_keys: '[]', nvidia_api_key: '' }, legacy: { olanga_api_key: 'old', olanga_nvidia_key: 'old' } });
  const result = await deleted.context.loadStoredKeys();
  assert.deepEqual(plain(result.geminiKeys), []); assert.equal(result.nvidiaKey, '');
  assert.equal(deleted.calls.saves.length, 0);
});

test('loaded Gemini key indexes use the same bounded normalization as provider requests', async () => {
  const saved = [' one ', {}, 'one', 'two', 'bad\nkey', 'x'.repeat(513), ...Array.from({ length: 55 }, (_, index) => `extra-${index}`)];
  const h = settingsRenderer({ stored: { gemini_api_keys: JSON.stringify(saved) } });
  const loaded = await h.context.loadStoredKeys();
  assert.equal(loaded.geminiKeys.length, 50);
  assert.deepEqual(Array.from(loaded.geminiKeys.slice(0, 3)), ['one', 'two', 'extra-0']);
  assert.deepEqual(Array.from(h.context.apiKeys), require('../../shared/gemini-keys').normalizeSavedKeys(saved));
  assert.equal(h.calls.saves.length, 0);
});

test('invalid or excess Gemini saves retain the selected key, entered value and saved list', async () => {
  for (const setup of [false, true]) {
    for (const invalid of ['bad\nkey', 'bad\u0000key', 'x'.repeat(513), 'excess-key']) {
      const h = settingsRenderer();
      const keys = invalid === 'excess-key' ? Array.from({ length: 50 }, (_, index) => `key-${index}`) : ['original'];
      Object.assign(h.context, { apiKeys: [...keys], apiKey: keys[0], currentKeyIndex: 0 });
      const input = setup ? h.context.apiKeyInput : h.context.newKeyInput;
      input.value = invalid;
      await (setup ? h.context.handleSaveKey() : h.context.handleAddKeyFromSettings());
      assert.deepEqual(Array.from(h.context.apiKeys), keys);
      assert.equal(h.context.apiKey, keys[0]);
      assert.equal(h.context.currentKeyIndex, 0);
      assert.equal(input.value, invalid);
      assert.equal(h.calls.saves.length, 0);
      assert.equal(h.calls.errors.length, 1);
      assert.equal(h.calls.microphone, 0);
    }
  }
});

test('failed plaintext migration keeps credentials inactive', async () => {
  const h = settingsRenderer({ legacy: { olanga_api_key: 'legacy-key' }, save: () => Promise.reject(new Error('encryption unavailable')) });
  await h.context.loadStoredKeys();
  assert.equal(h.context.apiKey, ''); assert.deepEqual(plain(h.context.apiKeys), []);
  assert.equal(h.calls.errors.length, 1);
});

test('unreadable secure credentials preserve legacy recovery sources without migration writes', async () => {
  for (const raw of ['{', 'null', '{}', '[{}]', null]) {
    const legacy = { olanga_api_keys: '["recovery-list"]', olanga_api_key: 'recovery-single', olanga_nvidia_key: 'nvapi-recovery' };
    const h = settingsRenderer({ legacy, get: async key => {
      if (key === 'nvidia_api_key' || raw === null) throw new Error('Secure storage unreadable');
      return raw;
    } });
    const loaded = await h.context.loadStoredKeys();
    assert.deepEqual(plain(loaded), { geminiKeys: [], nvidiaKey: '' });
    assert.deepEqual(Object.fromEntries(h.values), legacy);
    assert.equal(h.calls.saves.length, 0);
  }
});

test('missing secure credentials migrate a valid legacy single key after an empty or damaged list', async () => {
  for (const raw of ['[]', '{}', '{', 'null']) {
    const h = settingsRenderer({ legacy: { olanga_api_keys: raw, olanga_api_key: 'legacy-single' } });
    const loaded = await h.context.loadStoredKeys();
    assert.deepEqual(plain(loaded.geminiKeys), ['legacy-single']);
    assert.deepEqual(h.calls.saves, [{ key: 'gemini_api_keys', value: '["legacy-single"]' }]);
    assert.equal(h.values.size, 0);
  }
});

test('an explicit secure empty entry remains deleted even if legacy cleanup fails', async () => {
  const h = settingsRenderer({ stored: { gemini_api_keys: '[]', nvidia_api_key: '' }, legacy: { olanga_api_key: 'old-gemini', olanga_nvidia_key: 'old-nvidia' }, removeError: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const loaded = await h.context.loadStoredKeys();
    assert.deepEqual(plain(loaded), { geminiKeys: [], nvidiaKey: '' });
    assert.equal(h.calls.saves.length, 0);
  }
  assert.equal(h.values.size, 2, 'the undeletable plaintext copy remains inactive');
});

test('quitting disposes media, desktop automation and the overlay without referencing obsolete launch state', () => {
  const handlers = [], calls = [], app = { on: (_, handler) => handlers.push(handler) };
  const main = source('main.js');
  const start = main.indexOf("app.on('before-quit', () => {\n") >= 0 ? main.indexOf("app.on('before-quit', () => {\n") : main.indexOf("app.on('before-quit', () => {\r\n");
  const end = main.indexOf("trustedMainIpc.on('window-minimize'", start);
  vm.runInNewContext(main.slice(start, end), { app, mediaController: { dispose: () => calls.push('media') }, desktopAutomation: { dispose: () => calls.push('desktop') }, destroyStatusIndicatorWindow: () => calls.push('overlay') });
  handlers[0]();
  assert.equal(app.isQuiting, true); assert.deepEqual(calls, ['media', 'desktop', 'overlay']);
});

test('adding the first key after local setup activates cloud input only after a successful secure save', async () => {
  const saved = deferred();
  const h = settingsRenderer({ save: () => saved.promise });
  const adding = h.context.handleAddKeyFromSettings();
  await h.context.handleAddKeyFromSettings();
  assert.equal(h.calls.saves.length, 1, 'a repeated click cannot start another save');
  assert.equal(h.context.apiKey, ''); assert.equal(h.calls.microphone, 0);
  saved.resolve(); await adding;
  assert.equal(h.context.apiKey, 'first-key');
  assert.deepEqual(plain(h.context.apiKeys), ['first-key']);
  assert.equal(h.context.newKeyInput.value, '');
  assert.equal(h.calls.model, 1); assert.equal(h.calls.microphone, 1);
  assert.equal(h.context.addKeyBtn.disabled, false);
});

test('a failed first key save leaves local input usable and the key available for retry', async () => {
  const h = settingsRenderer({ save: () => Promise.reject(new Error('Encryption unavailable')) });
  await h.context.handleAddKeyFromSettings();
  assert.equal(h.context.apiKey, ''); assert.deepEqual(plain(h.context.apiKeys), []);
  assert.equal(h.context.newKeyInput.value, 'first-key');
  assert.equal(h.calls.microphone, 0); assert.equal(h.calls.errors.length, 1);
  assert.equal(h.context.addKeyBtn.disabled, false);
});

test('a superseded speech setting cannot start the microphone or overwrite the latest selection', async () => {
  for (const fail of [false, true]) {
    const loaded = deferred();
    const h = settingsRenderer({ model: () => loaded.promise });
    const select = { value: 'offline' };
    const pending = h.context.changeSpeechInput(select);
    select.value = 'cloud'; await h.context.changeSpeechInput(select);
    if (fail) loaded.reject(new Error('Old model failure')); else loaded.resolve();
    await pending;
    assert.equal(h.mode(), 'cloud'); assert.equal(select.value, 'cloud');
    assert.equal(h.calls.microphone, 0); assert.deepEqual(h.calls.errors, []);
  }
});

test('selecting offline speech starts keyless voice input and cloud retains voice when a key exists', async () => {
  const local = settingsRenderer();
  await local.context.changeSpeechInput({ value: 'offline-general' });
  assert.equal(local.mode(), 'offline-general'); assert.equal(local.calls.microphone, 1);
  const cloud = settingsRenderer(); cloud.context.apiKey = 'saved';
  await cloud.context.changeSpeechInput({ value: 'cloud' });
  assert.equal(cloud.mode(), 'cloud'); assert.equal(cloud.calls.microphone, 1);
});

test('local setup and idle hints never claim the microphone is listening when absent or muted', async () => {
  let voiceStarts = 0;
  const context = vm.createContext({
    State: { IDLE: 'idle' }, currentState: 'thinking', lastIdleTime: 0,
    refreshOrbAnimation() {},
    micStream: null, isMicMuted: false, voskRecognizer: null, isVoskReady: false, isWakeWordCapturing: false,
    hint: element(), setupScreen: element(), mainScreen: element(),
    document: { body: element(), querySelector: () => element() }, window: {}, console: { log() {}, error() {} },
    initVosk: async () => { voiceStarts++; }, initMicrophone: async () => { voiceStarts++; }, showError() {}
  });
  const core = source('js/core.js');
  vm.runInContext(core.slice(core.indexOf('function setState('), core.indexOf('// ORB CANVAS ANIMATION')), context);
  await context.showMainScreen({ voice: false });
  assert.equal(voiceStarts, 0); assert.equal(context.currentState, 'thinking');
  context.setState('idle'); assert.match(context.hint.textContent, /Type a local command/);
  context.micStream = { active: true }; context.isMicMuted = true;
  context.setState('idle'); assert.match(context.hint.textContent, /Microphone muted/);
  context.isMicMuted = false; context.setState('idle');
  assert.match(context.hint.textContent, /Wake word is not ready/);
  context.isVoskReady = true; context.voskRecognizer = { reset() {} }; context.setState('idle');
  assert.match(context.hint.innerHTML, /Hey Olanga/);
});
