const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { APP_CATALOG, findApp } = require('../../shared/app-catalog');
const { createAppController } = require('../../desktop/app-controller');

function fixture(options = {}) {
  const workers = [];
  const controller = createAppController({ platform: 'win32', ...options, spawnProcess(executable, args, spawnOptions) {
    assert.equal(spawnOptions.shell, false);
    assert.equal(spawnOptions.windowsHide, true);
    assert.ok(args.includes('-File'));
    assert.ok(!args.includes('-Command'));
    const worker = new EventEmitter();
    worker.stdout = new PassThrough(); worker.stderr = new PassThrough(); worker.stdin = new PassThrough();
    worker.stdin.on('data', bytes => { worker.request = JSON.parse(bytes); });
    worker.kill = () => { worker.killed = true; };
    worker.reply = result => worker.stdout.write(JSON.stringify({ id: worker.request.id, result }) + '\n');
    worker.dispatched = () => worker.stdout.write(JSON.stringify({ id: worker.request.id, event: 'dispatched' }) + '\n');
    workers.push(worker);
    return worker;
  } });
  return { controller, workers };
}

function verified(appId = 'chrome', extra = {}) {
  return { ok: true, verified: true, appId, status: 'opened', message: 'The app is open.', processId: 123, windowHandle: '456', windowCount: 1, ...extra };
}

test('every current app fast intent has a known adapter and aliases share identity', () => {
  for (const name of ['spotify', 'discord', 'chrome', 'google chrome', 'edge', 'microsoft edge', 'firefox', 'notepad', 'calculator', 'word', 'excel', 'powerpoint', 'outlook', 'teams', 'slack', 'vs code', 'visual studio code', 'file explorer']) assert.ok(findApp(name), name);
  assert.equal(findApp(' Google   Chrome ').id, 'chrome');
  assert.equal(new Set(APP_CATALOG.map(app => app.id)).size, APP_CATALOG.length);
});

test('known names select static targets and successful launch requires window identity', async () => {
  const { controller, workers } = fixture();
  const opening = controller.open('Google Chrome');
  assert.equal(workers[0].request.operation, 'open');
  assert.equal(workers[0].request.app.id, 'chrome');
  assert.equal(workers[0].request.name, undefined);
  workers[0].dispatched();
  workers[0].reply(verified());
  assert.deepEqual(await opening, { ...verified(), dispatched: true });
  assert.equal(workers[0].killed, true);
  for (const bad of [
    verified('edge'), verified('chrome', { verified: false }),
    verified('chrome', { processId: 0 }), verified('chrome', { windowHandle: '0' }),
    verified('chrome', { windowCount: 0 }),
  ]) {
    const pending = controller.open('Chrome');
    workers.at(-1).reply(bad);
    assert.equal((await pending).ok, false);
  }
  controller.dispose();
});

test('missing known app is an honest failure and never falls back to Search', async () => {
  const { controller, workers } = fixture();
  const pending = controller.open('Word');
  const missing = { ok: false, verified: false, status: 'missing-app', message: 'Word is not installed.' };
  workers[0].reply(missing);
  assert.deepEqual(await pending, { ...missing, dispatched: false });
  assert.equal(workers.length, 1);
  assert.equal(workers[0].request.operation, 'open');
});

test('unknown app names retain an explicitly unverified data-only Search fallback', async () => {
  const { controller, workers } = fixture();
  const pending = controller.open("Example App's Editor");
  assert.equal(workers[0].request.operation, 'search');
  assert.equal(workers[0].request.name, "Example App's Editor");
  workers[0].reply({ ok: true, verified: false, status: 'dispatched', dispatched: true, message: 'Requested through Windows Search; not verified.' });
  assert.equal((await pending).verified, false);
  for (const name of ['powershell -Command calc', 'cmd /c calc', 'cmd calc', 'Chrome --incognito', 'C:\\Windows\\notepad.exe', 'https://example.com', 'App; calc', 'App\nCalculator', '[OPEN_APP: Chrome]']) assert.equal((await controller.open(name)).status, 'invalid-app', name);
  assert.equal(workers.length, 1);
});

test('cancellation fences delayed receipts and preserves possible-dispatch evidence', async () => {
  const { controller, workers } = fixture();
  const old = controller.open('Chrome');
  workers[0].dispatched();
  controller.cancel();
  assert.equal((await old).status, 'cancelled');
  assert.equal((await old).dispatched, true);
  assert.match((await old).message, /may already/);
  const current = controller.open('Chrome');
  workers[0].reply(verified());
  workers[0].emit('close', 0);
  assert.equal(workers[1].killed, undefined);
  workers[1].reply(verified('chrome', { alreadyOpen: true, status: 'already-open', windowCount: 2, focused: false }));
  assert.equal((await current).windowCount, 2);
});

test('timeout and helper startup failure always settle with a failure receipt', async () => {
  const { controller, workers } = fixture({ timeoutMs: 10 });
  const result = await controller.open('Chrome');
  assert.equal(result.status, 'timeout');
  assert.equal(workers[0].killed, true);
  const unavailable = createAppController({ platform: 'win32', spawnProcess() { throw new Error('Unavailable'); } });
  assert.equal((await unavailable.open('Chrome')).status, 'helper-error');
});

test('malformed app envelopes and capability rows settle without event-handler exceptions', async () => {
  for (const envelope of [null, [], 1, 'unexpected']) {
    const { controller, workers } = fixture();
    const pending = controller.open('Chrome');
    assert.doesNotThrow(() => workers[0].stdout.write(JSON.stringify(envelope) + '\n'));
    assert.equal((await pending).status, 'invalid-result');
    controller.dispose();
  }
  const apps = APP_CATALOG.map(app => ({ id: app.id, installed: false, available: false, status: 'missing', windowCount: 0 }));
  for (const rows of [[null], apps.map((app, index) => index ? app : null), apps.map((app, index) => index ? app : { ...app, windowCount: -1 }), apps.map((app, index) => index ? app : { ...app, installed: 'yes' }), apps.map((app, index) => index ? app : { ...app, id: apps[1].id })]) {
    const { controller, workers } = fixture();
    const pending = controller.listCapabilities();
    assert.doesNotThrow(() => workers[0].reply({ ok: true, message: 'Checked.', apps: rows }));
    assert.equal((await pending).status, 'invalid-result');
    controller.dispose();
  }
});

test('helper termination errors cannot leave app cancellation unsettled', async () => {
  const { controller, workers } = fixture();
  const pending = controller.open('Chrome');
  workers[0].kill = () => { throw new Error('already exited'); };
  assert.doesNotThrow(() => controller.cancel());
  assert.equal((await pending).status, 'cancelled');
});

test('arrangement accepts only static layouts and known adapters', async () => {
  const { controller, workers } = fixture();
  for (const payload of [{ appName: 'Chrome', layout: '1,2,3,4' }, { appName: 'Chrome', layout: 'left; calc' }, { appName: 'Unknown', layout: 'left' }]) assert.equal((await controller.arrange(payload)).ok, false);
  assert.equal(workers.length, 0);
  const pending = controller.arrange({ appName: 'Google Chrome', layout: 'left', x: 999, script: 'ignored' });
  assert.equal(workers[0].request.operation, 'arrange');
  assert.equal(workers[0].request.layout, 'left');
  assert.equal(workers[0].request.x, undefined);
  assert.equal(workers[0].request.script, undefined);
  workers[0].reply({ ok: false, verified: false, status: 'ambiguous-window', message: 'Multiple windows are open.' });
  assert.equal((await pending).status, 'ambiguous-window');
  const incorrect = controller.arrange({ appName: 'Chrome', layout: 'left' });
  workers[1].reply(verified('chrome', { status: 'arranged', layout: 'right', bounds: { left: 0, top: 0, right: 500, bottom: 800 } }));
  assert.equal((await incorrect).ok, false);
});

test('discovery is read-only, distinguishes unavailable apps, and survives turn cancellation', async () => {
  const { controller, workers } = fixture();
  const pending = controller.listCapabilities();
  assert.equal(workers[0].request.operation, 'discover');
  controller.cancel();
  assert.equal(workers[0].killed, undefined);
  workers[0].reply({ ok: true, message: 'Checked.', apps: APP_CATALOG.map((app, index) => ({ id: app.id, installed: index === 0, available: index === 0, status: index === 0 ? 'installed' : 'missing', windowCount: 0 })) });
  const result = await pending;
  assert.equal(result.apps.length, APP_CATALOG.length);
  assert.equal(result.apps[0].installed, true);
  assert.equal(result.apps[1].available, false);
  assert.deepEqual(result.apps[1].operations, ['open', 'arrange']);
  assert.equal(result.fallback.verification, 'unverified');
});

test('Windows app helper and its native interop compile without issuing an action', { skip: process.platform !== 'win32' }, () => {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(__dirname, '../../desktop/app-helper.ps1')], { input: '', encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(output.trim(), '');
});

test('native arrangement stops if restoration changes window identity or introduces ambiguity', { skip: process.platform !== 'win32' }, () => {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helper = path.resolve(__dirname, '../../desktop/app-helper.ps1').replace(/'/g, "''");
  // Execute the production PowerShell orchestration with fake native methods;
  // no actual window, pointer, foreground focus or process is touched.
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
public static class OlangaAppNative {
  public class Rect { public int Left=0, Top=0, Right=1000, Bottom=800; }
  public static bool Restored; public static int Moves;
  public static IntPtr GetForegroundWindow() { return new IntPtr(100); }
  public static Rect WorkArea(long handle) { return new Rect(); }
  public static bool ShowWindowAsync(IntPtr handle,int command) { Restored=true; return true; }
  public static bool SetWindowPos(IntPtr handle,IntPtr after,int x,int y,int width,int height,uint flags) { Moves++; return true; }
  public static Rect Bounds(long handle) { return new Rect { Right=500 }; }
  public static bool IsZoomed(IntPtr handle) { return false; }
}
'@
$tokens=$null; $errors=$null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${helper}',[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'App helper did not parse' }
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Invoke-KnownApp','Test-SameAppWindow','New-AppFailure') },$true)) { Invoke-Expression $definition.Extent.Text }
function Resolve-AppTarget($App) { return @{ kind='executable'; path='fixture.exe' } }
function Send-Dispatched($Request) { $script:dispatched++ }
function Start-Sleep { param($Milliseconds) }
function Get-AppWindows($App,$Target) {
  if ([OlangaAppNative]::Restored) {
    if ($script:scenario -eq 'missing') { return @() }
    if ($script:scenario -eq 'process') { return @(@{ Handle=100; ProcessId=999 }) }
    if ($script:scenario -eq 'handle') { return @(@{ Handle=999; ProcessId=123 }) }
    if ($script:scenario -eq 'multiple') { return @(@{ Handle=100; ProcessId=123 },@{ Handle=200; ProcessId=123 }) }
    if ($script:scenario -eq 'after-move' -and [OlangaAppNative]::Moves -gt 0) { return @() }
  }
  return @(@{ Handle=100; ProcessId=123 })
}
$results = @()
foreach ($script:scenario in @('stable','missing','process','handle','multiple','after-move')) {
  [OlangaAppNative]::Restored=$false; [OlangaAppNative]::Moves=0; $script:dispatched=0
  $receipt = Invoke-KnownApp @{ operation='arrange'; layout='left'; app=@{ id='fixture'; name='Fixture' } }
  $results += @{ scenario=$script:scenario; receipt=$receipt; moves=[OlangaAppNative]::Moves; dispatched=$script:dispatched }
}
$results | ConvertTo-Json -Depth 6 -Compress
`;
  const output = execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const results = JSON.parse(output.trim());
  assert.equal(results.length, 6);
  for (const result of results) {
    assert.equal(result.dispatched, 1);
    if (result.scenario === 'stable') { assert.equal(result.receipt.ok, true); assert.equal(result.moves, 1); }
    else {
      assert.equal(result.receipt.ok, false, result.scenario);
      assert.equal(result.receipt.status, 'window-changed');
      assert.equal(result.receipt.dispatched, true, 'Restoring a window is already an external effect');
      assert.equal(result.moves, result.scenario === 'after-move' ? 1 : 0, 'Do not move a changed or ambiguous window');
    }
  }
});
