// Real native visibility + production renderer, with a fresh profile, blocked
// network/microphone/native actions, captured notifications and silent alarms.
const { app, BrowserWindow, ipcMain, session, powerMonitor } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const output = path.resolve(__dirname, '../build/qa');
fs.mkdirSync(output, { recursive: true });
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(output, 'renderer-resources-profile-')));
if (!process.argv.includes('--hidden')) process.argv.push('--hidden');
const report = { passed: false, checks: [], forbiddenCalls: [], errors: [], notices: [], milestones: [] };
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
let main, cancelReloadWait;
const startedAt = performance.now();
const elapsedMs = () => Math.round((performance.now() - startedAt) * 1000) / 1000;
function phase(name) { report.phase = name; report.milestones.push({ phase: name, elapsedMs: elapsedMs() }); }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = fn => main.webContents.executeJavaScript(`(${fn.toString()})()`, true);
const save = () => fs.writeFileSync(path.join(output, 'renderer-resources-smoke.json'), JSON.stringify(report, null, 2));
async function waitFor(fn, label) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await pause(40); }
  throw new Error(label);
}
function nativeSnapshot() {
  const state = { phase: report.phase, elapsedMs: elapsedMs() };
  try {
    if (!main || main.isDestroyed()) return { ...state, windowUnavailable: true };
    state.visible = main.isVisible(); state.minimized = main.isMinimized(); state.bounds = main.getBounds();
    const contents = main.webContents;
    state.webContentsDestroyed = contents.isDestroyed();
    if (!state.webContentsDestroyed) {
      state.url = contents.getURL(); state.loading = contents.isLoading(); state.mainFrameLoading = contents.isLoadingMainFrame();
    }
  } catch (error) { state.snapshotError = error.message; }
  return state;
}
function reload(label) {
  phase(label + ': loading');
  return new Promise((resolve, reject) => {
    const contents = main.webContents;
    let settled = false;
    function cleanup() {
      contents.removeListener('did-finish-load', loaded);
      contents.removeListener('did-fail-load', failed);
      contents.removeListener('render-process-gone', crashed);
      contents.removeListener('destroyed', destroyed);
      if (cancelReloadWait === cleanup) cancelReloadWait = null;
    }
    function finish(error) {
      if (settled) return;
      settled = true; cleanup();
      phase(label + (error ? ': failed' : ': loaded'));
      if (error) reject(error); else resolve();
    }
    const loaded = () => finish();
    const failed = (_event, code, description, url, isMainFrame) => {
      if (isMainFrame) finish(new Error(label + ' main-frame load failed (' + code + '): ' + description + ' [' + url + ']'));
    };
    const crashed = (_event, details) => finish(new Error(label + ' renderer exited: ' + details.reason));
    const destroyed = () => finish(new Error(label + ' web contents were destroyed'));
    contents.once('did-finish-load', loaded);
    contents.on('did-fail-load', failed);
    contents.once('render-process-gone', crashed);
    contents.once('destroyed', destroyed);
    // The unchanged global deadline bounds this waiter; no additional time is granted.
    cancelReloadWait = cleanup;
    try { main.reload(); } catch (error) { finish(error); }
  });
}
async function diagnostics() {
  if (!main || main.isDestroyed() || main.webContents.isDestroyed()) return { windowUnavailable: true };
  return {
    native: { visible: main.isVisible(), minimized: main.isMinimized(), bounds: main.getBounds() },
    renderer: await evaluate(async () => {
      const canvas = document.getElementById('orbCanvas');
      const intersection = canvas ? await new Promise(resolve => {
        const observer = new IntersectionObserver(entries => { clearTimeout(timer); observer.disconnect(); resolve(entries.map(entry => ({ intersecting: entry.isIntersecting, ratio: entry.intersectionRatio }))); });
        const timer = setTimeout(() => { observer.disconnect(); resolve('not delivered'); }, 500);
        observer.observe(canvas);
      }) : null;
      return { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, documentHidden: document.hidden,
        nativeVisible: window.OlangaVisibility?.isVisible(), state: typeof currentState === 'undefined' ? null : currentState,
        pendingFrame: typeof animationFrameId === 'undefined' ? null : animationFrameId,
        draws: window.orbDraws, mainHidden: document.getElementById('mainScreen')?.classList.contains('hidden'),
        canvasBounds: canvas?.getBoundingClientRect().toJSON(), intersection };
    })
  };
}
async function setReducedMotion(reduce) {
  // Use Chromium's real media-query machinery: Windows CI images may default
  // to reduced motion. Verify both preferences independently of the host.
  await main.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }]
  });
  await waitFor(() => evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches).then(value => value === reduce), 'Emulated motion preference did not reach the renderer');
}
const deadline = setTimeout(() => {
  report.passed = false;
  report.error ||= 'Resource lifecycle check exceeded 45 seconds.';
  report.deadlineExceeded = true;
  // Synchronous native getters only: an unresponsive renderer cannot delay exit.
  report.timeoutState = nativeSnapshot();
  cancelReloadWait?.();
  save(); app.exit(1);
}, 45000);
deadline.unref();
app.whenReady().then(async () => {
  try {
    phase('initial main load');
    await waitFor(() => {
      main = BrowserWindow.getAllWindows().find(win => /index\.html/.test(win.webContents.getURL()));
      return main && !main.webContents.isLoading();
    }, 'Main renderer did not load');
    phase('initial renderer initialization');
    await waitFor(() => evaluate(() => typeof orbCanvasCtx !== 'undefined' && !!orbCanvasCtx && !!window.OlangaVisibility), 'Asynchronous app initialization did not finish');
    phase('initial motion and instrumentation');
    report.initialReducedMotion = await evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
    main.webContents.debugger.attach('1.3');
    await setReducedMotion(false);
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
    phase('hidden startup rendering');
    assert.match(main.getBackgroundColor(), /^#(?:ff)?0a0a0f$/i, 'native fallback matches the existing opaque page');
    assert.equal(await evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(10, 10, 15)');
    await waitFor(() => evaluate(() => !window.OlangaVisibility.isVisible()), 'Hidden startup was not propagated');
    await evaluate(() => setState(State.LISTENING));
    await pause(250);
    assert.equal(await evaluate(() => orbDraws), 0, 'hidden active state does not draw');
    assert.equal(await evaluate(() => document.body.classList.contains('app-visuals-paused')), true);
    report.checks.push('hidden startup pauses CSS and Canvas without changing assistant state');

    phase('visible active and idle rendering');
    main.showInactive();
    await waitFor(() => evaluate(() => window.OlangaVisibility.isVisible() && orbDraws > 1), 'Native show did not resume active canvas');
    await evaluate(() => setState(State.IDLE));
    const idleDraws = await evaluate(() => orbDraws);
    await pause(250);
    assert.equal(await evaluate(() => orbDraws), idleDraws, 'idle canvas is invisible and does no work');
    report.checks.push('native show resumes active animation; idle draws zero frames');

    phase('live motion preferences');
    await evaluate(() => setState(State.LISTENING));
    await waitFor(() => evaluate(() => animationFrameId !== null), 'Visible active canvas did not schedule animation');
    await setReducedMotion(true);
    await waitFor(() => evaluate(() => animationFrameId === null), 'Reduced motion did not cancel the animation loop');
    const reducedDraws = await evaluate(() => orbDraws);
    await pause(250);
    assert.equal(await evaluate(() => orbDraws), reducedDraws, 'reduced motion keeps a static texture without recurring canvas draws');
    assert.equal(await evaluate(() => currentState), 'listening', 'motion preference must not change assistant state');
    await setReducedMotion(false);
    await waitFor(async () => {
      const state = await evaluate(() => ({ drawing: animationFrameId !== null, draws: orbDraws }));
      return state.drawing && state.draws > reducedDraws + 1;
    }, 'Normal motion did not resume the visible active canvas');
    report.checks.push('live reduced-motion changes stop recurring draws and normal motion resumes them');

    phase('minimize restore and countdown');
    await evaluate(() => { setState(State.SPEAKING); createTimer(4, 'Visible countdown'); });
    main.minimize();
    await waitFor(() => evaluate(() => !window.OlangaVisibility.isVisible()), 'Minimize did not pause visual work');
    const minimizedDraws = await evaluate(() => orbDraws);
    await pause(300);
    assert.equal(await evaluate(() => orbDraws), minimizedDraws);
    main.restore(); main.showInactive();
    await waitFor(async () => {
      const state = await evaluate(() => ({ visible: window.OlangaVisibility.isVisible(), drawing: animationFrameId !== null, draws: orbDraws }));
      return state.visible && state.drawing && state.draws > minimizedDraws + 1;
    }, 'Restore did not resume visual work');
    await pause(1100);
    const timer = await evaluate(() => {
      const value = activeTimers.find(item => item.label === 'Visible countdown');
      return { label: document.querySelector(`#timer-card-${value.id} .timer-time`).textContent, remaining: formatTime(Math.max(0, value.endTime - Date.now())) };
    });
    assert.equal(timer.label, timer.remaining, 'restored countdown reflects the wall-clock deadline');
    await evaluate(() => clearAllTimers());
    report.checks.push('native minimize/restore pauses rendering and refreshes countdowns correctly');

    phase('hidden timer deadlines');
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

    phase('clock resume reconciliation');
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

    phase('pre-reload error verification');
    assert.deepEqual(await evaluate(() => resourceErrors), []);
    assert.deepEqual(report.errors, []); assert.deepEqual(report.forbiddenCalls, []);
    phase('minimize before reload');
    main.showInactive(); main.minimize();
    await waitFor(() => main.isMinimized(), 'Native window did not minimize before reload');
    await reload('minimized reload'); await pause(100);
    phase('minimized reload verification');
    assert.equal(main.isMinimized(), true, 'background reload must not restore a minimized window');
    main.hide();
    await reload('hidden reload'); await pause(100);
    phase('hidden reload verification');
    assert.equal(main.isVisible(), false, 'background reload must not show a hidden window');
    phase('hidden renderer reinitialization');
    await waitFor(() => evaluate(() => !!orbCanvasCtx && !window.OlangaVisibility.isVisible()), 'Reload did not reinitialize hidden renderer');
    await evaluate(() => { isMicMuted = true; isTtsMuted = true; showMainScreen({ voice: false }); });
    report.checks.push('background reload preserves minimized and hidden native windows');
    if (process.argv.includes('--compare-opaque')) {
      phase('opaque surface comparison');
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
      const contentSize = [960, 640];
      report.opaqueWindows = [];
      for (const transparent of [true, false]) {
        const comparison = new BrowserWindow({ width: contentSize[0], height: contentSize[1], useContentSize: true, frame: false, show: false, transparent, backgroundColor: transparent ? '#00000000' : '#0a0a0f', webPreferences: { contextIsolation: true, sandbox: true, javascript: false } });
        try {
          await comparison.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
          // Windows frame metrics differ between transparent and opaque windows.
          // Compare equal client areas that fit the display, never cropped images.
          const geometry = { transparent, attempts: [] };
          report.opaqueWindows.push(geometry);
          let requested = [...contentSize];
          for (let attempt = 0; attempt < 3; attempt++) {
            comparison.setContentSize(...requested);
            const actual = comparison.getContentSize();
            geometry.attempts.push({ requested, actual, bounds: comparison.getBounds() });
            if (actual.every((value, index) => value === contentSize[index])) break;
            // Fractional Windows display scaling can round a frame conversion
            // by one DIP. Correct the native window, not the captured pixels.
            requested = requested.map((value, index) => value + contentSize[index] - actual[index]);
          }
          assert.deepEqual(comparison.getContentSize(), contentSize);
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
    // Reloads and optional comparison windows can record late failures too.
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.forbiddenCalls, []);
    phase('complete');
    main.webContents.debugger.detach();
    report.passed = true; save(); console.log(JSON.stringify({ passed: true, checks: report.checks.length, initialReducedMotion: report.initialReducedMotion }));
    app.quit();
  } catch (error) {
    report.passed = false;
    report.error = error.stack;
    report.failureState = nativeSnapshot();
    phase('failure diagnostics');
    try { report.diagnostics = await diagnostics(); } catch (diagnosticError) { report.diagnosticError = diagnosticError.message; }
    save(); console.error(error.stack); console.error(JSON.stringify(report.diagnostics)); app.exit(1);
  }
});
