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

test('explicit mute states and legacy toggle keep distinct native actions', async () => {
  const { controller, workers } = fixture();
  for (const action of ['VOLUME_MUTE_ON', 'VOLUME_MUTE_OFF', 'VOLUME_MUTE']) {
    const response = controller.execute({ action });
    assert.equal(workers[0].requests.at(-1).action, action);
    assert.equal(workers[0].requests.at(-1).level, undefined);
    workers[0].reply({ ok: true, verified: true, message: 'System mute state confirmed.', volume: 37, muted: action !== 'VOLUME_MUTE_OFF' });
    assert.equal((await response).verified, true);
  }
  const unverified = controller.execute({ action: 'VOLUME_MUTE_ON' });
  workers[0].reply({ ok: true, message: 'Mute request sent.' });
  assert.equal((await unverified).ok, false);
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

test('malformed native envelopes reject the request without throwing in the event handler', async () => {
  for (const envelope of [null, [], 1, 'unexpected']) {
    const { controller, workers } = fixture();
    const response = controller.execute({ action: 'STATUS' });
    const rejected = assert.rejects(response, /Unexpected media helper response/);
    assert.doesNotThrow(() => workers[0].stdout.write(JSON.stringify(envelope) + '\n'));
    await rejected;
    assert.equal(workers[0].killed, true);
    controller.dispose();
  }
});

test('a synchronous media pipe failure clears pending state and allows a fresh helper', async () => {
  const { controller, workers } = fixture();
  const first = controller.execute({ action: 'STATUS' });
  workers[0].reply({ ok: true, verified: true, message: 'A song is playing.' });
  await first;
  workers[0].stdin.write = () => { throw new Error('closed pipe'); };
  await assert.rejects(controller.execute({ action: 'PAUSE' }), /disconnected/);
  assert.equal(workers[0].killed, true);
  const retry = controller.execute({ action: 'STATUS' });
  workers[1].reply({ ok: true, verified: true, message: 'A song is playing.' });
  assert.equal((await retry).ok, true);
  controller.dispose();
});

test('disposed media controllers cannot start or reconnect a native helper', async () => {
  const { controller, workers } = fixture();
  controller.dispose();
  await assert.rejects(controller.execute({ action: 'PLAY' }), /closing/);
  assert.equal(workers.length, 0);
});

test('Windows media helper and its Core Audio interop compile without issuing any command', { skip: process.platform !== 'win32' }, () => {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // A fresh hosted Windows runner may need over 15 seconds to start PowerShell
  // and compile Add-Type. Keep the compilation check bounded without treating
  // cold CI startup as a native-helper failure; runtime action deadlines stay unchanged.
  const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(__dirname, '../../desktop/media-helper.ps1')], { input: '', encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(output.trim(), '');
});

test('native mute logic is idempotent and requires readback, using a fake audio endpoint', { skip: process.platform !== 'win32' }, () => {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helperPath = path.resolve(__dirname, '../../desktop/media-helper.ps1').replace(/'/g, "''");
  // Load only the two production PowerShell functions from their parsed AST.
  // The fake OlangaSystemAudio below has no COM implementation or OS handles,
  // so exercising these functions cannot change the machine's audio state.
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
public sealed class OlangaVolumeState {
  public double Level { get; set; }
  public bool Muted { get; set; }
}
public sealed class OlangaSystemAudio : IDisposable {
  public static bool Muted;
  public static bool IgnoreWrites;
  public static int Reads;
  public static int Writes;
  public static int Disposals;
  public OlangaVolumeState Read() { Reads++; return new OlangaVolumeState { Level = 37, Muted = Muted }; }
  public void SetMuted(bool value) { Writes++; if (!IgnoreWrites) Muted = value; }
  public void SetLevel(double value) { throw new InvalidOperationException("Mute must preserve volume"); }
  public void Dispose() { Disposals++; }
}
'@
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${helperPath}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Media helper did not parse' }
$functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Invoke-VolumeRequest', 'Invoke-MediaRequest') }, $true)
foreach ($definition in $functions) { Invoke-Expression $definition.Extent.Text }
$cases = [System.Collections.Generic.List[object]]::new()
foreach ($initial in @($false, $true)) {
  foreach ($action in @('VOLUME_MUTE_ON', 'VOLUME_MUTE_OFF')) {
    [OlangaSystemAudio]::Muted = $initial
    foreach ($attempt in @(1, 2)) {
      [OlangaSystemAudio]::Reads = 0
      [OlangaSystemAudio]::Writes = 0
      [OlangaSystemAudio]::Disposals = 0
      $receipt = Invoke-MediaRequest @{ action = $action }
      $cases.Add(@{ initial = $initial; action = $action; attempt = $attempt; receipt = $receipt; reads = [OlangaSystemAudio]::Reads; writes = [OlangaSystemAudio]::Writes; disposals = [OlangaSystemAudio]::Disposals })
    }
  }
}
[OlangaSystemAudio]::Muted = $false
$toggleFirst = Invoke-MediaRequest @{ action = 'VOLUME_MUTE' }
$toggleSecond = Invoke-MediaRequest @{ action = 'VOLUME_MUTE' }
[OlangaSystemAudio]::Muted = $false
[OlangaSystemAudio]::IgnoreWrites = $true
$failed = Invoke-MediaRequest @{ action = 'VOLUME_MUTE_ON' }
@{ cases = $cases.ToArray(); toggle = @($toggleFirst, $toggleSecond); failed = $failed } | ConvertTo-Json -Compress -Depth 8
`;
  const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const result = JSON.parse(output.trim());
  assert.equal(result.cases.length, 8);
  for (const item of result.cases) {
    assert.equal(item.receipt.ok, true);
    assert.equal(item.receipt.verified, true);
    assert.equal(item.receipt.muted, item.action === 'VOLUME_MUTE_ON', JSON.stringify(item));
    assert.equal(item.receipt.volume, 37);
    assert.ok(item.reads >= 2, 'State must be read after setting mute');
    assert.equal(item.writes, 1);
    assert.equal(item.disposals, 1);
  }
  assert.deepEqual(result.toggle.map(receipt => receipt.muted), [true, false]);
  assert.equal(result.failed.ok, false);
  assert.equal(result.failed.verified, false);
  assert.equal(result.failed.muted, false);
  assert.match(result.failed.message, /did not confirm.*mute state/);
});

test('native playback verifies the acted-on player and reports paused track changes honestly', { skip: process.platform !== 'win32' }, () => {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helperPath = path.resolve(__dirname, '../../desktop/media-helper.ps1').replace(/'/g, "''");
  // Run the actual production dispatch and verification functions against
  // in-memory player sessions. No Windows media runtime or input is loaded.
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${helperPath}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Media helper did not parse' }
$functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Wait-Playback', 'Invoke-MediaRequest') }, $true)
foreach ($definition in $functions) { Invoke-Expression $definition.Extent.Text }
$script:verifyPlayback = (Get-Command Wait-Playback).ScriptBlock
function Wait-Playback([bool]$SpotifyOnly, [string]$Expected, [string]$PreviousTitle = '', $Session = $null, [string]$PreviousArtist = '') {
  & $script:verifyPlayback $SpotifyOnly $Expected $PreviousTitle $Session $PreviousArtist 1
}
function Start-Sleep { param($Milliseconds) }
function Await-Media($Operation, [Type]$ResultType) { return [bool]$Operation }
function Get-MediaSession([bool]$SpotifyOnly) { $script:reads++; if ($script:reads -eq 1) { return $script:target }; return $script:other }
function Get-MediaState($Session) { return @{ title = $Session.title; artist = $Session.artist; status = $Session.status } }
$results = @()
foreach ($scenario in @('pause-correct', 'pause-no-change', 'paused-next', 'same-title-next', 'empty-next', 'unchanged-next', 'normal-next', 'paused-prev')) {
  $script:reads = 0
  $script:target = [pscustomobject]@{ scenario = $scenario; title = 'One'; artist = 'First Artist'; status = 'Playing'; writes = 0 }
  if ($scenario -in @('paused-next', 'paused-prev')) { $script:target.status = 'Paused' }
  if ($scenario -eq 'empty-next') { $script:target.title = ''; $script:target.artist = '' }
  $script:other = [pscustomobject]@{ title = 'Other player song'; artist = 'Other Artist'; status = 'Paused' }
  $script:target | Add-Member ScriptMethod TryPauseAsync { $this.writes++; if ($this.scenario -eq 'pause-correct') { $this.status = 'Paused' }; return $true }
  $script:target | Add-Member ScriptMethod TrySkipNextAsync { $this.writes++; if ($this.scenario -eq 'same-title-next') { $this.artist = 'Second Artist' } elseif ($this.scenario -in @('normal-next', 'paused-next')) { $this.title = 'Two' }; return $true }
  $script:target | Add-Member ScriptMethod TrySkipPreviousAsync { $this.writes++; $this.title = 'Previous'; return $true }
  $action = if ($scenario.StartsWith('pause-')) { 'PAUSE' } elseif ($scenario -eq 'paused-prev') { 'PREV' } else { 'NEXT' }
  $receipt = Invoke-MediaRequest @{ action = $action; spotifyOnly = $false }
  $results += @{ scenario = $scenario; reads = $script:reads; writes = $script:target.writes; receipt = $receipt }
}
$results | ConvertTo-Json -Compress -Depth 6
`;
  const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const results = JSON.parse(output.trim());
  assert.equal(results.length, 8);
  for (const result of results) {
    assert.equal(result.reads, 1, 'Verification cannot reacquire a different current player');
    assert.equal(result.writes, 1, 'Verification cannot resend the transport action');
    if (['pause-no-change', 'empty-next', 'unchanged-next'].includes(result.scenario)) assert.equal(result.receipt.ok, false, result.scenario);
    else { assert.equal(result.receipt.ok, true, result.scenario); assert.equal(result.receipt.verified, true); }
    if (['paused-next', 'paused-prev'].includes(result.scenario)) {
      assert.match(result.receipt.message, /Selected .*Playback is paused/);
      assert.ok(!result.receipt.message.startsWith('Playing'));
    }
  }
});
