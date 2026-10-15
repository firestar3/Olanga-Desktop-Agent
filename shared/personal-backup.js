/* Portable personal data only. This module never executes imported content. */
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./notes-store') : root.OlangaNotes, node ? require('./schedules') : root.OlangaSchedules, node ? require('./productivity') : root.OlangaProductivity);
  if (node) module.exports = api; else root.OlangaPersonalBackup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Notes, Schedules, Workspace) {
  const FORMAT = 'olanga-personal-backup', VERSION = 1, MAX_BYTES = 4000000;
  const COLLECTIONS = Object.freeze(['notes', 'checklist', 'timers', 'schedules', 'preferences', 'workspace']);
  const RECOVERY_KEY = 'olanga_personal_restore_recovery_v1';
  const PREF_KEYS = Object.freeze(['appearanceAccent', 'appearanceMotion', 'appearanceContrast', 'appearanceGlow', 'responseStyle', 'preferredAddress', 'ttsRate', 'endOfSpeech', 'bargeIn', 'streamReplies', 'features']);
  const clone = value => JSON.parse(JSON.stringify(value));
  const encodedSize = value => new TextEncoder().encode(value).byteLength;
  const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
  function text(value, max, empty = false) { if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error('A backup text field is invalid or too long.'); return value; }
  function list(input, limit, validator) { if (!Array.isArray(input) || input.length > limit) throw new Error('A backup collection exceeds its supported limit.'); return input.map(validator); }
  function preferences(input) {
    if (!exact(input, PREF_KEYS)) throw new Error('Preferences include unsupported or missing fields. Keys and device settings cannot be imported.');
    const values = { appearanceAccent: ['violet', 'blue', 'mint', 'rose', 'amber'], appearanceMotion: ['system', 'reduced'], appearanceContrast: ['standard', 'strong'], appearanceGlow: ['standard', 'subtle', 'off'], responseStyle: ['natural', 'concise'], endOfSpeech: ['standard', 'quick', 'fast'] };
    for (const [key, allowed] of Object.entries(values)) if (!allowed.includes(input[key])) throw new Error('A portable preference is invalid: ' + key);
    text(input.preferredAddress, 40, true);
    if (!Number.isFinite(input.ttsRate) || input.ttsRate < 0.8 || input.ttsRate > 1.2 || typeof input.bargeIn !== 'boolean' || typeof input.streamReplies !== 'boolean' || !Array.isArray(input.features) || input.features.length > 2 || new Set(input.features).size !== input.features.length || input.features.some(value => !['notepadScreen', 'newsScreen'].includes(value))) throw new Error('A portable preference is invalid.');
    return clone(input);
  }
  function validateCollection(name, input, { parse, sanitizeNotes } = {}) {
    if (name === 'notes') return Notes.normalizeNotes(input, sanitizeNotes);
    if (name === 'preferences') return preferences(input);
    if (name === 'checklist') {
      const ids = new Set(); return list(input, 500, item => {
        if (!exact(item, ['id', 'text', 'completed', 'dueDate']) || typeof item.completed !== 'boolean') throw new Error('A checklist entry is invalid.');
        text(item.id, 150); text(item.text, 2000); if (item.dueDate !== null) text(item.dueDate, 200);
        if (ids.has(item.id)) throw new Error('Checklist IDs must be unique.'); ids.add(item.id); return clone(item);
      });
    }
    if (name === 'timers') return list(input, 100, item => {
      if (!exact(item, ['label', 'kind', 'remainingMs']) || !['timer', 'reminder', 'alarm'].includes(item.kind) || !Number.isSafeInteger(item.remainingMs) || item.remainingMs < 0 || item.remainingMs > 31536000000) throw new Error('An imported timer is invalid.');
      text(item.label, 200); return clone(item);
    });
    if (name === 'schedules') return list(input, Schedules.LIMIT, item => {
      if (!plain(item)) throw new Error('An imported schedule is invalid.');
      const keys = ['kind', 'title', 'repeat', 'online', ...(item.repeat === 'once' ? ['onceAt'] : ['time']), ...(item.repeat === 'weekly' ? ['days'] : [])];
      if (!exact(item, keys) || typeof item.online !== 'boolean') throw new Error('An imported schedule contains unsupported fields.');
      return Schedules.validate(item);
    });
    if (name === 'workspace') {
      if (typeof Workspace.validatePersonalBackup !== 'function') throw new Error('Workspace backup validation is unavailable.');
      return Workspace.validatePersonalBackup(JSON.stringify(input), parse);
    }
    throw new Error('Unknown backup collection.');
  }
  function validate(input, options = {}) {
    if (typeof input === 'string') { if (encodedSize(input) > MAX_BYTES) throw new Error('Choose a personal backup smaller than 4 MB.'); try { input = JSON.parse(input); } catch (_) { throw new Error('The backup is not valid JSON.'); } }
    if (!exact(input, ['format', 'version', 'createdAt', 'collections']) || input.format !== FORMAT || input.version !== VERSION || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0 || !plain(input.collections)) throw new Error('This is not a supported Olanga personal backup.');
    const names = Object.keys(input.collections);
    if (!names.length || names.some(name => !COLLECTIONS.includes(name))) throw new Error('The backup has no supported collections or includes private device data.');
    const collections = {};
    for (const name of names) collections[name] = validateCollection(name, input.collections[name], options);
    const result = { format: FORMAT, version: VERSION, createdAt: input.createdAt, collections };
    if (encodedSize(JSON.stringify(result)) > MAX_BYTES) throw new Error('The backup exceeds the 4 MB text limit.');
    return result;
  }
  function create(collections, options = {}) { return validate({ format: FORMAT, version: VERSION, createdAt: Date.now(), collections }, options); }
  function count(name, value) { return name === 'preferences' ? Object.keys(value).length : name === 'workspace' ? Object.values(value.content).reduce((total, items) => total + items.length, 0) : value.length; }
  function createRestorer(storage, adapters, options = {}) {
    let pending = null, busy = false, previewSequence = 0;
    async function snapshot(names) { const result = {}; for (const name of names) { if (!adapters[name]) throw new Error('The ' + name + ' collection is unavailable.'); result[name] = await adapters[name].read(); } return result; }
    function saveRecovery(record) { const raw = JSON.stringify(record); storage.setItem(RECOVERY_KEY, raw); if (storage.getItem(RECOVERY_KEY) !== raw) throw new Error('The recovery copy could not be verified. Nothing was replaced.'); }
    return {
      async preview(text) {
        if (busy) throw new Error('A restore is already running.');
        const sequence = ++previewSequence; pending = null;
        const backup = validate(text, options), names = Object.keys(backup.collections), before = await snapshot(names);
        if (sequence !== previewSequence) throw new Error('A newer backup selection replaced this preview.');
        const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        pending = { token, backup, before };
        return { token, createdAt: backup.createdAt, collections: names.map(name => ({ name, incoming: count(name, backup.collections[name]), current: adapters[name].count ? adapters[name].count(before[name]) : count(name, before[name]) })) };
      },
      async apply(token, selected) {
        if (busy || !pending || pending.token !== token) throw new Error('Choose the backup again and review its current preview.');
        if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(name => !Object.hasOwn(pending.backup.collections, name))) throw new Error('Choose at least one collection from the preview.');
        busy = true; const preview = pending, changed = [];
        try {
          const current = await snapshot(selected);
          for (const name of selected) if (JSON.stringify(current[name]) !== JSON.stringify(preview.before[name])) throw new Error('Your ' + name + ' changed after preview. Choose the backup again before replacing it.');
          const recovery = { format: 'olanga-personal-restore-recovery', version: 1, createdAt: Date.now(), status: 'prepared', originals: current };
          const retained = storage.getItem(RECOVERY_KEY);
          if (retained !== null) { let earlier; try { earlier = JSON.parse(retained); } catch (_) {} if ((!earlier || ['prepared', 'needs-recovery'].includes(earlier.status)) && !preview.fromRecovery) throw new Error('Review and download the existing unfinished recovery copy before replacing it.'); }
          saveRecovery(recovery);
          try {
            for (const name of selected) { changed.push(name); await adapters[name].write(clone(preview.backup.collections[name])); }
            recovery.status = 'completed'; saveRecovery(recovery); pending = null;
            return { restored: [...selected], paused: selected.filter(name => ['timers', 'schedules'].includes(name)) };
          } catch (error) {
            const failed = [];
            for (const name of changed.reverse()) try {
              if (JSON.stringify(await adapters[name].read()) === JSON.stringify(current[name])) continue;
              await (adapters[name].rollback || adapters[name].write)(clone(current[name]));
              if (JSON.stringify(await adapters[name].read()) !== JSON.stringify(current[name])) throw new Error('Rollback verification failed.');
            } catch (_) { failed.push(name); }
            recovery.status = failed.length ? 'needs-recovery' : 'rolled-back'; recovery.failed = failed;
            try { saveRecovery(recovery); } catch (_) {}
            pending = null;
            throw new Error(failed.length ? 'Restore stopped. Some original data needs recovery: ' + failed.join(', ') + '. Download the retained recovery copy before closing Olanga.' : 'Restore could not be saved. Your selected collections were rolled back. ' + (error.message || 'Try again.'));
          }
        } finally { busy = false; }
      },
      async previewRecovery() {
        if (busy) throw new Error('A restore is already running.');
        const raw = storage.getItem(RECOVERY_KEY); if (!raw || raw.length > MAX_BYTES * 2) throw new Error('The recovery copy is missing or too large.');
        let saved; try { saved = JSON.parse(raw); } catch (_) { throw new Error('The recovery copy could not be read. Download it before making more changes.'); }
        if (!plain(saved) || saved.format !== 'olanga-personal-restore-recovery' || saved.version !== 1 || !Number.isSafeInteger(saved.createdAt) || !plain(saved.originals)) throw new Error('The retained recovery format is invalid.');
        const collections = {};
        for (const [name, original] of Object.entries(saved.originals)) {
          if (!COLLECTIONS.includes(name) || !adapters[name]?.portableRecovery) throw new Error('The recovery copy includes an unsupported collection.');
          collections[name] = await adapters[name].portableRecovery(original, saved.createdAt);
        }
        // Use the ordinary bounded parser and preview. Recovery never bypasses
        // validation and re-imported clocks remain paused.
        const result = await this.preview(create(collections, options)); pending.fromRecovery = true; return result;
      },
      recoveryText() { return storage.getItem(RECOVERY_KEY); },
      deleteRecovery() { if (busy) throw new Error('Wait for the current restore to finish.'); storage.removeItem(RECOVERY_KEY); if (storage.getItem(RECOVERY_KEY) !== null) throw new Error('The recovery copy could not be deleted.'); },
      isBusy: () => busy
    };
  }
  return { FORMAT, VERSION, MAX_BYTES, COLLECTIONS, PREF_KEYS, RECOVERY_KEY, validateCollection, validate, create, count, createRestorer };
});
