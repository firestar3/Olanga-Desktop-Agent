const test = require('node:test');
const assert = require('node:assert/strict');
const Backup = require('../../shared/personal-backup');
const Intents = require('../../shared/fast-intents');
const emptyWorkspace = { format: 'olanga-workspace-backup', version: 1, createdAt: 1, content: { facts: [], aliases: [], playlists: [], routines: [] } };
const prefs = { appearanceAccent: 'blue', appearanceMotion: 'reduced', appearanceContrast: 'strong', appearanceGlow: 'off', responseStyle: 'concise', preferredAddress: '', ttsRate: 1.05, endOfSpeech: 'standard', bargeIn: true, streamReplies: true, features: ['notepadScreen'] };
const values = () => ({ notes: [{ id: 2, name: 'Important', content: '<b>keep</b>' }], checklist: [{ id: 't1', text: 'review', completed: false, dueDate: null }], timers: [{ label: 'Focus', kind: 'timer', remainingMs: 25000 }], schedules: [{ kind: 'reminder', title: 'Review', repeat: 'daily', time: '09:00', online: false }], preferences: { ...prefs }, workspace: structuredClone(emptyWorkspace) });
function storage() { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; }
const options = { parse: Intents.parse };

test('a complete portable backup validates all six independent collections', () => {
  const backup = Backup.create(values(), options); assert.deepEqual(Object.keys(backup.collections), Backup.COLLECTIONS); assert.equal(backup.collections.schedules[0].online, false);
  assert.deepEqual(Backup.validate(JSON.stringify(backup), options), backup);
});

test('credentials, local device data, unknown versions and unknown collection fields are rejected', () => {
  for (const mutate of [value => value.collections.apiKeys = ['secret'], value => value.collections.preferences.apiKey = 'secret', value => value.collections.schedules[0].enabled = true, value => value.version = 99, value => value.collections.notes[0].path = 'C:\\private', value => value.collections.timers[0].remainingMs = -1]) {
    const value = Backup.create(values(), options); mutate(value); assert.throws(() => Backup.validate(value, options));
  }
});

test('array limits, invalid schedule definitions and malformed JSON fail before mutation', () => {
  assert.throws(() => Backup.validate('{broken', options), /JSON/);
  assert.throws(() => Backup.create({ schedules: [{ kind: 'reminder', title: 'x', repeat: 'weekly', time: '99:00', days: [], online: false }] }, options));
  assert.throws(() => Backup.create({ checklist: Array.from({ length: 501 }, (_, i) => ({ id: String(i), text: 'x', completed: false, dueDate: null })) }, options), /limit/);
});

function fixture() {
  const saved = storage(), state = { notes: [{ id: 0, name: 'Original', content: 'old' }], checklist: [{ id: 'old', text: 'old task', completed: false, dueDate: null }] }, events = [];
  const adapters = Object.fromEntries(Object.keys(state).map(name => [name, { read: () => structuredClone(state[name]), write: value => { events.push(name); state[name] = structuredClone(value); }, portableRecovery: value => value }]));
  return { saved, state, adapters, events, restorer: Backup.createRestorer(saved, adapters, options) };
}

test('scope preview reports replacement counts and unchecked collections survive', async () => {
  const f = fixture(), preview = await f.restorer.preview(Backup.create({ notes: values().notes, checklist: [] }, options));
  assert.deepEqual(preview.collections.map(item => [item.name, item.current, item.incoming]), [['notes', 1, 1], ['checklist', 1, 0]]);
  await f.restorer.apply(preview.token, ['notes']); assert.equal(f.state.notes[0].name, 'Important'); assert.equal(f.state.checklist[0].id, 'old');
  const recovery = JSON.parse(f.restorer.recoveryText()); assert.equal(recovery.originals.notes[0].content, 'old'); assert.equal(recovery.status, 'completed');
});

test('a changed collection invalidates the preview without writing even a recovery copy', async () => {
  const f = fixture(), preview = await f.restorer.preview(Backup.create({ notes: values().notes }, options)); f.state.notes[0].content = 'newer';
  await assert.rejects(f.restorer.apply(preview.token, ['notes']), /changed after preview/); assert.deepEqual(f.events, []); assert.equal(f.restorer.recoveryText(), null);
});

test('failure to verify the original copy prevents every selected mutation', async () => {
  const f = fixture(); f.saved.setItem = () => {}; const preview = await f.restorer.preview(Backup.create({ notes: values().notes }, options));
  await assert.rejects(f.restorer.apply(preview.token, ['notes']), /verified/); assert.deepEqual(f.events, []); assert.equal(f.state.notes[0].content, 'old');
});

test('failure in a later selected collection restores all earlier selected data', async () => {
  const f = fixture(); let calls = 0; f.adapters.checklist.write = value => { if (++calls === 1) throw Error('disk full'); f.state.checklist = value; };
  const preview = await f.restorer.preview(Backup.create({ notes: values().notes, checklist: [] }, options));
  await assert.rejects(f.restorer.apply(preview.token, ['notes', 'checklist']), /rolled back/); assert.equal(f.state.notes[0].content, 'old'); assert.equal(f.state.checklist[0].text, 'old task'); assert.equal(JSON.parse(f.restorer.recoveryText()).status, 'rolled-back');
});

test('a rollback failure retains a truthful recovery copy and prevents a new unrelated restore', async () => {
  const f = fixture(); f.adapters.notes.rollback = () => { throw Error('still full'); }; f.adapters.checklist.write = () => { throw Error('full'); };
  const preview = await f.restorer.preview(Backup.create({ notes: values().notes, checklist: [] }, options));
  await assert.rejects(f.restorer.apply(preview.token, ['notes', 'checklist']), /needs recovery/); const saved = JSON.parse(f.restorer.recoveryText()); assert.equal(saved.status, 'needs-recovery'); assert.equal(saved.originals.notes[0].content, 'old');
  const next = await f.restorer.preview(Backup.create({ notes: values().notes }, options)); await assert.rejects(f.restorer.apply(next.token, ['notes']), /existing unfinished/);
});

test('recovery goes through a new validated preview and can restore the original selected collections', async () => {
  const f = fixture(), preview = await f.restorer.preview(Backup.create({ notes: values().notes }, options)); await f.restorer.apply(preview.token, ['notes']);
  const recovery = await f.restorer.previewRecovery(); assert.equal(recovery.collections[0].incoming, 1); await f.restorer.apply(recovery.token, ['notes']); assert.equal(f.state.notes[0].content, 'old');
});

test('concurrent restore calls cannot interleave during asynchronous durable writes', async () => {
  const f = fixture(); let release; f.adapters.notes.write = value => new Promise(resolve => { release = () => { f.state.notes = value; resolve(); }; });
  const preview = await f.restorer.preview(Backup.create({ notes: values().notes }, options)); const first = f.restorer.apply(preview.token, ['notes']);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.restorer.isBusy(), true); await assert.rejects(f.restorer.apply(preview.token, ['notes']), /review/); release(); await first; assert.equal(f.restorer.isBusy(), false);
});

test('delayed older previews cannot replace the token belonging to a newer selection', async () => {
  const f = fixture(); let release, calls = 0; const base = f.adapters.notes.read;
  f.adapters.notes.read = () => ++calls === 1 ? new Promise(resolve => { release = () => resolve(base()); }) : base();
  const older = f.restorer.preview(Backup.create({ notes: values().notes }, options));
  const latest = await f.restorer.preview(Backup.create({ notes: [{ id: 50, name: 'Latest', content: 'latest' }] }, options));
  release(); await assert.rejects(older, /newer backup/); await f.restorer.apply(latest.token, ['notes']); assert.equal(f.state.notes[0].name, 'Latest');
});

test('backup byte limits count Unicode encoding rather than accepting oversized multibyte files', () => {
  const content = '界'.repeat(999999); const collection = { notes: [{ id: 0, name: 'Unicode one', content }, { id: 1, name: 'Unicode two', content }] };
  assert.throws(() => Backup.create(collection, options), /4 MB/);
});
