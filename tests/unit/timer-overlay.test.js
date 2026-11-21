'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeSnapshot, remainingText } = require('../../shared/timer-overlay');

const timer = (id, endTime, extra = {}) => ({ id, label: id, endTime, kind: 'timer', ...extra });

test('timer cards require explicit opt-in and valid active records', () => {
  for (const value of [undefined, null, {}, [], 'enabled', { enabled: 'true', timers: [timer('Tea', 10000)] }]) {
    assert.deepEqual(normalizeSnapshot(value), { enabled: false, timers: [], total: 0 });
  }
  assert.deepEqual(normalizeSnapshot({ enabled: false, timers: [timer('Tea', 10000)], total: 1 }), { enabled: false, timers: [], total: 0 });
  assert.deepEqual(normalizeSnapshot({ enabled: true, timers: null }), { enabled: true, timers: [], total: 0 });
  assert.deepEqual(normalizeSnapshot({ enabled: true, timers: [], total: 10 }), { enabled: true, timers: [], total: 0 });
});

test('five visible timers prioritize ringing, earliest deadlines and paused imports in that order', () => {
  const records = [
    timer('Paused', 1, { paused: true, remainingMs: 1000 }),
    timer('Long', 70000), timer('Soon', 20000), timer('Last', 90000),
    timer('Ringing', 80000, { ringing: true }), timer('Next', 40000), timer('Later', 60000)
  ];
  const before = JSON.stringify(records);
  const snapshot = normalizeSnapshot({ enabled: true, timers: records });
  assert.deepEqual(snapshot.timers.map(item => item.id), ['Ringing', 'Soon', 'Next', 'Later', 'Long']);
  assert.equal(snapshot.total, 7);
  assert.equal(JSON.stringify(records), before, 'sorting and normalization leave the caller records intact');
  assert.deepEqual(normalizeSnapshot(snapshot), snapshot, 'passing a bounded snapshot through main and controller retains the full count');
  const tied = normalizeSnapshot({ enabled: true, timers: [timer('b', 10000), timer('a', 10000)] });
  assert.deepEqual(tied.timers.map(item => item.id), ['a', 'b']);
});

test('invalid records and duplicate IDs cannot replace a valid timer or reach the card', () => {
  const invalid = [
    null, {}, timer('', 1), timer('blank', 1, { label: '  ' }),
    ...[NaN, Infinity, -1, 0, 8640000000000001, '2000'].map((value, index) => timer('end-' + index, value)),
    ...[-1, NaN, Infinity, 0.5, 31536000001, '1000'].map((value, index) => timer('paused-' + index, 1000, { paused: true, remainingMs: value })),
    timer('recovered', NaN)
  ];
  const snapshot = normalizeSnapshot({ enabled: true, timers: [
    ...invalid, timer('Tea', 3000), timer('Tea', 1000, { label: 'Duplicate' }), timer('recovered', 2000)
  ], total: -5 });
  assert.deepEqual(snapshot.timers.map(item => [item.id, item.label, item.endTime]), [['recovered', 'recovered', 2000], ['Tea', 'Tea', 3000]]);
  assert.equal(snapshot.total, 2);
  const legacyId = 'x'.repeat(257);
  assert.equal(normalizeSnapshot({ enabled: true, timers: [timer(legacyId, 1000)] }).timers[0].id, legacyId, 'existing stored IDs remain usable');
});

test('paused records never ring and the published shape excludes unrelated renderer data', () => {
  const snapshot = normalizeSnapshot({ enabled: true, timers: [timer('Import', 1000, {
    label: '  ' + 'A'.repeat(140) + '  ', kind: 'unknown', paused: true, remainingMs: 0,
    ringing: true, intervalId: 99, secret: 'unrelated'
  })] });
  assert.deepEqual(snapshot.timers, [{
    id: 'Import', label: 'A'.repeat(120), kind: 'timer', endTime: 1000,
    paused: true, ringing: false, remainingMs: 0
  }]);
  for (const kind of ['timer', 'reminder', 'alarm']) {
    const normalized = normalizeSnapshot({ enabled: true, timers: [timer(kind, 1000, { kind })] });
    assert.equal(normalized.timers[0].kind, kind);
  }
});

test('countdown text follows deadlines, rounds fractional seconds up and keeps paused time fixed', () => {
  const item = timer('Tea', 12000);
  assert.equal(remainingText(item, 10000), '00:02');
  assert.equal(remainingText(item, 11001), '00:01');
  assert.equal(remainingText(item, 12000), '00:00');
  assert.equal(remainingText(item, 20000), '00:00');
  assert.equal(remainingText(item, 9000), '00:03', 'a clock adjustment is reflected on the next paint');
  assert.equal(remainingText({ ...item, ringing: true }, 10000), '00:00');
  const paused = { ...item, paused: true, remainingMs: 3661000 };
  assert.equal(remainingText(paused, 20000), '01:01:01');
  assert.equal(remainingText(paused, 90000), '01:01:01');
  assert.equal(remainingText({ ...paused, remainingMs: 100 * 3600000 }), '100:00:00');
});

test('the sandboxed browser receives the same helper API without Node globals', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../shared/timer-overlay.js'), 'utf8'), context);
  const snapshot = context.OlangaTimerOverlay.normalizeSnapshot({ enabled: true, timers: [timer('Tea', 12000)] });
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), normalizeSnapshot({ enabled: true, timers: [timer('Tea', 12000)] }));
  assert.equal(context.OlangaTimerOverlay.remainingText(snapshot.timers[0], 10000), '00:02');
});
