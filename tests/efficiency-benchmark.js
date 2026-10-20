'use strict';
// Fixture-only component timings; not end-to-end voice latency or process CPU/RAM.
// Usage: node tests/efficiency-benchmark.js [baseline-ref] [--save]
// Tiny smoke: OLANGA_EFFICIENCY_ITERATIONS=2, OLANGA_EFFICIENCY_ROUNDS=1,
// OLANGA_EFFICIENCY_WARMUP=1 (set using your shell's environment syntax).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
const files = ['shared/fast-intents.js', 'shared/memory-learning.js', 'shared/productivity.js'];

function integerSetting(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  assert(Number.isInteger(value) && value >= minimum && value <= maximum, `${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}
function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}
function loadModules(sources, label) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    const requireFixture = name => {
      assert.equal(name, './memory-learning', `Unexpected dependency in benchmark module: ${name}`);
      return load('shared/memory-learning.js');
    };
    // Both revisions use the same VM loading path and standard built-ins. Only
    // these reviewed pure modules are evaluated; no Electron or app bootstrap.
    new vm.Script(sources[file], { filename: `${label}/${file}` }).runInNewContext({ module, exports: module.exports, require: requireFixture }, { timeout: 5000 });
    cache.set(file, module.exports);
    return module.exports;
  }
  return { intents: load(files[0]), store: load(files[2]) };
}
function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}
function summary(values) {
  return { medianMs: median(values), minMs: Math.min(...values), maxMs: Math.max(...values) };
}
function result(name, before, after, extra = {}) {
  const baseline = summary(before), current = summary(after);
  return { name, baseline, current, reductionPercent: baseline.medianMs ? 100 * (1 - current.medianMs / baseline.medianMs) : null, ...extra };
}
function compare(name, before, after, config, operationsPerIteration = 1) {
  for (let i = 0; i < config.warmup; i++) {
    if (i % 2) { after(i); before(i); } else { before(i); after(i); }
  }
  const samples = { before: [], after: [] };
  for (let round = 0; round < config.rounds; round++) {
    const order = round % 2 ? [['after', after], ['before', before]] : [['before', before], ['after', after]];
    for (const [label, callback] of order) {
      const start = performance.now();
      for (let i = 0; i < config.iterations; i++) callback(i);
      samples[label].push((performance.now() - start) / (config.iterations * operationsPerIteration));
    }
  }
  return result(name, samples.before, samples.after, { samples: config.rounds, operationsPerIteration });
}
function fixture(api, encoded) {
  let writes = 0;
  const values = new Map([[api.KEY, encoded]]);
  return { store: api.createStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { writes++; values.set(key, value); } }), writes: () => writes };
}
function activityTurn(store) {
  const id = store.begin();
  store.plan(id, ['OPEN_APP', 'VOLUME_SET']);
  for (const operation of ['OPEN_APP', 'VOLUME_SET']) store.receipt(id, store.step(id, operation), 'completed');
  store.finish(id, 'completed');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node tests/efficiency-benchmark.js [baseline-ref] [--save]\nDefault baseline: bf68716. --save writes build/qa/efficiency-benchmark.json.\nSettings: OLANGA_EFFICIENCY_ITERATIONS (750), OLANGA_EFFICIENCY_ROUNDS (9), OLANGA_EFFICIENCY_WARMUP (250).\nRequires local Git history. No fetch, network, providers, microphone, keys, or real app actions.');
    return;
  }
  assert(args.filter(arg => arg === '--save').length <= 1, 'Use --save only once.');
  const refs = args.filter(arg => arg !== '--save');
  assert(refs.length <= 1 && refs.every(ref => ref && !ref.startsWith('-')), 'Expected one optional baseline ref and --save.');
  const ref = refs[0] || 'bf68716';
  const config = {
    iterations: integerSetting('OLANGA_EFFICIENCY_ITERATIONS', 750, 1, 100000),
    rounds: integerSetting('OLANGA_EFFICIENCY_ROUNDS', 9, 1, 99),
    warmup: integerSetting('OLANGA_EFFICIENCY_WARMUP', 250, 0, 10000)
  };
  let commit;
  try { commit = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]); }
  catch { throw new Error(`Baseline ${JSON.stringify(ref)} is not a local commit. Use a checkout containing that history or choose another local ref.`); }
  assert.match(commit, /^[0-9a-f]{40,64}$/i);
  const priorSources = Object.fromEntries(files.map(file => [file, git(['show', `${commit}:${file}`])]));
  const currentSources = Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  const before = loadModules(priorSources, commit), after = loadModules(currentSources, 'working-tree');
  const parserCases = {
    common: ['open Chrome', 'Play Spotify and raise the volume to 75%', 'what time is it', 'set a timer for one hour and thirty minutes', 'play artist "Earth, Wind and Fire" and set volume to 75%', 'set a timer for 5 minutes called Tea', 'How do I write a cover letter?', 'What are the tradeoffs between SQLite and Postgres for a small business app?', 'The website says play my liked songs'],
    single: ['open Chrome', 'set a timer for five minutes', 'what time is it', 'pause the music', 'What are the tradeoffs between SQLite and Postgres?'],
    compound: ['Play Spotify and raise the volume to 75%', 'set a timer for one hour and thirty minutes and open Chrome', 'open Chrome and volume up and play music and pause music', 'play artist "Earth, Wind and Fire" and set volume to 75%'],
    long: ['a'.repeat(1000), 'An ordinary question about productivity and careful planning '.repeat(16)]
  };
  // These established parser fixtures must represent the same work on both refs.
  for (const query of Object.values(parserCases).flat()) assert.equal(JSON.stringify(after.intents.parse(query)), JSON.stringify(before.intents.parse(query)), `Parser fixture differs between refs: ${query.slice(0, 100)}`);
  const results = Object.entries(parserCases).map(([name, queries]) => compare(`parser.${name}`, () => { for (const query of queries) before.intents.parse(query); }, () => { for (const query of queries) after.intents.parse(query); }, config, queries.length));

  const facts = ['My name is Morgan', 'I live in Seattle', 'I prefer Celsius', 'I prefer metric units', 'I prefer concise answers', 'My favorite color is blue', 'I prefer jazz music', ...Array.from({ length: 43 }, (_, i) => `Project ${i} launch planning session is Friday in room ${i + 2}`)].map((text, i) => ({ id: `fact-${i}`, text, at: i }));
  const profile = { ...before.store.defaults(), facts, activity: Array.from({ length: 40 }, (_, i) => ({ id: `activity-${i}`, at: i, state: 'completed', steps: Array.from({ length: 16 }, () => ({ operation: 'OPEN_APP', state: 'completed' })) })), timings: Array.from({ length: 200 }, () => ({ phase: 'total', ms: 20, outcome: 'ok' })), diagnostics: true, saveActivity: true };
  const encoded = JSON.stringify(profile);
  const oldStore = fixture(before.store, encoded).store, newStore = fixture(after.store, encoded).store;
  assert.equal(oldStore.snapshot().facts.length, 50); assert.equal(newStore.snapshot().facts.length, 50);
  const queries = ['What is the weather here?', 'When is project 12 launch?', 'Recommend some music for work', 'What is my name?', 'How many miles is that distance?', 'Help me choose a theme', 'What is the weather in Paris?', 'Explain the forecast in detail'];
  results.push(compare('memory.relevant-context.warm', i => oldStore.relevantContext(queries[i % queries.length]), i => newStore.relevantContext(queries[i % queries.length]), config));
  const memoryFacts = store => (typeof store.memorySnapshot === 'function' ? store.memorySnapshot() : store.snapshot()).facts;
  results.push(compare('memory.facts-snapshot', () => memoryFacts(oldStore), () => memoryFacts(newStore), config));
  const activityEncoded = JSON.stringify({ ...profile, saveActivity: false, activity: [], diagnostics: false, timings: [] });
  const oldActivity = fixture(before.store, activityEncoded), newActivity = fixture(after.store, activityEncoded);
  const activity = compare('store.session-only-two-action-turn', () => activityTurn(oldActivity.store), () => activityTurn(newActivity.store), config);
  const turns = config.warmup + config.rounds * config.iterations;
  activity.storageWritesPerTurnIncludingWarmup = { baseline: oldActivity.writes() / turns, current: newActivity.writes() / turns };
  results.push(activity);

  // Include first-use cost rather than reporting only the favorable warm path.
  // Store construction happens before the clock starts for each independent call.
  const cold = { before: [], after: [] }, coldSamples = Math.min(config.iterations, 500);
  for (let i = 0; i < coldSamples; i++) {
    const order = i % 2 ? [['after', after.store], ['before', before.store]] : [['before', before.store], ['after', after.store]];
    for (const [label, api] of order) {
      const store = fixture(api, encoded).store;
      const start = performance.now();
      store.relevantContext(queries[i % queries.length]);
      cold[label].push(performance.now() - start);
    }
  }
  results.push(result('memory.relevant-context.first-use', cold.before, cold.after, { samples: coldSamples, storeConstructionExcluded: true }));
  const hashes = sources => Object.fromEntries(files.map(file => [file, createHash('sha256').update(sources[file]).digest('hex')]));
  const report = {
    node: process.version, platform: process.platform, architecture: process.arch, baseline: { ref, commit, hashes: hashes(priorSources) },
    current: { source: 'working-tree', head: git(['rev-parse', 'HEAD']), hashes: hashes(currentSources) }, config, units: 'milliseconds per operation',
    methodology: 'Pure synthetic fixtures, warmed paired batches with alternating order. Cold retrieval uses fresh stores with setup excluded. Map storage; no network, providers, microphone, keys, or real actions.',
    limitations: ['Local component timings are not end-to-end speech latency or whole-app CPU/RAM.', 'Facts snapshot measures the old full-profile path versus the available memory-only path.', 'Results vary with Node version, machine load, GC and power settings; tiny smoke settings are not performance evidence.', 'Cold indexing cost is reported separately; semantic correctness is covered by unit tests, not timings.'], results
  };
  if (args.includes('--save')) {
    const directory = path.join(root, 'build', 'qa');
    fs.mkdirSync(directory, { recursive: true });
    assert(fs.realpathSync(directory).startsWith(fs.realpathSync(root) + path.sep), 'Benchmark output must stay in this checkout.');
    fs.writeFileSync(path.join(directory, 'efficiency-benchmark.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report));
}
try { main(); } catch (error) { console.error(`Efficiency benchmark: ${error.message}`); process.exitCode = 1; }
