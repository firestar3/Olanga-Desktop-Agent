// Uses real Windows executables and the production supervisor in an isolated
// temp installation. It never touches Olanga's registry, settings or install.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createInstallerLauncher } = require('../desktop/update-installer');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
async function waitFor(predicate, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await pause(100);
  }
  throw new Error(message);
}

if (process.argv[2] === '--parent-fixture') {
  const config = readJson(process.argv[3]);
  const launch = createInstallerLauncher({
    appExe: config.appExe, currentVersion: '1.5.1', updatesDir: config.updatesDir, showProgress: config.showProgress, restartTimeoutMs: 3000,
    spawnImpl(file, args, options) {
      const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
      fs.writeFileSync(path.join(config.updatesDir, 'helper-command.json'), JSON.stringify({ file, args, options: { cwd: options.cwd }, pid: child.pid }));
      for (const stream of [child.stdout, child.stderr]) stream.on('data', value => fs.appendFileSync(path.join(config.updatesDir, 'helper-output.txt'), value));
      return child;
    },
    quit() { fs.writeFileSync(config.quitMarker, 'quit'); process.exit(0); },
  });
  launch(config.installer, '1.5.2', { sha256: config.sha256 }).then(result => {
    fs.writeFileSync(config.launchMarker, JSON.stringify(result));
  }).catch(error => { fs.writeFileSync(config.launchMarker, JSON.stringify({ error: error.message })); process.exit(1); });
} else {
  run().catch(error => { console.error(error.stack); process.exitCode = 1; });
}

async function run() {
  if (process.platform !== 'win32') throw new Error('This smoke test requires Windows.');
  // Native processes expand Windows 8.3 aliases such as RUNNER~1. Compare
  // actual directories, even when TEMP or a child process uses another spelling.
  const temporaryDirectory = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(temporaryDirectory, "olanga-installer-native-")));
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const report = { cases: [], isolatedRoot: root, passed: false };
  const fixtureProcesses = [];
  const fixtureCode = version => `using System; using System.IO; using System.Reflection; using System.Threading; using System.Diagnostics; using System.Collections.Generic; using System.Web.Script.Serialization; using System.Windows.Forms; using System.Drawing;
[assembly: AssemblyFileVersion("${version}")]
class FixtureApp { [STAThread] static void Main(string[] args) {
  var directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
  if (args.Length > 0 && args[0] == "--orphan-fixture") { File.WriteAllText(Path.Combine(directory, "orphan-started.txt"), "orphan without a main window"); Thread.Sleep(6000); return; }
  File.WriteAllText(Path.Combine(directory, "app-started.txt"), String.Join(" ", args) + "\\n${version}");
  if (File.Exists(Path.Combine(directory, "exit-after-launch.txt"))) return;
  var form = new Form { Text = "Olanga disposable updater fixture", StartPosition = FormStartPosition.Manual, Location = new Point(-20000, -20000), Size = new Size(260, 160), ShowInTaskbar = true };
  form.Controls.Add(new Button { Text = "Fixture ready", Location = new Point(10, 10) });
  var close = new System.Windows.Forms.Timer { Interval = 9000 }; close.Tick += delegate { form.Close(); }; close.Start();
  form.Shown += delegate {
    var timer = new System.Windows.Forms.Timer { Interval = 300 };
    timer.Tick += delegate {
      timer.Stop();
      var modePath = Path.Combine(directory, "readiness-mode.txt");
      var mode = File.Exists(modePath) ? File.ReadAllText(modePath) : "success";
      if (mode == "unready") return;
      string attempt = null, nonce = null;
      foreach (var arg in args) { if (arg.StartsWith("--olanga-update-attempt=")) attempt = arg.Substring("--olanga-update-attempt=".Length); if (arg.StartsWith("--olanga-update-nonce=")) nonce = arg.Substring("--olanga-update-nonce=".Length); }
      if (attempt == null || nonce == null) return;
      var serializer = new JavaScriptSerializer();
      var attemptDirectory = Path.Combine(directory, "updates", attempt);
      var challenge = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(attemptDirectory, "restart-challenge.json")));
      var acknowledgment = new Dictionary<string, object> { { "schema", 1 }, { "attemptId", attempt }, { "nonce", mode == "wrongnonce" ? new String('0', 48) : nonce }, { "version", new Version("${version}").ToString(3) }, { "mode", challenge["mode"] }, { "pid", Process.GetCurrentProcess().Id }, { "ready", true }, { "rendererReady", true }, { "visible", true }, { "createdAt", DateTime.UtcNow.ToString("o") } };
      File.WriteAllText(Path.Combine(attemptDirectory, "app-ready.json"), serializer.Serialize(acknowledgment));
    }; timer.Start();
  };
  Application.Run(form);
} }`;
  const installerCode = `using System; using System.IO; using System.Reflection; using System.Runtime.InteropServices; using System.Text.RegularExpressions; using System.Diagnostics; using System.Threading;
class FixtureInstaller { static int Main(string[] args) {
  var directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
  File.WriteAllText(Path.Combine(directory, "install-invocation.txt"), String.Join(" ", args) + "\\n" + Environment.CurrentDirectory);
  var mode = File.ReadAllText(Path.Combine(directory, "mode.txt"));
  if (mode == "progress") {
    var receipt = File.ReadAllText(Path.Combine(Directory.GetParent(directory).FullName, "install-result.json"));
    var expectedPid = UInt32.Parse(Regex.Match(receipt, "\\\"supervisorPid\\\":(\\\\d+)").Groups[1].Value);
    var found = false;
    EnumWindows(delegate(IntPtr window, IntPtr ignored) { uint pid; GetWindowThreadProcessId(window, out pid); if (pid == expectedPid && IsWindowVisible(window)) found = true; return true; }, IntPtr.Zero);
    File.WriteAllText(Path.Combine(directory, "progress-visible.txt"), found.ToString());
  }
  if (mode == "failure") return 42;
  if (mode == "success" || mode == "threepart" || mode == "revision" || mode == "progress" || mode == "orphan" || mode == "unready" || mode == "wrongnonce") File.Copy(File.ReadAllText(Path.Combine(directory, "replacement-path.txt")), File.ReadAllText(Path.Combine(directory, "app-path.txt")), true);
  if (mode == "orphan") {
    var appPath = File.ReadAllText(Path.Combine(directory, "app-path.txt"));
    var appDirectory = Path.GetDirectoryName(appPath);
    File.WriteAllText(Path.Combine(appDirectory, "exit-after-launch.txt"), "exit after startup");
    Process.Start(new ProcessStartInfo(appPath, "--orphan-fixture") { UseShellExecute = false, CreateNoWindow = true });
    for (int attempt = 0; attempt < 40 && !File.Exists(Path.Combine(appDirectory, "orphan-started.txt")); attempt++) Thread.Sleep(50);
    if (!File.Exists(Path.Combine(appDirectory, "orphan-started.txt"))) return 43;
  }
  return 0;
}
delegate bool WindowCallback(IntPtr window, IntPtr data);
[DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr data);
[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}`;
  function compile(name, source) {
    const sourcePath = path.join(root, name + '.cs');
    const exePath = path.join(root, name + '.exe');
    fs.writeFileSync(sourcePath, source);
    const result = spawnSync(compiler, ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', '/out:' + exePath, sourcePath], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    return exePath;
  }
  try {
    const before = compile('before', fixtureCode('1.5.1.0'));
    const after = compile('after', fixtureCode('1.5.2.0'));
    const afterThree = compile('after-three', fixtureCode('1.5.2'));
    const afterRevision = compile('after-revision', fixtureCode('1.5.2.1'));
    const setup = compile('setup', installerCode);
    const allCases = ['success', 'threepart', 'revision', 'progress', 'failure', 'mismatch', 'tampered', 'orphan', 'unready', 'wrongnonce'];
    const selectedCase = process.argv.find(value => value.startsWith('--case='))?.slice(7);
    if (selectedCase) assert.ok(allCases.includes(selectedCase), 'Unknown native fixture case');
    for (const mode of selectedCase ? [selectedCase] : allCases) {
      // Spaces, apostrophes, ampersands and Unicode must be data, never shell code.
      const testDirectory = path.join(root, `${mode} user's & 测试`);
      const updatesDir = path.join(testDirectory, 'updates');
      const cache = path.join(updatesDir, 'update-1.5.2-abc123');
      fs.mkdirSync(cache, { recursive: true });
      const appExe = path.join(testDirectory, 'OlangaFixture.exe');
      const installer = path.join(cache, 'Olanga-Setup-1.5.2.exe');
      fs.copyFileSync(before, appExe);
      fs.writeFileSync(path.join(testDirectory, 'readiness-mode.txt'), mode);
      fs.copyFileSync(setup, installer);
      fs.writeFileSync(path.join(cache, 'mode.txt'), mode);
      fs.writeFileSync(path.join(cache, 'app-path.txt'), appExe);
      fs.writeFileSync(path.join(cache, 'replacement-path.txt'), mode === 'threepart' ? afterThree : mode === 'revision' ? afterRevision : after);
      const config = { appExe, installer, updatesDir, showProgress: mode === 'progress',
        sha256: mode === 'tampered' ? '0'.repeat(64) : crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex'),
        quitMarker: path.join(testDirectory, 'quit.txt'), launchMarker: path.join(testDirectory, 'launch.json') };
      const configPath = path.join(testDirectory, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify(config));
      const parent = spawn(process.execPath, [__filename, '--parent-fixture', configPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      fixtureProcesses.push(parent);
      let output = '';
      parent.stderr.on('data', value => { output += value; });
      const outcome = await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Parent handoff exceeded 30 seconds')), 30000);
        parent.once('error', error => { clearTimeout(deadline); reject(error); });
        parent.once('exit', (code, signal) => { clearTimeout(deadline); resolve({ code, signal }); });
      });
      const launch = readJson(config.launchMarker);
      const helperOutput = path.join(updatesDir, 'helper-output.txt');
      if (fs.existsSync(helperOutput)) output += fs.readFileSync(helperOutput, 'utf8');
      if (outcome.code !== 0 && mode !== 'tampered') {
        for (const entry of fs.readdirSync(updatesDir, { recursive: true })) {
          if (/^(?:install-result\.json|helper-command\.json)$/.test(entry) || entry.endsWith('ready.json')) {
            output += '\n' + entry + ': ' + fs.readFileSync(path.join(updatesDir, entry), 'utf8');
          }
        }
      }
      if (mode === 'tampered') {
        assert.equal(outcome.code, 1, output);
        assert.match(launch.error, /supervisor/);
        assert.equal(fs.existsSync(config.quitMarker), false, 'preflight failures must not quit the parent');
        assert.equal(fs.existsSync(path.join(cache, 'install-invocation.txt')), false);
        report.cases.push({ mode, passed: true, appStayedOpen: true });
        continue;
      }
      assert.equal(outcome.code, 0, output + JSON.stringify(launch));
      assert.equal(launch.supervised, true);
      assert.equal(fs.existsSync(config.quitMarker), true);
      const resultPath = path.join(updatesDir, 'install-result.json');
      const result = await waitFor(() => {
        if (!fs.existsSync(resultPath)) return null;
        const value = readJson(resultPath);
        return ['restarted', 'failed'].includes(value.stage) ? value : null;
      }, 'Supervisor did not report completion');
      const appMarker = path.join(testDirectory, 'app-started.txt');
      await waitFor(() => fs.existsSync(appMarker), 'App was not restarted after installer completed');
      const invocation = fs.readFileSync(path.join(cache, 'install-invocation.txt'), 'utf8').split('\n');
      assert.equal(invocation[0], '--updated /S');
      assert.equal(fs.realpathSync.native(path.dirname(invocation[1])), fs.realpathSync.native(updatesDir), 'installer working directory must be outside the installed app');
      const appStart = fs.readFileSync(appMarker, 'utf8');
      if (mode === 'success' || mode === 'threepart' || mode === 'progress') {
        assert.equal(result.stage, 'restarted', JSON.stringify({result, appStart, attempts: fs.readdirSync(updatesDir).filter(name=>name.startsWith('install-attempt-')).map(name=>({name, files: fs.readdirSync(path.join(updatesDir,name)).filter(file=>file.endsWith('.json')).map(file=>({file,body:readJson(path.join(updatesDir,name,file))}))}))}));
        assert.equal(result.installedVersion, mode === 'threepart' ? '1.5.2' : '1.5.2.0');
        assert.equal(result.rendererReady, true);
        assert.match(appStart, /^--updated --olanga-update-attempt=install-attempt-[a-zA-Z0-9]+ --olanga-update-nonce=[a-f0-9]{48}\n1\.5\.2(?:\.0)?$/);
        if (mode === 'progress') assert.equal(fs.readFileSync(path.join(cache, 'progress-visible.txt'), 'utf8'), 'True', 'a native progress window must remain visible after Olanga quits');
      } else if (mode === 'revision') {
        assert.equal(result.stage, 'failed');
        assert.equal(result.code, 'installed-version-mismatch');
        assert.equal(result.installedVersion, '1.5.2.1');
        assert.match(appStart, /^--update-recovery .*\n1\.5\.2\.1$/);
        await waitFor(() => readJson(resultPath).recoveryReady === true, 'Different-revision installation must recover without claiming update success');
      } else if (mode === 'orphan') {
        assert.equal(result.stage, 'failed', 'an orphan process without a main window cannot count as successful restart');
        assert.equal(result.code, 'app-restart-failed');
        assert.equal(result.installedVersion, '1.5.2.0');
        assert.ok(fs.existsSync(path.join(testDirectory, 'orphan-started.txt')));
        await waitFor(() => /^--update-recovery .*\n1\.5\.2\.0$/.test(fs.readFileSync(appMarker, 'utf8')), 'Recovery must be attempted when only an orphan process remains');
      } else if (mode === 'unready' || mode === 'wrongnonce') {
        assert.equal(result.stage, 'failed');
        assert.equal(result.code, 'app-ready-timeout');
        assert.equal(result.rendererReady, false, 'a visible process with no valid renderer acknowledgment must not complete the update');
        await waitFor(() => /^--update-recovery .*\n1\.5\.2\.0$/.test(fs.readFileSync(appMarker, 'utf8')), 'Recovery must be attempted after readiness timeout');
      } else {
        assert.equal(result.stage, 'failed');
        assert.equal(result.code, mode === 'failure' ? 'installer-exit-code' : 'installed-version-mismatch');
        assert.match(appStart, /^--update-recovery .*\n1\.5\.1\.0$/);
        await waitFor(() => readJson(resultPath).recoveryReady === true, 'Previous version must be usable after recovery');
      }
      report.cases.push({ mode, passed: true, exitCode: result.exitCode, stage: result.stage, installedVersion: result.installedVersion });
    }
    report.passed = true;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory() && /^install-attempt-/.test(entry.name)) fs.writeFileSync(path.join(entry.parentPath, entry.name, 'cancel'), 'cancel');
    }
    for (const child of fixtureProcesses) if (child.exitCode == null && child.signalCode == null) child.kill();
    // Fixture applications terminate themselves; allow their short liveness check
    // to finish before deleting this test's own directory.
    await pause(10000);
    const reportPath = process.env.OLANGA_UPDATE_SMOKE_REPORT;
    console.log(JSON.stringify(report, null, 2));
    if (reportPath) {
      fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
      fs.writeFileSync(path.resolve(reportPath), JSON.stringify(report, null, 2));
    }
    assert.equal(fs.realpathSync.native(path.dirname(root)), temporaryDirectory);
    assert.match(path.basename(root), /^olanga-installer-native-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
