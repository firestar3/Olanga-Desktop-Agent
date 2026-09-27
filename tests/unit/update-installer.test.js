const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createInstallerLauncher } = require('../../desktop/update-installer');

const installer = path.resolve('update cache', 'Olanga-Setup-1.4.1.exe');
function fixture(overrides = {}) {
  const calls = [], children = [], scheduled = [];
  let quitCount = 0;
  const launch = createInstallerLauncher({
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
  return { launch, calls, children, scheduled, quitCount: () => quitCount };
}

test('installer launch is explicit and passes only the fixed silent update and restart switches', async () => {
  const h = fixture();
  assert.equal(h.calls.length, 0);
  assert.equal(h.scheduled.length, 0);
  const launching = h.launch(installer, '1.4.1');
  assert.deepEqual(h.calls, [{ file: installer, args: ['--updated', '/S', '--force-run'], options: { detached: true, stdio: 'ignore', windowsHide: true, shell: false } }]);
  assert.equal(h.quitCount(), 0);
  assert.equal(h.scheduled.length, 0, 'creating a child is not proof that Windows launched it');
  h.children[0].emit('spawn');
  assert.deepEqual(await launching, { launched: true, version: '1.4.1' });
  assert.equal(h.children[0].unreferenced, true);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0].delay, 300);
  assert.equal(h.quitCount(), 0, 'the renderer receives the result before shutdown');
  h.scheduled[0].callback();
  assert.equal(h.quitCount(), 1);
});

test('spawn failures leave Olanga open and allow an explicit retry', async () => {
  const h = fixture();
  const launching = h.launch(installer, '1.4.1');
  h.children[0].emit('error', Object.assign(new Error('Windows denied installer launch'), { code: 'EACCES' }));
  await assert.rejects(launching, /Windows denied/);
  h.children[0].emit('spawn');
  assert.equal(h.scheduled.length, 0);
  assert.equal(h.quitCount(), 0);
  const retry = h.launch(installer, '1.4.1');
  h.children[1].emit('spawn');
  await retry;
  assert.equal(h.calls.length, 2);
  assert.equal(h.scheduled.length, 1);
});

test('synchronous process launch errors never schedule a quit', async () => {
  let calls = 0;
  const h = fixture({ spawnImpl() { calls++; throw new Error('Cannot create process'); } });
  await assert.rejects(h.launch(installer, '1.4.1'), /Cannot create process/);
  await assert.rejects(h.launch(installer, '1.4.1'), /Cannot create process/);
  assert.equal(calls, 2);
  assert.equal(h.scheduled.length, 0);
  assert.equal(h.quitCount(), 0);
});

test('double clicks share one launch and cannot start another installer while exiting', async () => {
  const h = fixture();
  const first = h.launch(installer, '1.4.1');
  const second = h.launch(installer, '1.4.1');
  await assert.rejects(h.launch(path.resolve('Olanga-Setup-1.4.2.exe'), '1.4.2'), /already starting/);
  assert.equal(h.calls.length, 1);
  h.children[0].emit('spawn');
  assert.deepEqual(await first, await second);
  await h.launch(installer, '1.4.1');
  assert.equal(h.calls.length, 1);
  assert.equal(h.scheduled.length, 1);
});

test('malformed paths or versions cannot reach the process launcher', async () => {
  const h = fixture();
  for (const [file, version] of [
    ['relative.exe', '1.4.1'], [installer + '\n', '1.4.1'], [installer + '\0.exe', '1.4.1'],
    [path.resolve('update.cmd'), '1.4.1'], [path.resolve('other.exe'), '1.4.1'], [installer, '1.4.2'],
    [null, '1.4.1'], [installer, 'invalid'], [installer, '1.4.1-beta.1'],
  ]) await assert.rejects(h.launch(file, version), /invalid/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.scheduled.length, 0);
  assert.equal(h.quitCount(), 0);
});
