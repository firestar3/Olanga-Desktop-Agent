'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function harness() {
  const nodes = { coreConnectionStatus: { textContent: '', dataset: {} }, coreConnectionTestBtn: { disabled: false } }, calls = [];
  const context = vm.createContext({ AbortController, DOMException, setTimeout, clearTimeout, performance,
    OlangaGemini: require('../../shared/gemini-request'),
    apiKeys: ['fixture-secret-A', 'fixture-secret-B'], apiKey: 'fixture-secret-A', currentKeyIndex: 0,
    window: { electronAPI: { providerGenerate: payload => new Promise(resolve => calls.push({ payload, resolve })), providerStatus: async () => ({ configured: true }), getAppInfo: async () => ({ version: 'fixture' }) } },
    document: { getElementById: id => nodes[id] },
    navigator: { onLine: true, mediaDevices: { enumerateDevices: async () => [] } },
    localStorage: { setItem() {}, removeItem() {} }, store: { snapshot: () => ({ speechInput: 'offline' }) },
    micStream: null, isMicMuted: true, isTtsMuted: true, isVoskReady: false, ttsEngine: 'windows', nvidiaApiKey: '', synthesis: { getVoices: () => [] }, pushToTalkStatus: null,
    runHealthCheck() {}
  });
  const read = file => fs.readFileSync(path.join(__dirname, '../../', file), 'utf8');
  const assistant = read('js/assistant.js');
  vm.runInContext(assistant.slice(assistant.indexOf('async function callGeminiGenerate('), assistant.indexOf('async function sendAudioToGemini(')), context);
  const productivity = read('js/productivity.js');
  vm.runInContext(productivity.slice(productivity.indexOf('  let lastGeminiTest = null;'), productivity.indexOf('  async function runHealthCheck()')) + productivity.slice(productivity.indexOf('  let healthTestPending = null;'), productivity.indexOf("  panel.querySelector('#healthTest')")), context);
  const settings = read('js/settings.js');
  vm.runInContext(settings.slice(settings.indexOf('let coreConnectionTestRunning'), settings.indexOf('function renderKeyList')), context);
  const choose = index => { context.currentKeyIndex = index; context.apiKey = context.apiKeys[index]; context.refreshCoreConnectionStatus(); };
  const reply = (index, keyIndex, ok = true) => calls[index].resolve(ok ? { ok, text: 'OK', keyIndex } : { ok, keyIndex, error: { message: 'Fixture key B failed.' } });
  return { context, nodes, calls, choose, reply };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Core status and ordinary Health snapshots never start a provider test', async () => {
  const { context, calls, nodes } = harness();
  context.refreshCoreConnectionStatus(); const snapshot = await context.healthSnapshot();
  assert.equal(calls.length, 0); assert.equal(snapshot.gemini.test, null);
  assert.match(nodes.coreConnectionStatus.textContent, /not been tested/);
});

test('same-credential Health and Core tests share one minimal request and expose no credential metadata', async () => {
  const { context, calls, nodes, reply } = harness();
  const health = context.testGeminiConnection(); assert.equal(context.testGeminiConnection(), health);
  const core = context.testCoreConnection(); assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.body.contents[0].parts[0].text, 'Reply with the single word OK.');
  assert.doesNotMatch(JSON.stringify(calls[0].payload), /fixture-secret|memory|location|inline_data/);
  reply(0, 0); const result = await health; await core;
  assert.equal(nodes.coreConnectionStatus.dataset.state, 'success');
  assert.deepEqual(Object.keys(result).sort(), ['message', 'ms', 'ok']);
  assert.doesNotMatch(JSON.stringify(await context.healthSnapshot()), /fixture-secret|keyIndex|selectionUnchanged|credential/);
});

test('automatic key rotation displays success for the actual active key', async () => {
  const { context, nodes, reply } = harness();
  const pending = context.testCoreConnection(); reply(0, 1); await pending;
  assert.equal(context.currentKeyIndex, 1); assert.equal(nodes.coreConnectionStatus.dataset.state, 'success');
  assert.match(nodes.coreConnectionStatus.textContent, /ready/);
  assert.equal((await context.healthSnapshot()).gemini.test.ok, true);
});

test('a user key change rejects a late Core result and hides the stale Health result', async () => {
  const { context, nodes, choose, reply } = harness();
  const pending = context.testCoreConnection(); choose(1); reply(0, 0); await pending;
  assert.equal(context.currentKeyIndex, 1); assert.equal(nodes.coreConnectionStatus.dataset.state, '');
  assert.match(nodes.coreConnectionStatus.textContent, /not been tested/);
  assert.equal((await context.healthSnapshot()).gemini.test, null);
  choose(0); assert.match(nodes.coreConnectionStatus.textContent, /not been tested/);
});

test('changing keys during a Health test starts a separate Core test rather than crediting the old key', async () => {
  const { context, calls, nodes, choose, reply } = harness();
  const old = context.testGeminiConnection(); choose(1); const core = context.testCoreConnection();
  assert.equal(calls.length, 2); assert.equal(calls[0].payload.keyIndex, 0); assert.equal(calls[1].payload.keyIndex, 1);
  reply(0, 0); await old; await tick();
  assert.equal(nodes.coreConnectionTestBtn.disabled, true); assert.notEqual(nodes.coreConnectionStatus.dataset.state, 'success');
  reply(1, 1, false); await core;
  assert.equal(nodes.coreConnectionStatus.dataset.state, 'error'); assert.match(nodes.coreConnectionStatus.textContent, /key B failed/);
});

test('an old Health completion cannot clear a newer pending test or replace its result', async () => {
  const { context, calls, choose, reply } = harness();
  const old = context.testGeminiConnection(); choose(1); const fresh = context.testGeminiConnection();
  reply(0, 0); await old; assert.equal(context.testGeminiConnection(), fresh); assert.equal(calls.length, 2);
  reply(1, 1); await fresh;
  assert.equal((await context.healthSnapshot()).gemini.test.ok, true);
});

test('editing the saved key pool while a test runs invalidates the result', async () => {
  const { context, nodes, reply } = harness();
  const pending = context.testCoreConnection(); context.apiKeys = [context.apiKeys[0]];
  reply(0, 0); await pending;
  assert.equal(nodes.coreConnectionStatus.dataset.state, ''); assert.match(nodes.coreConnectionStatus.textContent, /not been tested/);
  assert.equal((await context.healthSnapshot()).gemini.test, null);
});
