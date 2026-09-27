// Real production renderer and preload with simulated update IPC. This never
// contacts a release server, downloads a file, or starts an installer.
const { app, BrowserWindow, ipcMain, session, net } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, '../build/qa');
fs.mkdirSync(output, { recursive: true });
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(output, 'manual-update-profile-')));
const report = { passed: false, startedAt: new Date().toISOString(), checks: [], screenshots: [], calls: [], forbiddenCalls: [], rendererErrors: [], blockedNetwork: [],
  coverage: { realDom: true, realPreload: true, isolatedProfile: true, simulatedUpdateIPC: true, liveDownload: false, installerExecution: false, microphone: false } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let main, pendingDownload, pendingInitialState, delayNextState = false, nextCheckError = false, nextDownloadError = false, nextInstallError = false, finished = false;
const initial = { ok: true, phase: 'idle', installedVersion: '1.4.0', canDownload: false, canInstall: false, message: 'Check for a newer version of Olanga.' };
const available = { ...initial, phase: 'available', version: '1.4.1', canDownload: true, url: 'https://github.com/firestar3/Olanga-Desktop-Agent/releases/tag/v1.4.1', message: 'Olanga 1.4.1 is available to download.' };
let fixtureState = { ...initial };
function publish(state) {
  fixtureState = { ...state };
  main?.webContents.send('update-state-changed', fixtureState);
  return fixtureState;
}
function completeDownload() {
  const state = publish({ ...available, phase: 'ready', canDownload: false, canInstall: true, downloaded: true, assetVerification: 'sha256-verified', progress: 100, bytesReceived: 128 * 1048576, totalBytes: 128 * 1048576, message: 'Olanga 1.4.1 is downloaded and its SHA-256 checksum is verified. Install & restart when you are ready.' });
  pendingDownload?.(state); pendingDownload = null;
}
const fixtureHandlers = {
  'update-state': () => {
    if (!delayNextState) return fixtureState;
    delayNextState = false;
    const snapshot = { ...fixtureState };
    return new Promise(resolve => { pendingInitialState = () => resolve(snapshot); });
  },
  'check-release': () => {
    if (nextCheckError) { nextCheckError = false; throw new Error('Fixture: connection unavailable. Try again.'); }
    return publish({ ...available });
  },
  'update-download': () => {
    if (nextDownloadError) { nextDownloadError = false; throw new Error('Fixture: download interrupted. Try again.'); }
    publish({ ...available, phase: 'downloading', canDownload: false, progress: 12.5, bytesReceived: 16 * 1048576, totalBytes: 128 * 1048576, message: 'Downloading Olanga 1.4.1…' });
    return new Promise(resolve => { pendingDownload = resolve; });
  },
  'update-cancel': () => {
    const state = publish({ ...available, phase: 'cancelled', message: 'Download cancelled. You can download again when ready.' });
    const resolve = pendingDownload; pendingDownload = null;
    // A completed older IPC promise must not resurrect progress after Cancel.
    setTimeout(() => resolve?.({ ...available, phase: 'downloading', progress: 99 }), 25);
    return state;
  },
  'update-install': () => {
    if (nextInstallError) { nextInstallError = false; throw new Error('Fixture: installer could not start. Try again.'); }
    return publish({ ...fixtureState, phase: 'installing', canInstall: false, message: 'Installing Olanga 1.4.1. Olanga will close and restart…' });
  },
};
const forbidden = new Set(['provider-generate', 'provider-generate-stream', 'nvidia-tts-config', 'nvidia-tts-synthesize', 'open-app', 'arrange-app', 'close-app', 'play-spotify', 'reload-spotify', 'media-control', 'desktop-capture', 'desktop-run', 'desktop-undo', 'execute-command', 'terminal-session-create', 'terminal-session-execute', 'fetch-news-bundle', 'open-external']);
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, (event, ...args) => {
  if (fixtureHandlers[channel]) { report.calls.push(channel); return fixtureHandlers[channel](); }
  if (forbidden.has(channel)) { report.forbiddenCalls.push(channel); throw new Error('External action disabled in manual-update smoke.'); }
  return callback(event, ...args);
});
const forbidFetch = async () => { report.forbiddenCalls.push('network-fetch'); throw new Error('Network disabled in manual-update smoke.'); };
globalThis.fetch = forbidFetch;
net.fetch = forbidFetch;
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event, ...legacy) => {
    const detail = event?.message ? event : { level: legacy[0], message: legacy[1] };
    if (['error', 3].includes(detail.level) && !/ERR_INTERNET_DISCONNECTED|ERR_BLOCKED_BY_CLIENT/.test(detail.message)) report.rendererErrors.push(detail.message);
  });
  contents.on('preload-error', (_event, _file, error) => report.rendererErrors.push(error.message));
  contents.on('render-process-gone', (_event, detail) => report.rendererErrors.push('Renderer stopped: ' + detail.reason));
});
app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => { report.forbiddenCalls.push('permission:' + permission); callback(false); });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (detail, callback) => { report.blockedNetwork.push(new URL(detail.url).origin); callback({ cancel: true }); });
  session.defaultSession.on('will-download', (_event, item) => { report.forbiddenCalls.push('browser-download'); item.cancel(); });
});
function finish(code) {
  if (finished) return;
  finished = true;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'manual-update-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(code);
}
try { require('../main'); } catch (error) { report.error = error.stack; finish(1); }
async function evaluate(fn, ...args) { return main.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true); }
async function waitFor(fn, message, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(fn)) return; await pause(50); }
  throw new Error(message);
}
async function click(selector) {
  await evaluate(selector => {
    const node = document.querySelector(selector);
    if (!node || !node.getClientRects().length || node.disabled) throw new Error('Missing enabled visible control: ' + selector);
    node.scrollIntoView({ block: 'nearest' }); node.focus(); node.click();
  }, selector);
}
async function screenshot(name) {
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  main.webContents.invalidate(); await pause(150);
  await main.webContents.capturePage(); await pause(80);
  const filename = path.join(output, `manual-update-${name}.png`);
  fs.writeFileSync(filename, (await main.webContents.capturePage()).toPNG()); report.screenshots.push(filename);
}
const count = channel => report.calls.filter(value => value === channel).length;
async function check(name, action) {
  await action(); report.checks.push({ name, passed: true });
}
async function openUpdates() {
  if (!await evaluate(() => document.getElementById('workspaceDialog').open)) await click('#workspaceOpen');
  await click('[data-workspace-tab="3"]');
}
async function quiet() {
  await evaluate(() => {
    isTtsMuted = true;
    window.__updateMicCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__updateMicCalls++; throw new Error('Microphone disabled in update smoke.'); };
  });
}
app.whenReady().then(async () => {
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      main = BrowserWindow.getAllWindows().find(win => /[\\/]index\.html$/.test(win.webContents.getURL()));
      if (main && !main.webContents.isLoading()) break;
      await pause(100);
    }
    assert.ok(main, 'Production main window loaded');
    main.webContents.setZoomFactor(1);
    await waitFor(() => !!window.OlangaWorkspace && !!document.getElementById('workspaceOpen'), 'Workspace did not initialize');
    await pause(300); await quiet();
    main.unmaximize(); main.setContentSize(1100, 800); await pause(150);
    await check('Startup and opening Apps read local state without checking, downloading, or installing', async () => {
      await click('#startLocalBtn'); await screenshot('home');
      await click('[data-screen="settingsScreen"]'); await screenshot('settings');
      await click('[data-screen="mainScreen"]'); await openUpdates();
      assert.deepEqual(report.calls, ['update-state']);
      assert.equal(await evaluate(() => document.getElementById('downloadUpdate').hidden && document.getElementById('installUpdate').hidden), true);
      await screenshot('idle');
    });
    await check('Workspace typography, fields, tabs, and surfaces match the existing app controls', async () => {
      const style = await evaluate(() => {
        const css = selector => getComputedStyle(document.querySelector(selector));
        return {
          fonts: ['body', '#workspaceOpen', '#workspaceDialog', '#checkRelease', '#routineName', '#viewIntroBtn'].map(selector => css(selector).fontFamily),
          dialog: css('#workspaceDialog').backgroundColor, appCard: css('.notepad-formatting').backgroundColor,
          field: css('#routineName').backgroundColor, settingsField: css('#speechInputSelect').backgroundColor,
          fieldBorder: css('#routineName').borderColor, settingsBorder: css('#speechInputSelect').borderColor,
          tab: css('[data-workspace-tab][aria-pressed="true"]').backgroundColor, existingTab: css('.notepad-tab.active').backgroundColor,
          primary: css('#downloadUpdate').backgroundColor, existingPrimary: css('.add-key-row button').backgroundColor,
        };
      });
      assert.match(style.fonts[0], /Outfit/);
      assert.ok(style.fonts.every(font => font === style.fonts[0]), 'Workspace controls must inherit the same app font');
      for (const [actual, expected] of [['dialog', 'appCard'], ['field', 'settingsField'], ['fieldBorder', 'settingsBorder'], ['tab', 'existingTab'], ['primary', 'existingPrimary']]) assert.equal(style[actual], style[expected], `${actual} must match established app styling`);
      report.computedStyles = style;
    });
    await check('Checking reveals an explicit download action without starting it', async () => {
      await click('#checkRelease'); await waitFor(() => !document.getElementById('downloadUpdate').hidden, 'Download action missing after check');
      assert.equal(count('check-release'), 1); assert.equal(count('update-download'), 0); assert.equal(count('update-install'), 0);
      assert.match(await evaluate(() => document.getElementById('releaseVersion').textContent), /1\.4\.0/);
      await screenshot('available');
    });
    await check('Explicit download reports progress, permits cancellation, and ignores its older completion', async () => {
      await click('#downloadUpdate'); await waitFor(() => document.getElementById('releaseProgress').value === 12.5, 'Progress did not arrive');
      assert.equal(await evaluate(() => document.getElementById('checkRelease').disabled), true);
      assert.match(await evaluate(() => document.getElementById('releaseDetail').textContent), /16\.0 MB of 128\.0 MB/);
      assert.equal(count('update-download'), 1); assert.equal(count('update-install'), 0);
      await screenshot('progress');
      main.setContentSize(480, 760); await pause(120); await screenshot('progress-narrow');
      assert.equal(await evaluate(() => { const dialog = document.getElementById('workspaceDialog'); return dialog.scrollWidth <= dialog.clientWidth + 1 && dialog.getBoundingClientRect().right <= innerWidth; }), true, 'Narrow dialog must not overflow horizontally');
      await click('#cancelUpdate'); await waitFor(() => /cancelled/i.test(document.getElementById('releaseStatus').textContent), 'Cancel did not finish');
      await pause(80);
      assert.equal(await evaluate(() => document.getElementById('releaseProgress').hidden && !document.getElementById('downloadUpdate').hidden), true);
      assert.equal(count('update-cancel'), 1); assert.equal(count('update-install'), 0);
      main.setContentSize(1100, 800); await pause(120);
    });
    await check('Download failures offer a manual retry and never start installation', async () => {
      nextDownloadError = true; await click('#downloadUpdate');
      await waitFor(() => /download interrupted/.test(document.getElementById('releaseStatus').textContent), 'Download failure not shown');
      assert.equal(await evaluate(() => !document.getElementById('downloadUpdate').hidden && document.getElementById('installUpdate').hidden), true);
      await pause(80); assert.equal(count('update-download'), 2); assert.equal(count('update-install'), 0);
      await click('#downloadUpdate'); await waitFor(() => document.getElementById('releaseProgress').value === 12.5, 'Retry did not start');
      publish({ ...fixtureState, phase: 'verifying', progress: 100, bytesReceived: 128 * 1048576, message: 'Verifying the downloaded installer…' });
      await waitFor(() => /Verifying download/.test(document.getElementById('releaseDetail').textContent), 'Verification phase missing');
      assert.equal(await evaluate(() => document.getElementById('installUpdate').hidden), true);
      completeDownload(); await waitFor(() => !document.getElementById('installUpdate').hidden, 'Install action missing after verification');
      assert.equal(count('update-install'), 0); await screenshot('ready');
      main.setContentSize(480, 760); await pause(120); await screenshot('ready-narrow');
      assert.equal(await evaluate(() => { const dialog = document.getElementById('workspaceDialog'); return dialog.scrollWidth <= dialog.clientWidth + 1; }), true);
      main.setContentSize(1100, 800); await pause(120);
    });
    await check('Reopening and reloading preserve a ready update without new work', async () => {
      const before = report.calls.length;
      await click('#workspaceClose'); await openUpdates();
      assert.equal(await evaluate(() => !document.getElementById('installUpdate').hidden), true);
      assert.equal(report.calls.length, before);
      await new Promise(resolve => { main.webContents.once('did-finish-load', resolve); main.webContents.reload(); });
      await waitFor(() => !!window.OlangaWorkspace && !document.getElementById('installUpdate').hidden, 'Ready state not restored after reload');
      await quiet(); await openUpdates();
      assert.equal(count('update-state'), 2); assert.equal(count('update-download'), 3); assert.equal(count('update-install'), 0);
    });
    await check('A late initial state snapshot cannot overwrite a newer ready event', async () => {
      const ready = { ...fixtureState };
      fixtureState = { ...initial }; delayNextState = true;
      await new Promise(resolve => { main.webContents.once('did-finish-load', resolve); main.webContents.reload(); });
      await waitFor(() => !!window.OlangaWorkspace, 'Renderer did not initialize for delayed-state check');
      for (let attempt = 0; attempt < 40 && !pendingInitialState; attempt++) await pause(25);
      assert.equal(typeof pendingInitialState, 'function', 'Initial local-state IPC must be pending');
      publish(ready);
      await waitFor(() => !document.getElementById('installUpdate').hidden, 'Newer ready event did not render');
      pendingInitialState(); pendingInitialState = null; await pause(100);
      assert.equal(await evaluate(() => !document.getElementById('installUpdate').hidden), true, 'Stale idle result must not hide a ready update');
      await quiet(); await openUpdates();
      assert.equal(count('update-state'), 3); assert.equal(count('update-download'), 3); assert.equal(count('update-install'), 0);
    });
    await check('Rechecking a saved installer hides download progress and cancellation', async () => {
      const ready = { ...fixtureState };
      publish({ ...ready, phase: 'verifying', downloaded: true, message: 'Rechecking the installer before updating…' });
      await waitFor(() => /Rechecking the installer/.test(document.getElementById('releaseStatus').textContent), 'Install recheck phase did not render');
      assert.equal(await evaluate(() => document.getElementById('releaseProgress').hidden && document.getElementById('cancelUpdate').hidden && document.getElementById('installUpdate').disabled), true);
      publish(ready);
      await waitFor(() => !document.getElementById('installUpdate').disabled, 'Ready state did not restore');
    });
    await check('Installation needs its own click and launcher failure permits an explicit retry', async () => {
      nextInstallError = true; await click('#installUpdate');
      await waitFor(() => /installer could not start/.test(document.getElementById('releaseStatus').textContent), 'Installer failure not shown');
      assert.equal(count('update-install'), 1);
      assert.equal(await evaluate(() => !document.getElementById('installUpdate').hidden && !document.getElementById('installUpdate').disabled), true);
      await pause(80); assert.equal(count('update-install'), 1);
      await click('#installUpdate'); await waitFor(() => /Installing Olanga/.test(document.getElementById('releaseStatus').textContent), 'Explicit install did not render');
      assert.equal(count('update-install'), 2);
    });
    await check('Check failures recover only when the user checks again', async () => {
      publish({ ...initial }); await waitFor(() => !document.getElementById('checkRelease').disabled, 'Idle state not restored');
      nextCheckError = true; await click('#checkRelease');
      await waitFor(() => /connection unavailable/.test(document.getElementById('releaseStatus').textContent), 'Check failure not shown');
      await pause(80); assert.equal(count('check-release'), 2);
      assert.equal(await evaluate(() => document.getElementById('downloadUpdate').hidden && document.getElementById('installUpdate').hidden), true);
      await click('#checkRelease'); await waitFor(() => !document.getElementById('downloadUpdate').hidden, 'Manual check retry did not recover');
      assert.equal(count('check-release'), 3); assert.equal(count('update-download'), 3); assert.equal(count('update-install'), 2);
    });
    await check('No network, actual download, installer, microphone, provider, or native action ran', async () => {
      assert.deepEqual(report.forbiddenCalls, []);
      assert.deepEqual(report.rendererErrors, []);
      assert.equal(await evaluate(() => window.__updateMicCalls), 0);
    });
    report.passed = true; finish(0);
  } catch (error) { report.error = error.stack || error.message; await screenshot('failure').catch(() => {}); finish(1); }
});
setTimeout(() => { report.error = 'Manual update smoke exceeded its 60-second deadline.'; finish(1); }, 60000).unref();
