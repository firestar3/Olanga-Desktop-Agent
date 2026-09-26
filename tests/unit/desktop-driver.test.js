const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createWindowsDriver } = require('../../desktop/automation');

function fixture() {
  const worker = new EventEmitter();
  worker.stdout = new PassThrough(); worker.stderr = new PassThrough(); worker.stdin = new PassThrough();
  worker.requests = []; worker.stdin.on('data', bytes => worker.requests.push(JSON.parse(bytes)));
  worker.kill = () => { worker.killed = true; };
  const driver = createWindowsDriver({ spawnProcess: (_file, args, options) => {
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.ok(args.includes('-File')); assert.ok(!args.includes('-Command'));
    return worker;
  } });
  return { driver, worker };
}

test('desktop transport rejects malformed envelopes without throwing from stdout callbacks', async () => {
  for (const value of [null, [], true, { id: 1, ok: 'true' }, { id: 1 }, { id: 999, ok: true }]) {
    const { driver, worker } = fixture();
    const pending = driver.request({ kind: 'inspect' });
    const rejected = assert.rejects(pending, /Unexpected desktop helper response/);
    assert.doesNotThrow(() => worker.stdout.write(JSON.stringify(value) + '\n'));
    await rejected;
    assert.equal(worker.killed, true);
    await assert.rejects(driver.request({ kind: 'inspect' }), /stopped/);
  }
});

test('synchronous desktop pipe failures settle and stop the helper without leaving pending input', async () => {
  const { driver, worker } = fixture();
  worker.stdin.write = () => { throw new Error('closed pipe'); };
  await assert.rejects(driver.request({ kind: 'type', text: 'fixture' }), /disconnected/);
  assert.equal(worker.killed, true);
  await assert.rejects(driver.request({ kind: 'inspect' }), /stopped/);
});

test('desktop disposal settles once even if kill fails and ignores late native output', async () => {
  const { driver, worker } = fixture();
  const pending = driver.request({ kind: 'inspect' });
  const rejected = assert.rejects(pending, /stopped/);
  worker.kill = () => { throw new Error('already exited'); };
  assert.doesNotThrow(() => driver.dispose());
  await rejected;
  assert.doesNotThrow(() => worker.stdout.write('null\n'));
  assert.doesNotThrow(() => worker.emit('exit', 0));
});

test('desktop transport handles complete receipts and does not queue overlapping input', async () => {
  const { driver, worker } = fixture();
  const pending = driver.request({ kind: 'inspect' });
  await assert.rejects(driver.request({ kind: 'type', text: 'second' }), /already pending/);
  worker.stdout.write(JSON.stringify({ id: worker.requests[0].id, ok: true, result: { windows: [] } }) + '\n');
  assert.deepEqual(await pending, { windows: [] });
  assert.equal(worker.requests.length, 1);
  driver.dispose();
});
