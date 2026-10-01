const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const schedules = require('../../shared/schedules');
const date = (day, hour = 8, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
function fixture(initial = date(29)) {
  let clock = initial, counter = 0, timeZone = 'device-test'; const memory = new Map();
  const storage = { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) };
  const options = { now: () => clock, zone: () => timeZone, id: () => `schedule-${++counter}` };
  const store = schedules.createStore(storage, options);
  return { store, storage, memory, options, setTime: value => { clock = value; }, setZone: value => { timeZone = value; } };
}
const daily = { kind: 'reminder', title: 'Coursework', repeat: 'daily', time: '09:00' };
const briefing = { ...daily, kind: 'briefing', title: 'Briefing' };

test('new schedules are explicit, bounded and local by default', () => {
  const { store } = fixture(); assert.equal(store.snapshot().items.length, 0);
  const saved = store.add(briefing); assert.equal(saved.online, false); assert.equal(saved.nextAt, date(29, 9));
  for (const value of [{ ...daily, title: '' }, { ...daily, time: '24:00' }, { ...daily, repeat: 'weekly', days: [] }, { ...daily, repeat: 'weekly', days: [7] }, { ...daily, repeat: 'hourly' }, { ...daily, kind: 'shell' }]) assert.throws(() => store.add(value));
  assert.throws(() => store.add({ kind: 'reminder', title: 'Past', repeat: 'once', onceAt: date(28) }), /future/);
});

test('once reminder persists consumption before delivery and never replays after restart', () => {
  const f = fixture(); const item = f.store.add({ kind: 'reminder', title: 'Call', repeat: 'once', onceAt: date(29, 9) });
  f.setTime(date(29, 9)); const [due] = f.store.takeDue(); assert.equal(due.id, item.id); assert.equal(f.store.takeDue().length, 0);
  const reopened = schedules.createStore(f.storage, f.options); assert.equal(reopened.takeDue().length, 0);
  assert.equal(reopened.snapshot().deliveries[0].status, 'interrupted'); assert.equal(reopened.snapshot().items[0].enabled, false);
});

test('missed daily occurrences collapse to one and schedule the next future occurrence', () => {
  const f = fixture(); f.store.add(daily); f.setTime(date(35, 15)); const due = f.store.takeDue();
  assert.equal(due.length, 1); assert.equal(due[0].missed, true); assert.equal(f.store.snapshot().items[0].nextAt, date(36, 9));
  assert.equal(f.store.takeDue().length, 0);
});

test('weekly schedules preserve selected weekdays across month boundaries', () => {
  const f = fixture(); const saved = f.store.add({ ...daily, repeat: 'weekly', days: [1, 3, 3] });
  assert.deepEqual(saved.days, [1, 3]); assert.equal(saved.nextAt, date(30, 9));
  f.setTime(date(30, 9)); f.store.takeDue(); assert.equal(new Date(f.store.snapshot().items[0].nextAt).getDay(), 1);
});

test('disable and re-enable skip missed work; removing the schedule prevents future work', () => {
  const f = fixture(); const item = f.store.add(daily); f.store.enable(item.id, false); f.setTime(date(35, 15));
  assert.equal(f.store.takeDue().length, 0); f.store.enable(item.id, true); assert.equal(f.store.takeDue().length, 0);
  assert.equal(f.store.snapshot().items[0].nextAt, date(36, 9)); f.store.remove(item.id); f.setTime(date(37, 10)); assert.equal(f.store.takeDue().length, 0);
});

test('the same local occurrence cannot replay after a backward clock adjustment', () => {
  const f = fixture(); f.store.add(daily); f.setTime(date(29, 9)); assert.equal(f.store.takeDue().length, 1);
  f.setTime(date(29, 8)); assert.equal(f.store.takeDue().length, 0); f.setTime(date(29, 9)); assert.equal(f.store.takeDue().length, 0);
});

test('a device time-zone change recomputes future repeating times without old-zone catchup', () => {
  const f = fixture(); f.store.add(daily); f.setTime(date(29, 12)); f.setZone('new-device-zone');
  assert.equal(f.store.takeDue().length, 0); assert.equal(f.store.snapshot().items[0].nextAt, date(30, 9));
});

test('storage write failure cannot consume or dispatch a scheduled action', async () => {
  const f = fixture(); f.store.add(daily); f.setTime(date(29, 9)); f.storage.setItem = () => { throw new Error('Disk full'); };
  let notices = 0; const runner = schedules.createRunner(f.store, { notify: () => notices++ });
  await assert.rejects(runner.tick(), /Disk full/); assert.equal(notices, 0); assert.equal(f.store.snapshot().deliveries.length, 0);
});

test('invalid saved records are preserved and schedules stay disabled rather than silently overwritten', () => {
  const f = fixture(); f.memory.set(schedules.KEY, '{broken'); const store = schedules.createStore(f.storage, f.options);
  assert.ok(store.snapshot().error); assert.throws(() => store.add(daily)); assert.throws(() => store.takeDue()); assert.equal(f.memory.get(schedules.KEY), '{broken');
});

test('resuming many missed reminders produces one notification and no online costs', async () => {
  const f = fixture(); f.store.add({ ...briefing, online: true }); f.store.add(daily); f.store.add({ ...daily, title: 'Stretch' }); f.setTime(date(35, 12));
  const notices = []; let network = 0;
  const runner = schedules.createRunner(f.store, { localBriefing: () => 'Current local tasks.', onlineBriefing: () => { network++; return 'Online'; }, notify: value => notices.push(value) });
  assert.equal(await runner.tick(), 3); assert.equal(notices.length, 1); assert.equal(network, 0); assert.match(notices[0].body, /Missed while away/);
  await runner.tick(); assert.equal(notices.length, 1);
});

test('on-time local briefings never call a provider, and explicit online briefings share one request', async () => {
  const f = fixture(); f.store.add(briefing); f.setTime(date(29, 9)); let network = 0;
  const runner = schedules.createRunner(f.store, { localBriefing: () => 'Local', onlineBriefing: () => { network++; return 'Online'; } });
  await runner.tick(); assert.equal(network, 0);
  f.store.add({ ...briefing, online: true }); f.store.add({ ...briefing, online: true }); f.setTime(date(30, 9)); await runner.tick(); assert.equal(network, 1);
});

test('concurrent polling coalesces; disabling while a provider works prevents stale delivery', async () => {
  const f = fixture(); const saved = f.store.add({ ...briefing, online: true }); f.setTime(date(29, 9));
  let resolve, started; const ready = new Promise(done => { started = done; }); let notices = 0;
  const runner = schedules.createRunner(f.store, { onlineBriefing: () => { started(); return new Promise(done => { resolve = done; }); }, notify: () => notices++ });
  const pending = runner.tick(); await ready; assert.equal(runner.tick(), pending);
  f.store.enable(saved.id, false); f.store.enable(saved.id, true); resolve('Stale response'); await pending;
  assert.equal(notices, 0); assert.equal(f.store.snapshot().deliveries[0].status, 'failed');
});

test('removing an earlier notification while a later briefing waits prevents it from appearing', async () => {
  const f = fixture(); const reminder = f.store.add(daily); f.store.add({ ...briefing, online: true }); f.setTime(date(29, 9));
  let resolve, started; const ready = new Promise(done => { started = done; }); const notices = [];
  const runner = schedules.createRunner(f.store, { onlineBriefing: () => { started(); return new Promise(done => { resolve = done; }); }, notify: value => notices.push(value) });
  const pending = runner.tick(); await ready; f.store.remove(reminder.id); resolve('Briefing only'); await pending;
  assert.equal(notices.length, 1); assert.equal(notices[0].title, 'Briefing'); assert.equal(notices[0].body, 'Briefing only');
});

test('provider failure falls back to local data and notification failures never retry side effects', async () => {
  const f = fixture(); f.store.add({ ...briefing, online: true }); f.setTime(date(29, 9)); let attempts = 0;
  const runner = schedules.createRunner(f.store, { localBriefing: () => 'Local tasks.', onlineBriefing: () => { throw new Error('Offline'); }, notify: value => { attempts++; assert.match(value.body, /Local tasks.*unavailable/); throw new Error('Notifications blocked'); } });
  await runner.tick(); await runner.tick(); assert.equal(attempts, 1); assert.equal(f.store.snapshot().deliveries[0].status, 'failed');
});

test('DST gaps and folds use local calendar semantics in America/Los_Angeles', () => {
  const modulePath = path.join(__dirname, '../../shared/schedules.js');
  const script = `const assert = require('node:assert/strict'); const { nextOccurrence } = require(${JSON.stringify(modulePath)});
    const next = (time, after) => new Date(nextOccurrence({ repeat: 'daily', time }, new Date(after).getTime()));
    const gap = next('02:30', '2026-03-08T00:00:00-08:00'); assert.equal(gap.toISOString(), '2026-03-08T10:30:00.000Z');
    const nextDay = next('02:30', gap); assert.equal(nextDay.toISOString(), '2026-03-09T09:30:00.000Z');
    const first = next('01:30', '2026-11-01T00:00:00-07:00'); assert.equal(first.toISOString(), '2026-11-01T08:30:00.000Z');
    const afterFirst = next('01:30', '2026-11-01T01:45:00-07:00'); assert.equal(afterFirst.toISOString(), '2026-11-02T09:30:00.000Z');
    const daily = next('09:00', '2026-03-07T09:00:00-08:00'); assert.equal(daily.toISOString(), '2026-03-08T16:00:00.000Z');`;
  execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'America/Los_Angeles' }, stdio: 'pipe' });
});
