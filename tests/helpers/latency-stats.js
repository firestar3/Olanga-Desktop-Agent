'use strict';
function percentile(values, fraction) {
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
}
function summarizeRuns(runs) {
  const success = run => !run.error && run.outcome === 'completed';
  const successful = runs.filter(success);
  const metric = (items, get) => { const values = items.map(get).filter(Number.isFinite); return { samples: values.length, p50: percentile(values, .5), p95: percentile(values, .95) }; };
  const failures = {};
  for (const run of runs.filter(run => !success(run))) { const category = run.error ? 'error' : run.outcome || 'unknown'; failures[category] = (failures[category] || 0) + 1; }
  return {
    attempts: runs.length, completed: successful.length, incomplete: runs.length - successful.length,
    completionRate: runs.length ? successful.length / runs.length : null, failures,
    providerFailureRuns: runs.filter(run => run.calls?.some(call => call.outcome === 'failed' || call.outcome === 'cancelled')).length,
    rateLimitedRuns: runs.filter(run => run.calls?.some(call => call.status === 429)).length,
    allAttemptElapsedMs: metric(runs, run => run.total),
    acknowledgmentMs: metric(runs, run => run.marks?.find(mark => mark.type === 'ack')?.at),
    successfulOnly: {
      firstSentenceReadyMs: metric(successful, run => run.marks?.find(mark => mark.type === 'speech')?.at),
      transcriptMs: metric(successful, run => run.marks?.find(mark => mark.type === 'transcript')?.at),
      totalMs: metric(successful, run => run.total),
    },
    acousticLatencyMeasured: false,
  };
}
function matchesCommands(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length && expected.every((value, index) => {
    const pattern = value.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp('^' + pattern + '$').test(actual[index]);
  });
}
module.exports = { percentile, summarizeRuns, matchesCommands };
