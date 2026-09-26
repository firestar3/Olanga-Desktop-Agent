// Live Windows adapter verification against an app created only for this test.
// It never closes user apps. Close tests target a unique fixture process; cleanup
// uses a private signal file even after an interrupted helper request.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createAppController } = require('../desktop/app-controller');
const { createCloseController } = require('../desktop/close-controller');
const output = path.resolve(__dirname, '../build/qa');
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(output, 'app-adapter-fixture-'));
const suffix = path.basename(directory).split('-').at(-1);
const processName = 'OlangaAdapterFixture-' + suffix;
const titleOnlyName = 'OlangaTitleOnly-' + suffix;
const executable = path.join(directory, processName + '.exe');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const report = { startedAt: new Date().toISOString(), fixture: directory, passed: false, checks: [], receipts: {} };
const reportPath = path.join(output, 'app-adapter-smoke.json');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const encoded = script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
const app = { id: 'fixture', name: 'Olanga adapter fixture', aliases: ['fixture'], processes: [processName], paths: [{ root: 'Absolute', path: executable }] };
const controller = createAppController({ catalog: [app], timeoutMs: 16000 });
const closeController = createCloseController();
const controllers = [controller, closeController];
function check(name, condition) { report.checks.push({ name, passed: Boolean(condition) }); assert.ok(condition, name); }
function save() { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); }

async function waitSignal(name) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(directory, name))) {
    if (Date.now() >= deadline) throw new Error('The disposable fixture did not confirm ' + name + '.');
    await pause(50);
  }
}

async function waitClosed() {
  fs.writeFileSync(path.join(directory, 'exit.signal'), 'exit');
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await controller.listCapabilities();
    if (result.ok && result.apps[0].windowCount === 0) return;
    await pause(100);
  }
  throw new Error('The disposable fixture did not close.');
}

(async () => {
  try {
    if (process.platform !== 'win32') throw new Error('The native adapter smoke requires Windows.');
    const source = `
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;
public class FixtureForm : Form {
  readonly string directory;
  public FixtureForm(string directory) { this.directory = directory; Text = "${titleOnlyName} - Example Browser"; Width = 600; Height = 420; StartPosition = FormStartPosition.Manual; Left = 120; Top = 120; }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override void OnFormClosing(FormClosingEventArgs e) {
    if (File.Exists(Path.Combine(directory, "hold-close.signal")) && !File.Exists(Path.Combine(directory, "exit.signal"))) {
      File.WriteAllText(Path.Combine(directory, "close-observed.signal"), e.CloseReason.ToString()); e.Cancel = true;
    }
    base.OnFormClosing(e);
  }
}
public static class Fixture {
  [STAThread] public static void Main(string[] args) {
    string directory = Encoding.UTF8.GetString(Convert.FromBase64String("${Buffer.from(directory).toString('base64')}"));
    int delay = args.Length > 0 ? Int32.Parse(args[0]) : 400;
    Thread.Sleep(delay);
    if (File.Exists(Path.Combine(directory, "exit.signal"))) return;
    Application.EnableVisualStyles();
    var first = new FixtureForm(directory); Form second = null;
    var elapsed = System.Diagnostics.Stopwatch.StartNew();
    var timer = new System.Windows.Forms.Timer(); timer.Interval = 80;
    timer.Tick += delegate {
      if (File.Exists(Path.Combine(directory, "exit.signal")) || elapsed.ElapsedMilliseconds > 90000 || Application.OpenForms.Count == 0) { timer.Stop(); Application.ExitThread(); return; }
      if (second == null && File.Exists(Path.Combine(directory, "multiple.signal"))) { second = new FixtureForm(directory); second.Left = 200; second.Show(); File.WriteAllText(Path.Combine(directory, "multiple.ready"), "ready"); }
    };
    first.Show(); timer.Start(); Application.Run(); timer.Dispose(); if (second != null) second.Dispose(); first.Dispose();
  }
}`;
    const script = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(source).toString('base64')}'))\nAdd-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly '${executable.replace(/'/g, "''")}' -OutputType WindowsApplication`;
    execFileSync(powershell, encoded(script), { encoding: 'utf8', timeout: 30000, windowsHide: true });
    report.receipts.capabilities = await controller.listCapabilities();
    check('Private fixture is discoverable before opening', report.receipts.capabilities.ok && report.receipts.capabilities.apps[0].installed && report.receipts.capabilities.apps[0].windowCount === 0);
    report.receipts.open = await controller.open('fixture');
    check('Delayed fixture startup is verified by its actual process and window', report.receipts.open.ok && report.receipts.open.verified && report.receipts.open.dispatched && report.receipts.open.windowCount === 1);
    report.receipts.reopen = await controller.open('fixture');
    check('Already-open fixture is reused without another launch', report.receipts.reopen.ok && report.receipts.reopen.alreadyOpen && !report.receipts.reopen.dispatched && report.receipts.reopen.processId === report.receipts.open.processId);
    report.receipts.closeTitleOnly = await closeController.close(titleOnlyName);
    report.receipts.afterTitleOnly = await controller.listCapabilities();
    check('A browser-like title-only match remains open and receives no close request', !report.receipts.closeTitleOnly.ok && report.receipts.closeTitleOnly.status === 'not-running' && !report.receipts.closeTitleOnly.dispatched && report.receipts.afterTitleOnly.ok && report.receipts.afterTitleOnly.apps[0].windowCount === 1);
    report.receipts.closeSubstring = await closeController.close('OlangaAdapterFixture');
    report.receipts.afterSubstring = await controller.listCapabilities();
    check('A substring of the fixture process name cannot close it', !report.receipts.closeSubstring.ok && report.receipts.closeSubstring.status === 'not-running' && !report.receipts.closeSubstring.dispatched && report.receipts.afterSubstring.ok && report.receipts.afterSubstring.apps[0].windowCount === 1);
    for (const layout of ['left', 'right', 'maximize']) {
      report.receipts[layout] = await controller.arrange({ appName: 'fixture', layout });
      check(`Native ${layout} layout has verified readback`, report.receipts[layout].ok && report.receipts[layout].verified && report.receipts[layout].layout === layout);
    }
    fs.writeFileSync(path.join(directory, 'hold-close.signal'), 'hold');
    report.receipts.closePending = await closeController.close(processName);
    await waitSignal('close-observed.signal');
    report.receipts.afterPending = await controller.listCapabilities();
    check('A fixture that declines closing reports pending without force or false verification', report.receipts.closePending.ok && report.receipts.closePending.status === 'pending' && report.receipts.closePending.pending && !report.receipts.closePending.verified && report.receipts.closePending.forced === false && report.receipts.closePending.requested === 1 && report.receipts.afterPending.ok && report.receipts.afterPending.apps[0].windowCount === 1);
    fs.unlinkSync(path.join(directory, 'hold-close.signal'));
    fs.writeFileSync(path.join(directory, 'multiple.signal'), 'multiple');
    await waitSignal('multiple.ready');
    report.receipts.multiple = await controller.open('fixture');
    check('Multiple verified windows are reported without choosing one to focus', report.receipts.multiple.ok && report.receipts.multiple.windowCount === 2 && report.receipts.multiple.focused === false);
    report.receipts.ambiguous = await controller.arrange({ appName: 'fixture', layout: 'left' });
    check('Multiple windows prevent an ambiguous arrangement', !report.receipts.ambiguous.ok && report.receipts.ambiguous.status === 'ambiguous-window' && !report.receipts.ambiguous.dispatched);
    report.receipts.closeOneWindow = await closeController.close(processName);
    report.receipts.afterOneWindow = await controller.listCapabilities();
    check('Closing one of two fixture windows reports the remaining window as pending', report.receipts.closeOneWindow.ok && report.receipts.closeOneWindow.status === 'pending' && !report.receipts.closeOneWindow.verified && report.receipts.closeOneWindow.forced === false && report.receipts.afterOneWindow.ok && report.receipts.afterOneWindow.apps[0].windowCount === 1);
    report.receipts.closeExact = await closeController.close(processName + '.exe');
    report.receipts.afterExact = await controller.listCapabilities();
    check('The exact fixture process closes gracefully with independent zero-window readback', report.receipts.closeExact.ok && report.receipts.closeExact.verified && report.receipts.closeExact.status === 'closed' && !report.receipts.closeExact.pending && report.receipts.closeExact.forced === false && report.receipts.afterExact.ok && report.receipts.afterExact.apps[0].windowCount === 0);
    await waitClosed();
    fs.unlinkSync(path.join(directory, 'exit.signal'));
    fs.unlinkSync(path.join(directory, 'multiple.signal'));
    const missing = createAppController({ catalog: [{ ...app, paths: [{ root: 'Absolute', path: path.join(directory, 'MissingFixture.exe') }] }] });
    controllers.push(missing);
    report.receipts.missing = await missing.open('fixture');
    check('Missing known target fails without Windows Search', !report.receipts.missing.ok && report.receipts.missing.status === 'missing-app' && !report.receipts.missing.dispatched);
    let cancellation;
    const delayedApp = { ...app, paths: [{ root: 'Absolute', path: executable, args: ['3000'] }] };
    cancellation = createAppController({ catalog: [delayedApp], spawnProcess(...args) {
      const worker = spawn(...args);
      worker.stdout.on('data', bytes => { if (bytes.toString().includes('"dispatched"')) setTimeout(() => cancellation.cancel(), 100); });
      return worker;
    } });
    controllers.push(cancellation);
    report.receipts.cancelled = await cancellation.open('fixture');
    check('Cancellation after dispatch is an honest possibly-applied result', !report.receipts.cancelled.ok && report.receipts.cancelled.status === 'cancelled' && report.receipts.cancelled.dispatched);
    fs.writeFileSync(path.join(directory, 'exit.signal'), 'exit');
    await pause(3300);
    fs.unlinkSync(path.join(directory, 'exit.signal'));
    const timeout = createAppController({ catalog: [delayedApp], startupTimeoutMs: 100 });
    controllers.push(timeout);
    report.receipts.timeout = await timeout.open('fixture');
    check('Startup without a window cannot claim completion', !report.receipts.timeout.ok && report.receipts.timeout.status === 'window-timeout' && report.receipts.timeout.dispatched);
    report.passed = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    for (const item of controllers) item.cancel();
    fs.writeFileSync(path.join(directory, 'exit.signal'), 'exit');
    // A cancelled delayed launch may still be starting; its own signal prevents
    // a late window, without killing a process belonging to another app.
    await pause(3300);
    try { await waitClosed(); report.fixtureClosed = true; } catch (error) { report.cleanupError = error.message; report.passed = false; }
    for (const item of controllers) item.dispose();
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    save();
    console.log(`App adapter smoke ${report.passed ? 'passed' : 'failed'}: ${reportPath}`);
    if (report.error) console.error(report.error);
    process.exitCode = report.passed ? 0 : 1;
  }
})();
