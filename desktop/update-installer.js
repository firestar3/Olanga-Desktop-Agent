const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { parseVersion, compareVersions } = require('./release-service');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const validPath = value => typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/.test(value);
const supervisorPath = path.join(__dirname, 'update-supervisor.ps1').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');

function readInstallResult(updatesDir, installedVersion) {
  try {
    if (!validPath(updatesDir)) return null;
    const file = path.join(updatesDir, 'install-result.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) return null;
    const result = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (result.schema !== 1 || !parseVersion(result.version) || !['installed', 'restarted', 'failed'].includes(result.stage)) return null;
    if (!Number.isFinite(Date.parse(result.updatedAt)) || Date.now() - Date.parse(result.updatedAt) > 7 * 86400000) return null;
    const succeeded = result.stage !== 'failed' && compareVersions(String(installedVersion), result.version) >= 0;
    return { ok: succeeded, version: result.version,
      message: succeeded ? `Olanga ${installedVersion} is installed. Your update is complete.`
        : `The update to Olanga ${result.version} did not finish. Your app has reopened. Check for updates to try again.` };
  } catch { return null; }
}

// The supervisor is copied outside the installation directory before startup.
// It survives app shutdown and owns installation, version checks and restart.
function createInstallerLauncher({
  spawnImpl = spawn, quit, scheduleQuit = setTimeout,
  appExe = process.execPath, currentVersion, updatesDir,
  helperSource = supervisorPath, powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  readyTimeoutMs = 15000, pollMs = 100, parentPid = process.pid,
  showProgress = true,
} = {}) {
  if (typeof quit !== 'function') throw new TypeError('An application quit callback is required.');
  let active = null;

  return async function launchInstaller(filePath, version, verification = {}) {
    const parsed = parseVersion(version);
    if (!validPath(filePath) || !parsed || parsed.prerelease.length || path.basename(filePath) !== `Olanga-Setup-${parsed.version}.exe`
      || !validPath(appExe) || !validPath(updatesDir) || !parseVersion(currentVersion) || compareVersions(version, currentVersion) <= 0
      || !/^[a-f0-9]{64}$/i.test(verification.sha256 || '') || path.dirname(path.dirname(filePath)) !== path.resolve(updatesDir)) {
      throw new Error('The verified Windows update installer is invalid.');
    }
    if (active) {
      if (active.filePath !== filePath || active.version !== version) throw new Error('An update installation is already starting.');
      return active.promise;
    }
    const request = { filePath, version, promise: null };
    active = request;
    request.promise = (async () => {
      const attemptDir = await fs.promises.mkdtemp(path.join(updatesDir, 'install-attempt-'));
      const configPath = path.join(attemptDir, 'request.json');
      const readyPath = path.join(attemptDir, 'ready.json');
      const cancelPath = path.join(attemptDir, 'cancel');
      const copiedHelper = path.join(attemptDir, 'update-supervisor.ps1');
      const token = crypto.randomBytes(24).toString('hex');
      let child, launchError = null, exited = false, exitCode = null;
      try {
        await fs.promises.copyFile(helperSource, copiedHelper, fs.constants.COPYFILE_EXCL);
        await fs.promises.writeFile(configPath, JSON.stringify({ schema: 1, token, parentPid, appExe, currentVersion,
          parentExe: process.execPath, installer: filePath, version, sha256: verification.sha256.toLowerCase(), showProgress }), { flag: 'wx', mode: 0o600 });
        const helperEnv = { ...process.env, PSModulePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') };
        // A development shell's PowerShell 7 module path or Electron Node mode
        // must not break the system helper or turn the restarted app into Node.
        delete helperEnv.ELECTRON_RUN_AS_NODE;
        delete helperEnv.ELECTRON_NO_ASAR;
        delete helperEnv.NODE_OPTIONS;
        child = spawnImpl(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', copiedHelper, '-RequestPath', configPath, '-Bootstrap'], {
          // The bootstrap creates the worker's independent hidden console with
          // Start-Process. Node's detached console flags can make Windows
          // PowerShell exit 0 before it executes the readiness handshake.
          cwd: attemptDir, detached: false, stdio: 'ignore', windowsHide: true, shell: false, env: helperEnv,
        });
        child.once('error', error => { launchError = error; });
        child.once('exit', code => { exited = true; exitCode = code; });
        const deadline = Date.now() + readyTimeoutMs;
        while (Date.now() < deadline) {
          if (launchError) throw launchError;
          if (exited) throw new Error(`The update supervisor stopped before it was ready (${exitCode}).`);
          let ready;
          try { ready = JSON.parse((await fs.promises.readFile(readyPath, 'utf8')).replace(/^\uFEFF/, '')); }
          catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
          if (ready?.token === token && ready?.ready === false) throw new Error('The update supervisor could not prepare the installation.');
          if (ready?.token === token && ready?.ready === true) {
            child.unref();
            // Let IPC deliver the handoff result before the renderer closes.
            // A process spawn alone is never enough evidence to close Olanga.
            scheduleQuit(quit, 300);
            return { launched: true, supervised: true, version };
          }
          await pause(pollMs);
        }
        throw new Error('The update supervisor did not become ready. Olanga has stayed open.');
      } catch (error) {
        // A slow supervisor must not install later, after the user saw failure.
        await fs.promises.writeFile(cancelPath, 'cancel').catch(() => {});
        child?.unref?.();
        throw error;
      }
    })();
    try { return await request.promise; }
    catch (error) {
      if (active === request) active = null;
      throw error;
    }
  };
}

module.exports = { createInstallerLauncher, readInstallResult };
