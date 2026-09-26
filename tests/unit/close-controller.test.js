const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createCloseController, closeTarget } = require('../../desktop/close-controller');

function fixture(options = {}) {
  const workers = [];
  const controller = createCloseController({ platform: 'win32', ...options, spawnProcess(executable, args, spawnOptions) {
    assert.equal(spawnOptions.shell, false); assert.equal(spawnOptions.windowsHide, true);
    assert.ok(args.includes('-File')); assert.ok(args.at(-1).endsWith('close-helper.ps1')); assert.ok(!args.includes('-Command'));
    const worker = new EventEmitter();
    worker.stdout = new PassThrough(); worker.stderr = new PassThrough(); worker.stdin = new PassThrough();
    worker.stdin.on('data', data => { worker.request = JSON.parse(data); });
    worker.kill = () => { worker.killed = true; };
    worker.reply = result => worker.stdout.write(JSON.stringify({ id: worker.request.id, result }) + '\n');
    worker.dispatch = () => worker.stdout.write(JSON.stringify({ id: worker.request.id, event: 'dispatched' }) + '\n');
    workers.push(worker); return worker;
  } });
  return { controller, workers };
}

function closed(extra = {}) {
  return { ok: true, verified: true, pending: false, status: 'closed', message: 'No visible app windows remain.', matched: 1, requested: 1, remaining: 0, dispatched: true, forced: false, closed: 'Chrome', ...extra };
}

test('close aliases select exact process names including modern Outlook and Teams', () => {
  for (const [name, expected] of [['Google Chrome', ['chrome']], ['Word', ['winword']], ['Microsoft Excel', ['excel']], ['PowerPoint', ['powerpnt']], ['Outlook', ['outlook', 'olk']], ['Teams', ['ms-teams', 'teams']], ['Calculator', ['calculatorapp', 'calculator', 'calc']], ['VS Code', ['code']], ['terminal', ['windowsterminal']], ['OBS', ['obs64']], ['Roblox', ['robloxplayerbeta']], ['cursor', ['cursor']], ['Custom.Editor.EXE', ['custom.editor']]]) {
    assert.deepEqual(closeTarget(name).processNames, expected, name);
  }
  assert.deepEqual(closeTarget(' code ').processNames, ['code']);
  assert.deepEqual(closeTarget('Spotify').processNames, ['spotify']);
});

test('close rejects wildcard, path, control, argument and protected process targets before spawning', async () => {
  const { controller, workers } = fixture();
  for (const name of ['*', 'chrome*', '[chrome]', 'Chrome?', 'C:\\Windows\\notepad.exe', 'cmd /c calc', 'code; calc', 'app\nname', '', 'Explorer', 'File Explorer', 'electron.exe', 'Olanga', 'ApplicationFrameHost', 'svchost']) {
    assert.equal((await controller.close(name)).status, 'invalid-app', name);
  }
  assert.equal(workers.length, 0);
});

test('closing passes only target data and retains verified versus pending receipts', async () => {
  const { controller, workers } = fixture();
  let pending = controller.close('Word');
  assert.deepEqual(workers[0].request.processNames, ['winword']);
  workers[0].dispatch(); workers[0].reply(closed());
  assert.equal((await pending).verified, true); assert.equal(workers[0].killed, true);
  pending = controller.close('Word');
  workers[1].reply(closed({ status: 'pending', pending: true, remaining: 1, verified: false }));
  const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.verified, false); assert.equal(result.pending, true); assert.equal(result.forced, false);
});

test('invalid close receipts and malformed envelopes cannot claim success or throw callbacks', async () => {
  for (const envelope of [null, [], 7, 'unexpected', { id: 99 }, { id: 1, result: null }]) {
    const { controller, workers } = fixture(); const pending = controller.close('Chrome');
    assert.doesNotThrow(() => workers[0].stdout.write(JSON.stringify(envelope) + '\n'));
    assert.equal((await pending).status, 'invalid-result');
  }
  for (const invalid of [closed({ verified: false }), closed({ remaining: 1 }), closed({ requested: 0 }), closed({ requested: 2 }), closed({ forced: true }), closed({ pending: true }), closed({ dispatched: false }), closed({ matched: NaN }), closed({ status: 'pending', verified: false })]) {
    const { controller, workers } = fixture(); const pending = controller.close('Chrome'); workers[0].reply(invalid);
    assert.equal((await pending).status, 'invalid-result');
  }
});

test('close cancellation settles even when termination throws and ignores delayed success', async () => {
  const { controller, workers } = fixture(); const old = controller.close('Chrome'); workers[0].dispatch();
  workers[0].kill = () => { throw new Error('already exited'); }; controller.cancel();
  const cancelled = await old; assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.dispatched, true); assert.equal(cancelled.verified, false);
  const current = controller.close('Word'); workers[0].reply(closed()); workers[0].emit('close');
  assert.equal(workers[1].killed, undefined); workers[1].reply(closed()); assert.equal((await current).verified, true);
  controller.dispose(); assert.equal((await controller.close('Chrome')).status, 'unavailable'); assert.equal(workers.length, 2);
});

test('close helper timeout, spawn, pipe and unexpected-exit failures all settle honestly', async () => {
  const { controller, workers } = fixture({ timeoutMs: 10 }); assert.equal((await controller.close('Chrome')).status, 'timeout'); assert.equal(workers[0].killed, true);
  assert.equal((await createCloseController({ platform: 'win32', spawnProcess() { throw new Error('missing'); } }).close('Chrome')).status, 'helper-error');
  for (const event of ['error', 'close', 'pipe']) {
    const current = fixture(); const pending = current.controller.close('Chrome');
    if (event === 'pipe') current.workers[0].stdin.emit('error', new Error('broken pipe'));
    else current.workers[0].emit(event, new Error('failure'));
    assert.equal((await pending).verified, false);
  }
  assert.equal((await createCloseController({ platform: 'linux' }).close('Chrome')).status, 'unsupported-platform');
});

const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const helper = path.resolve(__dirname, '../../desktop/close-helper.ps1');
const windows = { skip: process.platform !== 'win32' };

test('Windows close helper native interop compiles without closing any window', windows, () => {
  const output = execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], { input: '', encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(output.trim(), '');
});

test('native graceful closing rejects identity changes and reports tray, save-prompt and multiple-window outcomes honestly', windows, () => {
  // Execute the actual helper functions with in-memory processes and Win32
  // stand-ins. No fixture method can close a real app or post a window message.
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tokens = $null; $errors = $null
$tree = [System.Management.Automation.Language.Parser]::ParseFile('${helper.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
$tree.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { Invoke-Expression $_.Extent.Text }
Add-Type -TypeDefinition @'
using System;
public static class OlangaCloseNative {
  public static string Scenario, State;
  public static bool IsWindow(IntPtr handle) { return Scenario != "missing-window"; }
  public static bool IsWindowVisible(IntPtr handle) { return Scenario != "hidden-window"; }
  public static int ProcessId(long handle) { return Scenario == "changed-owner" ? 999 : (int)(handle / 10); }
  public static long[] VisibleWindows(int process) {
    if (State == "closed" || Scenario == "title-only") return new long[0];
    if (Scenario == "multiple-windows" && State != "sent") return new long[] { process * 10, process * 10 + 1 };
    if (Scenario == "multiple-windows" && State == "sent") return new long[] { process * 10 + 1 };
    return new long[] { process * 10 };
  }
}
'@
function New-FakeProcess([int]$Id, [string]$Name, [bool]$Recheck) {
  $start = [DateTime]::new(2026, 1, 1)
  $handle = $Id * 10
  if ($Recheck) {
    if ($script:scenario -eq 'changed-start' -or ($script:scenario -eq 'changed-second' -and $Id -eq 102)) { $start = $start.AddSeconds(1) }
    if ($script:scenario -eq 'changed-name') { $Name = 'chrome-helper' }
    if ($script:scenario -eq 'changed-handle') { $handle++ }
  }
  if ($script:scenario -eq 'multiple-windows' -and [OlangaCloseNative]::State -eq 'sent') { $handle++ }
  $process = [pscustomobject]@{ Id = $Id; ProcessName = $Name; StartTime = $start; MainWindowHandle = [IntPtr]$handle; MainWindowTitle = 'Spotify'; HasExited = $false }
  $process | Add-Member ScriptMethod Refresh {}
  $process | Add-Member ScriptMethod Dispose {}
  $process | Add-Member ScriptMethod CloseMainWindow {
    $script:sent++
    if ($script:scenario -eq 'refused') { return $false }
    [OlangaCloseNative]::State = if ($script:scenario -in @('pending','multiple-windows','changed-second')) { 'sent' } else { 'closed' }
    return $true
  }
  return $process
}
function Get-Process {
  param([int]$Id, $ErrorAction)
  if ($PSBoundParameters.ContainsKey('Id')) {
    if ($script:scenario -eq 'missing-process') { return $null }
    return New-FakeProcess $Id 'chrome' $true
  }
  if ($script:scenario -eq 'title-only') { return New-FakeProcess 200 'other-editor' $false }
  if ($script:scenario -eq 'substring-only') { return New-FakeProcess 200 'chrome-helper' $false }
  New-FakeProcess 101 'chrome' $false
  New-FakeProcess 200 'chrome-helper' $false
  if ($script:scenario -eq 'changed-second') { New-FakeProcess 102 'chrome' $false }
}
function Send-CloseDispatched($Request) { $script:events++ }
$results = foreach ($case in @('closed','pending','multiple-windows','refused','changed-start','changed-name','changed-handle','changed-owner','missing-window','hidden-window','missing-process','changed-second','title-only','substring-only')) {
  $script:scenario = $case; $script:sent = 0; $script:events = 0
  [OlangaCloseNative]::Scenario = $case; [OlangaCloseNative]::State = 'open'
  $receipt = Invoke-CloseRequest ([pscustomobject]@{ id = 1; name = 'Chrome'; processNames = @('chrome'); settleMs = 0 })
  [pscustomobject]@{ scenario = $case; sent = $script:sent; events = $script:events; result = $receipt }
}
$results | ConvertTo-Json -Depth 8 -Compress
`;
  const results = JSON.parse(execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 60000, windowsHide: true }).trim());
  for (const row of results) {
    const { scenario, sent, events, result } = row;
    assert.equal(result.forced, false, scenario);
    if (scenario === 'closed') { assert.equal(result.verified, true); assert.equal(result.remaining, 0); assert.equal(sent, 1); }
    else if (['pending', 'multiple-windows'].includes(scenario)) { assert.equal(result.status, 'pending', scenario); assert.equal(result.verified, false); assert.equal(result.pending, true); assert.equal(sent, 1); }
    else if (scenario === 'refused') { assert.equal(result.status, 'close-refused'); assert.equal(result.ok, false); assert.equal(sent, 1); }
    else if (scenario === 'changed-second') { assert.equal(result.status, 'target-changed'); assert.equal(result.ok, false); assert.equal(result.dispatched, true); assert.equal(result.requested, 1); assert.equal(sent, 1); }
    else if (['title-only', 'substring-only'].includes(scenario)) { assert.equal(result.status, 'not-running', scenario); assert.equal(sent, 0); }
    else { assert.equal(result.status, 'target-changed', scenario); assert.equal(result.ok, false); assert.equal(result.dispatched, false); assert.equal(sent, 0); }
    assert.equal(events, sent, scenario);
  }
});
