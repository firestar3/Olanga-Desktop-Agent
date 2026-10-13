// Two real fixture NSIS installers with separate product identity are required.
// Build each using tests/fixtures/update-e2e-builder.cjs, then pass their paths:
// node tests/update-installer-e2e-smoke.js --baseline=<1.5.2.exe> --target=<1.6.0.exe>
// This invokes production UI actions, not mocked update IPC. Only the release
// transport is local fixture data. The normal installed Olanga is never opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build', 'qa');
const fixtureGuid = 'd2e33a92-193e-46ee-87bc-0d079f2471a2';
const fixtureRegistryKeys = ['HKCU', 'HKLM'].flatMap(hive => [`${hive}\\Software\\${fixtureGuid}`, `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${fixtureGuid}`]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function readJourney(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; } }
function argument(name) { const values = process.argv.slice(2).filter(value => value.startsWith('--' + name + '=')); assert.equal(values.length, 1, 'One --' + name + '=installer path is required.'); return path.resolve(values[0].slice(name.length + 3)); }
function fileHash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function registryExists(key) { return spawnSync('reg.exe', ['query', key], { windowsHide: true, stdio: 'ignore' }).status === 0; }
function validateInstaller(file, version) {
  assert.equal(path.basename(file), `Olanga-Setup-${version}.exe`);
  const relative = path.relative(fs.realpathSync(output), fs.realpathSync(file));
  assert.equal(path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep), false, 'Use only fixture builds in build/qa.');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.equal(path.basename(path.dirname(file)), `update-fixture-${version}`);
  assert.ok(fs.statSync(file).isFile());
  const archive = path.join(path.dirname(file), 'win-unpacked', 'resources', 'app.asar');
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json'));
  assert.equal(packaged.name, 'olanga-update-e2e-fixture'); assert.equal(packaged.version, version);
  assert.equal(packaged.main, 'tests/fixtures/update-e2e-host.js');
  const sourceFiles = asar.listPackage(archive).map(file => file.replace(/^[/\\]/, '')).filter(relative => {
    if (/^(?:js|shared|desktop)[/\\]/.test(relative)) return !asar.statFile(archive, relative).files;
    return !/[/\\]/.test(relative) && (relative === 'PRIVACY.md' || /\.(?:js|css|html)$/.test(relative));
  });
  assert.ok(sourceFiles.length > 80, 'The full production source must be packaged.');
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  for (const relative of sourceFiles) {
    assert.equal(relative.split(/[/\\]/).includes('..'), false);
    assert.equal(hash(asar.extractFile(archive, relative)), hash(fs.readFileSync(path.join(root, relative))), 'Rebuild fixture with final production source: ' + relative);
  }
  assert.deepEqual(asar.extractFile(archive, path.join('tests', 'fixtures', 'update-e2e-host.js')), fs.readFileSync(path.join(__dirname, 'fixtures', 'update-e2e-host.js')), 'Rebuild the fixture with the current test host.');
  return sourceFiles.length;
}
async function execute(file, args, timeoutMs = 180000, options = {}) {
  const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let text = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { text += value; });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Fixture process timed out: ' + path.basename(file))); }, timeoutMs);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve(text) : reject(new Error('Fixture process failed: ' + path.basename(file) + ' (' + code + ') ' + text)); });
  });
}
function stopOnlyFixture(appExe) {
  // The executable is generated from the verified private directory, and both
  // filtering and process termination stay in one PowerShell invocation.
  const escapedPath = appExe.replace(/'/g, "''");
  const escapedRoot = path.dirname(path.dirname(appExe)).replace(/'/g, "''");
  const command = `$fixtureExecutable = '${escapedPath}'; Get-CimInstance Win32_Process -Filter "Name='OlangaUpdateFixture.exe'" | Where-Object { $_.ExecutablePath -eq $fixtureExecutable } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $fixtureRoot = '${escapedRoot}'; Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($fixtureRoot) -and $_.CommandLine.Contains('update-supervisor.ps1') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Get-CimInstance Win32_Process -Filter "Name='Olanga-Setup-1.6.0.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($fixtureRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F }`;
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8' });
}
async function run() {
  assert.equal(process.platform, 'win32');
  const baseline = argument('baseline'), target = argument('target');
  const verifiedSourceFiles = { baseline: validateInstaller(baseline, '1.5.2'), target: validateInstaller(target, '1.6.0') };
  for (const key of fixtureRegistryKeys) assert.equal(registryExists(key), false, 'A previous fixture install exists. Clean that known fixture before retrying.');
  const temp = fs.realpathSync.native(os.tmpdir());
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(temp, 'olanga-update-e2e-')));
  const installation = path.join(directory, 'installation'), appExe = path.join(installation, 'OlangaUpdateFixture.exe');
  let installed = false, report = { passed: false, isolatedRoot: directory, verifiedSourceFiles, coverage: { realNsis: true, fixtureTransport: true, liveGitHub: false, productionUserProfile: false, codeSigned: false }, cleanup: {} };
  fs.mkdirSync(output, { recursive: true });
  try {
    fs.mkdirSync(path.join(directory, 'assets'));
    fs.copyFileSync(target, path.join(directory, 'assets', path.basename(target)));
    fs.writeFileSync(path.join(directory, 'e2e-config.json'), JSON.stringify({ fixture: 'olanga-update-e2e-v1', installation, targetVersion: '1.6.0' }));
    // NSIS requires /D last and without quoting, even if the path has spaces.
    // No command shell is involved; path bytes are never interpreted as code.
    await execute(baseline, ['/S', '/currentuser', '/D=' + installation], 180000, { windowsVerbatimArguments: true });
    installed = true;
    assert.ok(fs.existsSync(appExe), 'Baseline fixture did not install into the private directory.');
    assert.equal(fileHash(path.join(installation, 'resources', 'app.asar')), fileHash(path.join(path.dirname(baseline), 'win-unpacked', 'resources', 'app.asar')), 'The installed baseline must exactly match the verified packaged source.');
    assert.equal(registryExists(fixtureRegistryKeys[0]), true, 'Only the fixture identity must be registered for the normal updater to locate it.');
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE; delete environment.NODE_OPTIONS;
    const child = spawn(appExe, [], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'], env: environment });
    let appOutput = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { appOutput += value; });
    let launchError = null; child.once('error', error => { launchError = error; });
    const reportPath = path.join(directory, 'journey.json');
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (fs.existsSync(reportPath)) {
        const journey = readJourney(reportPath);
        if (!journey) { await pause(50); continue; }
        if (journey.error) { report = { ...report, ...journey }; throw new Error(journey.error); }
        if (journey.passed) { report = { ...report, ...journey }; break; }
      }
      await pause(200);
    }
    assert.equal(report.passed, true, 'Full NSIS journey did not finish. ' + appOutput.slice(-4000));
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'profile', 'updates', 'install-result.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(receipt.schema, 2); assert.equal(receipt.stage, 'restarted'); assert.equal(receipt.rendererReady, true); assert.equal(receipt.version, '1.6.0');
    report.receipt = receipt;
    assert.equal(fileHash(path.join(installation, 'resources', 'app.asar')), fileHash(path.join(path.dirname(target), 'win-unpacked', 'resources', 'app.asar')), 'The installed update must exactly match the verified final source.');
    report.installedArchivesMatchVerifiedFixtures = true;
    fs.copyFileSync(path.join(directory, 'reopened.png'), path.join(output, 'update-installer-e2e-reopened.png'));
  } catch (error) {
    report.passed = false; report.error = error.stack || String(error);
    const journeyPath = path.join(directory, 'journey.json');
    if (fs.existsSync(journeyPath)) report.journey = readJourney(journeyPath);
    const receiptPath = path.join(directory, 'profile', 'updates', 'install-result.json');
    if (fs.existsSync(receiptPath)) report.receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8').replace(/^\uFEFF/, ''));
    process.exitCode = 1;
  } finally {
    assert.equal(fs.realpathSync.native(path.dirname(directory)), temp);
    assert.match(path.basename(directory), /^olanga-update-e2e-[a-zA-Z0-9]+$/);
    assert.equal(path.dirname(appExe), path.join(directory, 'installation'));
    const updates = path.join(directory, 'profile', 'updates');
    if (fs.existsSync(updates)) for (const entry of fs.readdirSync(updates, { withFileTypes: true })) if (entry.isDirectory() && /^install-attempt-[a-zA-Z0-9]+$/.test(entry.name)) fs.writeFileSync(path.join(updates, entry.name, 'cancel'), 'cancel');
    stopOnlyFixture(appExe); await pause(1500);
    if (installed && fs.existsSync(installation)) {
      const uninstallers = fs.readdirSync(installation).filter(name => /^Uninstall OlangaUpdateFixture\.exe$/.test(name));
      if (uninstallers.length === 1) {
        try { await execute(path.join(installation, uninstallers[0]), ['/S', '/currentuser'], 60000); }
        catch (error) { report.cleanup.error = error.message; }
      } else report.cleanup.error = 'Expected isolated fixture uninstaller not found.';
    }
    for (let index = 0; index < 50 && fixtureRegistryKeys.some(registryExists); index++) await pause(100);
    report.cleanup.registryRemoved = fixtureRegistryKeys.every(key => !registryExists(key));
    if (!report.cleanup.registryRemoved || report.cleanup.error) { report.passed = false; process.exitCode = 1; }
    else { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); report.cleanup.privateDirectoryRemoved = true; }
    fs.writeFileSync(path.join(output, 'update-installer-e2e-smoke.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
