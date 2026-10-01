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

test('Spotify resume preserves caller deadlines and a timed-out helper cannot block a following volume request', async () => {
  const { controller, workers } = fixture({ timeoutMs: 10 });
  await assert.rejects(controller.execute({ action: 'PLAY', spotifyOnly: true }), /too long/);
  assert.equal(workers[0].killed, true);
  const volume = controller.execute({ action: 'VOLUME_SET', level: 75 });
  workers[0].stdout.write(JSON.stringify({ id: workers[0].requests[0].id, result: { ok: true, verified: true, message: 'Late playback.' } }) + '\n');
  workers[1].reply({ ok: true, verified: true, volume: 75, muted: false, message: 'System volume is 75%.' });
  assert.equal((await volume).volume, 75);
  controller.dispose();
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
test('native output pipe failures settle promptly and stale pipe events cannot stop a replacement helper', async () => {
  for (const failure of ['stdout-error', 'stderr-error', 'stdout-end', 'process-close']) {
    const { controller, workers } = fixture(); const pending = controller.execute({ action: 'STATUS' });
    const rejected = assert.rejects(pending, /disconnected/);
    assert.doesNotThrow(() => {
      if (failure === 'process-close') workers[0].emit('close', 1);
      else if (failure === 'stdout-end') workers[0].stdout.emit('end');
      else workers[0][failure.split('-')[0]].emit('error', new Error('fixture pipe failure'));
    });
    await rejected; assert.equal(workers[0].killed, true);
    const retry = controller.execute({ action: 'PAUSE' }); workers[0].stdout.emit('error', new Error('late old failure'));
    workers[1].reply({ ok: true, verified: true, message: 'Playback paused.' }); assert.equal((await retry).verified, true); controller.dispose();
  }
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

test('Spotify cold resume opens only the requested app, invokes one unambiguous Play once, and requires its song readback', { skip: process.platform !== 'win32' }, () => {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helperPath = path.resolve(__dirname, '../../desktop/media-helper.ps1').replace(/'/g, "''");
  // Execute production dispatch, UI filtering, discovery and readback against
  // fake elements/sessions. No process launch, media API or real UI is accessed.
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${helperPath}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Media helper did not parse' }
$functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Wait-SpotifySession', 'Wait-Playback', 'Get-SpotifyButtons', 'Invoke-MediaRequest') }, $true)
foreach ($definition in $functions) {
    $source = $definition.Extent.Text
    if ($definition.Name -in @('Wait-SpotifySession', 'Wait-Playback')) {
        # Keep production timeout values and control flow. Only the clock is
        # virtual: no-op sleeps plus a short wall-clock deadline can expire
        # during the first UI lookup on a busy runner, before session readback.
        if ([regex]::Matches($source, '\\[DateTime\\]::UtcNow').Count -ne 2) { throw 'Review the fixture clock for the changed production wait function' }
        $source = $source.Replace('[DateTime]::UtcNow', '$script:fixtureNow')
    }
    Invoke-Expression $source
}
function Start-Sleep { param($Milliseconds) $script:fixtureNow = $script:fixtureNow.AddMilliseconds($Milliseconds) }
function Start-Process { throw 'Fixture must not launch any process' }
function Await-Media($Operation, [Type]$ResultType) { return [bool]$Operation }
function Open-Spotify { $script:opens++; return @{ ok = $script:scenario -ne 'launch-failed'; verified = $script:scenario -ne 'launch-failed'; message = 'Fixture launch result.' } }
function Get-MediaSession([bool]$SpotifyOnly) {
    $script:reads++; $script:requestedScopes.Add($SpotifyOnly)
    if ($script:scenario -in @('existing-playing', 'existing-paused', 'playing-empty-title')) { return $script:session }
    if ($script:scenario -eq 'cold-session' -and $script:opens -gt 0) { return $script:session }
    if ($script:invokes -gt 0 -and $script:scenario -in @('cold-ui', 'ui-no-playback', 'ui-empty-title')) { return $script:session }
    # An unrelated player can be playing, but Spotify-scoped lookup is empty.
    if (-not $SpotifyOnly -and $script:scenario -eq 'other-player') { return [pscustomobject]@{ title = 'Unrelated'; artist = 'Other'; status = 'Playing' } }
    return $null
}
function Get-MediaState($Session) { if (-not $Session) { return @{ title = ''; artist = ''; status = 'Closed' } }; return @{ title = $Session.title; artist = $Session.artist; status = $Session.status } }
function Get-SpotifyRoot {
    $script:rootReads++
    $root = [pscustomobject]@{}
    $root | Add-Member ScriptMethod FindAll { param($scope, $condition)
      $count = if ($script:scenario -eq 'ambiguous-ui') { 2 } elseif ($script:scenario -in @('no-ui', 'other-player', 'generic-no-session')) { 0 } else { 1 }
      $items = @()
      for ($i = 0; $i -lt $count; $i++) {
        $identity = if ($script:scenario -eq 'changed-ui') { $script:rootReads } else { $i + 1 }
        $name = if ($script:scenario -eq 'named-result') { 'Play Another Song by Another Artist' } else { 'Play' }
        $item = [pscustomobject]@{ identity = $identity; Current = [pscustomobject]@{ Name = $name; IsOffscreen = $script:scenario -eq 'hidden-ui'; IsEnabled = $script:scenario -ne 'disabled-ui' } }
        $item | Add-Member ScriptMethod GetRuntimeId { return @([int]$this.identity) }
        $items += $item
      }
      return $items
    }
    return $root
}
function Invoke-SpotifyControl($Control) {
    $script:invokes++
    if ($script:scenario -ne 'ui-no-playback') { $script:session.status = 'Playing' }
    if ($script:scenario -eq 'ui-empty-title') { $script:session.title = '' }
}
$results = @()
foreach ($scenario in @('existing-playing', 'existing-paused', 'cold-session', 'cold-ui', 'ui-no-playback', 'ui-empty-title', 'other-player', 'ambiguous-ui', 'changed-ui', 'hidden-ui', 'disabled-ui', 'named-result', 'no-ui', 'launch-failed', 'generic-no-session', 'playing-empty-title')) {
    $script:scenario = $scenario; $script:reads = 0; $script:opens = 0; $script:invokes = 0; $script:rootReads = 0
    $script:fixtureNow = [DateTime]::Parse('2026-01-01T00:00:00Z').ToUniversalTime()
    $script:requestedScopes = [System.Collections.Generic.List[bool]]::new()
    $script:session = [pscustomobject]@{ title = 'Queued Song'; artist = 'Fixture Artist'; status = 'Paused'; writes = 0 }
    if ($scenario -in @('existing-playing', 'playing-empty-title')) { $script:session.status = 'Playing' }
    if ($scenario -eq 'playing-empty-title') { $script:session.title = '' }
    $script:session | Add-Member ScriptMethod TryPlayAsync { $this.writes++; $this.status = 'Playing'; return $true }
    $receipt = Invoke-MediaRequest @{ action = 'PLAY'; spotifyOnly = $scenario -ne 'generic-no-session' }
    $results += @{ scenario = $scenario; opens = $script:opens; invokes = $script:invokes; transportWrites = $script:session.writes; scopes = $script:requestedScopes.ToArray(); receipt = $receipt }
}
$results | ConvertTo-Json -Compress -Depth 7
`;
  const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const results = JSON.parse(output.trim());
  assert.equal(results.length, 16);
  for (const result of results) {
    const success = ['existing-playing', 'existing-paused', 'cold-session', 'cold-ui'].includes(result.scenario);
    assert.equal(result.receipt.ok, success, result.scenario + ': ' + JSON.stringify(result));
    if (success) {
      assert.equal(result.receipt.verified, true); assert.equal(result.receipt.status, 'Playing');
      assert.equal(result.receipt.source, 'spotify'); assert.equal(result.receipt.title, 'Queued Song');
    }
    const uiAttempt = ['cold-ui', 'ui-no-playback', 'ui-empty-title'].includes(result.scenario);
    assert.equal(result.invokes, uiAttempt ? 1 : 0, result.scenario + ': only one eligible Play may be invoked');
    assert.equal(result.transportWrites, ['existing-paused', 'cold-session'].includes(result.scenario) ? 1 : 0, result.scenario + ': UI invocation is never replayed as a transport command');
    assert.equal(result.opens, ['existing-playing', 'existing-paused', 'playing-empty-title', 'generic-no-session'].includes(result.scenario) ? 0 : 1, result.scenario);
    assert.ok(result.scopes.length > 0);
    assert.ok(result.scopes.every(scope => scope === (result.scenario !== 'generic-no-session')), 'Another player cannot verify Spotify playback');
    if (['no-ui', 'ambiguous-ui', 'other-player', 'changed-ui'].includes(result.scenario)) assert.match(result.receipt.message, /Sign in or choose a song/);
  }
});

test('native status receipts include observed playback state and scope without changing either player', { skip: process.platform !== 'win32' }, () => {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helperPath = path.resolve(__dirname, '../../desktop/media-helper.ps1').replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${helperPath}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Media helper did not parse' }
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-MediaRequest' }, $true)
Invoke-Expression $definition.Extent.Text
function Get-MediaSession([bool]$SpotifyOnly) { $script:scopes.Add($SpotifyOnly); return $script:session }
function Get-MediaState($Session) { $script:reads++; return @{ title = $Session.title; artist = $Session.artist; status = $Session.status } }
function Open-Spotify { throw 'Status must not launch Spotify' }
function Invoke-SpotifyControl { throw 'Status must not invoke Play' }
$results = @()
foreach ($scope in @($true, $false)) {
  foreach ($state in @('Playing', 'Paused', 'Closed')) {
    $script:reads = 0; $script:scopes = [System.Collections.Generic.List[bool]]::new()
    $script:session = $null
    if ($state -ne 'Closed') {
      $script:session = [pscustomobject]@{ title = 'Fixture Song'; artist = 'Fixture Artist'; status = $state }
      $script:session | Add-Member ScriptMethod TryPlayAsync { throw 'Status must not play' }
      $script:session | Add-Member ScriptMethod TryPauseAsync { throw 'Status must not pause' }
    }
    $receipt = Invoke-MediaRequest @{ action = 'STATUS'; spotifyOnly = $scope }
    $results += @{ scope = $scope; state = $state; reads = $script:reads; scopes = $script:scopes.ToArray(); receipt = $receipt; after = if ($script:session) { $script:session.status } else { 'Closed' } }
  }
}
$results | ConvertTo-Json -Compress -Depth 6
`;
  const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const results = JSON.parse(output.trim());
  assert.equal(results.length, 6);
  for (const result of results) {
    assert.equal(result.receipt.ok, result.state !== 'Closed'); assert.equal(result.receipt.verified, true);
    assert.equal(result.receipt.status, result.state);
    assert.equal(result.receipt.source, result.scope ? 'spotify' : 'media');
    assert.equal(result.after, result.state); assert.equal(result.reads, result.state === 'Closed' ? 0 : 1); assert.deepEqual(result.scopes, [result.scope]);
    if (result.state === 'Closed') {
      assert.equal(result.receipt.reason, 'no-session');
      assert.equal(result.receipt.message, 'No active music player is available. Open Spotify, sign in, and choose a song first.');
      assert.equal(result.receipt.title, undefined); continue;
    }
    assert.equal(result.receipt.title, 'Fixture Song'); assert.equal(result.receipt.artist, 'Fixture Artist');
    if (result.state === 'Playing') assert.equal(result.receipt.message, 'Playing Fixture Song by Fixture Artist.');
    else assert.equal(result.receipt.message, 'Fixture Song by Fixture Artist is paused.');
  }
});
