/* ============================================
   OLANGA — PREFERENCE SCHEMA (SHARED)

   One declarative list describes every preference: where it
   lives in localStorage, what values are legal, and its default.
   Reading, writing, merging the secure-store copy and running
   one-time migrations all derive from that list, so adding a
   setting means adding a single entry below.
   ============================================ */

(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const statusLight = isNode ? require('./status-light.js') : root.OlangaStatusLight;
  const quickActions = isNode ? require('./quick-actions.js') : root.OlangaQuickActions;
  const shortcuts = isNode ? require('./shortcuts.js') : root.OlangaShortcuts;
  const api = factory(statusLight, quickActions, shortcuts);
  if (isNode) {
    module.exports = api;
  } else {
    root.OlangaPrefs = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (statusLight, quickActions, shortcuts) {
  const DEFAULT_NVIDIA_VOICE = 'Magpie-Multilingual.EN-US.Sofia';
  const OPTIONAL_FEATURES = ['notepadScreen', 'newsScreen', 'terminalScreen'];
  const DEFAULT_TTS_RATE = 1.05;
  // Silence that ends a spoken request. Standard keeps the original timing.
  const END_OF_SPEECH_MS = Object.freeze({ standard: 1500, quick: 1000, fast: 700 });

  const PREF_DEFS = [
    { key: 'quickActions', storageKey: 'olanga_quick_actions', type: 'quickActions', default: quickActions.DEFAULT_QUICK_ACTIONS },
    { key: 'city', storageKey: 'olanga_city', type: 'string', default: '' },
    { key: 'state', storageKey: 'olanga_state', type: 'string', default: '' },
    { key: 'country', storageKey: 'olanga_country', type: 'string', default: '' },
    {
      key: 'ttsEngine',
      storageKey: 'olanga_tts_engine',
      type: 'enum',
      values: ['windows', 'magpie'],
      default: 'windows'
    },
    { key: 'ttsRate', storageKey: 'olanga_tts_rate', type: 'number', default: DEFAULT_TTS_RATE },
    {
      key: 'nvidiaVoice',
      storageKey: 'olanga_nvidia_voice',
      type: 'string',
      default: DEFAULT_NVIDIA_VOICE,
      emptyIsDefault: true
    },
    {
      key: 'features',
      storageKey: 'olanga_enabled_features',
      type: 'stringSet',
      values: OPTIONAL_FEATURES,
      default: []
    },
    { key: 'keyRotation', storageKey: 'olanga_key_rotation', type: 'boolean', default: false },
    {
      key: 'statusLightMode',
      storageKey: 'olanga_status_light_mode',
      type: 'enum',
      values: statusLight.MODES,
      default: statusLight.DEFAULT_MODE
    },
    {
      key: 'statusLightSize',
      storageKey: 'olanga_status_light_size',
      type: 'enum',
      values: statusLight.SIZES,
      default: statusLight.DEFAULT_SIZE
    },
    { key: 'bargeIn', storageKey: 'olanga_barge_in', type: 'boolean', default: true },
    { key: 'streamReplies', storageKey: 'olanga_stream_replies', type: 'boolean', default: true },
    { key: 'endOfSpeech', storageKey: 'olanga_end_of_speech', type: 'enum', values: Object.keys(END_OF_SPEECH_MS), default: 'standard' },
    { key: 'pushToTalk', storageKey: 'olanga_push_to_talk', type: 'enum', values: shortcuts.VALUES, default: shortcuts.DEFAULT }
  ];

  // One-time reshapes of stored values. Each records a flag once applied so
  // it never runs twice, including against the secure-store copy.
  const MIGRATIONS = [
    {
      flagKey: 'statusLightSizeV2',
      flagStorageKey: 'olanga_status_light_size_v2',
      keys: ['statusLightSize'],
      // The size labels shifted down: the old Normal is today's Small and the
      // old Large is today's Normal.
      apply(prefs) {
        return {
          ...prefs,
          statusLightSize: prefs.statusLightSize === 'large' ? 'normal' : 'small'
        };
      }
    }
  ];

  const DEF_BY_KEY = new Map(PREF_DEFS.map((def) => [def.key, def]));

  function defaultValue(def) {
    if (def.type === 'quickActions') return quickActions.normalizeQuickActions(def.default);
    return Array.isArray(def.default) ? [...def.default] : def.default;
  }

  // Returns undefined when the value can't be used, so callers can fall back.
  function coerce(def, value) {
    if (value === undefined || value === null) return undefined;
    switch (def.type) {
      case 'quickActions':
        return Array.isArray(value) ? quickActions.normalizeQuickActions(value) : undefined;
      case 'string': {
        const text = String(value).trim();
        if (!text && def.emptyIsDefault) return undefined;
        return text;
      }
      case 'enum':
        return def.values.includes(value) ? value : undefined;
      case 'number': {
        const num = typeof value === 'number' ? value : Number.parseFloat(value);
        return Number.isFinite(num) ? num : undefined;
      }
      case 'boolean':
        if (typeof value === 'boolean') return value;
        if (value === 'true') return true;
        if (value === 'false') return false;
        return undefined;
      case 'stringSet': {
        if (!Array.isArray(value)) return undefined;
        return value.filter((item) => def.values.includes(item));
      }
      default:
        return undefined;
    }
  }

  function parseStored(def, raw) {
    if (raw === null || raw === undefined) return undefined;
    if (def.type === 'stringSet' || def.type === 'quickActions') {
      try {
        return coerce(def, JSON.parse(raw));
      } catch {
        return undefined;
      }
    }
    return coerce(def, raw);
  }

  function serialize(def, value) {
    if (def.type === 'stringSet' || def.type === 'quickActions') return JSON.stringify(value);
    if (def.type === 'boolean') return value ? 'true' : 'false';
    return String(value);
  }

  function defaults() {
    const out = {};
    for (const def of PREF_DEFS) out[def.key] = defaultValue(def);
    for (const migration of MIGRATIONS) out[migration.flagKey] = true;
    return out;
  }

  function readFromStorage(storage) {
    const read = key => { try { return storage.getItem(key); } catch (_) { return null; } };
    const out = {};
    for (const def of PREF_DEFS) {
      const parsed = parseStored(def, read(def.storageKey));
      out[def.key] = parsed === undefined ? defaultValue(def) : parsed;
    }
    for (const migration of MIGRATIONS) {
      out[migration.flagKey] = read(migration.flagStorageKey) === '1';
    }
    return out;
  }

  // `keys` limits which preferences are written; migration flags always are.
  function writeToStorage(storage, prefs, keys) {
    for (const def of PREF_DEFS) {
      if (keys && !keys.includes(def.key)) continue;
      const value = coerce(def, prefs[def.key]);
      storage.setItem(def.storageKey, serialize(def, value === undefined ? defaultValue(def) : value));
    }
    for (const migration of MIGRATIONS) {
      if (prefs[migration.flagKey]) storage.setItem(migration.flagStorageKey, '1');
    }
  }

  function sanitize(prefs) {
    const source = prefs || {};
    const out = {};
    for (const def of PREF_DEFS) {
      const value = coerce(def, source[def.key]);
      out[def.key] = value === undefined ? defaultValue(def) : value;
    }
    for (const migration of MIGRATIONS) out[migration.flagKey] = !!source[migration.flagKey];
    return out;
  }

  // Layer a stored copy (e.g. the secure store) over known-good values.
  function merge(base, incoming) {
    const out = { ...base };
    const source = incoming || {};
    for (const def of PREF_DEFS) {
      if (source[def.key] === undefined) continue;
      const value = coerce(def, source[def.key]);
      if (value !== undefined) out[def.key] = value;
    }
    for (const migration of MIGRATIONS) {
      // Only trust the incoming flag when that copy actually carries a value
      // the migration would touch; otherwise `base` is already up to date.
      const suppliesMigratedKey = migration.keys.some((key) => source[key] !== undefined);
      if (suppliesMigratedKey) out[migration.flagKey] = !!source[migration.flagKey];
    }
    return out;
  }

  function applyMigrations(prefs) {
    let out = { ...prefs };
    for (const migration of MIGRATIONS) {
      if (out[migration.flagKey]) continue;
      out = migration.apply(out);
      out[migration.flagKey] = true;
    }
    return sanitize(out);
  }

  function load(storage) {
    return applyMigrations(readFromStorage(storage));
  }

  function definition(key) {
    return DEF_BY_KEY.get(key);
  }

  function allowedValues(key) {
    const def = DEF_BY_KEY.get(key);
    return def && def.values ? [...def.values] : [];
  }

  return {
    PREF_DEFS,
    MIGRATIONS,
    OPTIONAL_FEATURES,
    DEFAULT_NVIDIA_VOICE,
    DEFAULT_TTS_RATE,
    END_OF_SPEECH_MS,
    coerce,
    defaults,
    definition,
    allowedValues,
    readFromStorage,
    writeToStorage,
    sanitize,
    merge,
    applyMigrations,
    load
  };
});
