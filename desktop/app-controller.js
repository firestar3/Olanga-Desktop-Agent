const path = require('node:path');
const { spawn } = require('node:child_process');
const { APP_CATALOG, normalizeAppName, findApp, safeSearchName } = require('../shared/app-catalog');

function createAppController({ spawnProcess = spawn, platform = process.platform, timeoutMs = 18000, startupTimeoutMs = 12000, catalog = APP_CATALOG } = {}) {
  const pending = new Map();
  let sequence = 0;
  let disposed = false;

  function failed(message, status, extra = {}) { return { ok: false, verified: false, status, message, ...extra }; }
  function execute(request, { cancellable = true } = {}) {
    if (disposed) return Promise.resolve(failed('App control is unavailable because Olanga is closing.', 'unavailable'));
    if (platform !== 'win32') return Promise.resolve(failed('App control currently requires Windows.', 'unsupported-platform'));
    return new Promise(resolve => {
      const id = ++sequence;
      let worker, timer, settled = false, buffer = '', dispatched = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(id);
        try { worker?.kill(); } catch { /* The child may already have exited. */ }
        resolve(result);
      };
      const abort = status => finish(failed(status === 'cancelled' ? (dispatched ? 'App action cancelled. The app may already have opened or moved.' : 'App action cancelled.') : 'The app did not confirm the request before the deadline.', status, { dispatched }));
      pending.set(id, { abort, cancellable });
      timer = setTimeout(() => abort('timeout'), timeoutMs);
      const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const helper = path.join(__dirname, 'app-helper.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      try {
        worker = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        worker.stdout.setEncoding('utf8');
        worker.stdout.on('data', chunk => {
          if (settled) return;
          buffer += chunk;
          if (buffer.length > 256000) return finish(failed('The app helper returned an invalid response.', 'invalid-result', { dispatched }));
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            let envelope;
            try { envelope = JSON.parse(line); } catch { return finish(failed('The Windows app helper could not initialize.', 'invalid-result', { dispatched })); }
            if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.id !== id) return finish(failed('The app helper returned an unexpected response.', 'invalid-result', { dispatched }));
            if (envelope.event === 'dispatched') { dispatched = true; continue; }
            const result = envelope.result;
            if (!result || typeof result.ok !== 'boolean' || typeof result.message !== 'string') return finish(failed('The app helper did not return a valid receipt.', 'invalid-result', { dispatched }));
            if (request.operation === 'discover') {
              if (!result.ok || !Array.isArray(result.apps)) return finish(failed(result.message, 'discovery-failed'));
              if (result.apps.length !== catalog.length || result.apps.some(app => !app || typeof app !== 'object' || Array.isArray(app) || typeof app.id !== 'string' || typeof app.installed !== 'boolean' || typeof app.available !== 'boolean' || !Number.isInteger(app.windowCount) || app.windowCount < 0 || !['running', 'installed', 'missing', 'ambiguous'].includes(app.status))) return finish(failed('The app capability report was invalid.', 'invalid-result'));
              const byId = new Map(result.apps.map(app => [app.id, app]));
              if (byId.size !== catalog.length || catalog.some(app => !byId.has(app.id))) return finish(failed('The app capability report was incomplete.', 'invalid-result'));
              return finish({ ok: true, platform, message: 'App capabilities checked.', apps: catalog.map(app => {
                const found = byId.get(app.id);
                return { id: app.id, name: app.name, aliases: [...app.aliases], installed: found.installed === true, available: found.available === true, status: found.status, reason: found.reason || '', operations: ['open', 'arrange'], verification: app.id === 'spotify' ? 'spotify-window' : 'window-and-process', windowCount: Number.isInteger(found.windowCount) ? found.windowCount : 0 };
              }), fallback: { operation: 'open', verification: 'unverified', method: 'windows-search' } });
            }
            if (result.ok && request.app && (result.verified !== true || result.appId !== request.app.id || !Number.isInteger(result.processId) || result.processId <= 0 || !/^\d+$/.test(String(result.windowHandle)) || Number(result.windowHandle) === 0 || !Number.isInteger(result.windowCount) || result.windowCount < 1)) return finish(failed('Windows did not verify the expected app window.', 'unverified', { dispatched }));
            if (result.ok && request.operation === 'arrange' && (result.windowCount !== 1 || result.status !== 'arranged' || result.layout !== request.layout || !result.bounds || !['left', 'top', 'right', 'bottom'].every(key => Number.isFinite(result.bounds[key])) || result.bounds.right <= result.bounds.left || result.bounds.bottom <= result.bounds.top)) return finish(failed('Windows did not verify the requested window layout.', 'unverified', { dispatched }));
            if (result.ok && !request.app && result.verified !== false) return finish(failed('Windows Search cannot verify an unknown app.', 'invalid-result', { dispatched }));
            finish({ ...result, dispatched: dispatched || result.dispatched === true });
          }
        });
        worker.stderr.resume();
        worker.on('error', () => finish(failed('Windows app control could not start.', 'helper-error', { dispatched })));
        worker.on('close', () => finish(failed('Windows app control stopped without confirming the request.', 'helper-exited', { dispatched })));
        worker.stdin.on('error', () => finish(failed('Windows app control disconnected.', 'helper-error', { dispatched })));
        worker.stdin.end(JSON.stringify({ ...request, id, startupTimeoutMs: Math.min(12000, Math.max(100, startupTimeoutMs)) }) + '\n');
      } catch { finish(failed('Windows app control could not start.', 'helper-error', { dispatched })); }
    });
  }

  return {
    async open(appName) {
      let name, app;
      try { name = normalizeAppName(appName); app = findApp(name, catalog); if (!app) name = safeSearchName(name); } catch (error) { return failed(error.message, 'invalid-app'); }
      return execute(app ? { operation: 'open', app } : { operation: 'search', name });
    },
    async arrange(payload) {
      if (!payload || !['left', 'right', 'maximize'].includes(payload.layout)) return failed('Choose a supported layout: left, right, or maximize.', 'unsupported-layout');
      let app;
      try { app = findApp(payload.appName, catalog); } catch (error) { return failed(error.message, 'invalid-app'); }
      if (!app) return failed('Window arrangement is available only for apps with a known adapter.', 'unsupported-app');
      return execute({ operation: 'arrange', app, layout: payload.layout });
    },
    listCapabilities: () => execute({ operation: 'discover', apps: catalog }, { cancellable: false }),
    cancel: () => { for (const item of [...pending.values()]) if (item.cancellable) item.abort('cancelled'); },
    dispose: () => { disposed = true; for (const item of [...pending.values()]) item.abort('cancelled'); },
  };
}

module.exports = { createAppController };
