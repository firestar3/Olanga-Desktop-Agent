const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = file => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function element() {
  return { children: [], value: '', disabled: false, textContent: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    set innerHTML(value) { this.markup = value; this.children = []; }, get innerHTML() { return this.markup || ''; },
    appendChild(child) { this.children.push(child); }, addEventListener() {}, querySelector() { return element(); }, querySelectorAll() { return []; } };
}
async function terminalRenderer(options = {}) {
  const nodes = new Map();
  const values = new Map([['olangaTerminalTabs', JSON.stringify(options.tabs || [{ id: 0, name: 'Saved', cwd: 'Z:\\deleted', entries: [] }])]]);
  const calls = { create: [], execute: [], close: [], alerts: [] };
  const context = vm.createContext({
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element },
    window: { electronAPI: {
      createTerminalSession(payload) { calls.create.push(payload); return options.create?.(payload) || Promise.resolve({ cwd: 'C:\\Users\\Tester' }); },
      executeTerminalSessionCommand(payload) { calls.execute.push(payload); return options.execute?.(payload) || Promise.resolve({ output: 'first command output', cwd: 'C:\\Users\\Tester', success: true }); },
      closeTerminalSession(payload) { calls.close.push(payload); return options.close?.(payload) || Promise.resolve({ closed: true }); }
    } },
    localStorage: { getItem: key => { if (options.readError) throw new Error('storage unavailable'); return values.get(key); }, setItem: (key, value) => { if (options.writeError) throw new Error('quota'); values.set(key, value); } },
    escapeHTML: text => String(text), alert: text => calls.alerts.push(text), prompt() {}, console: { warn() {}, error() {} }
  });
  vm.runInContext(source('js/terminal.js'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { context, calls, nodes, tabs: () => vm.runInContext('terminalTabsData', context) };
}

test('saved terminal tabs launch no shell until a real command, then use the actual initial directory', async () => {
  const h = await terminalRenderer();
  assert.equal(h.calls.create.length, 0);
  await h.context.executeTerminalCommand('cls');
  assert.equal(h.calls.create.length, 0);
  await h.context.executeTerminalCommand('Get-Location');
  assert.deepEqual(plain(h.calls.create), [{ sessionId: 0 }], 'a deleted saved path is not sent to spawn');
  assert.equal(h.calls.execute[0].cwd, 'C:\\Users\\Tester');
  assert.equal(h.tabs()[0].entries.find(entry => entry.type === 'command').prompt, 'PS C:\\Users\\Tester>');
  assert.ok(h.tabs()[0].entries.some(entry => entry.text === 'first command output'));
  await h.context.executeTerminalCommand('Write-Output second');
  assert.equal(h.calls.create.length, 1);
  assert.equal(h.calls.execute.length, 2);
});

test('concurrent first commands share initialization and a failed initialization can retry', async () => {
  const ready = deferred();
  const h = await terminalRenderer({ create: () => ready.promise });
  const first = h.context.executeTerminalCommand('one'), second = h.context.executeTerminalCommand('two');
  assert.equal(h.calls.create.length, 1); assert.equal(h.calls.execute.length, 0);
  ready.resolve({ cwd: 'C:\\Users\\Tester' });
  await Promise.all([first, second]);
  assert.deepEqual(h.calls.execute.map(call => call.command), ['one', 'two']);

  let attempts = 0;
  const retry = await terminalRenderer({ create: () => ++attempts === 1 ? Promise.reject(new Error('PowerShell missing')) : Promise.resolve({ cwd: 'C:\\' }) });
  await retry.context.executeTerminalCommand('one');
  assert.equal(retry.calls.execute.length, 0);
  assert.ok(retry.tabs()[0].entries.some(entry => entry.text === 'PowerShell missing'));
  await retry.context.executeTerminalCommand('two');
  assert.equal(retry.calls.execute.length, 1);
});

test('closing a tab during initialization prevents its command and a stale reply cannot affect a replacement', async () => {
  const ready = deferred();
  const tabs = [0, 1].map(id => ({ id, name: `Tab ${id}`, cwd: 'C:\\', entries: [] }));
  const h = await terminalRenderer({ tabs, create: () => ready.promise });
  h.context.switchTerminalTab(1);
  const pending = h.context.executeTerminalCommand('must not dispatch');
  await h.context.closeTerminalTab(1);
  ready.resolve({ cwd: 'C:\\Users\\Tester' }); await pending;
  assert.equal(h.calls.execute.length, 0);

  const result = deferred();
  const second = await terminalRenderer({ tabs, execute: () => result.promise });
  second.context.switchTerminalTab(1);
  const executing = second.context.executeTerminalCommand('old command');
  await new Promise(resolve => setImmediate(resolve));
  await second.context.closeTerminalTab(1);
  await second.context.addTerminalTab(); // Reuses the old numeric ID, with a new object.
  result.resolve({ output: 'stale private output', cwd: 'Z:\\wrong', success: true });
  await executing;
  assert.equal(second.tabs()[1].cwd, 'C:\\Users\\Tester');
  assert.equal(JSON.stringify(second.tabs()[1].entries).includes('stale private output'), false);
});

test('overlapping terminal closes remove the intended tabs and always retain one usable tab', async () => {
  const waits = new Map([[0, deferred()], [1, deferred()]]);
  const h = await terminalRenderer({ tabs: [0, 1, 2].map(id => ({ id, entries: [] })), close: payload => waits.get(payload.sessionId).promise });
  const first = h.context.closeTerminalTab(0), second = h.context.closeTerminalTab(1);
  await h.context.closeTerminalTab(2);
  assert.equal(h.calls.close.length, 2);
  waits.get(0).resolve(); await first;
  waits.get(1).resolve(); await second;
  assert.deepEqual(Array.from(h.tabs(), tab => tab.id), [2]);
});

test('saved terminal headers cannot inject arbitrary HTML into the renderer', async () => {
  const h = await terminalRenderer({ tabs: [{ id: 0, entries: [{ type: 'header', html: '<img src=x onerror="runCommands()">' }] }] });
  const header = h.nodes.get('terminalOutput').children[0];
  assert.match(header.innerHTML, /Windows PowerShell/);
  assert.doesNotMatch(header.innerHTML, /onerror|runCommands/);
});

test('unavailable terminal storage leaves a usable tab and failed writes do not discard live command output', async () => {
  const h = await terminalRenderer({ readError: true, writeError: true });
  assert.equal(h.tabs().length, 1); assert.equal(h.calls.create.length, 0);
  await h.context.executeTerminalCommand('Get-Location');
  assert.ok(h.tabs()[0].entries.some(entry => entry.text === 'first command output'));
  assert.equal(h.calls.alerts.length, 1);
});

test('malformed saved terminal rows preserve valid neighbors without duplicate session IDs', async () => {
  const h = await terminalRenderer({ tabs: [null, { id: 'NaN', name: 'Saved', entries: [null, { type: 'output', text: 'kept' }] }, { id: 'NaN', entries: [] }] });
  assert.deepEqual(Array.from(h.tabs(), tab => tab.id), [0, 1]);
  assert.equal(h.tabs()[0].entries[0].text, 'kept');
  assert.equal(h.calls.create.length, 0);
});

function terminalMain(options = {}) {
  const handles = new Map(), children = [];
  const context = vm.createContext({
    Map, String, Number, Error, process: { nextTick: callback => callback() },
    os: { homedir: () => 'C:\\Users\\Tester' }, path: path.win32,
    fs: { statSync(cwd) { if (cwd === 'Z:\\deleted') throw new Error('ENOENT'); return { isDirectory: () => cwd !== 'C:\\file.txt' }; } },
    trustedMainIpc: { handle: (name, handler) => handles.set(name, handler) },
    spawn(executable, args, config) {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.writes = []; child.killed = false;
      child.stdin.write = text => { if (child.writeError) throw child.writeError; child.writes.push(text); return true; };
      child.kill = () => { child.killed = true; };
      child.config = config; children.push(child); return child;
    }
  });
  const main = source('main.js');
  vm.runInContext(main.slice(main.indexOf('const terminalSessions = new Map();'), main.indexOf("trustedMainIpc.handle('execute-command'")), context);
  return { children, call: (name, payload) => handles.get(`terminal-session-${name}`)({}, payload) };
}

test('native terminal handlers reject invalid working directories before spawning', async () => {
  const h = terminalMain();
  assert.equal(h.children.length, 0);
  for (const cwd of ['Z:\\deleted', 'C:\\file.txt', 'relative']) await assert.rejects(h.call('execute', { sessionId: 'a', command: 'dir', cwd }), /folder is unavailable/);
  assert.equal(h.children.length, 0);
  await h.call('create', { sessionId: 'a' });
  assert.equal(h.children[0].config.windowsHide, true);
  assert.equal(h.children[0].config.cwd, 'C:\\Users\\Tester');
});

test('native spawn and pipe errors reject pending terminal commands without crashing or hanging', async () => {
  for (const failure of ['spawn', 'pipe', 'write']) {
    const h = terminalMain();
    const first = h.call('execute', { sessionId: 'a', command: 'one' });
    const second = h.call('execute', { sessionId: 'a', command: 'two' });
    const settled = Promise.all([failure === 'write' ? first.then(result => assert.equal(result.success, true)) : assert.rejects(first, /missing|broken/), assert.rejects(second, /missing|broken/)]);
    const child = h.children[0];
    if (failure === 'spawn') child.emit('error', new Error('PowerShell missing'));
    else if (failure === 'pipe') child.stdin.emit('error', new Error('broken pipe'));
    else { child.writeError = new Error('broken write'); child.stdout.emit('data', Buffer.from('__OLANGA_DONE__\n')); }
    await settled;
    assert.equal(child.killed, true);
    await h.call('create', { sessionId: 'a' });
    assert.equal(h.children.length, 2);
  }
});

test('closing a native terminal settles its queue and a delayed old close cannot erase its replacement', async () => {
  const h = terminalMain();
  const pending = h.call('execute', { sessionId: 'a', command: 'one' });
  const cancelled = assert.rejects(pending, /closed/);
  await h.call('close', { sessionId: 'a' }); await cancelled;
  await h.call('create', { sessionId: 'a' });
  h.children[0].emit('close', 0);
  const next = h.call('execute', { sessionId: 'a', command: 'new command' });
  h.children[1].stdout.emit('data', Buffer.from('new output\n__OLANGA_EXIT__:0\n__OLANGA_CWD__:C:\\Users\\Tester\n__OLANGA_DONE__\n'));
  assert.equal((await next).output, 'new output');
  assert.equal(h.children.length, 2);
});

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
    micStream: null, isMicMuted: false, voskRecognizer: null, isWakeWordCapturing: false,
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
  assert.match(context.hint.innerHTML, /Hey Olanga/);
});
