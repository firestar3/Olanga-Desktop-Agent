'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMedia, sportsVisible, createMediaMonitor } = require('../../js/companion-cards');
const receipt = (status = 'Playing', title = 'Test track') => ({ ok: true, verified: true, status, title, artist: 'Test artist' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function settle() { for (let n = 0; n < 15; n++) await Promise.resolve(); }
function fixture(t, read = async () => receipt(), onChange) {
  let sequence = 0, calls = 0;
  const timers = new Map(), changes = [];
  const monitor = createMediaMonitor({ read: () => { calls++; return read(calls); }, onChange: value => { changes.push(value); onChange?.(value); },
    setTimer(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; }, clearTimer(id) { timers.delete(id); } });
  t.after(() => monitor.dispose());
  return { monitor, timers, changes, calls: () => calls, delay: () => [...timers.values()][0]?.delay,
    async tick() { const next = timers.entries().next().value; assert.ok(next, 'An update is scheduled'); timers.delete(next[0]); next[1].fn(); await settle(); } };
}

test('sports companion obeys enabled and live-only preferences without inventing live status', () => {
  assert.equal(sportsVisible(null), false);
  assert.equal(sportsVisible({ enabled: false, game: { state: 'live' } }), false);
  for (const state of ['pre', 'final', 'postponed']) assert.equal(sportsVisible({ enabled: true, game: { state } }), false);
  assert.equal(sportsVisible({ enabled: true, game: { state: 'live' } }), true);
  assert.equal(sportsVisible({ enabled: true, liveOnly: false, game: null }), true);
  assert.equal(sportsVisible({ enabled: true, liveOnly: false, game: { state: 'final' } }), true);
});

test('music accepts only verified state and uses honest labels for missing metadata', () => {
  assert.deepEqual(normalizeMedia(receipt()), { available: true, title: 'Test track', artist: 'Test artist', status: 'Playing' });
  assert.equal(normalizeMedia(receipt('Paused', '')).title, 'Current track');
  assert.equal(normalizeMedia(receipt('Paused', '')).available, true);
  assert.equal(normalizeMedia(receipt('Unknown')).status, 'Unknown');
  assert.equal(normalizeMedia({ ...receipt(), verified: false }).available, false);
  assert.equal(normalizeMedia({ ...receipt(), status: 'Closed' }).available, false);
  assert.equal(normalizeMedia({ ok: false, verified: true, reason: 'no-session' }).title, 'Nothing playing on Spotify');
  assert.equal(normalizeMedia({ ...receipt(), title: 'x'.repeat(500), artist: 'a\u0000b' }).title.length, 160);
  assert.equal(normalizeMedia({ ...receipt(), artist: 'a\u0000b' }).artist, 'a b');
});

test('media polling begins only when active, uses five seconds while playing, and does not overlap', async t => {
  const delayed = deferred();
  const f = fixture(t, () => delayed.promise);
  await settle(); assert.equal(f.calls(), 0); assert.equal(f.timers.size, 0);
  f.monitor.setActive(true); await settle(); assert.equal(f.calls(), 1);
  f.monitor.setActive(true); await settle(); assert.equal(f.calls(), 1); assert.equal(f.timers.size, 0);
  delayed.resolve(receipt()); await settle();
  assert.equal(f.changes.length, 1); assert.equal(f.delay(), 5000);
  await f.tick(); assert.equal(f.calls(), 2); assert.equal(f.delay(), 5000);
});

test('paused and empty players use ten-second checks without sending a playback action', async t => {
  const f = fixture(t, async call => call === 1 ? receipt('Paused') : { status: 'Closed', reason: 'no-session' });
  f.monitor.setActive(true); await settle(); assert.equal(f.delay(), 10000);
  await f.tick(); assert.equal(f.delay(), 10000); assert.equal(f.changes.at(-1).available, false);
  f.monitor.setActive(false); assert.equal(f.timers.size, 0);
});

test('hiding while a status request is pending suppresses its result and stops timers', async t => {
  const delayed = deferred(), f = fixture(t, () => delayed.promise);
  f.monitor.setActive(true); await settle(); f.monitor.setActive(false);
  delayed.resolve(receipt()); await settle();
  assert.equal(f.changes.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.calls(), 1);
});

test('showing during an old pending read waits for it then immediately checks fresh state', async t => {
  const delayed = deferred(), f = fixture(t, call => call === 1 ? delayed.promise : Promise.resolve(receipt('Paused', 'New track')));
  f.monitor.setActive(true); await settle(); f.monitor.setActive(false); f.monitor.setActive(true); await settle();
  assert.equal(f.calls(), 1, 'The old read is not overlapped');
  delayed.resolve(receipt()); await settle(); assert.equal(f.changes.length, 0); assert.equal(f.delay(), 0);
  await f.tick(); assert.equal(f.calls(), 2); assert.equal(f.changes.at(-1).title, 'New track'); assert.equal(f.delay(), 10000);
});

test('explicit actions invalidate old status results and refresh after completion without overlap', async t => {
  const delayed = deferred(), f = fixture(t, call => call === 1 ? delayed.promise : Promise.resolve(receipt('Paused')));
  f.monitor.setActive(true); await settle(); f.monitor.setActionPending(true);
  delayed.resolve(receipt()); await settle(); assert.equal(f.changes.length, 0); assert.equal(f.timers.size, 0);
  f.monitor.setActionPending(false); await settle();
  assert.equal(f.calls(), 2); assert.equal(f.changes.at(-1).status, 'Paused'); assert.equal(f.delay(), 10000);
});

test('an action completing before an old read returns cannot let that old read overwrite it', async t => {
  const delayed = deferred(), f = fixture(t, call => call === 1 ? delayed.promise : Promise.resolve(receipt('Paused', 'Selected track')));
  f.monitor.setActive(true); await settle(); f.monitor.setActionPending(true); f.monitor.setActionPending(false);
  assert.equal(f.calls(), 1); delayed.resolve(receipt()); await settle();
  assert.equal(f.changes.length, 0); assert.equal(f.delay(), 0);
  await f.tick(); assert.equal(f.changes.at(-1).title, 'Selected track');
});

test('read errors and view callback errors cannot stop bounded polling', async t => {
  const f = fixture(t, async call => { if (call === 1) throw Error('Unavailable'); return receipt(); }, () => { throw Error('View'); });
  f.monitor.setActive(true); await settle(); assert.equal(f.changes.at(-1).status, 'Unavailable'); assert.equal(f.delay(), 10000);
  await f.tick(); assert.equal(f.changes.at(-1).status, 'Playing'); assert.equal(f.delay(), 5000);
});

test('dispose ignores pending work and prevents all later polling', async t => {
  const delayed = deferred(), f = fixture(t, () => delayed.promise);
  f.monitor.setActive(true); await settle(); f.monitor.dispose(); delayed.resolve(receipt()); await settle();
  f.monitor.setActive(true); f.monitor.setActionPending(false); await settle();
  assert.equal(f.calls(), 1); assert.equal(f.changes.length, 0); assert.equal(f.timers.size, 0);
});
