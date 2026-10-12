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
  const write = data => fs.writeFileSync(resultPath, JSON.stringify({ schema: 1, version: '1.5.2', stage: 'restarted', updatedAt: new Date().toISOString(), ...data }));
  assert.equal(readInstallResult(h.directory, '1.5.2'), null);
  write({});
  assert.equal(readInstallResult(h.directory, '1.5.2').ok, true);
  assert.equal(readInstallResult(h.directory, '1.5.1').ok, false);
  write({ stage: 'failed', code: 'installer-exit-code', appExe: h.directory });
  const failed = readInstallResult(h.directory, '1.5.1');
  assert.equal(failed.ok, false);
  assert.match(failed.message, /did not finish/);
  assert.equal(JSON.stringify(failed).includes(h.directory), false);
  write({ updatedAt: '2020-01-01' });
  assert.equal(readInstallResult(h.directory, '1.5.2'), null);
  fs.writeFileSync(resultPath, 'broken');
  assert.equal(readInstallResult(h.directory, '1.5.2'), null);
});
