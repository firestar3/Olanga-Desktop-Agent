const test = require('node:test');
const assert = require('node:assert/strict');
const Notes = require('../../shared/notes-store');
const makeStorage = (seed = {}) => { const map = new Map(Object.entries(seed)); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), map }; };
const note = (content, id = 0) => ({ id, name: 'Project notes', content });

test('malformed notes remain byte-for-byte untouched and cannot be overwritten by normal edits', () => {
  const original = '{not json'; const storage = makeStorage({ [Notes.KEY]: original }), store = Notes.createStore(storage);
  assert.equal(store.snapshot().blocked, true); assert.throws(() => store.save([note('new')]), /recovery/); assert.equal(storage.getItem(Notes.KEY), original);
  assert.equal(JSON.parse(store.originalText()).records[Notes.KEY], original);
  store.resetAfterRecovery(); assert.equal(store.snapshot().blocked, false); assert.equal(JSON.parse(store.retainedRecovery()).records[Notes.KEY], original);
});

test('unreadable history blocks edits without destroying otherwise readable notes', () => {
  const raw = JSON.stringify([note('keep me')]); const storage = makeStorage({ [Notes.KEY]: raw, [Notes.HISTORY_KEY]: '{bad' }), store = Notes.createStore(storage);
  assert.equal(store.snapshot().notes[0].content, 'keep me'); assert.equal(store.snapshot().blocked, true);
  assert.throws(() => store.save([note('replacement')]), /recovery/); assert.equal(storage.getItem(Notes.KEY), raw);
});

test('typing checkpoints are bounded and restoring an old version keeps the current content as another version', () => {
  let clock = 1000, sequence = 0; const storage = makeStorage({ [Notes.KEY]: JSON.stringify([note('original')]) });
  const store = Notes.createStore(storage, { now: () => clock, id: () => String(++sequence) });
  store.save([note('first')]); store.save([note('second')]); assert.equal(store.snapshot().history.versions.length, 1);
  clock += 31000; store.save([note('third')]); assert.equal(store.snapshot().history.versions.length, 2);
  store.restoreVersion('1'); assert.equal(store.snapshot().notes[0].content, 'original'); assert.ok(store.snapshot().history.versions.some(item => item.note.content === 'third'));
  for (let i = 0; i < 40; i++) { clock += 31000; store.save([note('revision-' + i)], { forceVersion: true }); }
  assert.equal(store.snapshot().history.versions.length, Notes.LIMITS.perNote);
});

test('deleted tabs enter trash and restoring one preserves current tabs and assigns a unique ID', () => {
  const storage = makeStorage({ [Notes.KEY]: JSON.stringify([note('alpha', 0), note('beta', 1)]) });
  const store = Notes.createStore(storage); store.save([note('alpha', 0)]);
  const deleted = store.snapshot().history.trash[0]; assert.equal(deleted.note.content, 'beta');
  store.restoreDeleted(deleted.key); const state = store.snapshot(); assert.equal(state.notes.length, 2); assert.equal(new Set(state.notes.map(item => item.id)).size, 2); assert.equal(state.history.trash.length, 0);
});

test('a failed primary write rolls history back and leaves the last committed notes in memory', () => {
  const raw = JSON.stringify([note('original')]), storage = makeStorage({ [Notes.KEY]: raw }); const set = storage.setItem;
  let fail = true; storage.setItem = (key, value) => { if (key === Notes.KEY && fail) { fail = false; throw Error('disk full'); } return set(key, value); };
  const store = Notes.createStore(storage); assert.throws(() => store.save([note('new')]), /disk full/);
  assert.equal(storage.getItem(Notes.KEY), raw); assert.equal(storage.getItem(Notes.HISTORY_KEY), null); assert.equal(store.snapshot().notes[0].content, 'original');
});

test('the original recovery copy must be saved and verified before a reset can replace anything', () => {
  const storage = makeStorage({ [Notes.KEY]: '{damaged' }), set = storage.setItem;
  storage.setItem = (key, value) => { if (key !== Notes.RECOVERY_KEY) set(key, value); };
  const store = Notes.createStore(storage); assert.throws(() => store.resetAfterRecovery(), /verified/); assert.equal(storage.getItem(Notes.KEY), '{damaged');
});

test('a concurrent raw-record change is rejected instead of silently replacing another write', () => {
  const storage = makeStorage({ [Notes.KEY]: JSON.stringify([note('one')]) }), store = Notes.createStore(storage);
  storage.setItem(Notes.KEY, JSON.stringify([note('external')])); assert.throws(() => store.save([note('local')]), /changed elsewhere/); assert.equal(JSON.parse(storage.getItem(Notes.KEY))[0].content, 'external');
});

test('legacy sparse numeric IDs remain stable across reload and active HTML is sanitized by the caller', () => {
  const storage = makeStorage({ [Notes.KEY]: JSON.stringify([note('<script>bad</script>safe', 50)]) });
  const store = Notes.createStore(storage, { sanitize: value => value.replace(/<script>.*?<\/script>/g, '') });
  assert.deepEqual(store.snapshot().notes, [note('safe', 50)]); store.save([note('next', 50)]); store.reload(); assert.equal(store.snapshot().notes[0].id, 50);
});
module.exports = { makeStorage };

test('maximum safe imported IDs cannot prevent creating or recovering another note', () => {
  const storage = makeStorage({ [Notes.KEY]: JSON.stringify([note('large ID', Number.MAX_SAFE_INTEGER), note('delete me', 2)]) });
  const store = Notes.createStore(storage); store.save([note('large ID', Number.MAX_SAFE_INTEGER)]); const state = store.snapshot();
  const available = Notes.nextId([...state.notes, ...state.history.trash.map(item => item.note)]); assert.equal(available, 0);
  store.restoreDeleted(state.history.trash[0].key); assert.equal(store.snapshot().notes.length, 2); assert.equal(new Set(store.snapshot().notes.map(item => item.id)).size, 2);
});

test('a continuously failing primary write does not falsely require recovery when original notes never changed', () => {
  const storage = makeStorage({ [Notes.KEY]: JSON.stringify([note('original')]) }), set = storage.setItem;
  storage.setItem = (key, value) => { if (key === Notes.KEY) throw Error('unavailable'); set(key, value); };
  const store = Notes.createStore(storage); assert.throws(() => store.save([note('new')]), /unavailable/); assert.equal(store.snapshot().blocked, false); assert.equal(store.snapshot().notes[0].content, 'original');
  storage.setItem = set; store.save([note('retry')]); assert.equal(store.snapshot().notes[0].content, 'retry');
});
