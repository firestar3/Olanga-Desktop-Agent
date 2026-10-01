// Real packaged-binary profile compatibility, never an installer test. Both
// executables use the same freshly generated fixture profile, not a user profile.
// Usage: node tests/profile-upgrade-smoke.js [--seed-only | --resume]
// Optional: OLANGA_UPGRADE_OLD_EXE, OLANGA_UPGRADE_NEW_EXE and matching *_VERSION.
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build', 'qa');
fs.mkdirSync(output, { recursive: true });
const seedFile = path.join(output, 'profile-upgrade-seed.json');
const reportFile = path.join(output, 'profile-upgrade-smoke.json');
const seedOnly = process.argv.includes('--seed-only');
const resume = process.argv.includes('--resume');
const oldExe = path.resolve(process.env.OLANGA_UPGRADE_OLD_EXE || path.join(root, 'dist', 'win-unpacked', 'Olanga.exe'));
const newExe = path.resolve(process.env.OLANGA_UPGRADE_NEW_EXE || path.join(root, process.env.OLANGA_BUILD_DIR || 'dist/next-level', 'win-unpacked', 'Olanga.exe'));
const oldVersion = process.env.OLANGA_UPGRADE_OLD_VERSION || '1.4.1';
const newVersion = process.env.OLANGA_UPGRADE_NEW_VERSION || require('../package.json').version;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exited = child => child.exitCode !== null || child.signalCode !== null;
const report = {
  passed: false, oldExecutable: oldExe, newExecutable: newExe, oldVersion, newVersion,
  coverage: { packagedBinaries: true, sameDisposableProfile: true, securePreferences: true,
    localTimers: true, tasks: true, aliases: true, routines: true, explicitMemories: true,
    interruptedRoutineRecovery: true, installerUpgrade: false, installedUserProfile: false,
    liveMicrophone: false, liveProviders: false }, checks: [], stages: []
};
let profile, fixtureId, active;
function check(name, condition) {
  report.checks.push({ name, passed: !!condition });
  assert.ok(condition, name);
}
function same(name, actual, expected) {
  try { assert.deepEqual(actual, expected); report.checks.push({ name, passed: true }); }
  catch (error) { report.checks.push({ name, passed: false }); throw new Error(name + ': ' + error.message); }
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function verifyFixture() {
  // --resume is intentionally unable to name an installed or arbitrary profile.
  assert.equal(path.dirname(profile).toLowerCase(), output.toLowerCase(), 'Fixture must be directly inside build/qa');
  assert.match(path.basename(profile), /^upgrade-profile-[A-Za-z0-9]+$/);
  assert.equal(fs.readFileSync(path.join(profile, '.olanga-upgrade-fixture'), 'utf8'), fixtureId);
}
async function launch(executable, expectedVersion, label) {
  verifyFixture();
  assert.ok(fs.existsSync(executable), 'Missing packaged executable: ' + executable);
  const port = await freePort();
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, ['--hidden', '--disable-gpu', '--user-data-dir=' + profile,
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
    // A regression may request input; it must never open the user's real mic.
    '--use-fake-device-for-media-stream', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment });
  const instance = { label, child, socket: null, log: '', sequence: 0, pending: new Map(), networkRequests: [], launchError: null };
  active = instance;
  child.stdout.on('data', value => { instance.log += value; });
  child.stderr.on('data', value => { instance.log += value; });
  child.on('error', error => { instance.launchError = error.message; });
  let target;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (instance.launchError || exited(child)) throw new Error(instance.launchError || label + ' exited before inspection');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      target = (await response.json()).find(item => /app\.asar[\\/]index\.html$/.test(item.url));
    } catch (_) { /* The private debugging endpoint is still starting. */ }
    if (target && instance.log.includes('[Main] userData: ' + profile)) break;
    await pause(100);
  }
  check(label + ': executable uses only the fixture profile', instance.log.includes('[Main] userData: ' + profile));
  check(label + ': packaged renderer loaded from app.asar', !!target?.webSocketDebuggerUrl);
  const socket = instance.socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url)) {
      instance.networkRequests.push({ url: message.params.request.url, method: message.params.request.method, type: message.params.type });
    }
    const item = instance.pending.get(message.id);
    if (!item) return;
    instance.pending.delete(message.id);
    message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
  });
  instance.send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++instance.sequence;
    const timer = setTimeout(() => { instance.pending.delete(id); reject(new Error(label + ': ' + method + ' timed out')); }, 10000);
    instance.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  instance.evaluate = async expression => {
    const result = await instance.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  await instance.send('Network.enable');
  await instance.send('Page.enable');
  await instance.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
  // Capture requests from the start of the controlled reload as well. These
  // wrappers observe the real renderer without replacing application behavior.
  await instance.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.__upgradeSmoke = { microphoneRequests: 0, playbackRequests: 0 };
    if (navigator.mediaDevices?.getUserMedia) {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (...args) => { window.__upgradeSmoke.microphoneRequests++; return original(...args); };
    }
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) { window.__upgradeSmoke.playbackRequests++; return play.apply(this, args); };
    const speak = speechSynthesis.speak.bind(speechSynthesis);
    speechSynthesis.speak = (...args) => { window.__upgradeSmoke.playbackRequests++; return speak(...args); };
  })();` });
  await ready(instance);
  const info = await instance.evaluate('window.electronAPI.getAppInfo()');
  check(label + ': actual packaged version is ' + expectedVersion, info.packaged === true && info.version === expectedVersion);
  const isolated = await instance.evaluate(`({ node: typeof process, require: typeof require })`);
  check(label + ': renderer retains Node isolation', isolated.node === 'undefined' && isolated.require === 'undefined');
  return instance;
}
async function ready(instance) {
  let lastError;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      if (await instance.evaluate(`typeof persistAppPreferences === 'function' && !!window.OlangaWorkspace && document.querySelectorAll('#quickActionsEditor fieldset').length === 5`)) return;
    } catch (error) { lastError = error; }
    await pause(100);
  }
  throw new Error(instance.label + ': renderer did not initialize' + (lastError ? ': ' + lastError.message : ''));
}
async function reload(instance) {
  await instance.send('Page.reload');
  // Prevent accepting the old document's ready state before the navigation.
  await pause(300);
  await ready(instance);
  check(instance.label + ': controlled reload installed boot observation hooks', !!await instance.evaluate('window.__upgradeSmoke'));
}
async function stop(instance) {
  if (!instance) return;
  // Let Chromium flush profile storage; Browser.close only targets this CDP
  // connection. Some Electron builds do not implement it, hence the PID fallback.
  if (instance.socket?.readyState === WebSocket.OPEN) {
    const id = ++instance.sequence;
    instance.socket.send(JSON.stringify({ id, method: 'Browser.close' }));
    for (let attempt = 0; attempt < 20 && !exited(instance.child); attempt++) await pause(100);
    instance.socket.close();
  }
  if (!exited(instance.child) && instance.child.pid) {
    await new Promise((resolve, reject) => {
      const stopper = spawn('taskkill.exe', ['/PID', String(instance.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      stopper.once('error', reject); stopper.once('exit', resolve);
    });
    for (let attempt = 0; attempt < 30 && !exited(instance.child); attempt++) await pause(100);
  }
  for (const item of instance.pending.values()) item.reject(new Error('Fixture process closed'));
  instance.pending.clear();
  fs.writeFileSync(path.join(output, 'profile-upgrade-' + instance.label + '.log'), instance.log);
  report.stages.push({ label: instance.label, pid: instance.child.pid, exited: exited(instance.child), exitCode: instance.child.exitCode, signalCode: instance.child.signalCode, rendererNetworkRequests: instance.networkRequests });
  if (active === instance) active = null;
  assert.ok(exited(instance.child), 'Spawned fixture did not exit');
}
const snapshotExpression = `(async () => ({
  localSetup: localStorage.getItem('olanga_local_setup'),
  localPreferences: readPrefsFromLocalStorage(),
  securePreferences: JSON.parse(await window.electronAPI.secureStoreGet('app_preferences')),
  workspace: window.OlangaWorkspace.snapshot(),
  savedWorkspace: JSON.parse(localStorage.getItem('olanga_productivity_v1')),
  savedTimers: JSON.parse(localStorage.getItem('olanga_timers')),
  savedTasks: JSON.parse(localStorage.getItem('olanga_tasks')),
  timers: activeTimers.map(({ id, endTime, label, kind, ringing }) => ({ id, endTime, label, kind, ringing })),
  tasks: activeTasks
}))()`;
async function quiet(instance, expectedVersion) {
  const state = await instance.evaluate(`(async () => ({
    visible: !document.getElementById('mainScreen').classList.contains('hidden'),
    apiKey: !!apiKey, mic: !!micStream, assistantIdle: currentState === State.IDLE,
    provider: await window.electronAPI.providerStatus(),
    update: await window.electronAPI.getUpdateState(),
    observations: window.__upgradeSmoke || null,
    phone: window.electronAPI.phoneStatus ? await window.electronAPI.phoneStatus() : null,
    schedules: window.OlangaScheduleStore ? window.OlangaScheduleStore.snapshot() : null,
    turnSupported: !!window.OlangaTurns,
    turn: window.OlangaTurns ? window.OlangaTurns.snapshot() : null
  }))()`);
  check(instance.label + ': keyless local setup opens without microphone or assistant work', state.visible && !state.apiKey && !state.mic && state.assistantIdle);
  check(instance.label + ': no saved provider key or provider requests', state.provider.configured === false && state.provider.totals.requests === 0);
  check(instance.label + ': manual updater remains unchecked and idle', state.update.installedVersion === expectedVersion && state.update.phase === 'idle' && state.update.status === 'not-checked' && !state.update.canDownload && !state.update.canInstall && state.update.bytesReceived === 0 && state.update.automaticUpdatesEnabled === false);
  if (state.observations) check(instance.label + ': observed boot requests no microphone or playback', state.observations.microphoneRequests === 0 && state.observations.playbackRequests === 0);
  if (state.phone) check(instance.label + ': phone remote remains off without pairing', state.phone.active === false && state.phone.sessions === 0);
  if (state.schedules) check(instance.label + ': upgrade adds no schedules or notifications', state.schedules.items.length === 0 && state.schedules.deliveries.length === 0);
  if (state.turnSupported) check(instance.label + ': upgrade starts no assistant turn', state.turn === null);
  // 1.4.1 references a static Google Fonts stylesheet. It is blocked by the
  // fixture and recorded, but is not a provider/action request.
  check(instance.label + ': no renderer provider or action network requests', instance.networkRequests.every(item => /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(item.url) && ['Stylesheet', 'Font'].includes(item.type)));
  return state;
}
async function seedOld() {
  const old = await launch(oldExe, oldVersion, 'old');
  const seeded = await old.evaluate(`(async () => {
    document.getElementById('startLocalBtn').click();
    const preferences = { ...readPrefsFromLocalStorage(), city: 'Upgrade Fixture City', state: 'Fixture State', country: 'Fixture Country',
      ttsEngine: 'windows', ttsRate: 1.2, statusLightMode: 'off', statusLightSize: 'large', statusLightSizeV2: true,
      bargeIn: false, streamReplies: false, endOfSpeech: 'quick', pushToTalk: 'off', features: ['notepadScreen'], keyRotation: false,
      customWakeWordGroups: [{ id: 'upgrade-wake', label: 'fixture assistant', phrases: ['fixture assistant', 'hello fixture'], createdAt: 1700000000000 }] };
    preferences.quickActions = preferences.quickActions.map((item, index) => index === 0 ? { ...item, label: 'Review fixture tasks', prompt: 'show my tasks' } : item);
    await persistAppPreferences(preferences); applyPrefsToRuntime(preferences);
    const created = [createTimer(7 * 24 * 60 * 60, 'Upgrade timer — preserve deadline'),
      addTask('Upgrade task — review notes', '2099-11-04'), addTask('Upgrade completed task')];
    const completion = completeTask('Upgrade completed task', true);
    const store = window.OlangaWorkspace;
    store.preference('memoryEnabled', true); store.preference('saveActivity', true); store.preference('diagnostics', true);
    store.preference('speechInput', 'cloud'); store.preference('factsEnabled', true);
    store.remember('aliases', 'work browser', 'Chrome'); store.remember('playlists', 'study music', 'Instrumental Focus');
    store.rememberFact('My preferred study block is forty minutes.');
    const routine = store.saveRoutine({ name: 'Upgrade study routine', lines: ['set a timer for five minutes', 'set a timer for ten minutes'] }, OlangaIntents.parse);
    const actions = routine.lines.flatMap(line => OlangaIntents.parse(line, store.options()));
    const run = store.createRun(routine, actions);
    // This is persisted metadata only. No routine command is dispatched.
    store.transitionRun(run.id, 0, 'completed'); store.transitionRun(run.id, 1, 'working');
    const activity = store.begin(); store.plan(activity, ['SET_TIMER', 'SET_TIMER']);
    store.step(activity, 'SET_TIMER'); store.receipt(activity, 0, 'completed'); store.step(activity, 'SET_TIMER');
    store.timing('execution', 37, 'ok');
    return { created: created.every(item => item.ok), completion: completion.ok, runId: run.id };
  })()`);
  check('1.4.1: native local-data APIs successfully seeded the profile', seeded.created && seeded.completion);
  await reload(old);
  const baseline = await old.evaluate(snapshotExpression);
  check('1.4.1: timer, incomplete task and completed task survive reload', baseline.savedTimers.length === 1 && baseline.tasks.length === 2 && baseline.tasks.filter(item => item.completed).length === 1);
  const run = baseline.workspace.runs.find(item => item.id === seeded.runId);
  check('1.4.1: interrupted routine preserves completion and marks in-flight step uncertain', run?.state === 'interrupted' && run.steps[0].state === 'completed' && run.steps[1].state === 'uncertain');
  const observations = await quiet(old, oldVersion);
  await stop(old);
  const seed = { profile, fixtureId, oldVersion, baseline, observations, checks: [...report.checks], stages: [...report.stages], createdAt: new Date().toISOString() };
  fs.writeFileSync(seedFile, JSON.stringify(seed, null, 2));
  return seed;
}
async function upgrade(seed) {
  const next = await launch(newExe, newVersion, 'new');
  const initial = await next.evaluate(snapshotExpression);
  same('New packaged build preserves every seeded record and preference on first launch', initial, seed.baseline);
  await quiet(next, newVersion);
  await reload(next);
  // Observe the schedule interval and normal post-boot initialization, then
  // ensure pending metadata has not become work or created extra local records.
  await pause(5500);
  const restored = await next.evaluate(snapshotExpression);
  same('New packaged build preserves all IDs, deadlines, completed steps and settings after reload', restored, seed.baseline);
  report.upgradedObservations = await quiet(next, newVersion);
  report.recordCounts = { timers: restored.timers.length, tasks: restored.tasks.length, routines: restored.workspace.routines.length,
    aliases: restored.workspace.aliases.length, playlists: restored.workspace.playlists.length, facts: restored.workspace.facts.length,
    interruptedRuns: restored.workspace.runs.filter(run => run.state === 'interrupted').length };
  await stop(next);
}
(async () => {
  let deadline;
  try {
    assert.equal(process.platform, 'win32', 'This test exercises Windows packaged executables');
    assert.ok(!(seedOnly && resume), 'Choose --seed-only or --resume');
    const work = async () => {
      let seed;
      if (resume) {
        seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
        profile = seed.profile; fixtureId = seed.fixtureId; verifyFixture();
        assert.equal(seed.oldVersion, oldVersion);
        report.checks.push(...(seed.checks || [])); report.stages.push(...(seed.stages || []));
      } else {
        profile = fs.mkdtempSync(path.join(output, 'upgrade-profile-')); fixtureId = crypto.randomUUID();
        fs.writeFileSync(path.join(profile, '.olanga-upgrade-fixture'), fixtureId);
      }
      report.isolatedProfile = profile;
      if (!seed) seed = await seedOld();
      if (!seedOnly) await upgrade(seed);
      report.seedOnly = seedOnly;
      report.passed = true;
    };
    await Promise.race([work(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Profile upgrade fixture exceeded 120 seconds')), 120000); })]);
  } catch (error) { report.error = error.message; }
  finally {
    clearTimeout(deadline);
    try { await stop(active); } catch (error) { report.passed = false; report.stopError = error.message; }
    report.finishedAt = new Date().toISOString();
    report.limitation = 'Validates real packaged-binary profile compatibility only; does not validate NSIS installation, in-place installer upgrade, or live provider/microphone behavior.';
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(`Profile upgrade ${report.passed ? seedOnly ? 'seeded' : 'passed' : 'failed'}: ${reportFile}`);
    if (report.error) console.error(report.error);
    process.exitCode = report.passed ? 0 : 1;
  }
})();
