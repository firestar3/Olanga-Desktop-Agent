const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { APP_CATALOG } = require('../shared/app-catalog');
const { sessionName, validBounds, restoreSummary } = require('../shared/work-sessions');

const copy = value => JSON.parse(JSON.stringify(value));
const failed = error => ({ ok: false, status: 'failed', message: error instanceof Error ? error.message : String(error) });
const sameWindow = (a, b) => a.appId === b.appId && a.windowHandle === b.windowHandle && a.processId === b.processId && a.processStarted === b.processStarted;

function createWorkspaceHelper({ spawnProcess = spawn, platform = process.platform, timeoutMs = 15000 } = {}) {
  const workers = new Set();
  function execute(request) {
    if (platform !== 'win32') return Promise.resolve(failed('Working sessions currently require Windows.'));
    return new Promise(resolve => {
      let worker, timer, settled = false, text = '';
      const id = randomUUID();
      const finish = result => { if (settled) return; settled = true; clearTimeout(timer); workers.delete(cancel); try { worker?.kill(); } catch {} resolve(result); };
      const cancel = () => finish({ ok: false, status: 'cancelled', message: 'Window action cancelled. A dispatched layout may already have changed.' });
      workers.add(cancel);
      timer = setTimeout(() => finish(failed('Windows did not confirm the session action before the deadline.')), timeoutMs);
      try {
        const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const helper = path.join(__dirname, 'workspace-helper.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
        worker = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        worker.stdout.setEncoding('utf8');
        worker.stdout.on('data', chunk => {
          text += chunk;
          if (text.length > 256000) return finish(failed('Windows returned too many session details.'));
          const end = text.indexOf('\n');
          if (end < 0) return;
          try {
            const envelope = JSON.parse(text.slice(0, end));
            if (envelope.id !== id || typeof envelope.result?.ok !== 'boolean' || typeof envelope.result?.message !== 'string') throw new Error('Invalid receipt.');
            finish(envelope.result);
          } catch { finish(failed('Windows returned an invalid session receipt.')); }
        });
        worker.stderr.resume();
        worker.on('error', () => finish(failed('The session helper could not start.')));
        worker.on('close', () => finish(failed('The session helper stopped without a receipt.')));
        worker.stdin.on('error', () => finish(failed('The session helper disconnected.')));
        worker.stdin.end(JSON.stringify({ ...request, id }) + '\n');
      } catch { finish(failed('The session helper could not start.')); }
    });
  }
  return { execute, cancel: () => { for (const stop of [...workers]) stop(); } };
}

function createWorkspaceService({ filePath, appController, catalog = APP_CATALOG, helper = createWorkspaceHelper(), now = Date.now } = {}) {
  if (!filePath || !appController) throw new Error('Working sessions require a storage path and app controller.');
  let sessions = [], loaded = false, loading = null, active = null, disposed = false, serial = Promise.resolve();
  const captures = new Map(), previews = new Map();
  const ttl = 10 * 60 * 1000;
  const appById = id => catalog.find(app => app.id === id);
  const publicWindow = window => ({ id: window.id, appId: window.appId, appName: appById(window.appId).name, title: window.title, bounds: copy(window.bounds), state: window.state });
  function validateWindow(window) {
    return !!window && !!appById(window.appId) && typeof window.title === 'string' && window.title.length <= 1024 && /^\d+$/.test(window.windowHandle) && Number(window.windowHandle) > 0 && Number.isInteger(window.processId) && window.processId > 0 && /^\d+$/.test(window.processStarted) && validBounds(window.bounds) && ['normal', 'minimized', 'maximized'].includes(window.state);
  }
  const publicSession = session => ({ id: session.id, name: session.name, savedAt: session.savedAt, windows: session.windows.map(publicWindow) });
  function prune(map) { for (const [id, item] of map) if (item.expiresAt < now()) map.delete(id); while (map.size > 20) map.delete(map.keys().next().value); }
  function load() {
    if (!loading) loading = loadData().catch(error => { loading = null; throw error; });
    return loading;
  }
  async function loadData() {
    if (loaded) return;
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 512000) throw new Error('The saved sessions file is too large.');
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.sessions) || data.sessions.length > 30) throw new Error('The saved sessions format is unsupported.');
      const seen = new Set();
      sessions = data.sessions.map(session => {
        if (typeof session.id !== 'string' || seen.has(session.id) || !Number.isFinite(session.savedAt) || !Array.isArray(session.windows) || !session.windows.length || session.windows.length > 12 || session.windows.some(window => !validateWindow(window) || typeof window.id !== 'string')) throw new Error('Saved session data could not be validated.');
        seen.add(session.id); return { id: session.id, name: sessionName(session.name), savedAt: session.savedAt, windows: session.windows.map(window => ({ ...publicWindow(window), windowHandle: window.windowHandle, processId: window.processId, processStarted: window.processStarted })) };
      });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    loaded = true;
  }
  async function persist(next) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify({ version: 1, sessions: next }), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, filePath); }
    finally { await fs.unlink(temporary).catch(() => {}); }
    sessions = next;
  }
  function guarded(fn) { return async (...args) => { if (disposed) return failed('Working sessions are unavailable while Olanga is closing.'); try { return await fn(...args); } catch (error) { return failed(error); } }; }
  function edit(fn) { const next = serial.then(fn, fn); serial = next.catch(() => {}); return next; }
  async function currentWindows() {
    const result = await helper.execute({ operation: 'capture', apps: catalog });
    if (!result.ok) throw new Error(result.message);
    if (!Array.isArray(result.windows) || result.windows.length > 120 || result.windows.some(window => !validateWindow(window))) throw new Error('Windows returned an invalid session snapshot.');
    const unique = new Set();
    for (const window of result.windows) { const key = `${window.windowHandle}:${window.processId}`; if (unique.has(key)) throw new Error('Windows returned ambiguous session identities.'); unique.add(key); }
    return result.windows;
  }
  function choose(saved, windows) {
    const exact = windows.find(window => sameWindow(saved, window));
    if (exact) return exact;
    // Titles are only a recovery hint. Multiple possible matches require a new capture.
    const candidates = windows.filter(window => window.appId === saved.appId && window.title === saved.title);
    return saved.title && candidates.length === 1 ? candidates[0] : null;
  }
  return {
    capture: guarded(async () => {
      const windows = (await currentWindows()).map(window => ({ ...window, id: randomUUID() }));
      const captureId = randomUUID(); prune(captures);
      captures.set(captureId, { windows, expiresAt: now() + ttl });
      return { ok: true, captureId, windows: windows.map(publicWindow) };
    }),
    save: guarded(input => edit(async () => {
      await load(); prune(captures);
      const capture = captures.get(input?.captureId);
      if (!capture) throw new Error('Capture the open windows again before saving.');
      if (!Array.isArray(input.windowIds) || !input.windowIds.length || input.windowIds.length > 12 || new Set(input.windowIds).size !== input.windowIds.length) throw new Error('Choose between 1 and 12 windows.');
      const windows = input.windowIds.map(id => capture.windows.find(window => window.id === id));
      if (windows.some(window => !window)) throw new Error('Choose windows from the current capture.');
      const name = sessionName(input.name);
      if (sessions.some(session => session.name.toLowerCase() === name.toLowerCase())) throw new Error('A session with this name already exists. Choose another name.');
      if (sessions.length >= 30) throw new Error('Remove an old session before saving more than 30.');
      const session = { id: randomUUID(), name, savedAt: now(), windows: copy(windows) };
      await persist([...sessions, session]); captures.delete(input.captureId);
      return { ok: true, session: publicSession(session) };
    })),
    list: guarded(async () => { await serial; await load(); return { ok: true, sessions: sessions.map(publicSession) }; }),
    remove: guarded(id => edit(async () => { await load(); if (active) throw new Error('Wait for the current restore before removing a session.'); if (!sessions.some(item => item.id === id)) throw new Error('This session no longer exists.'); await persist(sessions.filter(item => item.id !== id)); for (const [key, value] of previews) if (value.sessionId === id) previews.delete(key); return { ok: true }; })),
    previewRestore: guarded(async sessionId => {
      await serial; await load(); prune(previews);
      const session = sessions.find(item => item.id === sessionId);
      if (!session) throw new Error('This saved session no longer exists.');
      const windows = await currentWindows();
      const steps = session.windows.map(saved => {
        const target = choose(saved, windows), appWindows = windows.filter(window => window.appId === saved.appId);
        const duplicate = session.windows.filter(window => window.appId === saved.appId).length > 1;
        const status = target ? 'existing' : !appWindows.length && !duplicate ? 'open' : 'blocked';
        return { id: randomUUID(), saved, target, status, appName: appById(saved.appId).name, title: saved.title, message: status === 'existing' ? 'Restore the layout of this existing window.' : status === 'open' ? 'Open this app and restore its layout. Documents and browser tabs are not reopened.' : 'No unique saved window was found. Open the intended window and capture a new session.' };
      });
      const previewId = randomUUID(), expiresAt = now() + ttl;
      previews.set(previewId, { sessionId, steps, expiresAt });
      return { ok: true, previewId, name: session.name, expiresAt, steps: steps.map(({ id, appName, title, status, message }) => ({ id, appName, title, status, message })) };
    }),
    restore: guarded(async previewId => {
      if (active) throw new Error('A working session is already restoring.');
      prune(previews); const preview = previews.get(previewId);
      if (!preview) throw new Error('Preview this session again before restoring it.');
      previews.delete(previewId);
      const run = { cancelled: false }; active = run;
      const receipts = [];
      try {
        for (const step of preview.steps) {
          const base = { id: step.id, appName: step.appName, title: step.title };
          if (run.cancelled) { receipts.push({ ...base, ok: false, status: 'cancelled', message: 'This window was not changed.' }); continue; }
          if (step.status === 'blocked') { receipts.push({ ...base, ok: false, status: 'blocked', message: step.message }); continue; }
          try {
            let target = step.target;
            const current = await currentWindows();
            if (run.cancelled) throw new Error('Restore cancelled.');
            if (target && !current.some(window => sameWindow(window, target))) throw new Error('The previewed window changed. Preview this session again.');
            if (!target) {
              if (current.some(window => window.appId === step.saved.appId)) throw new Error('This app opened after the preview. Preview again to choose the correct window.');
              const opened = await appController.open(step.saved.appId);
              if (run.cancelled) throw new Error('Restore cancelled. The app may already have opened.');
              if (!opened.ok || !opened.verified || opened.windowCount !== 1) throw new Error(opened.message || 'The app did not confirm a unique window.');
              target = (await currentWindows()).find(window => window.appId === step.saved.appId && window.windowHandle === opened.windowHandle && window.processId === opened.processId);
              if (!target) throw new Error('The newly opened app window could not be verified.');
            }
            if (run.cancelled) throw new Error('Restore cancelled.');
            const result = await helper.execute({ operation: 'restore', app: appById(step.saved.appId), window: target, bounds: step.saved.bounds, state: step.saved.state });
            if (!result.ok || result.verified !== true || result.appId !== target.appId || result.windowHandle !== target.windowHandle || result.processId !== target.processId || !validBounds(result.bounds) || result.state !== step.saved.state) throw new Error(result.message || 'The restored window could not be verified.');
            receipts.push({ ...base, ...result });
          } catch (error) { receipts.push({ ...base, ok: false, status: run.cancelled ? 'cancelled' : 'failed', message: error.message }); }
        }
        const summary = restoreSummary(receipts);
        return { ok: receipts.every(item => item.ok), status: run.cancelled ? 'cancelled' : summary.failed ? 'partial' : 'completed', receipts, ...summary };
      } finally { active = null; }
    }),
    cancel() { if (active) { active.cancelled = true; helper.cancel?.(); } return { ok: true, message: 'Remaining window actions cancelled. Already restored windows stay in place.' }; },
    dispose() { disposed = true; if (active) active.cancelled = true; helper.cancel?.(); captures.clear(); previews.clear(); },
  };
}
module.exports = { createWorkspaceService, createWorkspaceHelper };
