const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(options = {}) {
  let saved = options.raw, pending;
  const calls = { writes: 0 }, handlers = new Map();
  const context = vm.createContext({
    app: { getPath: () => 'C:\\isolated-profile' }, path: path.win32, Buffer,
    console: { log() {}, warn() {} },
    validateStoreKey: require('../../shared/ipc-policy').validateStoreKey,
    normalizeNvidiaKey: require('../../shared/nvidia-key').normalizeNvidiaKey,
    normalizeGeminiKeys: require('../../shared/gemini-keys').normalizeSavedKeys,
    validateGeminiKeys: require('../../shared/gemini-keys').validateCandidateKeys,
    trustedMainIpc: { handle: (channel, callback) => handlers.set(channel, callback) },
    fs: {
      readFileSync() {
        if (options.readError) throw Object.assign(new Error('Fixture inaccessible'), { code: options.readError });
        if (saved === undefined) throw Object.assign(new Error('Fixture missing'), { code: 'ENOENT' });
        return saved;
      },
      writeFileSync(_target, value) { calls.writes++; pending = value; },
      renameSync() { saved = pending; }
    },
    safeStorage: {
      isEncryptionAvailable: () => options.encryption !== false,
      encryptString: value => Buffer.from('fixture-encrypted:' + value),
      decryptString(value) {
        const text = value.toString();
        if (!text.startsWith('fixture-encrypted:')) throw new Error('Fixture bad ciphertext');
        return text.slice('fixture-encrypted:'.length);
      }
    }
  });
  const main = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  vm.runInContext(main.slice(main.indexOf('function getSecureStorePath()'), main.indexOf('// Provider requests retrieve saved credentials')), context);
  vm.runInContext(main.slice(main.indexOf('function getGeminiProviderCredentials()'), main.indexOf("const { createProviderService } = require('./desktop/provider-service');")), context);
  vm.runInContext(main.slice(main.indexOf("trustedMainIpc.handle('secure-store-get'"), main.indexOf('const terminalSessions = new Map();')), context);
  return {
    calls, raw: () => saved,
    credentials: () => context.getGeminiProviderCredentials(),
    get: key => handlers.get('secure-store-get')({}, key),
    set: (key, value) => handlers.get('secure-store-set')({}, { key, value })
  };
}

test('secure storage distinguishes a missing record from unreadable or damaged data', async () => {
  const missing = fixture();
  assert.equal(await missing.get('gemini_api_keys'), null);
  await missing.set('gemini_api_keys', '["fixture-key"]');
  assert.equal(await missing.get('gemini_api_keys'), '["fixture-key"]');
  assert.equal(await missing.get('nvidia_api_key'), null);
  for (const raw of ['{', 'null', '[]', '1', '{"gemini_api_keys":null}', '{"gemini_api_keys":""}']) {
    const damaged = fixture({ raw });
    await assert.rejects(damaged.get('gemini_api_keys'), /damaged.*preserved/);
    await assert.rejects(damaged.set('gemini_api_keys', '["replacement"]'), /damaged.*preserved/);
    assert.equal(damaged.raw(), raw); assert.equal(damaged.calls.writes, 0);
  }
  const blocked = fixture({ raw: '{"existing":"saved"}', readError: 'EACCES' });
  await assert.rejects(blocked.get('gemini_api_keys'), /could not be read.*preserved/);
  await assert.rejects(blocked.set('nvidia_api_key', 'nvapi-new'), /could not be read.*preserved/);
  assert.equal(blocked.calls.writes, 0);
});

test('encryption unavailability and decryption failure cannot masquerade as a missing key', async () => {
  const raw = JSON.stringify({ gemini_api_keys: Buffer.from('fixture-encrypted:["fixture-key"]').toString('base64') });
  const unavailable = fixture({ raw, encryption: false });
  await assert.rejects(unavailable.get('gemini_api_keys'), /could not be decrypted.*preserved/);
  await assert.rejects(unavailable.set('gemini_api_keys', '[]'), /encryption is unavailable/);
  assert.equal(unavailable.raw(), raw); assert.equal(unavailable.calls.writes, 0);
  const damaged = fixture({ raw: '{"gemini_api_keys":"YWJj"}' });
  await assert.rejects(damaged.get('gemini_api_keys'), /could not be decrypted.*preserved/);
  assert.equal(damaged.calls.writes, 0);
});

test('NVIDIA empty deletion remains an encrypted tombstone across main-process reload', async () => {
  const first = fixture();
  await first.set('nvidia_api_key', 'nvapi-fixture');
  await first.set('nvidia_api_key', '');
  const raw = first.raw();
  assert.ok(JSON.parse(raw).nvidia_api_key);
  assert.equal(await first.get('nvidia_api_key'), '');
  const restarted = fixture({ raw });
  assert.equal(await restarted.get('nvidia_api_key'), '', 'empty is authoritative deletion; null would permit legacy migration');
  assert.equal(restarted.calls.writes, 0);
});

test('saved Gemini key indexes match the settings list through the actual main provider getter', async () => {
  const keys = [' one ', {}, 'one', 'two', 'bad\nkey', 'x'.repeat(513), ...Array.from({ length: 55 }, (_, index) => `extra-${index}`)];
  const raw = JSON.stringify({ gemini_api_keys: Buffer.from('fixture-encrypted:' + JSON.stringify(keys)).toString('base64') });
  const h = fixture({ raw });
  const normalized = h.credentials().keys;
  assert.equal(normalized.length, 50);
  assert.deepEqual(Array.from(normalized.slice(0, 3)), ['one', 'two', 'extra-0']);
  const requestedKeys = [];
  const service = require('../../desktop/provider-service').createProviderService({
    getCredentials: h.credentials,
    fetchImpl: async (_url, init) => {
      requestedKeys.push(init.headers['x-goog-api-key']);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Done' }] } }] }), { status: 200 });
    }
  });
  try {
    const result = await service.generate({ requestId: 'selected-normalized-key', model: 'gemini-3.5-flash', keyIndex: 1, body: { contents: [{ parts: [{ text: 'Fixture' }] }] } });
    assert.equal(result.ok, true);
    assert.equal(result.keyIndex, 1);
    assert.deepEqual(requestedKeys, ['two']);
    assert.equal(h.raw(), raw, 'reading and using older keys never rewrites the saved copy');
  } finally { service.dispose(); }
});

test('invalid Gemini candidate lists cannot overwrite the secure store', async () => {
  const h = fixture();
  await h.set('gemini_api_keys', '["original"]');
  const saved = h.raw();
  for (const candidate of [null, {}, ['one', 'one'], [' one '], ['bad\nkey'], ['bad\u0000key'], ['x'.repeat(513)], Array.from({ length: 51 }, (_, i) => `key-${i}`)]) {
    await assert.rejects(h.set('gemini_api_keys', JSON.stringify(candidate)), /Gemini/);
    assert.equal(h.raw(), saved);
  }
  assert.equal(h.calls.writes, 1);
});
