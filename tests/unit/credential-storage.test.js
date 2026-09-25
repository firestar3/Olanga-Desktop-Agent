const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function settingsHarness(fail = false) {
  const values = new Map([['olanga_api_keys', '["legacy"]'], ['olanga_api_key', 'legacy'], ['olanga_nvidia_key', 'legacy-nim']]);
  const saved = new Map();
  const errors = [];
  const context = vm.createContext({
    OlangaPrefs: require('../../shared/prefs-schema'),
    OlangaNvidiaKey: require('../../shared/nvidia-key'),
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: { electronAPI: { async secureStoreSet(key, value) { if (fail) throw new Error('Locked'); saved.set(key, value); } } },
    mainScreen: null, apiKeys: ['new-secret'], nvidiaApiKey: 'new-nim',
    localStorage: { getItem: key => values.get(key) ?? null, setItem(key, value) { values.set(key, value); }, removeItem: key => values.delete(key) },
    showError: message => errors.push(message), console: { warn() {} }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/settings.js'), 'utf8'), context);
  return { context, values, saved, errors };
}

test('successful encrypted saves remove all legacy plaintext credential mirrors', async () => {
  const { context, values, saved } = settingsHarness();
  assert.equal(await context.persistGeminiKeys(), true);
  assert.equal(await context.persistNvidiaKey(), true);
  assert.equal(values.size, 0);
  assert.equal(saved.get('gemini_api_keys'), '["new-secret"]');
  assert.equal(saved.get('nvidia_api_key'), 'new-nim');
});

test('failed encrypted save reports failure without writing a new plaintext key or losing migration source', async () => {
  const { context, values, saved, errors } = settingsHarness(true);
  assert.equal(await context.persistGeminiKeys(), false);
  assert.equal(values.get('olanga_api_keys'), '["legacy"]');
  assert.equal(saved.size, 0);
  assert.equal(errors.length, 1);
});

test('clearing the NVIDIA key deletes its encrypted entry instead of resurrecting it on restart', async () => {
  const { context, values, saved } = settingsHarness();
  context.nvidiaApiKey = '';
  await context.persistNvidiaKey();
  assert.equal(saved.get('nvidia_api_key'), '');
  assert.equal(values.has('olanga_nvidia_key'), false);
});

test('NVIDIA runtime key changes only after encrypted storage succeeds', async () => {
  const { context } = settingsHarness();
  let finish;
  context.window.electronAPI.secureStoreSet = () => new Promise(resolve => { finish = resolve; });
  const pending = context.persistNvidiaKey('Bearer nvapi-replacement');
  assert.equal(context.nvidiaApiKey, 'new-nim');
  finish({ ok: true });
  assert.equal(await pending, true);
  assert.equal(context.nvidiaApiKey, 'nvapi-replacement');
  context.window.electronAPI.secureStoreSet = async () => { throw new Error('Locked'); };
  assert.equal(await context.persistNvidiaKey('nvapi-unsaved'), false);
  assert.equal(context.nvidiaApiKey, 'nvapi-replacement');
});

function magpieHarness() {
  const h = settingsHarness();
  const status = {textContent:'',dataset:{}};
  h.context.document.getElementById = () => status;
  h.context.addNvidiaKeyBtn = {disabled:false};
  h.context.nvidiaSettingsKeyInput = {value:'nvapi-voice'};
  let calls=0;
  h.context.window.electronAPI.nvidiaTtsSynthesize = async payload => { calls++; assert.equal(h.saved.get('nvidia_api_key'),'nvapi-voice'); assert.match(payload.text,/Magpie/); return {audioBase64:'YXVkaW8='}; };
  h.context.window.electronAPI.nvidiaChat = () => { throw new Error('Removed NIM endpoint must not be used'); };
  return {...h,status,get calls(){return calls;}};
}
test('NVIDIA Save & Test tests only Magpie audio with the persisted key', async () => {
  const h=magpieHarness();await h.context.saveAndTestNvidiaKey();
  assert.equal(h.calls,1);assert.equal(h.status.dataset.state,'success');assert.equal(h.context.addNvidiaKeyBtn.disabled,false);
});
test('a key already used for Gemini cannot be silently saved as the Magpie key', async () => {
  const h=magpieHarness();h.context.nvidiaSettingsKeyInput.value='new-secret';await h.context.saveAndTestNvidiaKey();
  assert.equal(h.calls,0);assert.equal(h.saved.size,0);assert.match(h.status.textContent,/separate NVIDIA key/);
});
test('removing the Magpie key does not test or disable Gemini', async () => {
  const h=magpieHarness();h.context.nvidiaSettingsKeyInput.value='';await h.context.saveAndTestNvidiaKey();
  assert.equal(h.calls,0);assert.equal(h.saved.get('nvidia_api_key'),'');assert.match(h.status.textContent,/Gemini.*still work/);
});
