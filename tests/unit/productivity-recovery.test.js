const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, KEY } = require('../../shared/productivity');
const { parse } = require('../../shared/fast-intents');
function fixture(raw) {
  const data = new Map(raw === undefined ? [] : [[KEY, raw]]), writes = [];
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { writes.push(key); data.set(key, value); }, removeItem: key => data.delete(key), key: index => [...data.keys()][index] ?? null, get length() { return data.size; } };
  return { data, writes, storage, store: createStore(storage) };
}
function exerciseSession(store) {
  const id = store.begin(); store.plan(id, ['VOLUME_SET']); const step = store.step(id, 'VOLUME_SET');
  store.receipt(id, step, 'completed', 'Fixture result'); store.finish(id, 'completed');
  assert.equal(store.snapshot().activity.at(-1).state, 'completed');
}
function populated() {
  const f = fixture(); f.store.rememberFact('I prefer concise answers'); f.store.remember('aliases', 'work browser', 'Chrome');
  f.store.remember('playlists', 'quiet music', 'Quiet Coding'); f.store.saveRoutine({ name: 'Focus', lines: ['Set a timer for 25 minutes called Focus'] }, parse); return f;
}
for (const [name, raw, reason] of [['invalid JSON', '{broken', 'malformed'], ['future version', JSON.stringify({version: 2, facts: [{text:'future data'}]}), 'unsupported-version'], ['wrong root shape', '[]', 'malformed'], ['partially invalid collection', JSON.stringify({version:1,facts:[{id:'good',text:'keep this fact',at:1},null]}), 'malformed']]) {
  test(name + ' survives normal commands, failed edits and restart byte-for-byte', () => {
    const f = fixture(raw); assert.equal(f.store.recoveryStatus().reason, reason);
    exerciseSession(f.store); assert.throws(() => f.store.rememberFact('New fact'), /needs recovery/);
    assert.throws(() => f.store.preference('factsEnabled', false), /needs recovery/);
    assert.throws(() => f.store.exportPersonal(), /needs recovery/);
    assert.equal(f.data.get(KEY), raw); assert.deepEqual(f.writes, []);
    exerciseSession(createStore(f.storage)); assert.equal(f.data.get(KEY), raw);
  });
}
test('a temporary read failure cannot overwrite the unread record and retry loads original state', () => {
  const f = populated(), raw = f.data.get(KEY), get = f.storage.getItem;
  let failing = true; f.storage.getItem = key => { if (key === KEY && failing) throw Error('unavailable'); return get(key); };
  const store = createStore(f.storage); assert.equal(store.recoveryStatus().reason, 'read-failed');
  exerciseSession(store); assert.throws(() => store.createRecoveryBackup(), /cannot be read/); assert.equal(f.data.get(KEY), raw);
  failing = false; assert.equal(store.retryRecovery(), true); assert.equal(store.snapshot().facts[0].text, 'I prefer concise answers');
  store.rememberFact('Storage is available'); assert.equal(createStore(f.storage).snapshot().facts.length, 2);
});
test('supported records with different object key order are not incorrectly blocked', () => {
  const store = fixture(JSON.stringify({version:1,facts:[{text:'same fact',at:1,id:'a'}]})).store;
  assert.equal(store.recoveryStatus().blocked, false); store.rememberFact('another fact');
});
test('reset requires an exact verified recovery copy and preserves it across restart', () => {
  const f = fixture('{original'); assert.throws(() => f.store.resetAfterBackup('anything'), /recovery copy/);
  const {key} = f.store.createRecoveryBackup(); const backup = JSON.parse(f.data.get(key));
  assert.equal(backup.raw, '{original'); assert.equal(backup.sourceKey, KEY); assert.equal(f.data.get(KEY), '{original');
  assert.equal(f.store.resetAfterBackup(key), true); assert.equal(f.store.recoveryStatus().blocked, false);
  assert.equal(JSON.parse(f.store.recoveryBackupText(key)).raw, '{original');
  const reopened = createStore(f.storage); assert.equal(reopened.listRecoveryCopies()[0].key, key); assert.equal(JSON.parse(reopened.recoveryBackupText(key)).raw, '{original');
  reopened.rememberFact('New valid fact'); assert.equal(JSON.parse(f.data.get(key)).raw, '{original');
});
test('failed backup write, failed verification and changed originals prevent reset', () => {
  for (const mode of ['write', 'verify', 'changed']) {
    const f = fixture('{original'), set = f.storage.setItem;
    if (mode === 'write') f.storage.setItem = () => { throw Error('full'); };
    if (mode === 'verify') f.storage.setItem = (key,value) => set(key, key === KEY ? value : 'bad copy');
    if (mode !== 'changed') { assert.throws(() => f.store.createRecoveryBackup(), /could not be saved/); assert.equal(f.store.recoveryStatus().backupKey, null); }
    else { const {key} = f.store.createRecoveryBackup(); f.data.set(KEY, '{new original'); assert.throws(() => f.store.resetAfterBackup(key), /changed/); }
    assert.equal(f.data.get(KEY), mode === 'changed' ? '{new original' : '{original');
  }
});
test('failed reset save leaves original record and recovery guard intact', () => {
  const f = fixture('{original'), {key} = f.store.createRecoveryBackup(); f.storage.setItem = () => { throw Error('full'); };
  assert.throws(() => f.store.resetAfterBackup(key), /could not save/); assert.equal(f.store.recoveryStatus().blocked, true); assert.equal(f.data.get(KEY), '{original');
});
test('personal export round-trips only reviewed content and never runs a routine', () => {
  const f = populated(); f.store.preference('saveActivity', true); exerciseSession(f.store);
  const backup = f.store.exportPersonal(); assert.deepEqual(Object.keys(backup.content), ['facts','aliases','playlists','routines']);
  assert.equal(/Fixture result|activity|timings|apiKey/.test(JSON.stringify(backup)), false);
  const target = fixture(); target.store.preference('factsEnabled', false); const before = target.data.get(KEY), writes = target.writes.length;
  const preview = target.store.previewImport(JSON.stringify(backup), parse); assert.equal(target.writes.length, writes); assert.equal(target.data.get(KEY), before);
  preview.content.facts[0].text = 'Mutated public preview';
  const result = target.store.importPersonal(preview.token, parse); assert.equal(target.store.snapshot().factsEnabled, false);
  assert.deepEqual(target.store.exportPersonal().content, backup.content); assert.equal(target.store.snapshot().runs.length, 0); assert.equal(target.store.snapshot().activity.length, 0);
  assert.equal(JSON.parse(target.data.get(result.backupKey)).raw, before);
  assert.deepEqual(createStore(target.storage).exportPersonal().content, backup.content);
});
test('malformed, excessive, unknown and executable backup content is rejected without writes', () => {
  const good = populated().store.exportPersonal(), cases = [];
  function invalid(edit) { const payload = structuredClone(good); edit(payload); cases.push(JSON.stringify(payload)); }
  invalid(p => p.version = 2); invalid(p => p.apiKey = 'not allowed'); invalid(p => p.content.timings = []);
  invalid(p => p.content.facts.push({...p.content.facts[0]})); invalid(p => p.content.facts[0].at = -1); invalid(p => p.content.facts[0].extra = true);
  invalid(p => p.content.aliases.push({...p.content.aliases[0],alias:'WORK BROWSER'})); invalid(p => p.content.aliases[0].target = 'nonexistent unsafe app');
  invalid(p => p.content.routines[0].lines = ['Set a timer for 5 minutes and delete all my files']);
  invalid(p => p.content.routines[0].lines = ['[SHELL: unsafe]']); invalid(p => p.content.routines.push({...p.content.routines[0]}));
  invalid(p => p.content.facts = Array.from({length:51},(_,i)=>({id:'a'+i,text:'fact '+i,at:i})));
  for (const text of ['{broken', 'x'.repeat(1024*1024+1), ...cases]) {
    const f=populated(), before=f.data.get(KEY), count=f.writes.length;
    assert.throws(()=>f.store.previewImport(text,parse)); assert.equal(f.data.get(KEY),before); assert.equal(f.writes.length,count);
  }
});
test('a stale preview or failed safety copy cannot replace current personal content', () => {
  const backup = populated().store.exportPersonal(), f = fixture(); const preview = f.store.previewImport(JSON.stringify(backup),parse);
  f.store.rememberFact('A newer fact'); const current=f.data.get(KEY); assert.throws(()=>f.store.importPersonal(preview.token,parse),/changed after preview/); assert.equal(f.data.get(KEY),current);
  const second=f.store.previewImport(JSON.stringify(backup),parse); f.storage.setItem=()=>{throw Error('full');};
  assert.throws(()=>f.store.importPersonal(second.token,parse),/recovery copy/); assert.equal(f.data.get(KEY),current);
});
test('memory events contain only identities and happen only after committed changes', () => {
  const f=fixture(), events=[]; f.store.subscribeMemory(event=>events.push(event)); const fact=f.store.rememberFact('A private fixture detail');
  f.store.rememberFact('A private fixture detail'); assert.equal(events.length,1); assert.equal(events[0].reason,'added'); assert.deepEqual(events[0].addedIds,[fact.id]);
  f.store.preference('factsEnabled',false); assert.equal(events.at(-1).reason,'disabled'); assert.equal(events.at(-1).enabled,false);
  const set=f.storage.setItem; f.storage.setItem=()=>{throw Error('full');}; const count=events.length;
  assert.throws(()=>f.store.deleteFact(fact.id),/could not save/); assert.equal(events.length,count); f.storage.setItem=set;
  f.store.deleteFact(fact.id); assert.equal(events.at(-1).reason,'deleted'); assert.deepEqual(events.at(-1).removedIds,[fact.id]); assert.equal(JSON.stringify(events).includes('private fixture'),false);
});
test('retained valid recovery copies support reviewed personal restore and explicit deletion only', () => {
  const f=populated(), expected=f.store.exportPersonal().content, {key}=f.store.createRecoveryBackup();
  f.store.clearFacts(); const recovered=f.store.exportRecoveryPersonal(key,parse); assert.deepEqual(recovered.content,expected);
  const preview=f.store.previewImport(JSON.stringify(recovered),parse); f.store.importPersonal(preview.token,parse); assert.deepEqual(f.store.exportPersonal().content,expected);
  f.store.deleteRecoveryCopy(key); assert.equal(f.data.has(key),false); assert.deepEqual(f.store.exportPersonal().content,expected);
});
