const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../../shared/turn-lifecycle');
const corrections = require('../../shared/turn-corrections');

function fixture() {
  let time = 0, seq = 0;
  const pending = new Map(), changes = [], stalls = [], timeouts = [];
  const lifecycle = create({ now: () => time, schedule: (fn, delay) => { const id = ++seq; pending.set(id, { fn, at: time + delay }); return id; }, unschedule: id => pending.delete(id), timeoutMs: 100, stallMs: 10, onChange: value => changes.push(value), onStall: value => stalls.push(value), onTimeout: value => timeouts.push(value) });
  const advance = ms => { time += ms; for (const [id, timer] of [...pending]) if (timer.at <= time) { pending.delete(id); timer.fn(); } };
  return { lifecycle, advance, pending, changes, stalls, timeouts };
}
test('actions, actual playback onset and playback completion have distinct timestamps', () => {
  const { lifecycle: turn, advance } = fixture();
  const id = turn.begin(); advance(2); turn.actionsFinished(id); advance(3); turn.phase(id, 'speaking');
  assert.equal(turn.snapshot().playbackStartedAt, null);
  advance(4); turn.playbackStarted(id); advance(5); turn.playbackStarted(id); turn.playbackFinished(id, 'completed'); turn.finish(id, 'completed');
  assert.deepEqual([turn.snapshot().actionsFinishedAt, turn.snapshot().playbackStartedAt, turn.snapshot().playbackFinishedAt], [2, 9, 14]);
});
test('a stalled stage reports a bounded terminal outcome and ignores late completion', () => {
  const { lifecycle: turn, advance, stalls, timeouts, pending } = fixture(); const id = turn.begin();
  turn.steps(id, [{ state: 'completed', command: '[OPEN_APP: Spotify]' }, { state: 'working', command: '[VOLUME_SET: 75]' }]);
  advance(11); assert.equal(stalls.length, 1); advance(89);
  assert.equal(timeouts.length, 1); assert.equal(turn.snapshot().outcome, 'timed-out');
  assert.equal(turn.snapshot().steps[0].state, 'completed');
  assert.equal(turn.finish(id, 'completed'), false); assert.equal(pending.size, 0);
});
test('cancellation and supersession cannot be overwritten by stale speech or timers', () => {
  const { lifecycle: turn, advance, timeouts } = fixture(); const old = turn.begin(); turn.finish(old, 'cancelled'); const next = turn.begin();
  turn.playbackStarted(old); turn.playbackFinished(old, 'completed'); turn.finish(old, 'completed');
  assert.equal(turn.snapshot().id, next); assert.equal(turn.snapshot().playbackStartedAt, null);
  turn.finish(next, 'failed'); advance(200); assert.equal(timeouts.length, 0); assert.equal(turn.snapshot().outcome, 'failed');
});
test('review time does not count as a stalled operation; resuming work re-arms deadline', () => {
  const { lifecycle: turn, advance, timeouts } = fixture(); const id = turn.begin(); turn.phase(id, 'awaiting-review'); advance(1000);
  assert.equal(timeouts.length, 0); turn.phase(id, 'working'); advance(100); assert.equal(timeouts.length, 1);
});
test('volume correction requires one recent explicit target and never replays other steps', () => {
  const steps = corrections.createPlan(['[OPEN_APP: Spotify]', '[VOLUME_SET: 75]']); steps[0].state = 'completed';
  const result = corrections.resolve('actually, 30%', { steps, at: 100, now: 200 });
  assert.equal(result.command, '[VOLUME_SET: 30]'); assert.equal(result.index, 1); assert.equal(steps[0].state, 'completed');
  assert.equal(corrections.resolve('30', { steps, at: 100, now: 200 }), null);
  assert.equal(corrections.resolve('actually 30', { steps: [], now: 200 }).kind, 'clarify');
  assert.equal(corrections.resolve('actually 30', { steps, at: 100, now: 70000 }).kind, 'clarify');
  assert.equal(corrections.resolve('actually 130', { steps, at: 100, now: 200 }).kind, 'clarify');
  assert.equal(corrections.resolve('actually 30', { steps: [...steps, steps[1]], at: 100, now: 200 }).kind, 'clarify');
});
test('selective timer cancellation only identifies an undispatched unambiguous step', () => {
  const steps = corrections.createPlan(['[OPEN_APP: Spotify]', '[SET_TIMER: 60, Focus]']); steps[0].state = 'completed';
  const result = corrections.resolve('Keep Spotify open, but cancel the timer', { steps, at: 1, now: 2 });
  assert.equal(result.kind, 'cancel-pending'); assert.equal(result.index, 1); assert.equal(steps[0].state, 'completed');
  steps[1].state = 'completed';
  assert.equal(corrections.resolve('cancel the timer', { steps, at: 1, now: 2 }).kind, 'clarify');
});
test('inline correction changes only the final explicit volume target', () => {
  assert.equal(corrections.inline('open Spotify and set volume to 75%, actually 30'), 'open Spotify and set volume to 30%');
  assert.equal(corrections.inline('open Spotify and volume to 75 then delete 30'), 'open Spotify and volume to 75 then delete 30');
});
