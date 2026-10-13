const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { parseVersion } = require('./release-service');

const ATTEMPT = /^install-attempt-[a-zA-Z0-9]{6,64}$/;
const NONCE = /^[a-f0-9]{48}$/;
const validPath = value => typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/.test(value);
const samePath = (left, right) => process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
const stableVersion = value => { const parsed = parseVersion(value); return !!parsed && parsed.version === value && !parsed.prerelease.length; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function readBoundedJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Invalid update readiness file.');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function parseReadinessArguments(argv) {
  const values = prefix => argv.filter(value => typeof value === 'string' && value.startsWith(prefix)).map(value => value.slice(prefix.length));
  const attempts = values('--olanga-update-attempt='), nonces = values('--olanga-update-nonce=');
  if (attempts.length !== 1 || nonces.length !== 1 || !ATTEMPT.test(attempts[0]) || !NONCE.test(nonces[0])) return null;
  const modes = ['--updated', '--update-recovery'].filter(value => argv.includes(value));
  if (modes.length !== 1) return null;
  return { attemptId: attempts[0], nonce: nonces[0], mode: modes[0].slice(2) };
}
function loadReadinessChallenge({ argv, updatesDir, appExe, currentVersion, now = Date.now() }) {
  const args = parseReadinessArguments(argv);
  if (!args || !validPath(updatesDir) || !validPath(appExe) || !stableVersion(currentVersion)) return null;
  try {
    const attemptDir = path.join(updatesDir, args.attemptId), stat = fs.lstatSync(attemptDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(attemptDir), path.join(fs.realpathSync(updatesDir), args.attemptId))) return null;
    const request = readBoundedJson(path.join(attemptDir, 'request.json'));
    const challenge = readBoundedJson(path.join(attemptDir, 'restart-challenge.json'));
    const age = now - Date.parse(challenge.createdAt);
    if (request.schema !== 2 || !NONCE.test(request.token) || !validPath(request.appExe) || !samePath(request.appExe, appExe)
      || challenge.schema !== 1 || challenge.attemptId !== args.attemptId || challenge.nonce !== args.nonce || challenge.requestToken !== request.token
      || challenge.mode !== args.mode || challenge.version !== currentVersion || !stableVersion(challenge.version)
      || !Number.isFinite(age) || age < -60000 || age > 5 * 60000
      || (args.mode === 'updated' ? challenge.version !== request.version : ![request.currentVersion, request.version].includes(challenge.version))
      || fs.existsSync(path.join(attemptDir, 'cancel'))) return null;
    return { ...args, attemptDir, version: challenge.version, createdAt: challenge.createdAt };
  } catch { return null; }
}

// This is deliberately inspected from the main process, rather than trusting a
// renderer-supplied claim that a process/window exists. The marker is set only
// after the application's initialization promise resolves successfully.
const READINESS_PROBE = `(() => {
  if (window.OlangaAppInitialized !== true || document.readyState !== 'complete' || !window.OlangaWorkspace || typeof window.loadSettingsValues !== 'function') return false;
  const visibleScreens = [...document.querySelectorAll('.screen:not(.hidden), dialog[open]')];
  return visibleScreens.some(screen => [...screen.querySelectorAll('button, input, select, textarea, [contenteditable="true"]')].some(node => !node.disabled && !node.closest('[inert]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible'));
})()`;

function createUpdateReadiness({ updatesDir, appExe = process.execPath, currentVersion, getMainWindow, argv = process.argv,
  now = Date.now, pid = process.pid, confirmTimeoutMs = 5000, pollMs = 75 } = {}) {
  if (!Number.isFinite(confirmTimeoutMs) || confirmTimeoutMs <= 0 || confirmTimeoutMs > 30000 || !Number.isFinite(pollMs) || pollMs <= 0) throw new TypeError('Renderer readiness polling must be bounded.');
  if (typeof getMainWindow !== 'function') throw new TypeError('A main-window getter is required.');
  let pending = null, inFlight = null, generation = 0;
  function acceptLaunchArguments(nextArgv) {
    const next = loadReadinessChallenge({ argv: nextArgv, updatesDir, appExe, currentVersion, now: now() });
    if (!next) return false;
    pending = next; generation++; inFlight = null;
    return true;
  }
  acceptLaunchArguments(argv);
  async function confirmReady(sender) {
    const window = getMainWindow();
    if (sender && sender !== window?.webContents) throw new Error('Only the main application renderer may confirm update readiness.');
    if (!pending) return { ready: false, reason: 'no-update-attempt' };
    if (inFlight) return inFlight;
    const attempt = pending, revision = generation;
    inFlight = (async () => {
      const deadline = performance.now() + confirmTimeoutMs;
      while (performance.now() < deadline && revision === generation) {
        const current = getMainWindow();
        if (current && !current.isDestroyed() && current.isVisible() && !current.isMinimized() && !current.webContents.isDestroyed() && !current.webContents.isLoading()) {
          try {
            let probeTimer;
            const usable = await Promise.race([
              current.webContents.executeJavaScript(READINESS_PROBE, true),
              new Promise(resolve => { probeTimer = setTimeout(() => resolve(false), Math.max(1, deadline - performance.now())); }),
            ]).finally(() => clearTimeout(probeTimer));
            if (usable === true && current === getMainWindow() && current.isVisible() && !current.isMinimized() && !current.isDestroyed() && !current.webContents.isLoading() && revision === generation) {
              // Re-read the challenge immediately before acknowledging: a later
              // recovery/restart nonce must invalidate an older async probe.
              const fresh = loadReadinessChallenge({ argv: [`--${attempt.mode}`, `--olanga-update-attempt=${attempt.attemptId}`, `--olanga-update-nonce=${attempt.nonce}`], updatesDir, appExe, currentVersion, now: now() });
              if (!fresh) return { ready: false, reason: 'expired-update-attempt' };
              const acknowledgment = { schema: 1, attemptId: attempt.attemptId, nonce: attempt.nonce, version: currentVersion,
                mode: attempt.mode, pid, ready: true, rendererReady: true, visible: true, createdAt: new Date(now()).toISOString() };
              const file = path.join(attempt.attemptDir, 'app-ready.json');
              const temporary = file + '.' + pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
              try { await fs.promises.writeFile(temporary, JSON.stringify(acknowledgment), { flag: 'wx', mode: 0o600 }); await fs.promises.rename(temporary, file); }
              finally { await fs.promises.unlink(temporary).catch(() => {}); }
              return { ready: true, version: currentVersion };
            }
          } catch { /* A renderer still loading or being replaced can retry. */ }
        }
        await pause(pollMs);
      }
      return { ready: false, reason: 'renderer-not-ready' };
    })();
    try { return await inFlight; } finally { if (revision === generation) inFlight = null; }
  }
  return { acceptLaunchArguments, confirmReady, hasPendingAttempt: () => !!pending };
}
module.exports = { parseReadinessArguments, loadReadinessChallenge, createUpdateReadiness, READINESS_PROBE };
