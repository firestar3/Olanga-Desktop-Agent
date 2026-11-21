// Production renderer and preload in a permanently hidden offscreen window,
// with authored score/music fixtures only. Production main is tested separately.
// All media observation/actions, sports requests, providers and native tools
// are intercepted; no installed player, credentials or real score feed is read.
const { app, BrowserWindow, ipcMain, session, net } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../build/qa/companion-cards');
fs.mkdirSync(output, { recursive: true });
app.disableHardwareAcceleration();
// Keep one-pixel breakpoint checks independent of the host's Windows DPI.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.setPath('userData', fs.mkdtempSync(path.join(output, 'profile-')));
if (!process.argv.includes('--hidden')) process.argv.push('--hidden');
const report = { passed: false, checks: [], screenshots: [], forbidden: [], errors: [], reads: 0, commands: [], sportsPreferences: [] };
let main, done = false, allowMediaCommand = false;
let media = { ok: true, verified: true, status: 'Playing', source: 'spotify', title: 'After the Rain', artist: 'Olanga fixture artist', message: 'Authored fixture session' };
let sports = { enabled: true, liveOnly: true, team: 'gs', teamName: 'Golden State Warriors', state: 'ready', updatedAt: Date.now(), stale: false,
  game: { id: 'fixture-game', state: 'live', detail: 'Q4 2:14', away: { abbr: 'GSW', name: 'Golden State Warriors', score: 108 }, home: { abbr: 'LAL', name: 'Los Angeles Lakers', score: 105 } } };
const forbidden = new Set(['provider-generate', 'provider-generate-stream', 'nvidia-tts-config', 'nvidia-tts-synthesize', 'open-app', 'close-app', 'arrange-app', 'play-spotify', 'reload-spotify', 'desktop-capture', 'desktop-run', 'desktop-undo', 'execute-command', 'check-release', 'update-download', 'update-install', 'conversation-live-start', 'set-open-at-login', 'open-external', 'fetch-news-bundle']);
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, (event, ...args) => {
  if (channel === 'fetch-news-bundle') { report.newsFixtureReads = (report.newsFixtureReads || 0) + 1; return { locationLabel: 'Fixture region', topics: ['technology'], generatedAt: new Date().toISOString(), coverage: { failedFeeds: 0, localUnavailable: false }, articles: [] }; }
  if (channel === 'media-get-snapshot') { report.reads++; return { ...media }; }
  if (channel === 'sports-get-snapshot') return sports;
  if (channel === 'media-control') {
    if (!allowMediaCommand || !['PREV', 'PLAY_PAUSE', 'NEXT'].includes(args[0]) || args[1] !== true) {
      report.forbidden.push('unexpected-media-control'); throw Error('Unexpected media action in fixture');
    }
    report.commands.push(args);
    if (args[0] === 'PLAY_PAUSE') media = { ...media, status: media.status === 'Playing' ? 'Paused' : 'Playing' };
    return { ...media };
  }
  if (forbidden.has(channel)) { report.forbidden.push(channel); throw Error('Disabled in companion fixture: ' + channel); }
  return callback(event, ...args);
});
const on = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, callback) => on(channel, (event, ...args) => {
  if (channel === 'sports-set-preferences') { report.sportsPreferences.push(args[0]); return; }
  if (forbidden.has(channel)) { report.forbidden.push(channel); return; }
  return callback(event, ...args);
});
const offline = async () => { report.forbidden.push('network'); throw Error('Network disabled in companion fixture'); };
globalThis.fetch = net.fetch = offline;
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, _file, error) => report.errors.push(error.message));
  contents.on('render-process-gone', (_event, detail) => report.errors.push('Renderer stopped: ' + detail.reason));
  contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, reply) => { report.forbidden.push('renderer-network'); reply({ cancel: true }); });
});
app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, reply) => { report.forbidden.push('permission:' + permission); reply(false); });
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => main.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')', true);
async function until(predicate, label, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await predicate()) return; await pause(50); }
  throw Error(label);
}
async function click(selector) {
  await evaluate(selector => {
    const element = document.querySelector(selector);
    if (!element || !element.getClientRects().length || element.disabled) throw Error('Unavailable control: ' + selector);
    element.scrollIntoView({ block: 'nearest' }); element.click();
  }, selector);
}
async function uncovered(selector, label) {
  const result = await evaluate(selector => {
    const element = document.querySelector(selector);
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return !!element.getClientRects().length && box.x >= 0 && box.right <= innerWidth && box.y >= 0 && box.bottom <= innerHeight && (hit === element || element.contains(hit));
  }, selector);
  assert.equal(result, true, label);
}
async function resize(width, height) {
  await main.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await until(() => evaluate((width, height) => innerWidth === width && innerHeight === height, width, height), 'Emulated fixture viewport did not resize', 5000);
  assert.equal(main.isVisible(), false, 'fixture window must never appear on the desktop');
  await pause(150);
}
async function layout(name, screenId = 'mainScreen') {
  // The existing timer/task entrance animations replay after returning Home.
  // Measure their settled boxes, while leaving infinite orb animation intact.
  await evaluate(async () => {
    const animations = document.getElementById('mainScreen').getAnimations({ subtree: true });
    await Promise.allSettled(animations.filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished));
  });
  await evaluate(() => { document.querySelector('#mainScreen .assistant-container').scrollTop = 0; });
  const metrics = await evaluate(screenId => {
    const bounds = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const rail = document.getElementById('companionRail'), screen = document.getElementById(screenId);
    const pageElements = [...document.querySelectorAll('#mainScreen, #mainScreen .assistant-container, #mainScreen .assistant-container > :not(#companionRail), #textCommandInput, #textCommandBtn, #micToggleBtn, #ttsToggleBtn, #timerInput, #taskInput, .settings-container, .settings-header, .settings-scroll')].filter(element => element.getClientRects().length);
    const railWasHidden = rail.hidden, railWasEnabled = document.body.classList.contains('companion-rail-visible');
    rail.hidden = true; document.body.classList.remove('companion-rail-visible');
    const baseline = bounds(screen);
    const pageBaseline = pageElements.map(bounds);
    rail.hidden = railWasHidden; document.body.classList.toggle('companion-rail-visible', railWasEnabled);
    const controls = [...rail.querySelectorAll('button')].filter(button => button.getClientRects().length).map(button => {
      const box = bounds(button), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { id: button.id, ...box, reachable: hit === button || button.contains(hit) };
    });
    const cards = [...rail.querySelectorAll('.companion-card')].filter(card => card.getClientRects().length).map(bounds);
    const primary = ['textCommandInput', 'textCommandBtn', 'micToggleBtn', 'ttsToggleBtn'].map(id => {
      const element = document.getElementById(id), box = bounds(element);
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { id, reachable: !!element.getClientRects().length && (hit === element || element.contains(hit)) };
    });
    return { width: innerWidth, height: innerHeight, inline: getComputedStyle(rail).position === 'relative', hidden: rail.hidden, rail: bounds(rail), tasks: bounds(document.getElementById('tasksContainer')), screen: bounds(screen), baseline, pageBaseline, pageCurrent: pageElements.map(bounds), cards, overflow: document.documentElement.scrollWidth > innerWidth + 1, controls, primary };
  }, screenId);
  (report.layouts ||= []).push({ name, width: metrics.width, height: metrics.height, inline: metrics.inline, hidden: metrics.hidden, rail: metrics.rail, tasks: metrics.tasks, cards: metrics.cards, primary: metrics.primary });
  assert.equal(metrics.overflow, false, name + ': no document horizontal overflow');
  const { rail, screen } = metrics;
  assert.ok(rail.x >= 0 && rail.right <= metrics.width + 1, name + ': rail fits viewport width');
  if (!metrics.inline) assert.ok(rail.y >= 0 && rail.bottom <= metrics.height + 1, name + ': fixed rail fits viewport height');
  assert.deepEqual(screen, metrics.baseline, name + ': companions never resize or shift the existing screen');
  assert.deepEqual(metrics.pageCurrent, metrics.pageBaseline, name + ': inner page controls, panels and spacing remain unchanged');
  for (let index = 1; index < metrics.cards.length; index++) assert.ok(metrics.cards[index - 1].bottom <= metrics.cards[index].y, name + ': companion cards do not overlap one another');
  if (!metrics.hidden) {
    for (const control of metrics.primary) assert.equal(control.reachable, true, name + ': primary Home control is reachable before scrolling ' + control.id);
    if (metrics.inline) {
      assert.ok(metrics.cards[0].y >= metrics.tasks.bottom + 15, name + ': compact cards follow Tasks in the Home scroll region');
      assert.equal(metrics.width <= 1000, true, name + ': inline fallback is limited to narrow Home');
    }
    for (const selector of ['#textCommandInput', '#textCommandBtn', '#micToggleBtn', '#ttsToggleBtn']) {
      await uncovered(selector, name + ': primary Home control stays unobscured ' + selector);
    }
    await evaluate(() => { document.querySelector('#mainScreen .assistant-container').scrollTop = 0; });
  }
  async function capture(suffix = '') {
    main.webContents.invalidate(); await pause(120);
    const file = path.join(output, name + suffix + '-fixture.png');
    const shot = await main.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); report.screenshots.push(file);
  }
  await capture();
  for (const button of metrics.controls) {
    if (metrics.inline) await uncovered('#' + button.id, name + ': card control is reachable by scrolling ' + button.id);
    else {
      assert.ok(button.x >= 0 && button.right <= metrics.width + 1 && button.y >= 0 && button.bottom <= metrics.height + 1, name + ': button fits ' + button.id);
      assert.equal(button.reachable, true, name + ': button has an unobscured hit target ' + button.id);
    }
  }
  if (metrics.inline && !metrics.hidden) await capture('-cards');
  await evaluate(() => { document.querySelector('#mainScreen .assistant-container').scrollTop = 0; });
  report.checks.push(name + ': cards and primary Home controls stay reachable, with unchanged existing page geometry');
}
function finish(code) {
  if (done) return; done = true; report.passed = code === 0;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); app.exit(code);
}
process.on('uncaughtException', error => { report.error = error.stack; finish(1); });
process.on('unhandledRejection', error => { report.error = error.stack; finish(1); });
setTimeout(() => { report.error = 'Companion fixture exceeded 150 seconds'; finish(1); }, 150000).unref();
// Keep the real preload surface, but resolve every invocation inside this
// fixture instead of loading production main or creating any native worker.
const store = new Map();
const safe = new Map([
  ['secure-store-get', (_event, key) => store.get(key) ?? null],
  ['secure-store-set', (_event, value) => { store.set(value.key, value.value); return true; }],
  ['get-app-info', () => ({ version: '1.6.1', packaged: false })],
  ['get-app-visibility', () => ({ visible: true, revision: 0 })],
  ['get-open-at-login', () => ({ supported: false, enabled: false })],
  ['set-push-to-talk', () => ({ registered: false, value: 'off', label: 'Off' })],
  ['provider-status', () => ({ configured: false })],
  ['update-renderer-ready', () => ({ ok: true })],
  ['update-state', () => ({ status: 'idle' })]
]);
const preload = fs.readFileSync(path.resolve(__dirname, '../preload.js'), 'utf8');
for (const channel of new Set([...preload.matchAll(/ipcRenderer\.invoke\(['"]([^'"]+)['"]/g)].map(match => match[1]))) {
  ipcMain.handle(channel, safe.get(channel) || (() => { report.forbidden.push('unhandled:' + channel); throw Error('Unexpected fixture invocation: ' + channel); }));
}
for (const channel of new Set([...preload.matchAll(/ipcRenderer\.send\(['"]([^'"]+)['"]/g)].map(match => match[1]))) ipcMain.on(channel, () => {});
app.whenReady().then(async () => {
  try {
    main = new BrowserWindow({ width: 1600, height: 950, show: false, frame: false, skipTaskbar: true,
      webPreferences: { preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    main.webContents.debugger.attach('1.3');
    await main.loadFile(path.resolve(__dirname, '../index.html'));
    await until(() => evaluate(() => window.OlangaAppInitialized === true && !!window.OlangaCompanionCards), 'App and companions did not initialize');
    await evaluate(() => {
      // Only this offscreen fixture receives a synthetic visibility signal.
      // Production native visibility/disposal is covered by companion-main tests.
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      window.companionErrors = [];
      window.addEventListener('error', event => window.companionErrors.push(event.message));
      window.addEventListener('unhandledrejection', event => window.companionErrors.push(String(event.reason)));
      isMicMuted = true; isTtsMuted = true;
      document.getElementById('startLocalBtn').click();
    });
    await until(() => evaluate(() => !document.getElementById('companionRail').hidden && document.getElementById('companionTrackTitle').textContent === 'After the Rain'), 'Fixture media not displayed');
    assert.deepEqual(report.commands, [], 'boot and automatic observation must never play, pause, or skip music');
    assert.ok(report.reads > 0);
    report.checks.push('Music reads through readonly API; no automatic media action');
    await resize(1600, 950);
    assert.equal(await evaluate(() => !!document.getElementById('companionRailToggle')), false, 'Home cards have no hide toggle');
    await layout('desktop');
    for (const [width, height] of [[400, 550], [400, 650], [768, 800], [1000, 800], [1001, 800], [1200, 800]]) {
      await resize(width, height);
      await until(() => evaluate(() => !document.getElementById('companionRail').hidden && document.getElementById('companionMediaToggle').getClientRects().length > 0), 'Home cards must stay available at every tested width');
      await layout('home-' + width + 'x' + height);
    }
    await resize(400, 650);
    report.checks.push('Narrow Home cards follow Tasks, remain reachable without a hide toggle, and preserve existing controls');
    assert.equal(await evaluate(() => document.getElementById('companionSportsAwayScore').textContent), '108');
    sports = { ...sports, game: { ...sports.game, state: 'final', detail: 'Final' } };
    main.webContents.send('sports-snapshot', sports);
    await until(() => evaluate(() => document.getElementById('companionSportsCard').hidden), 'Live-only final card did not hide');
    await layout('narrow-music-only');
    sports = { ...sports, liveOnly: false }; main.webContents.send('sports-snapshot', sports);
    await until(() => evaluate(() => !document.getElementById('companionSportsCard').hidden && document.getElementById('companionSportsState').textContent === 'Final'), 'Always-show final score missing');
    sports = { ...sports, liveOnly: true, game: { ...sports.game, state: 'live', detail: 'Q4 2:14' } }; main.webContents.send('sports-snapshot', sports);
    await until(() => evaluate(() => document.getElementById('companionSportsState').textContent === 'Q4 2:14'), 'Live score did not return');
    report.checks.push('Live-only finals hide, always-show finals remain, next live update returns');
    await click('#companionSportsSettings');
    await until(() => evaluate(() => document.getElementById('settingsTabUser').getAttribute('aria-selected') === 'true' && document.activeElement.id === 'sportsTeamSelect'), 'Score settings did not focus the team selector');
    await until(() => evaluate(() => document.getElementById('companionRail').hidden), 'Opening score settings must hide the whole Home rail');
    report.checks.push('Score settings opens User preferences at team selection and hides Home cards');
    await resize(1600, 950);
    await uncovered('#sportsTeamSelect', 'Settings team selector is unobstructed because Home cards are absent');
    await uncovered('.toggle-switch:has(#sportsEnabledToggle)', 'Settings enable switch is unobstructed because Home cards are absent');
    await layout('desktop-settings', 'settingsScreen');
    await evaluate(() => { setFeatureEnabled('notepadScreen', true); setFeatureEnabled('newsScreen', true); });
    for (const screenId of ['settingsScreen', 'notepadScreen', 'newsScreen']) {
      await resize(...(screenId === 'notepadScreen' ? [400, 650] : [1600, 950]));
      await click('[data-screen="' + screenId + '"]');
      await until(() => evaluate(screenId => !document.getElementById(screenId).classList.contains('hidden') && document.getElementById('companionRail').hidden, screenId), 'Home companions remained visible on ' + screenId);
      assert.equal(await evaluate(() => document.getElementById('companionRail').getClientRects().length), 0, screenId + ': no visible rail or handle');
      await pause(150);
      const readsAway = report.reads;
      sports = { ...sports, game: { ...sports.game, away: { ...sports.game.away, score: sports.game.away.score + 1 } } };
      main.webContents.send('sports-snapshot', sports);
      await pause(10500);
      assert.equal(report.reads, readsAway, screenId + ': media polling must stop outside Home');
      assert.equal(await evaluate(() => document.getElementById('companionRail').hidden), true, screenId + ': score updates cannot reveal Home companions');
      await click('[data-screen="mainScreen"]');
      await until(() => report.reads > readsAway && evaluate(() => !document.getElementById('companionRail').hidden), 'Returning Home did not restore cards and media observation');
      assert.equal(await evaluate(() => document.getElementById('companionSportsAwayScore').textContent), String(sports.game.away.score), 'Home restores the latest score received while away');
      await layout('home-after-' + screenId);
      report.checks.push(screenId + ': whole rail hidden, media polling paused over10.5seconds; Home restores cards and latest scores without layout changes');
    }
    for (const [selector, action] of [['#companionMediaPrevious', 'PREV'], ['#companionMediaToggle', 'PLAY_PAUSE'], ['#companionMediaNext', 'NEXT']]) {
      await until(() => evaluate(selector => !document.querySelector(selector).disabled, selector), 'Music control did not become ready');
      const before = report.commands.length; allowMediaCommand = true;
      await click(selector);
      await until(() => report.commands.length === before + 1, 'Expected fixture media action missing');
      allowMediaCommand = false;
      assert.deepEqual(report.commands.at(-1), [action, true, undefined]);
    }
    report.checks.push('Previous, play/pause and next invoke only explicitly clicked fixture actions');
    await until(() => evaluate(() => !document.getElementById('companionMediaNext').disabled), 'Media action did not finish');
    main.webContents.send('app-visibility-changed', { visible: false, revision: 100 }); await pause(150);
    const readsBeforeHidden = report.reads;
    await pause(10500);
    assert.equal(report.reads, readsBeforeHidden, 'hidden app notification stops recurring media observations');
    main.webContents.send('app-visibility-changed', { visible: true, revision: 101 });
    await until(() => report.reads > readsBeforeHidden, 'Showing the app did not refresh media');
    report.checks.push('Visibility notification pauses and resumes media polling while fixture window remains offscreen');
    assert.equal(main.isVisible(), false);
    assert.deepEqual(report.commands.map(command => command[0]), ['PREV', 'PLAY_PAUSE', 'NEXT']);
    report.errors.push(...await evaluate(() => window.companionErrors));
    assert.deepEqual(report.errors, []); assert.deepEqual(report.forbidden, []);
    finish(0);
  } catch (error) { report.error = error.stack; finish(1); }
});
