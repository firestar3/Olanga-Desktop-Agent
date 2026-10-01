const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeRuns, percentile, matchesCommands } = require('../helpers/latency-stats');
test('latency reports retain failed attempts, rate limits and slow failures in the denominator', () => {
  const summary = summarizeRuns([
    { outcome: 'completed', total: 100, marks: [{ type: 'speech', at: 60 }, { type: 'ack', at: 10 }], calls: [{ outcome: 'succeeded', status: 200 }] },
    { outcome: 'failed', total: 30000, marks: [{ type: 'speech', at: 29000 }], calls: [{ outcome: 'failed', status: 429 }] },
    { outcome: 'cancelled', total: 500, marks: [], calls: [] },
  ]);
  assert.equal(summary.attempts, 3); assert.equal(summary.completionRate, 1 / 3); assert.equal(summary.rateLimitedRuns, 1);
  assert.equal(summary.allAttemptElapsedMs.p95, 30000); assert.equal(summary.successfulOnly.firstSentenceReadyMs.p50, 60);
  assert.equal(summary.successfulOnly.firstSentenceReadyMs.samples, 1); assert.equal(summary.acousticLatencyMeasured, false);
});
test('specialist timing cannot count a wrong action or timer duration as a matching plan', () => {
  const expected = ['[MEDIA_PAUSE]', '[SET_TIMER: 1200, *]'];
  assert.equal(matchesCommands(['[MEDIA_PAUSE]', '[SET_TIMER: 1200, laundry]'], expected), true);
  assert.equal(matchesCommands(['[MEDIA_PAUSE]', '[SET_TIMER: 120, laundry]'], expected), false);
  assert.equal(matchesCommands(['[MEDIA_PAUSE]'], expected), false);
});
test('empty, unverified and unknown outcomes never manufacture success or latency samples', () => {
  assert.equal(summarizeRuns([]).completionRate, null);
  const summary = summarizeRuns([{ outcome: 'unverified', total: 200, marks: [] }, { total: 100, marks: [] }]);
  assert.equal(summary.completed, 0); assert.equal(summary.successfulOnly.totalMs.p50, null);
  assert.equal(summary.failures.unknown, 1); assert.equal(percentile([NaN, -1, null, 0, 10], .95), 10);
});
