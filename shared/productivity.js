(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./memory-learning') : root.OlangaMemoryLearning);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaProductivity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (learning) {
  const KEY = 'olanga_productivity_v1';
  const STATES = new Set(['working', 'completed', 'failed', 'cancelled', 'awaiting-input', 'interrupted', 'unverified']);
  const STEP_STATES = new Set(['pending', 'working', 'completed', 'failed', 'cancelled', 'uncertain', 'skipped', 'unverified']);
  const MAX_HISTORY = 40;
  const MAX_FACTS = 50;
  const TIMING_PHASES = ['acknowledgment', 'ack-dispatch', 'ack-audio-start', 'actions-finished', 'transcription', 'planning', 'execution', 'first-audio', 'speech', 'total'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const name = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 100 && !/[\[\]\r\n\x00-\x1f]/.test(value) ? value.trim() : '';
  // Manual memories and narrowly learned direct-user facts are context for
  // answers, never instructions or permission to act.
  const factText = value => typeof value === 'string' && value.trim().length >= 2 && value.trim().length <= 300 && !/[\[\]\x00-\x1f]/.test(value) ? value.trim().replace(/\s+/g, ' ') : '';
  const FACT_STOP_WORDS = new Set(['the', 'that', 'this', 'my', 'is', 'are', 'was', 'and', 'about', 'your', 'for', 'our']);
  const LEARNING_UNDO_TTL_MS = 10 * 60 * 1000;
  function factMetadata(item, text) {
    const allowed = ['id', 'text', 'at', 'source', 'slot', 'updatedAt'];
    if (Object.keys(item).some(key => !allowed.includes(key))) return null;
    const metadata = {};
    if (Object.hasOwn(item, 'source')) {
      if (!['manual', 'conversation'].includes(item.source)) return null;
      metadata.source = item.source;
    }
    if (Object.hasOwn(item, 'slot')) {
      if (!learning?.SLOTS.includes(item.slot)) return null;
      const match = learning.classifyFact(text);
      if (!match || match.slot !== item.slot) return null;
      metadata.slot = item.slot;
    }
    if (metadata.source === 'conversation' && !metadata.slot) return null;
    if (Object.hasOwn(item, 'updatedAt')) {
      if (!Number.isFinite(item.updatedAt) || item.updatedAt < item.at) return null;
      metadata.updatedAt = item.updatedAt;
    }
    return metadata;
  }
  let idSequence = 0;
  const id = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}-${++idSequence}`;
  function completedState(steps) {
    if (steps.some(step => step.state === 'failed')) return 'failed';
    if (steps.some(step => step.state === 'cancelled')) return 'cancelled';
    if (steps.some(step => ['pending', 'working', 'uncertain'].includes(step.state))) return 'interrupted';
    return steps.some(step => step.state === 'unverified') ? 'unverified' : 'completed';
  }

  function defaults() {
    return { version: 1, memoryEnabled: false, saveActivity: false, diagnostics: false, speechInput: 'cloud', factsEnabled: true, learningEnabled: true, aliases: [], playlists: [], facts: [], routines: [], activity: [], runs: [], timings: [] };
  }
  function sanitize(raw) {
    const result = defaults();
    if (!raw || typeof raw !== 'object' || raw.version !== 1) return result;
    for (const key of ['memoryEnabled', 'saveActivity', 'diagnostics']) result[key] = raw[key] === true;
    result.factsEnabled = raw.factsEnabled !== false;
    result.learningEnabled = raw.learningEnabled !== false;
    const factIds = new Set(), factTexts = new Set();
    for (const item of Array.isArray(raw.facts) ? raw.facts.slice(0, MAX_FACTS) : []) {
      const text = factText(item?.text);
      if (!text || !name(item?.id) || factIds.has(item.id) || factTexts.has(text.toLowerCase()) || !Number.isFinite(item.at)) continue;
      const metadata = factMetadata(item, text);
      if (metadata === null) continue;
      factIds.add(item.id); factTexts.add(text.toLowerCase());
      result.facts.push({ id: item.id, text, at: item.at, ...metadata });
    }
    result.speechInput = ['offline', 'offline-general'].includes(raw.speechInput) ? raw.speechInput : 'cloud';
    for (const key of ['aliases', 'playlists']) {
      const seen = new Set();
      for (const item of Array.isArray(raw[key]) ? raw[key].slice(0, 50) : []) {
        const alias = name(item?.alias), target = name(item?.target);
        if (!alias || !target || seen.has(alias.toLowerCase())) continue;
        seen.add(alias.toLowerCase());
        result[key].push({ alias, target });
      }
    }
    const routineIds = new Set();
    for (const item of Array.isArray(raw.routines) ? raw.routines.slice(0, 30) : []) {
      if (!name(item?.id) || routineIds.has(item.id) || !name(item.name) || !Array.isArray(item.lines) || !item.lines.length || item.lines.length > 12 || item.lines.some(line => typeof line !== 'string' || !line.trim() || line.length > 500 || /[\r\n]/.test(line))) continue;
      routineIds.add(item.id);
      result.routines.push({ id: item.id, name: item.name.trim(), lines: item.lines.map(line => line.trim()) });
    }
    if (result.saveActivity) {
      for (const entry of Array.isArray(raw.activity) ? raw.activity.slice(-MAX_HISTORY) : []) {
        if (!name(entry?.id) || !Number.isFinite(entry.at) || !STATES.has(entry.state)) continue;
        result.activity.push({ id: entry.id, at: entry.at, state: ['working', 'awaiting-input'].includes(entry.state) ? 'interrupted' : entry.state,
          steps: (Array.isArray(entry.steps) ? entry.steps : []).slice(0, 16).filter(step => /^[A-Z_]{1,40}$/.test(step?.operation) && STEP_STATES.has(step.state)).map(step => ({ operation: step.operation, state: step.state === 'working' ? 'uncertain' : step.state })) });
      }
    }
    const runs = Array.isArray(raw.runs) ? raw.runs.slice(-10) : [];
    const runIdCounts = new Map();
    for (const run of runs) if (name(run?.id)) runIdCounts.set(run.id, (runIdCounts.get(run.id) || 0) + 1);
    for (const run of runs) {
      if (!name(run?.id) || !name(run.name) || !Number.isFinite(run.at) || !STATES.has(run.state) || !Array.isArray(run.steps) || !run.steps.length || run.steps.length > 12) continue;
      // Ambiguous IDs could display one proposal but dispatch another via find(id).
      if (runIdCounts.get(run.id) !== 1) continue;
      if (run.steps.some(step => typeof step?.command !== 'string' || !/^\[[A-Z_]+(?:: [^\[\]\r\n]+)?\]$/.test(step.command) || step.command.length > 1000 || !STEP_STATES.has(step.state))) continue;
      result.runs.push({ id: run.id, name: run.name, at: run.at, state: run.state === 'working' ? 'interrupted' : run.state,
        steps: run.steps.map(step => ({ command: step.command, state: step.state === 'working' ? 'uncertain' : step.state })) });
    }
    if (result.diagnostics) result.timings = (Array.isArray(raw.timings) ? raw.timings : []).slice(-200).filter(item => TIMING_PHASES.includes(item?.phase) && Number.isFinite(item.ms) && item.ms >= 0 && item.ms <= 3600000 && ['ok', 'error', 'cancelled'].includes(item.outcome)).map(item => ({ phase: item.phase, ms: item.ms, outcome: item.outcome }));
    return result;
  }

  const PERSONAL_KEYS = ['facts', 'aliases', 'playlists', 'routines'];
  const RECOVERY_MESSAGE = 'Workspace storage needs recovery. Your original data is preserved. Open Workspace → Backups to review it; saved changes are paused.';
  const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
  const personalContent = state => Object.fromEntries(PERSONAL_KEYS.map(key => [key, clone(state[key])]));
  function validatePersonal(content, parse) {
    if (!exactKeys(content, PERSONAL_KEYS)) throw new Error('This backup has unsupported personal content.');
    for (const key of PERSONAL_KEYS) if (!Array.isArray(content[key]) || content[key].length > (key === 'routines' ? 30 : 50)) throw new Error('This backup exceeds the Workspace limits.');
    const ids = new Set(), texts = new Set();
    for (const item of content.facts) {
      if (!plain(item) || !name(item.id) || name(item.id) !== item.id || !factText(item.text) || factText(item.text) !== item.text || !Number.isFinite(item.at) || item.at < 0 || factMetadata(item, item.text) === null || ids.has(item.id) || texts.has(item.text.toLowerCase())) throw new Error('This backup contains an invalid or duplicate memory.');
      ids.add(item.id); texts.add(item.text.toLowerCase());
    }
    for (const kind of ['aliases', 'playlists']) {
      const aliases = new Set();
      for (const item of content[kind]) {
        if (!exactKeys(item, ['alias', 'target']) || !name(item.alias) || name(item.alias) !== item.alias || !name(item.target) || name(item.target) !== item.target || aliases.has(item.alias.toLowerCase())) throw new Error('This backup contains an invalid or duplicate saved name.');
        aliases.add(item.alias.toLowerCase());
        if (kind === 'aliases' && typeof parse === 'function') {
          const actions = parse('open ' + item.target);
          if (!Array.isArray(actions) || actions.length !== 1 || actions[0].command !== '[OPEN_APP: ' + item.target + ']') throw new Error('A saved app name in this backup is not supported.');
        }
      }
    }
    const routines = new Set();
    for (const item of content.routines) {
      if (!exactKeys(item, ['id', 'name', 'lines']) || !name(item.id) || name(item.id) !== item.id || routines.has(item.id) || !name(item.name) || name(item.name) !== item.name || !Array.isArray(item.lines) || !item.lines.length || item.lines.length > 12 || item.lines.some(line => typeof line !== 'string' || !line.trim() || line !== line.trim() || line.length > 500 || /[\r\n]/.test(line))) throw new Error('This backup contains an invalid routine.');
      routines.add(item.id);
      if (typeof parse !== 'function') throw new Error('Routine validation is unavailable. Reopen Workspace and try again.');
      let count = 0;
      for (const line of item.lines) {
        const actions = parse(line, { aliases: content.aliases, playlists: content.playlists });
        if (!Array.isArray(actions) || !actions.length) throw new Error('A routine in this backup contains an unsupported command.');
        count += actions.length;
      }
      if (count > 12) throw new Error('A routine in this backup has too many actions.');
    }
    return clone(content);
  }
  function validatePersonalBackup(text, parse) {
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('Choose a Workspace backup smaller than 1 MB.');
    let payload;
    try { payload = JSON.parse(text); } catch (_) { throw new Error('This file is not valid JSON.'); }
    if (!exactKeys(payload, ['format', 'version', 'createdAt', 'content']) || payload.format !== 'olanga-workspace-backup' || payload.version !== 1 || !Number.isFinite(payload.createdAt) || payload.createdAt < 0) throw new Error('This is not a supported Olanga Workspace backup.');
    return { ...payload, content: validatePersonal(payload.content, parse) };
  }
  function sameData(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameData(left[key], right[key]));
  }
  function createStore(storage) {
    let state = defaults(), recovery = null, originalRaw, recoveryBackup = null, memorySelector = null;
    const listeners = new Set(), memoryListeners = new Set(), importPreviews = new Map(), learningUndos = new Map();
    function readState() {
      memorySelector = null;
      let raw;
      try { raw = storage.getItem(KEY); } catch (_) { recovery = { reason: 'read-failed' }; originalRaw = undefined; return false; }
      originalRaw = raw;
      if (raw === null) { state = defaults(); recovery = null; return true; }
      let parsed;
      try { parsed = JSON.parse(raw); } catch (_) { recovery = { reason: 'malformed' }; return false; }
      if (!plain(parsed)) { recovery = { reason: 'malformed' }; return false; }
      if (parsed.version !== 1) { recovery = { reason: 'unsupported-version' }; return false; }
      state = sanitize(parsed);
      // A partially damaged personal collection is useful in memory, but must
      // never be silently normalized over the only original copy.
      if (PERSONAL_KEYS.some(key => Object.hasOwn(parsed, key) && !sameData(parsed[key], state[key]))) { recovery = { reason: 'malformed' }; return false; }
      recovery = null; return true;
    }
    readState();
    function requireWritable() { if (recovery) throw new Error(RECOVERY_MESSAGE); }
    function memoryChanged(previous, reason) {
      const removedIds = previous.facts.filter(item => !state.facts.some(next => next.id === item.id && next.text === item.text)).map(item => item.id);
      const addedIds = state.facts.filter(item => !previous.facts.some(old => old.id === item.id && old.text === item.text)).map(item => item.id);
      if (!removedIds.length && !addedIds.length && previous.factsEnabled === state.factsEnabled && !['restored', 'reset'].includes(reason)) return;
      const change = { reason: reason || (previous.factsEnabled !== state.factsEnabled ? state.factsEnabled ? 'enabled' : 'disabled' : removedIds.length ? 'deleted' : 'added'), removedIds, addedIds, enabled: state.factsEnabled };
      for (const listener of [...memoryListeners]) { try { listener(clone(change)); } catch (_) {} }
    }
    function backupOriginal() {
      let raw;
      try { raw = storage.getItem(KEY); } catch (_) { throw new Error('The original Workspace record still cannot be read. Nothing was replaced. Retry after storage is available.'); }
      if (originalRaw !== undefined && raw !== originalRaw) throw new Error('Workspace storage changed. Retry recovery before creating a backup.');
      const key = KEY + '_recovery_' + id();
      const record = JSON.stringify({ format: 'olanga-workspace-recovery', version: 1, sourceKey: KEY, raw, createdAt: Date.now() });
      try {
        if (storage.getItem(key) !== null) throw new Error('Recovery key already exists.');
        storage.setItem(key, record);
        if (storage.getItem(key) !== record) throw new Error('Recovery verification failed.');
      } catch (_) { throw new Error('A verified recovery copy could not be saved. Your original Workspace data has not been replaced.'); }
      originalRaw = raw; recoveryBackup = { key, raw, record };
      notify(); return { key };
    }
    function readRecoveryCopy(key) {
      if (typeof key !== 'string' || !key.startsWith(KEY + '_recovery_') || key.length > 200) throw new Error('Invalid recovery copy.');
      let text, record;
      try { text = storage.getItem(key); record = JSON.parse(text); } catch (_) { throw new Error('This recovery copy cannot be read.'); }
      if (!exactKeys(record, ['format', 'version', 'sourceKey', 'raw', 'createdAt']) || record.format !== 'olanga-workspace-recovery' || record.version !== 1 || record.sourceKey !== KEY || record.raw !== null && typeof record.raw !== 'string' || !Number.isFinite(record.createdAt)) throw new Error('This recovery copy is invalid.');
      return { text, record };
    }
    function verifyBackup(key) {
      if (!recoveryBackup || key !== recoveryBackup.key) throw new Error('Create and verify a recovery copy before resetting Workspace.');
      try { if (storage.getItem(key) !== recoveryBackup.record || storage.getItem(KEY) !== recoveryBackup.raw) throw new Error('changed'); }
      catch (_) { throw new Error('The original data or recovery copy changed or cannot be read. Nothing was replaced. Create a fresh recovery copy first.'); }
    }
    // A view failure must not turn a committed write into an apparent storage
    // failure, nor prevent other views from receiving the committed state.
    function notify() { for (const listener of [...listeners]) { try { listener(); } catch (_) {} } }
    function freshId() {
      let candidate;
      do { candidate = id(); } while (['routines', 'runs', 'activity', 'facts'].some(key => state[key].some(item => item.id === candidate)));
      return candidate;
    }
    function save(required = false) {
      if (recovery) { if (required) requireWritable(); notify(); return false; }
      try {
        const activity = state.saveActivity ? state.activity.map(entry => ({ id: entry.id, at: entry.at, state: entry.state, steps: entry.steps.map(step => ({ operation: step.operation, state: step.state })) })) : [];
        const encoded = JSON.stringify({ ...state, activity, timings: state.diagnostics ? state.timings : [] });
        if (required || encoded !== originalRaw) storage.setItem(KEY, encoded);
        originalRaw = encoded;
      } catch (_) {
        if (required) throw new Error('Olanga could not save this change. Free some storage and try again.');
        notify();
        return false;
      }
      notify();
      return true;
    }
    function activityChanged() {
      // Session-only receipts still update the UI immediately. They do not
      // require serializing or rewriting an unchanged persistent Workspace.
      if (state.saveActivity) save();
      else notify();
    }
    function edit(fn, reason) {
      requireWritable();
      const previous = state, draft = clone(state);
      fn(draft);
      state = draft; memorySelector = null;
      try { save(true); } catch (error) { state = previous; memorySelector = null; notify(); throw error; }
      memoryChanged(previous, reason);
    }
    function options() {
      return state.memoryEnabled ? { aliases: clone(state.aliases), playlists: clone(state.playlists) } : {};
    }
    return {
      snapshot: () => clone(state), options,
      activitySummary() {
        const latest = state.activity.at(-1);
        if (!latest) return null;
        const step = latest.steps.find(item => item.state === 'working') || latest.steps.findLast(item => item.state !== 'pending' && item.state !== 'skipped');
        return { id: latest.id, state: latest.state, operation: step?.operation || null };
      },
      memorySnapshot: () => ({ factsEnabled: state.factsEnabled, learningEnabled: state.learningEnabled, facts: clone(state.facts) }),
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      subscribeMemory(listener) { memoryListeners.add(listener); return () => memoryListeners.delete(listener); },
      recoveryStatus() { return { blocked: !!recovery, reason: recovery?.reason || null, message: recovery ? RECOVERY_MESSAGE : '', backupKey: recoveryBackup?.key || null }; },
      retryRecovery() {
        if (!recovery) return true;
        const previous = state;
        const ok = readState(); recoveryBackup = null; importPreviews.clear(); learningUndos.clear();
        memoryChanged(previous, 'restored');
        notify(); return ok;
      },
      createRecoveryBackup: backupOriginal,
      recoveryBackupText(key) { return readRecoveryCopy(key).text; },
      listRecoveryCopies() {
        const keys = new Set(recoveryBackup ? [recoveryBackup.key] : []);
        if (Number.isInteger(storage.length) && typeof storage.key === 'function') for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index); if (typeof key === 'string' && key.startsWith(KEY + '_recovery_')) keys.add(key);
        }
        const copies = [];
        for (const key of keys) { try { const { record } = readRecoveryCopy(key); copies.push({ key, createdAt: record.createdAt }); } catch (_) {} }
        return copies.sort((a, b) => b.createdAt - a.createdAt);
      },
      deleteRecoveryCopy(key) {
        readRecoveryCopy(key);
        try { storage.removeItem(key); if (storage.getItem(key) !== null) throw new Error('not removed'); } catch (_) { throw new Error('This recovery copy could not be deleted.'); }
        if (recoveryBackup?.key === key) recoveryBackup = null;
        notify();
      },
      exportRecoveryPersonal(key, parse) {
        const { record } = readRecoveryCopy(key);
        let original;
        try { original = record.raw === null ? defaults() : JSON.parse(record.raw); } catch (_) { throw new Error('The original record is damaged. Download and keep this recovery copy; it cannot be restored automatically.'); }
        if (!plain(original) || original.version !== 1) throw new Error('This recovery copy uses an unsupported Workspace version. Keep it for a compatible version.');
        const content = Object.fromEntries(PERSONAL_KEYS.map(kind => [kind, Object.hasOwn(original, kind) ? original[kind] : []]));
        return { format: 'olanga-workspace-backup', version: 1, createdAt: Date.now(), content: validatePersonal(content, parse) };
      },
      resetAfterBackup(key) {
        if (!recovery) throw new Error('Workspace does not need a storage reset.');
        verifyBackup(key);
        const previous = state, previousRecovery = recovery;
        state = defaults(); recovery = null; memorySelector = null;
        try { save(true); } catch (error) { state = previous; recovery = previousRecovery; notify(); throw error; }
        importPreviews.clear(); learningUndos.clear(); memoryChanged(previous, 'reset');
        return true;
      },
      exportPersonal() {
        requireWritable();
        return { format: 'olanga-workspace-backup', version: 1, createdAt: Date.now(), content: personalContent(state) };
      },
      validatePersonalBackup,
      previewImport(text, parse) {
        requireWritable();
        const content = validatePersonalBackup(text, parse).content, token = id();
        importPreviews.clear(); importPreviews.set(token, { content, before: JSON.stringify(personalContent(state)) });
        return { token, content: clone(content), counts: Object.fromEntries(PERSONAL_KEYS.map(key => [key, content[key].length])), currentCounts: Object.fromEntries(PERSONAL_KEYS.map(key => [key, state[key].length])) };
      },
      importPersonal(token, parse) {
        requireWritable();
        const preview = importPreviews.get(token);
        if (!preview || preview.before !== JSON.stringify(personalContent(state))) throw new Error('Workspace changed after preview. Choose the backup again and review the new preview.');
        const content = validatePersonal(preview.content, parse);
        const backup = backupOriginal(); verifyBackup(backup.key);
        edit(data => { for (const key of PERSONAL_KEYS) data[key] = clone(content[key]); }, 'restored');
        importPreviews.clear(); learningUndos.clear();
        return { backupKey: backup.key, counts: Object.fromEntries(PERSONAL_KEYS.map(key => [key, state[key].length])) };
      },
      preference(key, value) {
        if (!['memoryEnabled', 'saveActivity', 'diagnostics', 'speechInput', 'factsEnabled', 'learningEnabled'].includes(key)) throw new Error('Unknown preference.');
        if (key === 'speechInput' ? !['cloud', 'offline', 'offline-general'].includes(value) : typeof value !== 'boolean') throw new Error('Invalid preference.');
        edit(data => { data[key] = value; if (key === 'diagnostics' && !value) data.timings = []; });
      },
      remember(kind, alias, target, previous) {
        if (!['aliases', 'playlists'].includes(kind) || !name(alias) || !name(target)) throw new Error('Use names of 1–100 characters without command markers or line breaks.');
        edit(data => {
          const index = data[kind].findIndex(item => item.alias.toLowerCase() === alias.trim().toLowerCase());
          if (previous) {
            const oldIndex = ['aliases', 'playlists'].includes(previous.kind) ? data[previous.kind].findIndex(item => item.alias === previous.alias) : -1;
            if (oldIndex < 0) throw new Error('This saved name was removed. Open a current saved name to edit.');
            if (index >= 0 && (kind !== previous.kind || index !== oldIndex)) throw new Error('Another saved name already uses that name. Choose a different name.');
            data[previous.kind].splice(oldIndex, 1);
          }
          const item = { alias: alias.trim(), target: target.trim() };
          if (!previous && index >= 0) data[kind][index] = item;
          else { if (data[kind].length >= 50) throw new Error('Remove a saved name before adding another.'); data[kind].push(item); }
        });
      },
      forget(kind, alias) { if (!['aliases', 'playlists'].includes(kind)) return; edit(data => { data[kind] = data[kind].filter(item => item.alias !== alias); }); },
      clearMemory() { edit(data => { data.aliases = []; data.playlists = []; data.memoryEnabled = false; }); },
      rememberFact(text) {
        const clean = factText(text);
        if (!clean) throw new Error('Tell me what to remember in 2–300 characters, without brackets or line breaks.');
        let record;
        edit(data => {
          record = data.facts.find(item => item.text.toLowerCase() === clean.toLowerCase());
          if (record) {
            // An explicit request to keep an already learned fact takes manual
            // ownership: later automatic updates/undo cannot replace it.
            if (record.source === 'conversation') { record.source = 'manual'; record.updatedAt = Math.max(Date.now(), record.at); }
            return;
          }
          const classified = learning?.classifyFact(clean);
          if (classified) {
            const related = data.facts.filter(item => item.slot === classified.slot || !item.slot && learning.extract(item.text).some(found => found.slot === classified.slot));
            if (related.length > 1) throw new Error('More than one saved memory matches that kind of detail. Edit the specific memory in Workspace, or identify its exact text when asking to update it.');
            if (related.length === 1) {
              const previous = related[0];
              if (!learning.classifyFact(previous.text)) throw new Error('The related memory includes other details. Edit that specific memory in Workspace, or identify its exact text when asking to update it.');
              record = { id: previous.id, text: clean, at: previous.at, source: 'manual', slot: classified.slot, updatedAt: Math.max(Date.now(), previous.at) };
              data.facts[data.facts.findIndex(item => item.id === previous.id)] = record;
              return;
            }
          }
          if (data.facts.length >= MAX_FACTS) throw new Error('Your memory list is full. Delete a memory in Workspace before adding another.');
          record = { id: freshId(), text: clean, at: Date.now() };
          data.facts.push(record);
        });
        return clone(record);
      },
      setLearningEnabled(value) {
        if (typeof value !== 'boolean') throw new Error('Choose whether Olanga may learn memories.');
        edit(data => { data.learningEnabled = value; });
        return value;
      },
      learnFromUserText(text) {
        const result = { learned: [], updated: [], skipped: [], undoToken: null };
        if (!state.learningEnabled) { result.skipped.push({ reason: 'paused' }); return result; }
        if (recovery) { result.skipped.push({ reason: 'storage-recovery' }); return result; }
        if (!learning?.extract) { result.skipped.push({ reason: 'learning-unavailable' }); return result; }
        const candidates = learning.extract(text);
        if (!candidates.length) return result;
        const changes = [];
        for (const candidate of candidates) {
          if (state.facts.some(item => item.text.toLocaleLowerCase() === candidate.text.toLocaleLowerCase())) continue;
          const sameSlot = state.facts.filter(item => item.slot === candidate.slot || !item.slot && (learning.mentionsSlot ? learning.mentionsSlot(item.text, candidate.slot) : learning.extract(item.text).some(found => found.slot === candidate.slot)));
          // Explicitly saved facts remain under explicit user control. Learning
          // can revise its own one-slot record, never erase a manual statement.
          if (sameSlot.some(item => item.source !== 'conversation')) { result.skipped.push({ slot: candidate.slot, reason: 'manual-memory-exists' }); continue; }
          if (sameSlot.length > 1) { result.skipped.push({ slot: candidate.slot, reason: 'ambiguous-existing-memories' }); continue; }
          const before = sameSlot[0] || null;
          if (!before && state.facts.length + changes.filter(change => !change.before).length >= MAX_FACTS) { result.skipped.push({ slot: candidate.slot, reason: 'memory-full' }); continue; }
          const after = before
            ? { ...before, text: candidate.text, updatedAt: Math.max(Date.now(), before.at), source: 'conversation', slot: candidate.slot }
            : { id: freshId(), text: candidate.text, at: Date.now(), source: 'conversation', slot: candidate.slot };
          changes.push({ before: before ? clone(before) : null, after });
        }
        if (!changes.length) return result;
        try {
          edit(data => {
            for (const change of changes) {
              if (change.before) data.facts[data.facts.findIndex(item => item.id === change.before.id)] = change.after;
              else data.facts.push(change.after);
            }
          }, 'learned');
        } catch (error) {
          result.skipped.push({ reason: 'storage-unavailable' }); result.error = error.message;
          return result;
        }
        const token = id(), at = Date.now();
        for (const [key, undo] of learningUndos) if (at - undo.at > LEARNING_UNDO_TTL_MS) learningUndos.delete(key);
        while (learningUndos.size >= 10) learningUndos.delete(learningUndos.keys().next().value);
        learningUndos.set(token, { at, changes: clone(changes) }); result.undoToken = token;
        for (const { before, after } of changes) {
          const entry = { id: after.id, text: after.text, slot: after.slot, source: 'conversation' };
          if (before) result.updated.push({ ...entry, previousText: before.text });
          else result.learned.push(entry);
        }
        return result;
      },
      undoLearnedMemory(token) {
        const selected = token === undefined ? [...learningUndos.keys()].at(-1) : token;
        const undo = learningUndos.get(selected);
        if (!undo || Date.now() - undo.at > LEARNING_UNDO_TTL_MS) {
          if (selected) learningUndos.delete(selected);
          throw new Error('That learning undo has expired. Edit or delete the memory in Workspace instead.');
        }
        if (undo.changes.some(change => !sameData(state.facts.find(item => item.id === change.after.id), change.after))) {
          learningUndos.delete(selected);
          throw new Error('Those memories changed after learning. Review their current versions in Workspace.');
        }
        // Restoring an earlier value cannot overwrite a duplicate created by a
        // later manual change. The entire batch succeeds or none of it does.
        const changedIds = new Set(undo.changes.map(change => change.after.id));
        if (undo.changes.some(change => change.before && state.facts.some(item => !changedIds.has(item.id) && item.text.toLocaleLowerCase() === change.before.text.toLocaleLowerCase()))) throw new Error('A matching memory already exists. Review the memories in Workspace.');
        edit(data => {
          for (const change of undo.changes) {
            const index = data.facts.findIndex(item => item.id === change.after.id);
            if (change.before) data.facts[index] = clone(change.before);
            else data.facts.splice(index, 1);
          }
        }, 'learning-undone');
        learningUndos.delete(selected);
        return { undone: true, removedIds: undo.changes.filter(change => !change.before).map(change => change.after.id), restored: undo.changes.filter(change => change.before).map(change => clone(change.before)) };
      },
      updateFact(factId, text) {
        const clean = factText(text);
        if (!clean) throw new Error('Use 2–300 characters without brackets or line breaks for a memory.');
        let updated;
        edit(data => {
          const index = data.facts.findIndex(item => item.id === factId);
          if (index < 0) throw new Error('That memory was removed. Open a current memory to edit.');
          if (data.facts.some(item => item.id !== factId && item.text.toLocaleLowerCase() === clean.toLocaleLowerCase())) throw new Error('Another memory already has that text.');
          const previous = data.facts[index], classified = learning?.classifyFact(clean);
          updated = { id: previous.id, text: clean, at: previous.at, source: 'manual', updatedAt: Math.max(Date.now(), previous.at), ...(classified ? { slot: classified.slot } : {}) };
          data.facts[index] = updated;
        }, 'edited');
        return clone(updated);
      },
      // Exact wording first, then a unique phrase, then all meaningful words.
      findFacts(query) {
        const target = String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (!target) return [];
        const exact = state.facts.filter(item => item.text.toLowerCase() === target);
        if (exact.length) return clone(exact);
        if (target.length > 300) return [];
        const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const phrasePattern = new RegExp('(?<![\\p{L}\\p{N}_])' + escaped + '(?![\\p{L}\\p{N}_])', 'u');
        const phrase = state.facts.filter(item => phrasePattern.test(item.text.toLowerCase()));
        if (phrase.length) return clone(phrase);
        if (/[^ \p{L}\p{N}'’.,?!:-]/u.test(target)) return [];
        const words = (target.match(/[\p{L}\p{N}]+/gu) || []).filter(word => word.length > 2 && !FACT_STOP_WORDS.has(word));
        return words.length ? clone(state.facts.filter(item => {
          const terms = new Set(item.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
          return words.every(word => terms.has(word));
        })) : [];
      },
      deleteFact(factId) {
        let removed = null;
        edit(data => { removed = data.facts.find(item => item.id === factId) || null; data.facts = data.facts.filter(item => item.id !== factId); });
        return removed ? clone(removed) : null;
      },
      clearFacts() { const count = state.facts.length; edit(data => { data.facts = []; }, 'cleared'); return count; },
      memoryContext() { return state.factsEnabled ? state.facts.map(item => item.text) : []; },
      recallFact(question) { return state.factsEnabled && learning?.recall ? learning.recall(state.facts, question) : null; },
      relevantContext(query, options) {
        if (!state.factsEnabled) return [];
        if (!learning?.select) return state.facts.slice(0, 8).map(item => ({ id: item.id, text: item.text }));
        if (learning.createSelector) {
          memorySelector ||= learning.createSelector(state.facts);
          return memorySelector(query, options);
        }
        return learning.select(state.facts, query, options);
      },
      saveRoutine(routine, parse) {
        if (!routine || !Array.isArray(routine.lines) || routine.lines.some(line => typeof line !== 'string')) throw new Error('Give the routine a name and supported commands.');
        const lines = routine.lines.map(line => line.trim()).filter(Boolean);
        if (!name(routine.name) || !lines.length || lines.length > 12 || lines.some(line => line.length > 500 || /[\r\n]/.test(line))) throw new Error('Give the routine a name and up to 12 short commands, one per line.');
        const actions = lines.flatMap(line => { const parsed = parse(line, options()); if (!Array.isArray(parsed) || !parsed.length) throw new Error(`This command needs interpretation and cannot be saved as a routine: ${line}`); return parsed; });
        if (actions.length > 12) throw new Error('A routine can contain at most 12 actions.');
        if (routine.id && !state.routines.some(item => item.id === routine.id)) throw new Error('This routine was removed. Start a new routine instead.');
        const record = { id: routine.id || freshId(), name: routine.name.trim(), lines };
        edit(data => { const index = data.routines.findIndex(item => item.id === record.id); if (index >= 0) data.routines[index] = record; else { if (data.routines.length >= 30) throw new Error('Remove a routine before adding another.'); data.routines.push(record); } });
        return clone(record);
      },
      deleteRoutine(routineId) { edit(data => { data.routines = data.routines.filter(item => item.id !== routineId); }); },
      createRun(routine, actions, selected) {
        if (!name(routine?.name) || !Array.isArray(actions) || !actions.length || actions.length > 12 || actions.some(action => typeof action?.command !== 'string' || action.command.length > 1000 || !/^\[[A-Z_]+(?:: [^\[\]\r\n]+)?\]$/.test(action.command))) throw new Error('Invalid routine steps.');
        if (selected === undefined) selected = actions.map((_, index) => index);
        if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(index => !Number.isInteger(index) || !actions[index])) throw new Error('Select at least one valid step.');
        const run = { id: freshId(), name: routine.name, at: Date.now(), state: 'awaiting-input', steps: actions.map((action, index) => ({ command: action.command, state: selected.includes(index) ? 'pending' : 'skipped' })) };
        edit(data => { data.runs = [...data.runs, run].slice(-10); });
        return clone(run);
      },
      selectRunSteps(runId, selected) {
        edit(data => {
          const run = data.runs.find(item => item.id === runId);
          if (!run || !Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(index => !Number.isInteger(index) || !run.steps[index] || ['completed', 'skipped', 'working'].includes(run.steps[index].state))) throw new Error('Review the unfinished steps again.');
          run.steps.forEach((step, index) => { if (!['completed', 'skipped'].includes(step.state) && !selected.includes(index)) step.state = 'skipped'; });
        });
      },
      transitionRun(runId, index, status) {
        if (!STEP_STATES.has(status)) throw new Error('Invalid step state.');
        edit(data => { const run = data.runs.find(item => item.id === runId); const step = run?.steps[index]; if (!step || step.state === 'completed' || step.state === 'skipped') throw new Error('This step cannot run again.'); step.state = status; run.state = 'working'; });
      },
      finishRun(runId, status) {
        if (!STATES.has(status)) return;
        let finished;
        try {
          edit(data => {
            const run = data.runs.find(item => item.id === runId);
            if (!run) return;
            run.state = finished = status === 'completed' ? completedState(run.steps) : status;
            for (const step of run.steps) if (step.state === 'working') step.state = 'uncertain';
          });
        } catch (error) {
          // The durable dispatch boundary still permits safe recovery on restart.
          // Mirror that uncertainty locally; no executor remains active after this.
          const run = state.runs.find(item => item.id === runId);
          if (run) {
            run.state = 'interrupted';
            for (const step of run.steps) if (step.state === 'working') step.state = 'uncertain';
          }
          notify();
          throw error;
        }
        return finished;
      },
      deleteRun(runId) { edit(data => { data.runs = data.runs.filter(item => item.id !== runId); }); },
      begin() { const entry = { id: freshId(), at: Date.now(), state: 'working', steps: [] }; state.activity = [...state.activity, entry].slice(-MAX_HISTORY); activityChanged(); return entry.id; },
      plan(entryId, operations) {
        const entry = state.activity.find(item => item.id === entryId);
        if (!entry || entry.state !== 'working' || entry.steps.length || !Array.isArray(operations) || operations.length > 16 || operations.some(operation => !/^[A-Z_]{1,40}$/.test(operation))) return;
        entry.steps = operations.map(operation => ({ operation, state: 'pending' })); activityChanged();
      },
      step(entryId, operation) {
        const entry = state.activity.find(item => item.id === entryId);
        if (!entry || entry.state !== 'working' || !/^[A-Z_]{1,40}$/.test(operation)) return null;
        const pending = entry.steps.findIndex(step => step.operation === operation && step.state === 'pending');
        if (pending >= 0) { entry.steps[pending].state = 'working'; activityChanged(); return pending; }
        if (entry.steps.length >= 16) return null;
        entry.steps.push({ operation, state: 'working' }); activityChanged(); return entry.steps.length - 1;
      },
      receipt(entryId, index, outcome, details) {
        const entry = state.activity.find(item => item.id === entryId), step = entry?.steps[index];
        if (!entry || entry.state !== 'working' || !step || step.state !== 'working') return;
        // A cancelled dispatch may already have affected the external app.
        step.state = outcome === 'cancelled' ? 'uncertain' : ['completed', 'unverified', 'uncertain'].includes(outcome) ? outcome : 'failed';
        if (typeof details === 'string') step.details = details.slice(0, 600);
        activityChanged();
      },
      finish(entryId, status) {
        const entry = state.activity.find(item => item.id === entryId);
        if (!entry || !['working', 'awaiting-input'].includes(entry.state) || !STATES.has(status)) return;
        entry.state = status === 'completed' ? completedState(entry.steps) : status;
        for (const step of entry.steps) {
          if (step.state === 'working') step.state = 'uncertain';
          else if (step.state === 'pending') step.state = 'skipped';
        }
        activityChanged();
      },
      clearActivity(entryId) { edit(data => { data.activity = entryId ? data.activity.filter(item => item.id !== entryId) : []; }); },
      timing(phase, ms, outcome = 'ok') {
        if (!state.diagnostics || !TIMING_PHASES.includes(phase) || !Number.isFinite(ms)) return;
        state.timings = [...state.timings, { phase, ms: Math.max(0, Math.min(3600000, ms)), outcome: ['ok', 'error', 'cancelled'].includes(outcome) ? outcome : 'error' }].slice(-200); save();
      },
      clearTimings() { edit(data => { data.timings = []; }); }
    };
  }
  // Presentation only: the reviewed command remains the authoritative dispatch
  // value. Preserve its arguments and never turn these labels back into actions.
  function formatCommand(command) {
    const match = /^\[([A-Z_]+)(?::\s*([^\[\]\r\n]+))?\]$/.exec(String(command));
    if (!match) return 'Unavailable command';
    const operation = match[1], argument = (match[2] || '').trim();
    const quoted = value => `“${value}”`;
    const names = {
      OPEN_APP: 'Open app', CLOSE_APP: 'Request app close', CANCEL_TIMER: 'Cancel timer',
      REMOVE_TASK: 'Remove task', COMPLETE_TASK: 'Complete task', UNCOMPLETE_TASK: 'Reopen task',
      SPOTIFY_SONG: 'Play Spotify song', SPOTIFY_ALBUM: 'Play Spotify album',
      SPOTIFY_PLAYLIST: 'Play public Spotify playlist', SPOTIFY_LIBRARY: 'Play private Spotify playlist', SPOTIFY_ARTIST: 'Play Spotify artist',
      SPOTIFY_LIKED: 'Play your Spotify Liked Songs', SPOTIFY_RELOAD: 'Restart Spotify and resume playback',
      MEDIA_PLAY_PAUSE: 'Toggle play / pause', MEDIA_PLAY: 'Resume playback', MEDIA_PAUSE: 'Pause playback',
      MEDIA_STATUS: 'Check current playback', MEDIA_NEXT: 'Skip to next track', MEDIA_PREV: 'Go to previous track',
      VOLUME_UP: 'Turn system volume up', VOLUME_DOWN: 'Turn system volume down', VOLUME_STATUS: 'Check system volume',
      VOLUME_MUTE: 'Toggle system mute', VOLUME_MUTE_ON: 'Mute system audio', VOLUME_MUTE_OFF: 'Unmute system audio',
      MUTE_MIC: 'Mute microphone', UNMUTE_MIC: 'Unmute microphone', MUTE_TTS: 'Mute Olanga’s voice', UNMUTE_TTS: 'Unmute Olanga’s voice',
      CLEAR_ALL_TIMERS: 'Clear all timers', TIMER_STATUS: 'Check timers', CLEAR_ALL_TASKS: 'Clear all checklist tasks', TASK_STATUS: 'Check checklist',
      TIME_STATUS: 'Say the time', DATE_STATUS: 'Say the date', HELP: 'Describe what Olanga can do', DISMISS: 'Dismiss the request',
      STOP_TIMER: 'Stop the ringing alarm or timer', REMEMBER: 'Remember', FORGET: 'Forget a memory', MEMORY_STATUS: 'List memories',
      CLEAR_MEMORIES: 'Delete all memories', DAILY_BRIEFING: 'Daily briefing'
    };
    if (operation === 'VOLUME_SET') return `Set system volume to ${argument}%`;
    const pair = /^([^,]+),\s*(.+)$/.exec(argument);
    const units = value => {
      let seconds = Number(value);
      const parts = [];
      for (const [size, label] of [[3600, 'hour'], [60, 'minute'], [1, 'second']]) {
        const amount = Math.floor(seconds / size); seconds %= size;
        if (amount) parts.push(`${amount} ${label}${amount === 1 ? '' : 's'}`);
      }
      return parts.join(' ') || '0 seconds';
    };
    if (operation === 'SET_TIMER' && pair && /^\d+$/.test(pair[1])) return `Start timer: ${units(pair[1])} · ${quoted(pair[2].trim())}`;
    if (operation === 'SET_REMINDER' && pair && /^\d+$/.test(pair[1])) return `Reminder in ${units(pair[1])}: ${quoted(pair[2].trim())}`;
    if (operation === 'SET_ALARM' && pair) return `${['alarm', 'wake up'].includes(pair[2].trim().toLowerCase()) ? 'Alarm' : 'Reminder'} at ${pair[1].trim()}: ${quoted(pair[2].trim())}`;
    if (operation === 'ARRANGE_APP' && pair) {
      const app = quoted(pair[1].trim()), layout = pair[2].trim().toLowerCase();
      if (layout === 'maximize') return `Maximize ${app}`;
      if (['left', 'right'].includes(layout)) return `Move ${app} to the ${layout} half`;
    }
    if (operation === 'SET_TASK_DUE' && pair) return `Set due date for ${quoted(pair[1].trim())} to ${quoted(pair[2].trim())}`;
    if (operation === 'ADD_TASK') return pair ? `Add task: ${quoted(pair[1].trim())} · due ${quoted(pair[2].trim())}` : `Add task: ${quoted(argument)}`;
    const label = names[operation] || operation.replaceAll('_', ' ').toLowerCase().replace(/^./, character => character.toUpperCase());
    return argument ? `${label}: ${quoted(argument)}` : label;
  }
  function statistics(timings) {
    return [...new Set(timings.map(item => item.phase))].map(phase => {
      const samples = timings.filter(item => item.phase === phase), values = samples.map(item => item.ms).sort((a, b) => a - b);
      return { phase, count: samples.length, median: values[Math.floor((values.length - 1) / 2)], p95: values[Math.ceil(values.length * .95) - 1], failures: samples.filter(item => item.outcome !== 'ok').length };
    });
  }
  const running = new WeakMap();
  async function executeRun(store, runId, indices, { signal, dispatch, validate = () => {} }) {
    const run = store.snapshot().runs.find(item => item.id === runId);
    if (!run || !Array.isArray(indices) || !indices.length || new Set(indices).size !== indices.length || indices.some(index => !Number.isInteger(index) || !run.steps[index] || ['completed', 'skipped', 'working'].includes(run.steps[index].state))) throw new Error('Review the unfinished steps before running them.');
    const active = running.get(store) || new Set(); running.set(store, active);
    if (active.size) throw new Error('A routine is already running. Cancel it before starting another.');
    const selected = [...indices].sort((a, b) => a - b);
    for (const index of selected) validate(run.steps[index].command);
    active.add(runId);
    let state = 'completed'; const messages = [];
    const assertActive = () => { if (signal?.aborted) throw Object.assign(new Error('Routine cancelled.'), { name: 'AbortError' }); };
    try {
      for (const index of selected) {
        assertActive();
        store.transitionRun(run.id, index, 'working');
        const result = await dispatch(run.steps[index].command);
        assertActive();
        const ok = Array.isArray(result?.results) && result.results.length > 0 && result.results.every(receipt => receipt.ok === true);
        const verified = ok && result.results.every(receipt => receipt.verified !== false);
        const uncertain = !ok && Array.isArray(result?.results) && result.results.some(receipt => receipt.dispatched === true || receipt.pending === true);
        store.transitionRun(run.id, index, ok ? verified ? 'completed' : 'unverified' : uncertain ? 'uncertain' : 'failed');
        messages.push(result?.spokenResponse || 'The step returned no confirmed result.');
        if (!ok) { state = 'failed'; messages.push('The remaining steps did not run. Review them in Workspace.'); break; }
      }
    } catch (error) {
      state = signal?.aborted || error.name === 'AbortError' ? 'cancelled' : 'failed';
      if (state !== 'cancelled') messages.push(`The routine stopped. ${error.message}`);
    } finally {
      try { state = store.finishRun(run.id, state) || 'failed'; } catch (error) { state = 'failed'; messages.push(error.message); }
      active.delete(runId);
    }
    return { state, messages };
  }
  return { createStore, sanitize, defaults, validatePersonalBackup, statistics, formatCommand, executeRun, isRunning: store => !!running.get(store)?.size, KEY, MAX_FACTS, LEARNING_UNDO_TTL_MS };
});
