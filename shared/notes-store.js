/* Bounded local note history. Unreadable records are preserved until reviewed. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaNotes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const KEY = 'olangaNotepadTabs', HISTORY_KEY = 'olanga_notes_history_v1', RECOVERY_KEY = 'olanga_notes_recovery_v1';
  const LIMITS = Object.freeze({ notes: 100, content: 1000000, total: 2000000, versions: 80, perNote: 15, trash: 30, historyBytes: 500000 });
  const clone = value => JSON.parse(JSON.stringify(value));
  const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  function normalizeNotes(input, sanitize = value => value, { portable = true } = {}) {
    if (!Array.isArray(input) || !input.length || portable && input.length > LIMITS.notes) throw new Error('Notes must contain 1–100 tabs.');
    const ids = new Set(); let length = 0;
    return input.map((note, index) => {
      if (!plain(note) || Object.keys(note).some(key => !['id', 'name', 'content'].includes(key)) || typeof note.name !== 'string' || !note.name.trim() || portable && note.name.length > 200 || /[\x00-\x1f]/.test(note.name) || typeof note.content !== 'string' || portable && note.content.length > LIMITS.content) throw new Error('A note is invalid or too large.');
      if (!Number.isSafeInteger(note.id) || note.id < 0) throw new Error('A note ID is invalid.');
      const id = note.id;
      if (ids.has(id)) throw new Error('Notes contain duplicate IDs.'); ids.add(id);
      const content = sanitize(note.content); length += content.length;
      if (typeof content !== 'string' || portable && length > LIMITS.total) throw new Error('Notes exceed the two-million-character text limit.');
      return { id, name: note.name.trim(), content };
    });
  }
  function nextId(records) {
    const ids = new Set(records.map(note => note.id)); const maximum = Math.max(-1, ...ids);
    let candidate = maximum < Number.MAX_SAFE_INTEGER ? maximum + 1 : 0;
    while (ids.has(candidate)) candidate++;
    if (!Number.isSafeInteger(candidate)) throw new Error('A new note ID could not be assigned.');
    return candidate;
  }
  function createStore(storage, { now = Date.now, sanitize = value => value, id = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` } = {}) {
    let notes = [{ id: 0, name: 'Note 1', content: '' }], history = { version: 1, versions: [], trash: [] }, blocked = '', rawNotes = null, rawHistory = null;
    function load() {
      blocked = ''; notes = [{ id: 0, name: 'Note 1', content: '' }]; history = { version: 1, versions: [], trash: [] };
      try {
        rawNotes = storage.getItem(KEY); rawHistory = storage.getItem(HISTORY_KEY);
        if (rawNotes !== null) { const savedNotes = JSON.parse(rawNotes); notes = Array.isArray(savedNotes) && savedNotes.length === 0 ? notes : normalizeNotes(savedNotes, sanitize, { portable: false }); }
        if (rawHistory !== null) {
          const saved = JSON.parse(rawHistory);
          if (!plain(saved) || saved.version !== 1 || !Array.isArray(saved.versions) || !Array.isArray(saved.trash) || saved.versions.length > LIMITS.versions || saved.trash.length > LIMITS.trash) throw new Error('The note history is unreadable.');
          const seen = new Set();
          for (const list of ['versions', 'trash']) history[list] = saved[list].map(item => {
            if (!plain(item) || typeof item.key !== 'string' || !item.key || seen.has(item.key) || !Number.isSafeInteger(item.at) || item.at < 0) throw new Error('The note history is invalid.');
            seen.add(item.key); const [note] = normalizeNotes([item.note], sanitize, { portable: false });
            return { key: item.key, at: item.at, note };
          });
        }
      } catch (error) { blocked = error.message || 'Saved notes could not be read.'; }
      return !blocked;
    }
    load();
    function set(key, value) { if (value === null) storage.removeItem(key); else storage.setItem(key, value); if (storage.getItem(key) !== value) throw new Error('The saved note data could not be verified.'); }
    function commit(nextNotes, nextHistory) {
      if (blocked) throw new Error('Saved notes need recovery. Download the original before starting new notes.');
      const previousNotes = storage.getItem(KEY), previousHistory = storage.getItem(HISTORY_KEY);
      if (previousNotes !== rawNotes || previousHistory !== rawHistory) throw new Error('Notes changed elsewhere. Reopen Olanga before saving more changes.');
      const encoded = JSON.stringify(nextNotes), encodedHistory = JSON.stringify(nextHistory);
      try {
        // Save prior versions before replacing note content. One failed write
        // rolls both records back; the in-memory committed state stays intact.
        if (encodedHistory !== previousHistory) set(HISTORY_KEY, encodedHistory);
        set(KEY, encoded);
      } catch (error) {
        try { if (storage.getItem(KEY) !== previousNotes) set(KEY, previousNotes); if (storage.getItem(HISTORY_KEY) !== previousHistory) set(HISTORY_KEY, previousHistory); }
        catch (_) { blocked = 'A note write was interrupted and could not be rolled back. Keep this window open and export your note.'; }
        throw error;
      }
      notes = clone(nextNotes); history = clone(nextHistory); rawNotes = encoded; rawHistory = encodedHistory;
      return clone(notes);
    }
    function trim(next) {
      const counts = new Map();
      next.versions = next.versions.slice().reverse().filter(item => { const count = (counts.get(item.note.id) || 0) + 1; counts.set(item.note.id, count); return count <= LIMITS.perNote; }).reverse().slice(-LIMITS.versions);
      next.trash = next.trash.slice(-LIMITS.trash);
      while (JSON.stringify(next).length > LIMITS.historyBytes && (next.versions.length || next.trash.length)) {
        if (!next.trash.length || next.versions.length && next.versions[0].at <= next.trash[0].at) next.versions.shift(); else next.trash.shift();
      }
      return next;
    }
    function archive(next, list, note) {
      const previous = next[list].filter(item => item.note.id === note.id).at(-1);
      if (previous && previous.note.name === note.name && previous.note.content === note.content) return;
      next[list].push({ key: id(), at: now(), note: clone(note) });
    }
    return {
      snapshot: () => ({ notes: clone(notes), history: clone(history), blocked: !!blocked, message: blocked }),
      reload: load,
      save(input, { forceVersion = false } = {}) {
        const nextNotes = normalizeNotes(input, sanitize, { portable: false }), next = clone(history);
        for (const old of notes) {
          const current = nextNotes.find(note => note.id === old.id);
          if (!current) archive(next, 'trash', old);
          else if (current.name !== old.name || current.content !== old.content) {
            const latest = next.versions.filter(item => item.note.id === old.id).at(-1);
            if (forceVersion || !latest || now() - latest.at >= 30000 || !current.content || old.name !== current.name) archive(next, 'versions', old);
          }
        }
        return commit(nextNotes, trim(next));
      },
      restoreVersion(key) {
        const record = history.versions.find(item => item.key === key); if (!record) throw new Error('This note version is no longer available.');
        const next = clone(notes), index = next.findIndex(note => note.id === record.note.id);
        if (index < 0) throw new Error('This note was deleted. Restore it from Deleted notes first.');
        const nextHistory = clone(history); archive(nextHistory, 'versions', next[index]); next[index] = clone(record.note);
        return commit(next, trim(nextHistory));
      },
      restoreDeleted(key) {
        const record = history.trash.find(item => item.key === key); if (!record) throw new Error('This deleted note is no longer available.');
        if (notes.length >= LIMITS.notes) throw new Error('Remove a note before restoring another.');
        const next = clone(notes), restored = clone(record.note); restored.id = nextId([...next, ...history.versions.map(item => item.note), ...history.trash.map(item => item.note)]); next.push(restored);
        const nextHistory = clone(history); nextHistory.trash = nextHistory.trash.filter(item => item.key !== key); return commit(next, nextHistory);
      },
      deleteRetained(list, key) {
        if (!['versions', 'trash'].includes(list)) throw new Error('Invalid retained note collection.');
        const next = clone(history); next[list] = next[list].filter(item => item.key !== key); return commit(notes, next);
      },
      originalText() {
        return JSON.stringify({ format: 'olanga-notes-recovery', version: 1, createdAt: now(), records: { [KEY]: storage.getItem(KEY), [HISTORY_KEY]: storage.getItem(HISTORY_KEY) } }, null, 2);
      },
      retainedRecovery() { const raw = storage.getItem(RECOVERY_KEY); return raw === null ? null : raw; },
      deleteRecovery() { set(RECOVERY_KEY, null); },
      resetAfterRecovery() {
        if (!blocked) throw new Error('Notes do not need a recovery reset.');
        // Original bytes survive reset, independently of the readable notes.
        const copy = this.originalText(), retained = storage.getItem(RECOVERY_KEY);
        if (retained !== null && retained !== copy) throw new Error('Download or delete the retained recovery copy before preserving another original.');
        set(RECOVERY_KEY, copy);
        const beforeNotes = storage.getItem(KEY), beforeHistory = storage.getItem(HISTORY_KEY);
        try { set(KEY, JSON.stringify([{ id: 0, name: 'Note 1', content: '' }])); set(HISTORY_KEY, JSON.stringify({ version: 1, versions: [], trash: [] })); }
        catch (error) { try { if (storage.getItem(KEY) !== beforeNotes) set(KEY, beforeNotes); if (storage.getItem(HISTORY_KEY) !== beforeHistory) set(HISTORY_KEY, beforeHistory); } catch (_) {} throw error; }
        load(); return clone(notes);
      }
    };
  }
  return { KEY, HISTORY_KEY, RECOVERY_KEY, LIMITS, normalizeNotes, nextId, createStore };
});
