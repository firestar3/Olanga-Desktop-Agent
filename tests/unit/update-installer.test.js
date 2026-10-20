const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createInstallerLauncher, readInstallResult } = require('../../desktop/update-installer');

const sha256 = 'a'.repeat(64);
const until = async predicate => {
  for (let index = 0; index < 200 && !predicate(); index++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(predicate(), 'Expected pending supervisor');
};
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'olanga-install-test-'));
  const cache = path.join(directory, 'update-1.5.2-abc123');
  fs.mkdirSync(cache);
  const installer = path.join(cache, 'Olanga-Setup-1.5.2.exe');
  const calls = [], children = [], scheduled = [];
  let quitCount = 0;
  const launch = createInstallerLauncher({
    appExe: path.join(directory, 'Olanga.exe'), currentVersion: '1.5.1', updatesDir: directory,
    pollMs: 2, readyTimeoutMs: 500,
    spawnImpl(file, args, options) {
      calls.push({ file, args, options });
      const child = new EventEmitter();
      child.unref = () => { child.unreferenced = true; };
      children.push(child);
      return child;
    },
    quit() { quitCount++; },
    scheduleQuit(callback, delay) { scheduled.push({ callback, delay }); },
    ...overrides,
  });
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^olanga-install-test-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function ready(index = 0, values = {}) {
    await until(() => calls.length > index);
    const request = JSON.parse(fs.readFileSync(path.join(calls[index].options.cwd, 'request.json')));
    fs.writeFileSync(path.join(calls[index].options.cwd, 'ready.json'), JSON.stringify({ token: request.token, ready: true, ...values }));
    return request;
  }
  return { launch, installer, calls, children, scheduled, ready, directory, quitCount: () => quitCount };
}

test('installer handoff waits for supervisor readiness before quitting, with a safe working directory', async t => {
  const h = fixture(t);
  const launching = h.launch(h.installer, '1.5.2', { sha256 });
  await until(() => h.calls.length);
  h.children[0].emit('spawn');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.scheduled.length, 0, 'process creation cannot prove the helper is ready');
  const call = h.calls[0];
  assert.equal(call.options.cwd.startsWith(h.directory + path.sep), true);
  assert.equal(call.options.detached, false);
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(call.options.env.NODE_OPTIONS, undefined);
  assert.match(call.options.env.PSModulePath, /WindowsPowerShell[\\/]v1\.0[\\/]Modules$/);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.args.slice(0, 7), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(call.options.cwd, 'update-supervisor.ps1')]);
  assert.ok(fs.existsSync(call.args[6]));
  const request = await h.ready();
  assert.equal(request.schema, 2);
  assert.equal(request.restartTimeoutMs, 45000);
  assert.equal(request.sha256, sha256);
  assert.equal(request.installer, h.installer);
  assert.equal(request.parentPid, process.pid);
  assert.deepEqual(await launching, { launched: true, supervised: true, version: '1.5.2' });
  assert.equal(h.children[0].unreferenced, true);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0].delay, 300);
  assert.equal(h.quitCount(), 0);
  h.scheduled[0].callback();
  assert.equal(h.quitCount(), 1);
});

test('spawn errors leave Olanga open and permit retry', async t => {
  const h = fixture(t);
  const launching = h.launch(h.installer, '1.5.2', { sha256 });
  await until(() => h.children.length);
  h.children[0].emit('error', new Error('Windows denied helper launch'));
  await assert.rejects(launching, /Windows denied/);
  assert.equal(h.quitCount(), 0);
  assert.equal(h.scheduled.length, 0);
  assert.ok(fs.existsSync(path.join(h.calls[0].options.cwd, 'cancel')));
  const retry = h.launch(h.installer, '1.5.2', { sha256 });
  await h.ready(1);
  await retry;
  assert.equal(h.scheduled.length, 1);
});

test('an early helper exit or preflight failure never closes the app', async t => {
  for (const failure of ['exit', 'preflight']) {
    const h = fixture(t);
    const launching = h.launch(h.installer, '1.5.2', { sha256 });
    await until(() => h.children.length);
    if (failure === 'exit') h.children[0].emit('exit', 1);
    else await h.ready(0, { ready: false });
    await assert.rejects(launching, /supervisor/);
    assert.equal(h.scheduled.length, 0);
    assert.equal(h.quitCount(), 0);
  }
});

test('readiness timeouts and unrelated acknowledgments cancel the helper and preserve the app', async t => {
  const h = fixture(t, { readyTimeoutMs: 50 });
  const launching = h.launch(h.installer, '1.5.2', { sha256 });
  await h.ready(0, { token: 'wrong-token' });
  await assert.rejects(launching, /did not become ready/);
  assert.ok(fs.existsSync(path.join(h.calls[0].options.cwd, 'cancel')));
  assert.equal(h.scheduled.length, 0);
});

test('double clicks share a handoff and another installation cannot race it', async t => {
  const h = fixture(t);
  const first = h.launch(h.installer, '1.5.2', { sha256 });
  const second = h.launch(h.installer, '1.5.2', { sha256 });
  await assert.rejects(h.launch(path.join(path.dirname(h.installer), 'Olanga-Setup-1.5.3.exe'), '1.5.3', { sha256 }), /already starting/);
  await h.ready();
  assert.deepEqual(await first, await second);
  assert.equal(h.calls.length, 1);
  assert.equal(h.scheduled.length, 1);
});

test('invalid, mismatched, unchecked, downgraded or out-of-cache installers cannot launch', async t => {
  const h = fixture(t);
  for (const [file, version, verification] of [
    ['relative.exe', '1.5.2', { sha256 }], [h.installer + '\n', '1.5.2', { sha256 }],
    [h.installer, '1.5.3', { sha256 }], [h.installer, 'invalid', { sha256 }],
    [h.installer, '1.5.2-beta.1', { sha256 }], [h.installer, '1.5.2', {}],
    [path.resolve('Olanga-Setup-1.5.2.exe'), '1.5.2', { sha256 }],
    [path.join(path.dirname(h.installer), 'Olanga-Setup-1.5.1.exe'), '1.5.1', { sha256 }],
  ]) await assert.rejects(h.launch(file, version, verification), /invalid/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.scheduled.length, 0);
});

test('startup receipts distinguish verified installation from failed or stale attempts without exposing paths', t => {
  const h = fixture(t);
  const resultPath = path.join(h.directory, 'install-result.json');
  const write = data => fs.writeFileSync(resultPath, JSON.stringify({ schema: 2, version: '1.5.2', rendererReady: true, stage: 'restarted', updatedAt: new Date().toISOString(), ...data }));
  assert.equal(readInstallResult(h.directory, '1.5.2'), null);
  write({});
  assert.equal(readInstallResult(h.directory, '1.5.2').ok, true);
  assert.equal(readInstallResult(h.directory, '1.5.1').ok, false);
  write({ stage: 'failed', code: 'installer-exit-code', appExe: h.directory });
  const failed = readInstallResult(h.directory, '1.5.1');
  assert.equal(failed.ok, false);
  assert.match(failed.message, /did not finish/);
  assert.equal(JSON.stringify(failed).includes(h.directory), false);
  write({ stage: 'installed' });
  assert.equal(readInstallResult(h.directory, '1.5.2').ok, false);
  assert.equal(readInstallResult(h.directory, '1.5.2').pending, true);
  write({ rendererReady: false });
  assert.equal(readInstallResult(h.directory, '1.5.2').ok, false);
  write({ schema: 1 });
  assert.equal(readInstallResult(h.directory, '1.5.2').ok, false);
  assert.match(readInstallResult(h.directory, '1.5.2').message, /older update record/);
  write({ code: 'app-ready-timeout', stage: 'failed' });
  assert.match(readInstallResult(h.directory, '1.5.2').message, /did not finish starting/);
  write({ updatedAt: '2020-01-01' });
  assert.equal(readInstallResult(h.directory, '1.5.2'), null);
  fs.writeFileSync(resultPath, 'broken');
  assert.equal(readInstallResult(h.directory, '1.5.2'), null);
});

const { parseReadinessArguments, loadReadinessChallenge, createUpdateReadiness, READINESS_PROBE } = require('../../desktop/update-readiness');
function readinessFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'olanga-readiness-test-'));
  const attemptId = 'install-attempt-abcdef', nonce = 'b'.repeat(48), token = 'c'.repeat(48);
  const attemptDir = path.join(directory, attemptId), appExe = path.join(directory, 'Olanga.exe');
  fs.mkdirSync(attemptDir);
  const argv = ['--updated', `--olanga-update-attempt=${attemptId}`, `--olanga-update-nonce=${nonce}`];
  const request = { schema: 2, token, appExe, version: '1.6.0', currentVersion: '1.5.2' };
  let challenge = { schema: 1, attemptId, nonce, requestToken: token, version: '1.6.0', mode: 'updated', createdAt: new Date().toISOString() };
  const write = changes => { challenge = { ...challenge, ...changes }; fs.writeFileSync(path.join(attemptDir, 'restart-challenge.json'), JSON.stringify(challenge)); };
  fs.writeFileSync(path.join(attemptDir, 'request.json'), JSON.stringify(request)); write({});
  let visible = true, minimized = false, loading = false, usable = false, probes = 0;
  const window = { isDestroyed: () => false, isVisible: () => visible, isMinimized: () => minimized,
    webContents: { isDestroyed: () => false, isLoading: () => loading, executeJavaScript: async source => { assert.equal(source, READINESS_PROBE); probes++; return usable; } } };
  const options = { updatesDir: directory, appExe, currentVersion: '1.6.0', getMainWindow: () => window, argv, confirmTimeoutMs: 80, pollMs: 2 };
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^olanga-readiness-test-/); fs.rmSync(directory, { recursive: true, force: true }); });
  return { ...options, options, directory, attemptDir, argv, nonce, write, window,
    set(value) { if ('visible' in value) visible = value.visible; if ('minimized' in value) minimized = value.minimized; if ('loading' in value) loading = value.loading; if ('usable' in value) usable = value.usable; },
    ack: () => fs.existsSync(path.join(attemptDir, 'app-ready.json')) ? JSON.parse(fs.readFileSync(path.join(attemptDir, 'app-ready.json'))) : null, probes: () => probes };
}
test('update launch arguments reject duplicate, ambiguous and traversal attempts', () => {
  const args = ['--updated', '--olanga-update-attempt=install-attempt-abcdef', `--olanga-update-nonce=${'a'.repeat(48)}`];
  assert.equal(parseReadinessArguments(args).mode, 'updated');
  for (const invalid of [[], args.slice(1), [...args, '--update-recovery'], [...args, args[1]], [args[0], '--olanga-update-attempt=../outside', args[2]], [args[0], args[1], '--olanga-update-nonce=bad']]) assert.equal(parseReadinessArguments(invalid), null);
});
test('readiness binds exact version, executable, fresh attempt and nonce', t => {
  const h = readinessFixture(t);
  assert.equal(loadReadinessChallenge(h.options).version, '1.6.0');
  for (const changes of [{ nonce: 'd'.repeat(48) }, { requestToken: 'e'.repeat(48) }, { version: '1.6.1' }, { mode: 'update-recovery' }, { createdAt: '2020-01-01' }, { createdAt: 'invalid' }]) {
    const previous = JSON.parse(fs.readFileSync(path.join(h.attemptDir, 'restart-challenge.json')));
    h.write(changes); assert.equal(loadReadinessChallenge(h.options), null); h.write(previous);
  }
  assert.equal(loadReadinessChallenge({ ...h.options, appExe: path.join(h.directory, 'Other.exe') }), null);
  fs.writeFileSync(path.join(h.attemptDir, 'cancel'), 'cancel');
  assert.equal(loadReadinessChallenge(h.options), null);
});
test('a surviving process, hidden/blank/loading/minimized window cannot acknowledge readiness', async t => {
  const h = readinessFixture(t), manager = createUpdateReadiness(h.options);
  for (const state of [{ usable: false }, { usable: true, visible: false }, { visible: true, loading: true }, { loading: false, minimized: true }]) {
    h.set(state);
    assert.equal((await manager.confirmReady(h.window.webContents)).ready, false);
    assert.equal(h.ack(), null);
  }
  h.set({ minimized: false });
  assert.deepEqual(await manager.confirmReady(h.window.webContents), { ready: true, version: '1.6.0' });
  assert.equal(h.ack().nonce, h.nonce); assert.equal(h.ack().rendererReady, true); assert.equal(h.ack().version, '1.6.0');
});
test('only owned renderer may acknowledge; readiness waits for actual initialization', async t => {
  const h = readinessFixture(t), manager = createUpdateReadiness(h.options);
  let completeProbe;
  h.window.webContents.executeJavaScript = source => {
    assert.equal(source, READINESS_PROBE);
    return new Promise(resolve => { completeProbe = resolve; });
  };
  await assert.rejects(manager.confirmReady({}), /main application renderer/);
  const pending = manager.confirmReady(h.window.webContents);
  assert.equal(typeof completeProbe, 'function');
  assert.equal(h.ack(), null);
  // Complete the held initialization probe directly; host scheduling must not
  // decide whether the test reaches a second poll inside its 80ms deadline.
  completeProbe(true);
  assert.equal((await pending).ready, true);
});
test('a newer launch challenge invalidates an in-flight older renderer probe', async t => {
  const h = readinessFixture(t), manager = createUpdateReadiness(h.options);
  let finish;
  h.window.webContents.executeJavaScript = () => new Promise(resolve => { finish = resolve; });
  const pending = manager.confirmReady(h.window.webContents);
  await until(() => !!finish);
  h.write({ nonce: 'f'.repeat(48) }); finish(true);
  assert.equal((await pending).ready, false); assert.equal(h.ack(), null);
  const nextArgs = h.argv.map(arg => arg.startsWith('--olanga-update-nonce=') ? `--olanga-update-nonce=${'f'.repeat(48)}` : arg);
  assert.equal(manager.acceptLaunchArguments(nextArgs), true);
  h.window.webContents.executeJavaScript = async () => true;
  assert.equal((await manager.confirmReady(h.window.webContents)).ready, true);
  assert.equal(h.ack().nonce, 'f'.repeat(48));
});
test('recovery can acknowledge the previous version but never the requested new version incorrectly', async t => {
  const h = readinessFixture(t);
  h.write({ version: '1.5.2', mode: 'update-recovery' });
  const options = { ...h.options, currentVersion: '1.5.2', argv: h.argv.map(arg => arg === '--updated' ? '--update-recovery' : arg) };
  h.set({ usable: true });
  assert.equal((await createUpdateReadiness(options).confirmReady()).ready, true);
  assert.equal(h.ack().mode, 'update-recovery'); assert.equal(h.ack().version, '1.5.2');
  assert.equal(loadReadinessChallenge({ ...options, currentVersion: '1.5.1' }), null);
});
test('an unresponsive renderer probe has a bounded deadline and writes no success', async t => {
  const h = readinessFixture(t);
  h.window.webContents.executeJavaScript = () => new Promise(() => {});
  const started = Date.now();
  assert.equal((await createUpdateReadiness(h.options).confirmReady()).ready, false);
  assert.ok(Date.now() - started < 1000);
  assert.equal(h.ack(), null);
});
test('interrupted supervisor receipts stop showing indefinite pending without claiming success', t => {
  const h = fixture(t), resultPath = path.join(h.directory, 'install-result.json');
  const receipt = (stage, age) => { fs.writeFileSync(resultPath, JSON.stringify({ schema: 2, stage, version: '1.5.2', rendererReady: false, updatedAt: new Date(Date.now() - age).toISOString() })); return readInstallResult(h.directory, '1.5.2'); };
  assert.equal(receipt('installed', 1000).pending, true);
  const interruptedStartup = receipt('installed', 150001);
  assert.equal(interruptedStartup.pending, false); assert.equal(interruptedStartup.ok, false);
  assert.match(interruptedStartup.message, /did not confirm a completed restart/);
  assert.equal(receipt('installing', 20 * 60000).pending, true, 'A Windows installer prompt can take longer than renderer startup.');
  const interruptedInstaller = receipt('installing', 31 * 60000);
  assert.equal(interruptedInstaller.pending, false); assert.equal(interruptedInstaller.ok, false);
  assert.equal(receipt('installed', -120000), null, 'Far-future timestamps cannot create indefinite pending status.');
});
