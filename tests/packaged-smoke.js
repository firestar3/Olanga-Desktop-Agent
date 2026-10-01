// Launch the built Windows executable with an isolated profile. The loopback
// debugging connection inspects only this test process, never another app.
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build', 'qa');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'packaged-profile-'));
const executable = path.join(path.resolve(root, process.env.OLANGA_BUILD_DIR || 'dist'), 'win-unpacked', 'Olanga.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { passed: false, version: require('../package.json').version, isolatedProfile: profile,
  coverage: { builtExecutable: true, packagedRenderer: true, packagedPreload: true, localSetup: true, localPersistence: true, microphone: false, providerCalls: false }, checks: [], rendererErrors: [] };
let child, socket, log = '';
const pending = new Map();
let sequence = 0;
function check(name, condition) { report.checks.push({ name, passed: !!condition }); assert.ok(condition, name); }
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function waitForRenderer(previousDocument = null) {
  let state, lastError;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      state = await evaluate(`({
        document: window.__packagedSmokeDocument || null,
        readyState: document.readyState,
        assistant: typeof processTextCommandWithGemini === 'function',
        preferences: document.querySelectorAll('#quickActionsEditor fieldset').length === 5,
        workspace: !!window.OlangaWorkspace,
        workbench: typeof window.OlangaWorkbench?.addPage === 'function',
        schedules: typeof window.OlangaScheduleStore?.add === 'function'
      })`);
      if ((!previousDocument || state.document !== previousDocument) && state.readyState === 'complete' &&
          state.assistant && state.preferences && state.workspace && state.workbench && state.schedules) return state;
    } catch (error) { lastError = error.message; /* A reload may replace the execution context. */ }
    await pause(100);
  }
  throw new Error('Packaged renderer did not finish initialization: ' + JSON.stringify({ state, lastError }));
}
async function reloadRenderer() {
  // Page.reload returns before navigation. Old timer/task globals can still be
  // readable until the replacement document starts parsing its scripts.
  const token = 'packaged-document-' + Date.now() + '-' + Math.random();
  await evaluate(`window.__packagedSmokeDocument = ${JSON.stringify(token)}`);
  await send('Page.reload');
  await waitForRenderer(token);
}
async function stop() {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  if (child && child.exitCode === null) {
    // Only the process tree created above is terminated; a running user copy
    // uses another PID and another profile.
    await new Promise(resolve => {
      const stopper = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      stopper.once('error', resolve); stopper.once('exit', resolve);
    });
  }
}
(async () => {
  let deadline;
  try {
    assert.equal(process.platform, 'win32'); assert.ok(fs.existsSync(executable), 'Build the app before running this smoke');
    const port = await freePort();
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    child = spawn(executable, ['--hidden', '--disable-gpu', '--user-data-dir=' + profile, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment });
    child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
    child.on('error', error => { report.launchError = error.message; });
    const work = async () => {
      let target;
      for (let attempt = 0; attempt < 120; attempt++) {
        if (report.launchError || child.exitCode !== null) throw new Error(report.launchError || 'Packaged app exited before inspection');
        try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => /app\.asar[\\/]index\.html$/.test(item.url)); } catch (_) { /* Debug endpoint is still starting. */ }
        if (target && log.includes(profile)) break;
        await pause(100);
      }
      check('Executable uses the isolated profile', log.includes('[Main] userData: ' + profile));
      check('Packaged index loaded from app.asar', !!target?.webSocketDebuggerUrl);
      socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
      socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data));
        if (message.method === 'Runtime.exceptionThrown') {
          const details = message.params.exceptionDetails;
          report.rendererErrors.push(details.exception?.description || details.text);
        }
        const item = pending.get(message.id);
        if (!item) return; pending.delete(message.id);
        message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
      });
      await send('Runtime.enable'); await send('Page.enable');
      await send('Network.enable'); await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
      await waitForRenderer();
      check('Packaged renderer finishes loading settings, workbench and schedules', true);
      const boot = await evaluate(`({ node: typeof process, require: typeof require, offline: typeof window.OlangaOfflineSpeech?.transcribe, provider: typeof window.electronAPI?.providerGenerate, undo: typeof window.electronAPI?.undoDesktopEdit, apps: typeof window.electronAPI?.listAppCapabilities, workbench: typeof window.openOlangaWorkbench, sessions: typeof window.electronAPI?.workSessionCapture, phone: typeof window.electronAPI?.phoneStatus })`);
      check('Packaged preload exposes new capabilities with renderer isolation', boot.node === 'undefined' && boot.require === 'undefined' && [boot.offline, boot.provider, boot.undo, boot.apps, boot.workbench, boot.sessions, boot.phone].every(value => value === 'function'));
      await evaluate(`document.getElementById('startLocalBtn').click(); void 0`);
      const local = await evaluate(`({ visible: !document.getElementById('mainScreen').classList.contains('hidden'), key: !!apiKey, mic: !!micStream, input: OlangaWorkspace.snapshot().speechInput })`);
      check('Keyless startup works without opening a microphone', local.visible && !local.key && !local.mic && local.input === 'cloud');
      const update = await evaluate('window.electronAPI.getUpdateState()');
      check('Packaged updater starts idle with no automatic download or install', update.phase === 'idle' && update.status === 'not-checked' && update.installedVersion === report.version && !update.canDownload && !update.canInstall && update.bytesReceived === 0 && update.automaticUpdatesEnabled === false);
      const created = await evaluate(`(() => { const timer = createTimer(1800, 'Packaged fixture'); const task = addTask('Packaged fixture'); return timer.ok && task.ok; })()`);
      check('Packaged local timer and task save successfully', created);
      await reloadRenderer();
      let restored;
      for (let attempt = 0; attempt < 80; attempt++) {
        try { restored = await evaluate(`({ timer: activeTimers.some(item => item.label === 'Packaged fixture'), task: activeTasks.some(item => item.text === 'Packaged fixture'), visible: !document.getElementById('mainScreen').classList.contains('hidden'), mic: !!micStream })`); } catch (_) { /* New renderer globals are still loading. */ }
        if (restored?.timer && restored?.task && restored?.visible) break;
        await pause(100);
      }
      check('Packaged reload restores local setup, timers and tasks', restored?.timer && restored?.task && restored?.visible && !restored?.mic);
      const provider = await evaluate('window.electronAPI.providerStatus()');
      check('No saved credential or provider request in test profile', !provider.configured && provider.totals.requests === 0);
      const optional = await evaluate(`(async () => ({ phone: await electronAPI.phoneStatus(), companions: await electronAPI.companionList(), phoneGuide: await electronAPI.workbenchGuide('phone'), companionGuide: await electronAPI.workbenchGuide('companions') }))()`);
      check('Optional servers stay off and packaged setup guides are available', !optional.phone.active && !optional.companions.running && optional.phoneGuide.includes('HTTPS') && optional.companionGuide.includes('VS Code'));
      const schedules = await evaluate(`(() => { window.OlangaScheduleStore.add({title:'Packaged schedule',kind:'reminder',repeat:'once',onceAt:Date.now()+3600000}); return window.OlangaScheduleStore.snapshot().items; })()`);
      check('Packaged schedule saves through its bounded store', schedules.length === 1);
      await reloadRenderer();
      const restoredSchedules = await evaluate('window.OlangaScheduleStore.snapshot().items');
      check('Packaged schedule keeps its ID and deadline after a complete renderer reload', isDeepStrictEqual(restoredSchedules, schedules));
      check('Packaged startup and reloads have no uncaught renderer errors', report.rendererErrors.length === 0);
      report.passed = true;
    };
    await Promise.race([work(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Packaged smoke exceeded 45 seconds')), 45000); })]);
  } catch (error) { report.error = error.message; }
  finally {
    clearTimeout(deadline); await stop();
    for (const item of pending.values()) item.reject(new Error('Test ended')); pending.clear();
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'packaged-smoke.log'), log);
    const filename = path.join(output, 'packaged-smoke.json'); fs.writeFileSync(filename, JSON.stringify(report, null, 2));
    console.log(`Packaged smoke ${report.passed ? 'passed' : 'failed'}: ${filename}`);
    if (report.error) console.error(report.error);
    process.exitCode = report.passed ? 0 : 1;
  }
})();
