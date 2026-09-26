const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, KEY, statistics, executeRun } = require('../../shared/productivity');
const { parse } = require('../../shared/fast-intents');
function fixture(raw) {
  const data = new Map(raw === undefined ? [] : [[KEY, raw]]);
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  return { data, storage, store: createStore(storage) };
}

test('memory is explicit, editable, removable, and cannot change actions while disabled', () => {
  const { store, storage } = fixture();
  store.remember('aliases', 'work browser', 'Chrome');
  store.remember('playlists', 'focus music', 'Deep Focus');
  assert.equal(parse('open work browser', store.options()), null);
  store.preference('memoryEnabled', true);
  assert.equal(parse('open work browser', store.options())[0].command, '[OPEN_APP: Chrome]');
  assert.equal(parse('play my focus music', store.options())[0].command, '[SPOTIFY_LIBRARY: Deep Focus]');
  store.remember('aliases', 'WORK BROWSER', 'Firefox');
  assert.equal(store.snapshot().aliases.length, 1);
  const reopened = createStore(storage);
  assert.equal(parse('open work browser', reopened.options())[0].command, '[OPEN_APP: Firefox]');
  reopened.clearMemory();
  assert.deepEqual(reopened.snapshot().aliases, []);
  assert.deepEqual(reopened.snapshot().playlists, []);
  assert.equal(reopened.snapshot().memoryEnabled, false);
});

test('activity persists only operation metadata and stale completions cannot overwrite cancellation', () => {
  const { store, data, storage } = fixture();
  const id = store.begin(), step = store.step(id, 'ADD_TASK');
  store.finish(id, 'cancelled');
  store.receipt(id, step, 'completed');
  store.finish(id, 'completed');
  assert.equal(store.snapshot().activity[0].state, 'cancelled');
  assert.equal(createStore(storage).snapshot().activity.length, 0);
  store.preference('saveActivity', true);
  const second = store.begin(); store.step(second, 'OPEN_APP');
  const reopened = createStore(storage);
  assert.equal(reopened.snapshot().activity[1].state, 'interrupted');
  assert.equal(reopened.snapshot().activity[1].steps[0].state, 'uncertain');
  assert.equal(JSON.parse(data.get(KEY)).activity.some(entry => 'prompt' in entry || 'receipt' in entry), false);
  store.preference('saveActivity', false);
  assert.deepEqual(JSON.parse(data.get(KEY)).activity, []);
});

test('failed action receipts cannot become a completed request and history remains bounded', () => {
  const { store } = fixture();
  const id = store.begin(); store.receipt(id, store.step(id, 'OPEN_APP'), 'failed'); store.finish(id, 'completed');
  assert.equal(store.snapshot().activity[0].state, 'failed');
  for (let i = 0; i < 100; i++) store.begin();
  assert.equal(store.snapshot().activity.length, 40);
  store.clearActivity(); assert.equal(store.snapshot().activity.length, 0);
});

test('routine validation rejects unsupported clauses as a whole and snapshots saved input', () => {
  const { store } = fixture();
  assert.throws(() => store.saveRoutine({ name: 'Bad', lines: ['open Chrome', 'delete my files'] }, parse), /cannot be saved/);
  assert.equal(store.snapshot().routines.length, 0);
  const lines = ['open Chrome', 'set a timer for five minutes'];
  const saved = store.saveRoutine({ name: 'Work', lines }, parse);
  lines[0] = 'delete files'; saved.lines[0] = 'delete files';
  assert.equal(store.snapshot().routines[0].lines[0], 'open Chrome');
});

test('routine restart makes in-flight work uncertain and preserves completed steps', () => {
  const { store, storage } = fixture();
  const routine = store.saveRoutine({ name: 'Work', lines: ['open Chrome', 'set a timer for five minutes', 'volume up'] }, parse);
  const run = store.createRun(routine, routine.lines.flatMap(line => parse(line)));
  store.transitionRun(run.id, 0, 'working'); store.transitionRun(run.id, 0, 'completed'); store.transitionRun(run.id, 1, 'working');
  const reopened = createStore(storage), recovered = reopened.snapshot().runs[0];
  assert.equal(recovered.state, 'interrupted');
  assert.deepEqual(recovered.steps.map(step => step.state), ['completed', 'uncertain', 'pending']);
  assert.throws(() => reopened.transitionRun(run.id, 0, 'working'), /cannot run again/);
  reopened.transitionRun(run.id, 1, 'skipped');
  assert.throws(() => reopened.transitionRun(run.id, 1, 'working'), /cannot run again/);
});

test('dispatch journaling fails closed on storage errors while earlier receipts survive', () => {
  const { store, storage } = fixture();
  const routine = store.saveRoutine({ name: 'Work', lines: ['open Chrome'] }, parse);
  const run = store.createRun(routine, parse('open Chrome'));
  storage.setItem = () => { throw new Error('Disk full'); };
  assert.throws(() => store.transitionRun(run.id, 0, 'working'), /could not save/);
  assert.equal(store.snapshot().runs[0].steps[0].state, 'pending');
  assert.throws(() => store.preference('memoryEnabled', true), /could not save/);
  assert.equal(store.snapshot().memoryEnabled, false);
});

test('corrupt records cannot break startup or create runnable malformed commands', () => {
  for (const raw of ['{', 'null', '[]', '{"version":999}']) assert.doesNotThrow(() => fixture(raw));
  const { store, data } = fixture(JSON.stringify({ version: 1, memoryEnabled: true, aliases: [null, { alias: 'browser', target: 'Chrome' }, { alias: 'browser', target: 'Firefox' }], runs: [{ id: 'a', name: 'Bad', at: 1, state: 'working', steps: [{ command: '[OPEN_APP: Chrome]\n[SHELL: nope]', state: 'pending' }] }], routines: [null] }));
  assert.equal(store.snapshot().aliases.length, 1);
  assert.equal(store.snapshot().runs.length, 0);
  assert.equal(store.snapshot().routines.length, 0);
  assert.match(data.get(KEY), /SHELL/, 'Loading does not silently rewrite corrupt storage');
});

test('performance collection is opt-in, bounded, and removed when disabled', () => {
  const { store, storage } = fixture();
  store.timing('execution', 40);
  assert.equal(store.snapshot().timings.length, 0);
  store.preference('diagnostics', true);
  for (let i = 0; i < 250; i++) store.timing('execution', i, i % 2 ? 'ok' : 'error');
  assert.equal(store.snapshot().timings.length, 200);
  const stats = statistics(store.snapshot().timings)[0];
  assert.equal(stats.count, 200); assert.equal(stats.failures, 100); assert.equal(stats.p95, 239);
  assert.equal(createStore(storage).snapshot().timings.length, 200);
  store.preference('diagnostics', false);
  assert.equal(createStore(storage).snapshot().timings.length, 0);
});

test('cloud input stays the default and offline modes require an explicit saved preference', () => {
  const { store, storage } = fixture();
  assert.equal(store.snapshot().speechInput, 'cloud');
  store.preference('speechInput', 'offline');
  assert.equal(createStore(storage).snapshot().speechInput, 'offline');
  store.preference('speechInput', 'offline-general');
  assert.equal(createStore(storage).snapshot().speechInput, 'offline-general');
  assert.throws(() => store.preference('speechInput', 'auto'), /Invalid/);
});

test('routine dispatch is journaled first, stops on failure, and never repeats completed work on recovery', async () => {
  const { store, storage } = fixture();
  const run = store.createRun({ name: 'Test' }, parse('open Chrome and set a timer for five minutes and volume up'));
  const calls = [];
  const result = await executeRun(store, run.id, [0, 1, 2], { dispatch: async command => {
    calls.push(command);
    const saved = JSON.parse(storage.getItem(KEY)).runs[0];
    assert.equal(saved.steps[calls.length - 1].state, 'working', 'persist before dispatch');
    return { spokenResponse: calls.length === 1 ? 'Opened.' : 'Failed.', results: [{ ok: calls.length === 1 }] };
  } });
  assert.equal(result.state, 'failed'); assert.equal(calls.length, 2);
  assert.deepEqual(store.snapshot().runs[0].steps.map(step => step.state), ['completed', 'failed', 'pending']);
  const restarted = createStore(storage);
  await assert.rejects(executeRun(restarted, run.id, [0, 2], { dispatch: () => { throw new Error('Must not run'); } }), /Review/);
  restarted.selectRunSteps(run.id, [2]);
  const resumed = await executeRun(restarted, run.id, [2], { dispatch: async command => { calls.push(command); return { spokenResponse: 'Done.', results: [{ ok: true }] }; } });
  assert.equal(resumed.state, 'completed');
  assert.deepEqual(calls, ['[OPEN_APP: Chrome]', '[SET_TIMER: 300, Timer]', '[VOLUME_UP]']);
});

test('cancelling a delayed routine leaves uncertain work and cannot dispatch the next action', async () => {
  const { store } = fixture();
  const run = store.createRun({ name: 'Test' }, parse('open Chrome and volume up'));
  const controller = new AbortController(); let finish, count = 0;
  const pending = executeRun(store, run.id, [0, 1], { signal: controller.signal, dispatch: () => { count++; return new Promise(resolve => { finish = resolve; }); } });
  await assert.rejects(executeRun(store, run.id, [1], { dispatch: () => {} }), /already running/);
  controller.abort(); finish({ spokenResponse: 'Opened.', results: [{ ok: true }] });
  assert.equal((await pending).state, 'cancelled'); assert.equal(count, 1);
  assert.deepEqual(store.snapshot().runs[0].steps.map(step => step.state), ['uncertain', 'pending']);
});

test('routine validation and failed writes cause no side effects', async () => {
  const { store, storage } = fixture();
  const run = store.createRun({ name: 'Test' }, parse('open Chrome and volume up')); let dispatches = 0;
  await assert.rejects(executeRun(store, run.id, [0, 1], { validate: command => { if (command === '[VOLUME_UP]') throw new Error('Unsupported'); }, dispatch: () => { dispatches++; } }), /Unsupported/);
  storage.setItem = () => { throw new Error('Disk full'); };
  const result = await executeRun(store, run.id, [0], { dispatch: () => { dispatches++; } });
  assert.equal(result.state, 'failed'); assert.equal(dispatches, 0);
});

test('explicit deletion is transactional and cannot falsely claim data was erased', () => {
  const { store, storage } = fixture();
  store.preference('saveActivity', true); store.preference('diagnostics', true);
  store.begin(); store.timing('execution', 10);
  storage.setItem = () => { throw new Error('Storage full'); };
  assert.throws(() => store.clearActivity(), /could not save/);
  assert.throws(() => store.clearTimings(), /could not save/);
  assert.equal(store.snapshot().activity.length, 1);
  assert.equal(store.snapshot().timings.length, 1);
});

test('routine approval persists selected and skipped states atomically', () => {
  const { store, storage } = fixture();
  const actions = parse('open Chrome and volume up');
  const run = store.createRun({ name: 'Work' }, actions, [1]);
  assert.deepEqual(run.steps.map(step => step.state), ['skipped', 'pending']);
  assert.equal(run.state, 'awaiting-input');
  const reopened = createStore(storage);
  assert.deepEqual(reopened.snapshot().runs[0].steps.map(step => step.state), ['skipped', 'pending']);
  storage.setItem = () => { throw new Error('Storage full'); };
  assert.throws(() => store.createRun({ name: 'Other' }, actions, [1]), /could not save/);
  assert.equal(store.snapshot().runs.length, 1);
});

test('a full activity plan consumes every pending step, including repeated operations', () => {
  const { store } = fixture();
  const entry = store.begin();
  const operations = Array.from({ length: 16 }, (_, index) => index % 2 ? 'VOLUME_SET' : 'OPEN_APP');
  store.plan(entry, operations);
  for (let index = 0; index < operations.length; index++) {
    const step = store.step(entry, operations[index]);
    assert.equal(step, index);
    store.receipt(entry, step, 'completed');
  }
  assert.equal(store.step(entry, 'OPEN_APP'), null, 'additional actions cannot grow the bounded journal');
  store.finish(entry, 'completed');
  const activity = store.snapshot().activity[0];
  assert.equal(activity.state, 'completed');
  assert.equal(activity.steps.length, 16);
  assert.ok(activity.steps.every(step => step.state === 'completed'));
});

test('cancellation distinguishes potentially applied work from commands never dispatched', () => {
  const { store, storage } = fixture();
  store.preference('saveActivity', true);
  const entry = store.begin();
  store.plan(entry, ['OPEN_APP', 'VOLUME_SET']);
  const step = store.step(entry, 'OPEN_APP');
  store.finish(entry, 'cancelled');
  store.receipt(entry, step, 'completed', 'A late callback must not change the cancelled request.');
  assert.equal(store.snapshot().activity[0].state, 'cancelled');
  assert.deepEqual(store.snapshot().activity[0].steps.map(step => step.state), ['uncertain', 'skipped']);
  assert.deepEqual(createStore(storage).snapshot().activity[0].steps.map(step => step.state), ['uncertain', 'skipped']);

  const second = store.begin();
  store.receipt(second, store.step(second, 'VOLUME_SET'), 'cancelled');
  store.finish(second, 'completed');
  assert.equal(store.snapshot().activity[1].state, 'interrupted');
  assert.equal(store.snapshot().activity[1].steps[0].state, 'uncertain');
});

test('activity cannot claim completion when an approved step has no final receipt', () => {
  for (const started of [false, true]) {
    const { store } = fixture();
    const entry = store.begin();
    store.plan(entry, ['OPEN_APP', 'VOLUME_SET']);
    store.receipt(entry, store.step(entry, 'OPEN_APP'), 'completed');
    if (started) store.step(entry, 'VOLUME_SET');
    store.finish(entry, 'completed');
    const activity = store.snapshot().activity[0];
    assert.equal(activity.state, 'interrupted');
    assert.deepEqual(activity.steps.map(step => step.state), ['completed', started ? 'uncertain' : 'skipped']);
  }
});

test('session receipt details remain available but never enter persisted activity', () => {
  const { store, storage, data } = fixture();
  store.preference('saveActivity', true);
  const entry = store.begin();
  const privateReceipt = 'Added task: private medical appointment details';
  store.receipt(entry, store.step(entry, 'ADD_TASK'), 'completed', privateReceipt);
  store.finish(entry, 'completed');
  store.preference('diagnostics', true);
  store.timing('execution', 12);
  assert.equal(store.snapshot().activity[0].steps[0].details, privateReceipt);
  assert.equal(data.get(KEY).includes(privateReceipt), false);
  assert.equal(data.get(KEY).includes('details'), false);
  assert.equal(createStore(storage).snapshot().activity[0].steps[0].details, undefined);
});

test('an unverified routine effect stays unverified after later verified work and restart', async () => {
  const { store, storage } = fixture();
  const run = store.createRun({ name: 'Test' }, parse('open Chrome and volume up'));
  const calls = [];
  const outcome = await executeRun(store, run.id, [0, 1], { dispatch: async command => {
    calls.push(command);
    return { spokenResponse: calls.length === 1 ? 'Launch was requested; not confirmed.' : 'Volume changed.', results: [{ ok: true, verified: calls.length > 1 }] };
  } });
  assert.equal(outcome.state, 'unverified');
  const resumed = createStore(storage);
  assert.equal(resumed.snapshot().runs[0].state, 'unverified');
  assert.deepEqual(resumed.snapshot().runs[0].steps.map(step => step.state), ['unverified', 'completed']);
  await assert.rejects(executeRun(resumed, run.id, [1], { dispatch: () => { throw new Error('Must not repeat'); } }), /Review/);
  assert.equal(calls.length, 2);
});

test('routine completion reflects unresolved steps instead of only the most recent selection', async () => {
  for (const unresolved of ['pending', 'failed', 'uncertain', 'unverified']) {
    const { store } = fixture();
    const run = store.createRun({ name: 'Test' }, parse('open Chrome and volume up'));
    if (unresolved !== 'pending') store.transitionRun(run.id, 0, unresolved);
    store.finishRun(run.id, 'interrupted');
    const calls = [];
    const outcome = await executeRun(store, run.id, [1], { dispatch: async command => { calls.push(command); return { spokenResponse: 'Done.', results: [{ ok: true }] }; } });
    const expected = ['pending', 'uncertain'].includes(unresolved) ? 'interrupted' : unresolved;
    assert.equal(outcome.state, expected);
    assert.equal(store.snapshot().runs[0].state, expected);
    assert.deepEqual(calls, ['[VOLUME_UP]']);
    assert.equal(store.snapshot().runs[0].steps[0].state, unresolved);
  }
});

test('a failed final receipt save cannot authorize repeating an effect on restart', async () => {
  const { store, storage } = fixture();
  const run = store.createRun({ name: 'Test' }, parse('open Chrome and volume up'));
  const write = storage.setItem;
  let calls = 0;
  const outcome = await executeRun(store, run.id, [0, 1], { dispatch: async () => {
    calls++;
    storage.setItem = () => { throw new Error('Disk full after the effect'); };
    return { spokenResponse: 'Opened.', results: [{ ok: true }] };
  } });
  assert.equal(outcome.state, 'failed');
  assert.equal(calls, 1);
  assert.equal(store.snapshot().runs[0].state, 'interrupted', 'the user can review recovery without restarting');
  assert.deepEqual(store.snapshot().runs[0].steps.map(step => step.state), ['uncertain', 'pending']);
  storage.setItem = write;
  const recovered = createStore(storage).snapshot().runs[0];
  assert.equal(recovered.state, 'interrupted');
  assert.deepEqual(recovered.steps.map(step => step.state), ['uncertain', 'pending']);
  store.selectRunSteps(run.id, [1]);
  const remaining = [];
  const resumed = await executeRun(store, run.id, [1], { dispatch: async command => { remaining.push(command); return { results: [{ ok: true }], spokenResponse: 'Changed.' }; } });
  assert.equal(resumed.state, 'completed');
  assert.deepEqual(remaining, ['[VOLUME_UP]'], 'only the explicitly reviewed unfinished step runs');
});

test('duplicate stored run identities cannot dispatch a different proposal than the one reviewed', async () => {
  const record = (id, command) => ({ id, name: 'Work', at: 1, state: 'interrupted', steps: [{ command, state: 'pending' }] });
  const { store } = fixture(JSON.stringify({ version: 1, runs: [
    record('ambiguous', '[OPEN_APP: Notepad]'),
    record('ambiguous', '[OPEN_APP: Chrome]'),
    record('unique', '[VOLUME_SET: 25]')
  ] }));
  assert.deepEqual(store.snapshot().runs.map(run => run.id), ['unique']);
  let dispatched = false;
  await assert.rejects(executeRun(store, 'ambiguous', [0], { dispatch: () => { dispatched = true; } }), /Review/);
  assert.equal(dispatched, false);
});

test('a throwing view listener cannot roll back a committed save or prevent journaled dispatch', async () => {
  const { store, storage } = fixture();
  let notifications = 0;
  store.subscribe(() => { throw new Error('Broken view'); });
  store.subscribe(() => { notifications++; });
  assert.doesNotThrow(() => store.remember('aliases', 'browser', 'Chrome'));
  assert.deepEqual(store.snapshot().aliases, createStore(storage).snapshot().aliases);
  const run = store.createRun({ name: 'Work' }, parse('open Chrome')); let calls = 0;
  const outcome = await executeRun(store, run.id, [0], { dispatch: async () => { calls++; return { results: [{ ok: true }] }; } });
  assert.equal(outcome.state, 'completed'); assert.equal(calls, 1);
  assert.equal(store.snapshot().runs[0].state, 'completed');
  assert.equal(createStore(storage).snapshot().runs[0].state, 'completed');
  assert.ok(notifications >= 4);
});

test('failed writes never publish transient unsaved state to subscribers', () => {
  const { store, storage } = fixture(); const seen = [];
  store.subscribe(() => seen.push(store.snapshot().memoryEnabled));
  storage.setItem = () => { throw new Error('Full'); };
  assert.throws(() => store.preference('memoryEnabled', true), /could not save/);
  assert.deepEqual(seen, [false]);
});

test('new records cannot collide when clock and randomness repeat', () => {
  const { store } = fixture(); const originalNow = Date.now, originalRandom = Math.random;
  try {
    Date.now = () => 1000; Math.random = () => 0;
    const first = store.saveRoutine({ name: 'First', lines: ['open Chrome'] }, parse);
    const second = store.saveRoutine({ name: 'Second', lines: ['open Notepad'] }, parse);
    const runA = store.createRun(first, parse('open Chrome')), runB = store.createRun(second, parse('open Notepad'));
    const activityA = store.begin(), activityB = store.begin();
    assert.equal(new Set([first.id, second.id, runA.id, runB.id, activityA, activityB]).size, 6);
    assert.equal(store.snapshot().routines.length, 2); assert.equal(store.snapshot().runs.length, 2);
  } finally { Date.now = originalNow; Math.random = originalRandom; }
});

test('stale routine edits and malformed run selections cannot modify saved work', () => {
  const { store, storage } = fixture();
  const routine = store.saveRoutine({ name: 'Work', lines: ['open Chrome'] }, parse);
  store.deleteRoutine(routine.id);
  const before = storage.getItem(KEY);
  assert.throws(() => store.saveRoutine(routine, parse), /removed/);
  assert.throws(() => store.createRun({ name: 'Bad' }, [{ command: '[OPEN_APP: Chrome][VOLUME_UP]' }]), /Invalid/);
  assert.throws(() => store.createRun({ name: 'Bad' }, null), /Invalid/);
  assert.throws(() => store.createRun({ name: 'Bad' }, parse('open Chrome'), [0, 0]), /valid step/);
  assert.equal(storage.getItem(KEY), before);
  const run = store.createRun({ name: 'Valid' }, parse('open Chrome and volume up'));
  assert.throws(() => store.selectRunSteps(run.id, [1, 1]), /Review/);
  assert.deepEqual(store.snapshot().runs[0].steps.map(step => step.state), ['pending', 'pending']);
});

test('memories are explicit, deduplicated, bounded, removable and shared only while enabled', () => {
  const { store, storage } = fixture();
  assert.deepEqual(store.memoryContext(), []);
  const saved = store.rememberFact('  my locker code   is 4312 ');
  assert.equal(saved.text, 'my locker code is 4312');
  assert.equal(store.rememberFact('My locker code is 4312').id, saved.id);
  store.rememberFact('I parked on level 3');
  assert.deepEqual(store.memoryContext(), ['my locker code is 4312', 'I parked on level 3']);
  for (const bad of ['', 'x', 'y'.repeat(301), 'code [OPEN_APP: Chrome]', 'line\nbreak', null]) assert.throws(() => store.rememberFact(bad), /2–300 characters/);
  store.preference('factsEnabled', false);
  assert.deepEqual(store.memoryContext(), []);
  const reopened = createStore(storage);
  assert.equal(reopened.snapshot().factsEnabled, false);
  assert.equal(reopened.snapshot().facts.length, 2);
  reopened.preference('factsEnabled', true);
  assert.equal(reopened.findFacts('locker code')[0].id, saved.id);
  assert.equal(reopened.findFacts('the parked level')[0].text, 'I parked on level 3');
  assert.deepEqual(reopened.findFacts('grocery list'), []);
  assert.equal(reopened.deleteFact(saved.id).text, 'my locker code is 4312');
  assert.equal(reopened.deleteFact(saved.id), null);
  assert.equal(reopened.clearFacts(), 1);
  assert.deepEqual(createStore(storage).snapshot().facts, []);
});

test('memory limits and damaged memory records fail closed without losing valid neighbors', () => {
  const { store } = fixture();
  for (let index = 0; index < 50; index++) store.rememberFact(`fact number ${index}`);
  assert.throws(() => store.rememberFact('one too many'), /full/);
  const { store: loaded } = fixture(JSON.stringify({ version: 1, facts: [
    { id: 'a', text: 'I like jazz', at: 1 }, { id: 'a', text: 'duplicate id', at: 2 }, { id: 'b', text: 'I LIKE JAZZ', at: 3 },
    { id: 'c', text: '[VOLUME_SET: 100]', at: 4 }, { id: 'd', text: 'no timestamp' }, null, { id: 'e', text: 'my sister is Priya', at: 5 }
  ] }));
  assert.deepEqual(loaded.snapshot().facts.map(item => item.text), ['I like jazz', 'my sister is Priya']);
  assert.equal(loaded.snapshot().factsEnabled, true);
});

test('editing a saved name renames it atomically without leaving an old alias or overwriting another', () => {
  const { store, storage } = fixture();
  store.remember('aliases', 'old browser', 'Chrome'); store.remember('aliases', 'other browser', 'Edge');
  store.remember('aliases', 'new browser', 'Firefox', { kind: 'aliases', alias: 'old browser' });
  assert.deepEqual(store.snapshot().aliases, [{ alias: 'other browser', target: 'Edge' }, { alias: 'new browser', target: 'Firefox' }]);
  const before = storage.getItem(KEY);
  assert.throws(() => store.remember('aliases', 'other browser', 'Firefox', { kind: 'aliases', alias: 'new browser' }), /already uses/);
  assert.throws(() => store.remember('aliases', 'missing browser', 'Chrome', { kind: 'aliases', alias: 'removed browser' }), /removed/);
  assert.equal(storage.getItem(KEY), before);
  assert.deepEqual(store.snapshot().aliases, createStore(storage).snapshot().aliases);
  storage.setItem = () => { throw new Error('Full'); };
  assert.throws(() => store.remember('playlists', 'music', 'Deep Focus', { kind: 'aliases', alias: 'new browser' }), /could not save/);
  assert.equal(store.snapshot().aliases.length, 2); assert.deepEqual(store.snapshot().playlists, []);
});
