const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseVersion } = require('./release-service');

// Called only after the manual update service has verified its private cached
// installer. Downloading an update and ordinary application exit never call it.
function createInstallerLauncher({ spawnImpl = spawn, quit, scheduleQuit = setTimeout } = {}) {
  if (typeof quit !== 'function') throw new TypeError('An application quit callback is required.');
  let active = null;

  return async function launchInstaller(filePath, version) {
    const parsed = parseVersion(version);
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || /[\0\r\n]/.test(filePath) || !parsed || parsed.prerelease.length || path.basename(filePath) !== `Olanga-Setup-${parsed.version}.exe`) {
      throw new Error('The verified Windows update installer is invalid.');
    }
    if (active) {
      if (active.filePath !== filePath || active.version !== version) throw new Error('An update installation is already starting.');
      return active.promise;
    }

    const request = { filePath, version, promise: null };
    active = request;
    request.promise = new Promise((resolve, reject) => {
      let child;
      let settled = false;
      const failed = error => {
        if (settled) return;
        settled = true;
        child?.removeListener('spawn', started);
        reject(error);
      };
      const started = () => {
        if (settled) return;
        try {
          child.unref();
          // Return the IPC result before before-quit closes the renderer. NSIS
          // handles replacing the existing installation and reopening Olanga.
          scheduleQuit(quit, 300);
          settled = true;
          resolve({ launched: true, version });
        } catch (error) { failed(error); }
      };
      try {
        // These are electron-builder's NSIS update switches. Let its registry
        // detection retain the installation directory and per-user/all-user mode.
        child = spawnImpl(filePath, ['--updated', '/S', '--force-run'], {
          detached: true, stdio: 'ignore', windowsHide: true, shell: false,
        });
        child.once('error', failed);
        child.once('spawn', started);
      } catch (error) { failed(error); }
    });
    try { return await request.promise; }
    catch (error) {
      if (active === request) active = null;
      throw error;
    }
  };
}

module.exports = { createInstallerLauncher };
