const test = require('node:test');
const assert = require('node:assert/strict');

const prefs = require('../../shared/prefs-schema.js');

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    snapshot: () => Object.fromEntries(map)
  };
}

test('empty storage yields the declared defaults', () => {
  const loaded = prefs.load(fakeStorage());

  assert.equal(loaded.city, '');
  assert.equal(loaded.ttsEngine, 'windows');
  assert.equal(loaded.ttsRate, prefs.DEFAULT_TTS_RATE);
  assert.equal(loaded.nvidiaVoice, prefs.DEFAULT_NVIDIA_VOICE);
  assert.deepEqual(loaded.features, []);
  assert.equal(loaded.keyRotation, false);
  assert.equal(loaded.statusLightMode, 'active');
  assert.equal(loaded.statusLightSize, 'small');
});

test('stored strings are parsed back into their real types', () => {
  const loaded = prefs.readFromStorage(fakeStorage({
    olanga_city: 'Seattle',
    olanga_tts_engine: 'magpie',
    olanga_tts_rate: '0.9',
    olanga_key_rotation: 'true',
    olanga_enabled_features: '["notepadScreen","newsScreen"]',
    olanga_status_light_size_v2: '1'
  }));

  assert.equal(loaded.city, 'Seattle');
  assert.equal(loaded.ttsEngine, 'magpie');
  assert.equal(loaded.ttsRate, 0.9);
  assert.equal(loaded.keyRotation, true);
  assert.deepEqual(loaded.features, ['notepadScreen', 'newsScreen']);
});

test('invalid stored values fall back instead of propagating', () => {
  const loaded = prefs.readFromStorage(fakeStorage({
    olanga_tts_engine: 'espeak',
    olanga_tts_rate: 'fast',
    olanga_status_light_mode: 'strobe',
    olanga_enabled_features: 'not json',
    olanga_nvidia_voice: '   '
  }));

  assert.equal(loaded.ttsEngine, 'windows');
  assert.equal(loaded.ttsRate, prefs.DEFAULT_TTS_RATE);
  assert.equal(loaded.statusLightMode, 'active');
  assert.deepEqual(loaded.features, []);
  assert.equal(loaded.nvidiaVoice, prefs.DEFAULT_NVIDIA_VOICE);
});

test('unknown feature ids are dropped', () => {
  const loaded = prefs.readFromStorage(fakeStorage({
    olanga_enabled_features: '["notepadScreen","hackerScreen"]'
  }));

  assert.deepEqual(loaded.features, ['notepadScreen']);
});

test('a write followed by a read round-trips', () => {
  const storage = fakeStorage();
  const written = prefs.sanitize({
    city: '  Portland  ',
    state: 'OR',
    country: 'USA',
    ttsEngine: 'magpie',
    ttsRate: 1.2,
    nvidiaVoice: 'Magpie-Multilingual.EN-US.Leo',
    features: ['terminalScreen'],
    keyRotation: true,
    statusLightMode: 'all',
    statusLightSize: 'large',
    statusLightSizeV2: true
  });

  prefs.writeToStorage(storage, written);
  const reloaded = prefs.load(storage);

  assert.equal(reloaded.city, 'Portland');
  assert.equal(reloaded.ttsEngine, 'magpie');
  assert.equal(reloaded.ttsRate, 1.2);
  assert.deepEqual(reloaded.features, ['terminalScreen']);
  assert.equal(reloaded.keyRotation, true);
  assert.equal(reloaded.statusLightMode, 'all');
  assert.equal(reloaded.statusLightSize, 'large');
});

test('the keys filter limits which preferences are written', () => {
  const storage = fakeStorage({ olanga_city: 'Denver' });
  prefs.writeToStorage(storage, { city: 'Austin', statusLightSize: 'normal' }, ['statusLightSize']);

  assert.equal(storage.getItem('olanga_city'), 'Denver');
  assert.equal(storage.getItem('olanga_status_light_size'), 'normal');
});

test('legacy sizes are remapped once: old large becomes normal', () => {
  const storage = fakeStorage({ olanga_status_light_size: 'large' });
  const loaded = prefs.load(storage);

  assert.equal(loaded.statusLightSize, 'normal');
  assert.equal(loaded.statusLightSizeV2, true);
});

test('legacy sizes other than large collapse to small', () => {
  const loaded = prefs.load(fakeStorage({ olanga_status_light_size: 'normal' }));
  assert.equal(loaded.statusLightSize, 'small');
});

test('an already-migrated size is left alone', () => {
  const loaded = prefs.load(fakeStorage({
    olanga_status_light_size: 'large',
    olanga_status_light_size_v2: '1'
  }));

  assert.equal(loaded.statusLightSize, 'large');
});

test('merge lets a valid stored copy win and ignores junk', () => {
  const base = prefs.load(fakeStorage({ olanga_city: 'Reno', olanga_status_light_size_v2: '1' }));
  const merged = prefs.merge(base, {
    city: 'Boise',
    ttsEngine: 'klingon',
    statusLightMode: 'all',
    statusLightSizeV2: true
  });

  assert.equal(merged.city, 'Boise');
  assert.equal(merged.ttsEngine, 'windows');
  assert.equal(merged.statusLightMode, 'all');
});

test('merge ignores a stale migration flag when the copy has no size', () => {
  const base = { ...prefs.defaults(), statusLightSize: 'large', statusLightSizeV2: true };
  const merged = prefs.applyMigrations(prefs.merge(base, { city: 'Tulsa' }));

  assert.equal(merged.statusLightSize, 'large', 'a size-free payload must not re-trigger the remap');
  assert.equal(merged.city, 'Tulsa');
});

test('merge migrates a size that arrives from an unmigrated copy', () => {
  const base = { ...prefs.defaults(), statusLightSize: 'small' };
  const merged = prefs.applyMigrations(prefs.merge(base, { statusLightSize: 'large' }));

  assert.equal(merged.statusLightSize, 'normal');
});

test('every definition exposes a storage key and a usable default', () => {
  const seen = new Set();
  for (const def of prefs.PREF_DEFS) {
    assert.ok(def.storageKey, `${def.key} needs a storage key`);
    assert.ok(!seen.has(def.storageKey), `${def.storageKey} is used twice`);
    seen.add(def.storageKey);
    assert.notEqual(prefs.coerce(def, def.default), undefined, `${def.key} default must be valid`);
  }
});
