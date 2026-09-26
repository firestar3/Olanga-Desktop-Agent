const path = require('node:path');
const { spawn } = require('node:child_process');
const { APP_CATALOG, normalizeAppName } = require('../shared/app-catalog');

const BLOCKED = new Set(['explorer', 'olanga', 'electron', 'dwm', 'winlogon', 'csrss', 'wininit', 'services', 'lsass', 'smss', 'svchost', 'fontdrvhost', 'sihost', 'ctfmon', 'searchhost', 'shellexperiencehost', 'startmenuexperiencehost', 'textinputhost', 'applicationframehost', 'systemsettings', 'lockapp', 'runtimebroker', 'audiodg', 'conhost']);
const LEGACY = { cursor: ['cursor'], terminal: ['windowsterminal'], 'windows terminal': ['windowsterminal'], obs: ['obs64'], roblox: ['robloxplayerbeta'] };

function closeTarget(value) {
  const name = normalizeAppName(value).replace(/\.exe$/i, '').toLowerCase();
  const app = APP_CATALOG.find(item => [item.id, item.name, ...item.aliases].some(alias => alias.toLowerCase() === name));
  const processNames = (app?.processes || LEGACY[name] || [name]).map(item => item.toLowerCase());
  if (processNames.some(item => !/^[a-z0-9][a-z0-9._ -]{0,119}$/.test(item))) throw new Error('Use an app name or an exact process name without paths, wildcards, or arguments.');
  if (processNames.some(item => BLOCKED.has(item))) throw new Error('Olanga cannot close this Windows or assistant process.');
  return { name: app?.name || name, processNames: [...new Set(processNames)] };
}

function createCloseController({ spawnProcess = spawn, platform = process.platform, timeoutMs = 10000, settleMs = 2000 } = {}) {
  let sequence = 0, disposed = false;
  const pending = new Map();
  const failure = (status, message, dispatched = false) => ({ ok: false, verified: false, status, reason: status, message, dispatched, forced: false, pending: dispatched });

  async function close(appName) {
    if (disposed) return failure('unavailable', 'App control is unavailable because Olanga is closing.');
    if (platform !== 'win32') return failure('unsupported-platform', 'Closing apps currently requires Windows.');
    let target;
    try { target = closeTarget(appName); } catch (error) { return failure('invalid-app', error.message); }
    return new Promise(resolve => {
      const id = ++sequence;
      let worker, timer, settled = false, buffer = '', dispatched = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(id);
        try { worker?.kill(); } catch { /* A dead helper must not prevent settlement. */ }
        resolve(result);
      };
      const abort = status => finish(failure(status, status === 'cancelled'
        ? (dispatched ? 'Close cancelled. A close request may already have reached the app; check for a save prompt.' : 'Close cancelled.')
        : 'The close request was not confirmed before the deadline. Check the app before trying again.', dispatched));
      pending.set(id, abort);
      timer = setTimeout(() => abort('timeout'), timeoutMs);
      const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const helper = path.join(__dirname, 'close-helper.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      try {
        worker = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        worker.stdout.setEncoding('utf8');
        worker.stdout.on('data', chunk => {
          if (settled) return;
          buffer += chunk;
          if (buffer.length > 64000) return finish(failure('invalid-result', 'Windows returned an invalid close receipt.', dispatched));
          let newline;
          while (!settled && (newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
            if (!line) continue;
            let envelope;
            try { envelope = JSON.parse(line); } catch { return finish(failure('invalid-result', 'Windows returned an invalid close receipt.', dispatched)); }
            if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.id !== id) return finish(failure('invalid-result', 'Windows returned an unexpected close receipt.', dispatched));
            if (envelope.event === 'dispatched') { dispatched = true; continue; }
            const result = envelope.result;
            if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean' || typeof result.verified !== 'boolean' || typeof result.pending !== 'boolean' || typeof result.dispatched !== 'boolean' || result.forced !== false || typeof result.message !== 'string' || typeof result.status !== 'string') return finish(failure('invalid-result', 'Windows did not provide a valid close receipt.', dispatched));
            const validCounts = ['matched', 'requested', 'remaining'].every(key => Number.isInteger(result[key]) && result[key] >= 0);
            const confirmed = result.ok && result.status === 'closed' && result.requested > 0 && result.remaining === 0 && !result.pending;
            if (!validCounts || result.requested > result.matched || result.verified !== confirmed || (result.ok && (!result.dispatched || result.requested < 1 || !['closed', 'pending'].includes(result.status))) || (result.status === 'pending' && (!result.pending || result.remaining < 1))) return finish(failure('invalid-result', 'Windows did not verify the close request consistently.', dispatched));
            finish({ ...result, dispatched: dispatched || result.dispatched });
          }
        });
        worker.stderr.resume();
        worker.on('error', () => finish(failure('helper-error', 'Windows app closing could not start.', dispatched)));
        worker.on('close', () => finish(failure('helper-exited', 'Windows app closing stopped without confirming the result.', dispatched)));
        worker.stdin.on('error', () => finish(failure('helper-error', 'Windows app closing disconnected.', dispatched)));
        worker.stdin.end(JSON.stringify({ id, ...target, settleMs: Math.min(5000, Math.max(0, settleMs)) }) + '\n');
      } catch { finish(failure('helper-error', 'Windows app closing could not start.', dispatched)); }
    });
  }

  return { close, cancel: () => { for (const abort of [...pending.values()]) abort('cancelled'); }, dispose: () => { disposed = true; for (const abort of [...pending.values()]) abort('cancelled'); } };
}

module.exports = { createCloseController, closeTarget };
