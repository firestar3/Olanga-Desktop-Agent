const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { createMediaController, normalizeMediaRequest } = require('../../desktop/media-controller');

function fixture(options = {}) {
  const workers = [];
  const controller = createMediaController({ platform: 'win32', ...options, spawnProcess(executable, args, spawnOptions) {
    assert.equal(spawnOptions.shell, false);
    assert.equal(spawnOptions.windowsHide, true);
    assert.ok(args.includes('-File'));
    const worker = new EventEmitter();
    worker.stdout = new PassThrough(); worker.stderr = new PassThrough(); worker.stdin = new PassThrough();
    worker.requests = []; worker.stdin.on('data', data => worker.requests.push(JSON.parse(data)));
    worker.kill = () => { worker.killed = true; };
    worker.reply = result => worker.stdout.write(JSON.stringify({ id: worker.requests.at(-1).id, result }) + '\n');
    workers.push(worker);
    return worker;
  } });
  return { controller, workers };
}

test('native results are awaited, and a warm helper serves the next request', async () => {
  const { controller, workers } = fixture();
  const first = controller.execute({ action: 'LIKED' });
  const receipt = { ok: true, verified: true, message: 'Your liked songs are playing now.' };
  workers[0].reply(receipt);
  assert.deepEqual(await first, receipt);
  const second = controller.execute({ action: 'PAUSE' });
  workers[0].reply({ ok: true, verified: true, message: 'Playback paused.' });
  await second;
  assert.equal(workers.length, 1);
  controller.dispose();
});

test('cancellation kills only this helper and an old exit cannot kill its replacement', async () => {
  const { controller, workers } = fixture();
  const first = controller.execute({ action: 'LIKED' });
  controller.cancel();
  await assert.rejects(first, /cancelled/);
  assert.equal(workers[0].killed, true);
  const second = controller.execute({ action: 'PAUSE' });
  workers[0].emit('exit');
  workers[1].reply({ ok: true, verified: true, message: 'Paused.' });
  assert.equal((await second).ok, true);
  controller.dispose();
});

test('a stalled helper times out and overlapping commands cannot be queued accidentally', async () => {
  const { controller, workers } = fixture({ timeoutMs: 10 });
  const pending = controller.execute({ action: 'LIKED' });
  await assert.rejects(controller.execute({ action: 'NEXT' }), /still running/);
  await assert.rejects(pending, /too long/);
  assert.equal(workers[0].killed, true);
});

test('absolute volume accepts numeric percentages only and carries the exact target to Windows', async () => {
  for (const level of [undefined, null, '75', NaN, Infinity, -1, 101]) {
    assert.throws(() => normalizeMediaRequest({ action: 'VOLUME_SET', level }), /between 0 and 100/);
  }
  assert.equal(normalizeMediaRequest({ action: 'VOLUME_SET', level: 0 }).level, 0);
  assert.equal(normalizeMediaRequest({ action: 'VOLUME_SET', level: 100 }).level, 100);
  const { controller, workers } = fixture();
  const response = controller.execute({ action: 'VOLUME_SET', level: 75 });
  assert.equal(workers[0].requests[0].level, 75);
  workers[0].reply({ ok: true, verified: true, message: 'System volume is 75%.', volume: 75, muted: false });
  assert.equal((await response).volume, 75);
  controller.dispose();
});

test('launch acknowledgement cannot masquerade as verified completion', async () => {
  const { controller, workers } = fixture();
  const response = controller.execute({ action: 'OPEN' });
  assert.equal(workers[0].requests[0].spotifyOnly, true);
  workers[0].reply({ ok: true, message: 'Launch request sent.' });
  const result = await response;
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.match(result.message, /did not verify/);
  controller.dispose();
});

test('verified launch is followed by a separately awaited volume result', async () => {
  const { controller, workers } = fixture();
  const launch = controller.execute({ action: 'OPEN' });
  workers[0].reply({ ok: true, verified: true, message: 'Spotify is open.', processId: 123 });
  assert.equal((await launch).verified, true);
  let completed = false;
  const volume = controller.execute({ action: 'VOLUME_SET', level: 75 }).then(result => { completed = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  const failedReadback = { ok: false, verified: false, message: 'Windows did not confirm the requested volume.', volume: 40, muted: false };
  workers[0].reply(failedReadback);
  assert.deepEqual(await volume, failedReadback);
  controller.dispose();
});

test('malformed native result rejects instead of producing a silent success', async () => {
  const { controller, workers } = fixture();
  const response = controller.execute({ action: 'VOLUME_STATUS' });
  workers[0].reply({ verified: true });
  await assert.rejects(response, /Invalid media helper result/);
  controller.dispose();
});

test('Windows media helper and its Core Audio interop compile without issuing any command', { skip: process.platform !== 'win32' }, () => {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // A fresh hosted Windows runner may need over 15 seconds to start PowerShell
  // and compile Add-Type. Keep the compilation check bounded without treating
  // cold CI startup as a native-helper failure; runtime action deadlines stay unchanged.
  const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(__dirname, '../../desktop/media-helper.ps1')], { input: '', encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(output.trim(), '');
});
