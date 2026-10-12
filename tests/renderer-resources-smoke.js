// Real native visibility + production renderer, with a fresh profile, blocked
// network/microphone/native actions, captured notifications and silent alarms.
const { app, BrowserWindow, ipcMain, session, powerMonitor } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, '../build/qa');
fs.mkdirSync(output, { recursive: true });
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(output, 'renderer-resources-profile-')));
if (!process.argv.includes('--hidden')) process.argv.push('--hidden');
const report = { passed: false, checks: [], forbiddenCalls: [], errors: [], notices: [] };
const forbidden = new Set(['provider-generate', 'nvidia-tts-synthesize', 'nvidia-tts-config', 'media-control', 'open-app', 'close-app', 'arrange-app', 'play-spotify', 'desktop-capture', 'desktop-run', 'desktop-undo', 'terminal-session-create']);
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, (event, ...args) => {
  if (forbidden.has(channel)) { report.forbiddenCalls.push(channel); throw new Error('Disabled in resource test: ' + channel); }
  return callback(event, ...args);
});
const on = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, callback) => on(channel, channel === 'notify' ? (_event, value) => report.notices.push(value) : callback);
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, _file, error) => report.errors.push(error.message));
  contents.on('render-process-gone', (_event, details) => report.errors.push(details.reason));
});
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => { report.forbiddenCalls.push(permission); callback(false); });
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
});
require('../main');
let main;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = fn => main.webContents.executeJavaScript(`(${fn.toString()})()`, true);
const save = () => fs.writeFileSync(path.join(output, 'renderer-resources-smoke.json'), JSON.stringify(report, null, 2));
async function waitFor(fn, label) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await pause(40); }
  throw new Error(label);
}
const deadline = setTimeout(() => { report.error = 'Resource lifecycle check exceeded 45 seconds.'; save(); app.exit(1); }, 45000);
deadline.unref();
app.whenReady().then(async () => {
  try {
    await waitFor(() => {
      main = BrowserWindow.getAllWindows().find(win => /index\.html/.test(win.webContents.getURL()));
      return main && !main.webContents.isLoading();
    }, 'Main renderer did not load');
    await waitFor(() => evaluate(() => typeof orbCanvasCtx !== 'undefined' && !!orbCanvasCtx && !!window.OlangaVisibility), 'Asynchronous app initialization did not finish');
    await evaluate(() => {
      window.resourceErrors = [];
      window.addEventListener('error', event => resourceErrors.push(event.message));
      window.addEventListener('unhandledrejection', event => resourceErrors.push(String(event.reason?.message || event.reason)));
      window.electronAPI.setStatusLightMode('off');
      isMicMuted = true; isTtsMuted = true;
      showMainScreen({ voice: false });
      window.orbDraws = 0; window.alarmPulses = 0;
      const clear = orbCanvasCtx.clearRect.bind(orbCanvasCtx);
      orbCanvasCtx.clearRect = (...args) => { orbDraws++; clear(...args); };
      playAlarmSound = () => { alarmPulses++; };
    });
    assert.match(main.getBackgroundColor(), /^#(?:ff)?0a0a0f$/i, 'native fallback matches the existing opaque page');
    assert.equal(await evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(10, 10, 15)');
    await waitFor(() => evaluate(() => !window.OlangaVisibility.isVisible()), 'Hidden startup was not propagated');
    await evaluate(() => setState(State.LISTENING));
    await pause(250);
    assert.equal(await evaluate(() => orbDraws), 0, 'hidden active state does not draw');
    assert.equal(await evaluate(() => document.body.classList.contains('app-visuals-paused')), true);
    report.checks.push('hidden startup pauses CSS and Canvas without changing assistant state');

    main.showInactive();
    await waitFor(() => evaluate(() => window.OlangaVisibility.isVisible() && orbDraws > 1), 'Native show did not resume active canvas');
    await evaluate(() => setState(State.IDLE));
    const idleDraws = await evaluate(() => orbDraws);
    await pause(250);
    assert.equal(await evaluate(() => orbDraws), idleDraws, 'idle canvas is invisible and does no work');
    report.checks.push('native show resumes active animation; idle draws zero frames');

    await evaluate(() => { setState(State.SPEAKING); createTimer(4, 'Visible countdown'); });
    main.minimize();
    await waitFor(() => evaluate(() => !window.OlangaVisibility.isVisible()), 'Minimize did not pause visual work');
    const minimizedDraws = await evaluate(() => orbDraws);
    await pause(300);
    assert.equal(await evaluate(() => orbDraws), minimizedDraws);
    main.restore(); main.showInactive();
    await waitFor(() => evaluate(() => window.OlangaVisibility.isVisible() && orbDraws > 1), 'Restore did not resume visual work');
    await pause(1100);
    const timer = await evaluate(() => {
      const value = activeTimers.find(item => item.label === 'Visible countdown');
      return { label: document.querySelector(`#timer-card-${value.id} .timer-time`).textContent, remaining: formatTime(Math.max(0, value.endTime - Date.now())) };
    });
    assert.equal(timer.label, timer.remaining, 'restored countdown reflects the wall-clock deadline');
    await evaluate(() => clearAllTimers());
    report.checks.push('native minimize/restore pauses rendering and refreshes countdowns correctly');

    main.hide();
    await waitFor(() => evaluate(() => !window.OlangaVisibility.isVisible()), 'Native hide did not pause visual work');
    await evaluate(() => { setState(State.IDLE); createTimer(0.2, 'Hidden deadline'); });
    await waitFor(() => evaluate(() => activeTimers.some(timer => timer.label === 'Hidden deadline' && timer.ringing)), 'Hidden timer missed its deadline');
    assert.equal(await evaluate(() => alarmPulses), 1);
    assert.equal(report.notices.length, 1);
    assert.equal(report.notices[0].body, 'Hidden deadline is done.');
    await evaluate(() => { clearAllTimers(); createTimer(0.2, 'Cancelled deadline'); cancelTimerByLabel('Cancelled deadline'); });
    await pause(350);
    assert.equal(await evaluate(() => alarmPulses), 1, 'cancelled hidden deadlines never ring');
    report.checks.push('hidden fractional deadline fires exactly once; cancellation disarms it');

    if (process.platform === 'win32') assert.equal(main.isWindowMessageHooked(0x001E), true, 'native WM_TIMECHANGE is observed');
    await evaluate(() => {
      createTimer(120, 'Resume deadline');
      window.realClockNow = Date.now;
      Date.now = () => realClockNow() + 180000;
    });
    powerMonitor.emit('resume');
    await waitFor(() => evaluate(() => activeTimers.some(timer => timer.label === 'Resume deadline' && timer.ringing)), 'Resume did not immediately reconcile hidden deadline');
    await evaluate(() => { Date.now = realClockNow; clearAllTimers(); });
    assert.equal(report.notices.length, 2);
    assert.equal(report.notices[1].body, 'Resume deadline is done.');
    report.checks.push('native clock hook is armed and resume reconciles tray deadlines without a polling delay');

    assert.deepEqual(await evaluate(() => resourceErrors), []);
    assert.deepEqual(report.errors, []); assert.deepEqual(report.forbiddenCalls, []);
    main.showInactive(); main.minimize();
    await waitFor(() => main.isMinimized(), 'Native window did not minimize before reload');
    let reloaded = new Promise(resolve => main.webContents.once('did-finish-load', resolve));
    main.reload(); await reloaded; await pause(100);
    assert.equal(main.isMinimized(), true, 'background reload must not restore a minimized window');
    main.hide();
    reloaded = new Promise(resolve => main.webContents.once('did-finish-load', resolve));
    main.reload(); await reloaded; await pause(100);
    assert.equal(main.isVisible(), false, 'background reload must not show a hidden window');
    await waitFor(() => evaluate(() => !!orbCanvasCtx && !window.OlangaVisibility.isVisible()), 'Reload did not reinitialize hidden renderer');
    await evaluate(() => { isMicMuted = true; isTtsMuted = true; showMainScreen({ voice: false }); });
    report.checks.push('background reload preserves minimized and hidden native windows');
    if (process.argv.includes('--compare-opaque')) {
      // Compare the exact same frozen production DOM/style at the same size.
      // The paired windows never load script, credentials or remote resources.
      const markup = await evaluate(() => {
        const clone = document.documentElement.cloneNode(true);
        clone.querySelectorAll('script, link, meta[http-equiv]').forEach(node => node.remove());
        clone.querySelector('body').classList.remove('app-visuals-paused');
        return clone.outerHTML;
      });
      const css = fs.readFileSync(path.resolve(__dirname, '../styles.css'), 'utf8') + '\n' + fs.readFileSync(path.resolve(__dirname, '../desktop-workflows.css'), 'utf8');
      const page = markup.replace('</head>', `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;"><style>${css}\n*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }</style></head>`);
      const images = [];
      for (const transparent of [true, false]) {
        const comparison = new BrowserWindow({ width: 1280, height: 900, frame: false, show: false, transparent, backgroundColor: transparent ? '#00000000' : '#0a0a0f', webPreferences: { contextIsolation: true, sandbox: true, javascript: false } });
        try {
          await comparison.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
          await pause(150);
          const screenshot = await comparison.webContents.capturePage();
          fs.writeFileSync(path.join(output, transparent ? 'window-transparent-before.png' : 'window-opaque-after.png'), screenshot.toPNG());
          images.push(screenshot);
        } finally { comparison.destroy(); }
      }
      assert.deepEqual(images[0].getSize(), images[1].getSize());
      const before = images[0].toBitmap(), after = images[1].toBitmap();
      let changedBytes = 0;
      for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changedBytes++;
      report.opaqueComparison = { changedBytes, totalBytes: before.length, size: images[0].getSize() };
      assert.equal(changedBytes, 0, 'opaque native surface preserves identical page pixels');
      report.checks.push('transparent and opaque native surfaces render the same frozen application pixels');
    }
    report.passed = true; save(); console.log(JSON.stringify({ passed: true, checks: report.checks.length }));
    app.quit();
  } catch (error) { report.error = error.stack; save(); console.error(error.stack); app.exit(1); }
});
