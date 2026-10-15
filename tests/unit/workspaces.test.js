const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../../shared/workspaces');
function fixture(initial) {
  const memory = new Map(initial === undefined ? [] : [[W.KEY, typeof initial === 'string' ? initial : JSON.stringify(initial)]]); let count = 0, fail = false;
  const storage = { getItem: key => memory.get(key) ?? null, setItem(key, value) { if (fail) throw new Error('Disk full'); memory.set(key, value); } };
  const make = () => W.createStore(storage, { id: () => `id-${++count}`, now: () => 10 });
  return { memory, storage, make, store: make(), fail: value => { fail = value; } };
}
const refs = [{ kind: 'windows', id: 'layout', name: 'Coursework windows' }, { kind: 'project', id: 'project', name: 'Coursework' }, { kind: 'routine', id: 'routine', name: 'Focus' }];
test('workspace definitions store bounded references and never authority or source content', () => {
  const f = fixture(), saved = f.store.save('Coursework', refs);
  assert.deepEqual(saved.components, refs); assert.equal(f.store.snapshot().runs.length, 0);
  for (const component of [{ ...refs[0], windowHandle: '123' }, { ...refs[0], command: '[OPEN_APP: Spotify]' }, { ...refs[0], kind: 'shell' }]) assert.throws(() => f.store.save('Unsafe', [component]), /invalid/);
  assert.throws(() => f.store.save('Duplicate kind', [refs[0], refs[0]]), /invalid/);
  assert.throws(() => f.store.save('Empty', []), /at least one/);
});
test('names are case insensitive, bounded and never silently overwrite a setup', () => {
  const f = fixture(); f.store.save('Coursework', refs); const raw = f.memory.get(W.KEY);
  assert.throws(() => f.store.save('coursework', refs), /already exists/); assert.equal(f.memory.get(W.KEY), raw);
  assert.throws(() => f.store.save('x'.repeat(81), refs), /name/); assert.throws(() => f.store.save('Bad\nname', refs), /name/);
  for (let index = 1; index < W.LIMIT; index++) f.store.save(`Workspace ${index}`, refs);
  assert.throws(() => f.store.save('Overflow', refs), /20/);
});
test('damaged and future workspace storage stays intact and blocks persistent changes', () => {
  for (const initial of ['{broken', { version: 2, items: [], runs: [] }, { version: 1, items: [{ id: 'x', name: 'X', at: 1, components: [{ ...refs[0], authority: true }] }], runs: [] }]) {
    const f = fixture(initial), original = f.memory.get(W.KEY); assert.ok(f.store.snapshot().error);
    assert.throws(() => f.store.save('A', refs), /preserved/); assert.equal(f.memory.get(W.KEY), original);
  }
});
test('workspace creation and selection journal before dispatch and cannot repeat completed or skipped steps', async () => {
  const f = fixture(), item = f.store.save('Work', refs), run = f.store.createRun(item.id, ['windows', 'project']), dispatched = [];
  const outcome = await W.executeRun(f.store, run.id, ['windows', 'project'], { dispatch: async component => {
    const durable = JSON.parse(f.memory.get(W.KEY)).runs[0]; assert.equal(durable.steps.find(step => step.component.kind === component.kind).state, 'working'); dispatched.push(component.kind); return { ok: true, verified: true, message: 'Verified.' };
  } });
  assert.deepEqual(dispatched, ['windows', 'project']); assert.deepEqual(outcome.steps.map(step => step.state), ['completed', 'completed', 'skipped']);
  assert.throws(() => f.store.select(run.id, ['windows']), /unfinished/); assert.throws(() => f.store.select(run.id, ['routine']), /unfinished/);
  await assert.rejects(W.executeRun(f.store, run.id, ['windows'], { dispatch() { throw new Error('Must not dispatch'); } }), /unfinished/);
});
test('in-flight interruption becomes uncertain on reopen and never automatically resumes', () => {
  const f = fixture(), item = f.store.save('Work', refs), run = f.store.createRun(item.id, ['windows', 'project']); f.store.step(run.id, 'windows', 'working', 'Dispatched');
  const reopened = f.make().snapshot().runs[0]; assert.equal(reopened.steps[0].state, 'uncertain'); assert.match(reopened.steps[0].message, /Check what happened/); assert.equal(reopened.steps[1].state, 'pending');
});
test('cancellation keeps a verified completed step and prevents the next dispatch', async () => {
  const f = fixture(), item = f.store.save('Work', refs), run = f.store.createRun(item.id, ['windows', 'project']), abort = new AbortController(), calls = [];
  const outcome = await W.executeRun(f.store, run.id, ['windows', 'project'], { signal: abort.signal, dispatch: async component => { calls.push(component.kind); abort.abort(); return { ok: true, verified: true }; } });
  assert.deepEqual(calls, ['windows']); assert.deepEqual(outcome.steps.map(step => step.state), ['completed', 'cancelled', 'skipped']);
});
test('unknown dispatch outcome is uncertain and routine review is not recorded as execution', async () => {
  const f = fixture(), item = f.store.save('Work', refs), run = f.store.createRun(item.id, ['windows', 'project', 'routine']);
  const outcome = await W.executeRun(f.store, run.id, ['windows', 'project', 'routine'], { dispatch: async component => {
    if (component.kind === 'windows') throw new Error('Lost receipt');
    return component.kind === 'routine' ? { ok: true, status: 'awaiting-review', message: 'Review routine' } : { ok: true, verified: true, message: 'Selected project' };
  } });
  assert.deepEqual(outcome.steps.map(step => step.state), ['uncertain', 'completed', 'awaiting-review']);
});
test('failed writes cannot dispatch workspace effects', async () => {
  const f = fixture(), item = f.store.save('Work', refs), run = f.store.createRun(item.id, ['windows']); f.fail(true); let calls = 0;
  await assert.rejects(W.executeRun(f.store, run.id, ['windows'], { dispatch: async () => { calls++; } }), /Disk full/); assert.equal(calls, 0); assert.equal(W.isRunning(f.store), false);
});
test('a concurrent resume cannot duplicate or remove the active setup', async () => {
  const f = fixture(), item = f.store.save('Work', refs), run = f.store.createRun(item.id, ['windows']); let release;
  const first = W.executeRun(f.store, run.id, ['windows'], { dispatch: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(W.executeRun(f.store, run.id, ['windows'], { dispatch: async () => ({ ok: true }) }), /already resuming/);
  assert.throws(() => f.store.remove(item.id), /Cancel/); assert.throws(() => f.store.clearHistory(), /Cancel/);
  release({ ok: true, verified: true }); await first; assert.equal(W.isRunning(f.store), false);
});
test('saved setup and history snapshots are independent copies', () => {
  const f = fixture(), item = f.store.save('Work', refs); item.components[0].name = 'Changed'; const snapshot = f.store.snapshot(); snapshot.items[0].components[0].id = 'forged';
  assert.equal(f.store.snapshot().items[0].components[0].id, 'layout'); assert.equal(f.store.snapshot().items[0].components[0].name, refs[0].name);
});
