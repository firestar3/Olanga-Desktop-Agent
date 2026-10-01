// Opens and moves only a disposable, uniquely named fixture window.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createAppController } = require('../desktop/app-controller');
const { createWorkspaceService, createWorkspaceHelper } = require('../desktop/workspace-service');
const output = path.resolve(__dirname, '../build/qa');
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(output, 'work-sessions-fixture-'));
const name = `OlangaSessionFixture-${path.basename(directory).split('-').at(-1)}`;
const executable = path.join(directory, name + '.exe');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const app = { id: 'fixture', name: 'Session fixture', aliases: ['fixture'], processes: [name], paths: [{ root: 'Absolute', path: executable }] };
const appController = createAppController({ catalog: [app] });
const nativeHelper = createWorkspaceHelper();
const service = createWorkspaceService({ filePath: path.join(directory, 'sessions.json'), appController, catalog: [app], helper: { execute: async request => { const result = await nativeHelper.execute(request); report.native = result; return result; }, cancel: () => nativeHelper.cancel() } });
const report = { passed: false, checks: [], receipts: {} };
function check(name, result) { report.checks.push({ name, passed: !!result }); assert.ok(result, name); }
(async () => {
  try {
    if (process.platform !== 'win32') throw new Error('This fixture requires Windows.');
    const source = `using System; using System.IO; using System.Text; using System.Windows.Forms;
public class Fixture : Form { protected override bool ShowWithoutActivation { get { return true; } }
[STAThread] public static void Main() { Application.EnableVisualStyles(); var f = new Fixture(); f.Text="Disposable Olanga session fixture"; f.StartPosition=FormStartPosition.Manual; f.SetBounds(120,140,600,420);
string directory=Encoding.UTF8.GetString(Convert.FromBase64String("${Buffer.from(directory).toString('base64')}")); var elapsed=System.Diagnostics.Stopwatch.StartNew(); var timer=new Timer(); timer.Interval=100; timer.Tick+=delegate { if(File.Exists(Path.Combine(directory,"maximize.signal"))) f.WindowState=FormWindowState.Maximized; if(File.Exists(Path.Combine(directory,"minimize.signal"))) f.WindowState=FormWindowState.Minimized; if(File.Exists(Path.Combine(directory,"normal.signal"))) f.WindowState=FormWindowState.Normal; if(File.Exists(Path.Combine(directory,"exit.signal")) || elapsed.ElapsedMilliseconds>90000) { timer.Stop(); f.Close(); } }; timer.Start(); Application.Run(f); timer.Dispose(); } }`;
    const script = `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(source).toString('base64')}'))\nAdd-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly '${executable.replace(/'/g, "''")}' -OutputType WindowsApplication`;
    execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000 });
    const opened = await appController.open('fixture'); report.receipts.opened = opened;
    check('Only the private fixture starts with verified identity', opened.ok && opened.verified);
    const capture = await service.capture(); report.receipts.capture = capture;
    check('Native capture returns exactly the private window and its geometry', capture.ok && capture.windows.length === 1 && capture.windows[0].bounds.right - capture.windows[0].bounds.left >= 500);
    const saved = await service.save({ captureId: capture.captureId, name: 'Fixture normal', windowIds: [capture.windows[0].id] });
    check('Explicit selected window saves', saved.ok);
    fs.writeFileSync(path.join(directory, 'maximize.signal'), 'maximize');
    await new Promise(resolve => setTimeout(resolve, 300));
    const arranged = await service.capture();
    check('Fixture moves away from its saved layout', arranged.ok && arranged.windows[0].state === 'maximized');
    fs.unlinkSync(path.join(directory, 'maximize.signal'));
    const preview = await service.previewRestore(saved.session.id); report.receipts.preview = preview;
    check('Preview finds the existing private window', preview.ok && preview.steps[0].status === 'existing');
    const restored = await service.restore(preview.previewId); report.receipts.restored = restored;
    check('Saved normal geometry restores with native readback', restored.ok && restored.receipts[0].verified && Math.abs(restored.receipts[0].bounds.left - capture.windows[0].bounds.left) <= 12);
    check('Repeated dispatch cannot reuse a consumed preview', !(await service.restore(preview.previewId)).ok);
    const capabilities = await service.capture();
    check('Restore reused one window without duplicate app launches', capabilities.ok && capabilities.windows.length === 1);
    fs.writeFileSync(path.join(directory, 'minimize.signal'), 'minimize');
    await new Promise(resolve => setTimeout(resolve, 250));
    const minimized = await service.capture();
    check('Minimized fixture retains valid normal restore geometry', minimized.ok && minimized.windows[0].state === 'minimized' && minimized.windows[0].bounds.bottom - minimized.windows[0].bounds.top >= 400);
    const savedMinimized = await service.save({ captureId: minimized.captureId, name: 'Fixture minimized', windowIds: [minimized.windows[0].id] });
    fs.unlinkSync(path.join(directory, 'minimize.signal')); fs.writeFileSync(path.join(directory, 'normal.signal'), 'normal');
    await new Promise(resolve => setTimeout(resolve, 250)); fs.unlinkSync(path.join(directory, 'normal.signal'));
    const minimizedPreview = await service.previewRestore(savedMinimized.session.id);
    const minimizedRestored = await service.restore(minimizedPreview.previewId); report.receipts.minimizedRestored = minimizedRestored;
    check('Minimized saved state restores with native state verification', minimizedRestored.ok && minimizedRestored.receipts[0].state === 'minimized');
    report.passed = true;
  } catch (error) { report.error = error.message; }
  finally {
    fs.writeFileSync(path.join(directory, 'exit.signal'), 'exit');
    service.dispose(); appController.dispose();
    fs.writeFileSync(path.join(output, 'work-sessions-native-smoke.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.passed ? 0 : 1;
  }
})();
