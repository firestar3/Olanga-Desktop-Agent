// Production Settings renderer/preload with a fresh profile and blocked external
// actions. No real credentials, microphone, playback, startup changes or network.
const { app, BrowserWindow, ipcMain, session, net } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, '../build/qa');
fs.mkdirSync(output, { recursive: true });
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(output, 'settings-experience-profile-')));
if (!process.argv.includes('--hidden')) process.argv.push('--hidden');
const report = { passed: false, checks: [], screenshots: [], externalLinks: [], forbiddenCalls: [], errors: [], preferenceWrites: [], coverage: { realRenderer: true, realPreload: true, isolatedProfile: true, liveProviders: false, microphone: false } };
const forbidden = new Set(['provider-generate', 'provider-generate-stream', 'nvidia-tts-config', 'nvidia-tts-synthesize', 'open-app', 'arrange-app', 'close-app', 'play-spotify', 'reload-spotify', 'media-control', 'desktop-capture', 'desktop-run', 'desktop-undo', 'execute-command', 'terminal-session-create', 'terminal-session-execute', 'fetch-news-bundle', 'check-release', 'update-download', 'update-install', 'set-open-at-login']);
let fixtureConnection = false, pendingConnection = null;
let failNextPrefs = false, holdNextPrefs = false, pendingPrefs = null, main, finished = false;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, async (event, ...args) => {
  if (channel === 'provider-generate' && fixtureConnection) { report.fixtureConnectionRequests = (report.fixtureConnectionRequests || 0) + 1; return new Promise(resolve => { pendingConnection = resolve; }); }
  if (forbidden.has(channel)) { report.forbiddenCalls.push(channel); throw new Error('External action disabled in Settings smoke: ' + channel); }
  if (channel === 'open-external') { report.externalLinks.push(args[0]); return true; }
  if (channel === 'secure-store-set' && args[0]?.key === 'app_preferences') {
    if (failNextPrefs) { failNextPrefs = false; throw new Error('Fixture: preference storage unavailable'); }
    if (holdNextPrefs) { holdNextPrefs = false; await new Promise(resolve => { pendingPrefs = resolve; }); }
    report.preferenceWrites.push(JSON.parse(args[0].value));
  }
  return callback(event, ...args);
});
const on = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, callback) => on(channel, (event, ...args) => {
  if (channel === 'open-external') { report.externalLinks.push(args[0]); return; }
  if (forbidden.has(channel)) { report.forbiddenCalls.push(channel); return; }
  return callback(event, ...args);
});
const forbidFetch = async () => { report.forbiddenCalls.push('network-fetch'); throw new Error('Network disabled in Settings smoke.'); };
globalThis.fetch = forbidFetch;
net.fetch = forbidFetch;
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, _file, error) => report.errors.push(error.message));
  contents.on('render-process-gone', (_event, detail) => report.errors.push('Renderer stopped: ' + detail.reason));
});
app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => { report.forbiddenCalls.push('permission:' + permission); callback(false); });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_detail, callback) => callback({ cancel: true }));
  session.defaultSession.on('will-download', (_event, item) => { report.forbiddenCalls.push('browser-download'); item.cancel(); });
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(fn, ...args) { return main.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true); }
async function waitFor(fn, label, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return; await pause(35); }
  throw new Error(label);
}
// Native resize acknowledgement can precede Chromium's responsive style/layout commit.
// Compare scrolling only after the requested viewport and its CSS have settled.
async function resizeSettings(width, height) {
  main.setContentSize(width, height);
  let previous = null, settled = null;
  await waitFor(async () => {
    await evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const state = await evaluate((width, height) => {
      const container = document.querySelector('.settings-container'), header = document.querySelector('.settings-screen-header');
      const box = container.getBoundingClientRect(), heading = header.getBoundingClientRect(), style = getComputedStyle(container);
      return { width: innerWidth, height: innerHeight, short: matchMedia('(max-height: 650px)').matches,
        narrow: matchMedia('(max-width: 760px)').matches, paddingTop: Number.parseFloat(style.paddingTop),
        containerWidth: box.width, containerHeight: box.height, headerTop: heading.top, headerBottom: heading.bottom,
        headerWidth: heading.width };
    }, width, height);
    const expectedTop = height <= 650 ? 40 : 48;
    const ready = state.width === width && state.height === height && state.short === (height <= 650)
      && state.narrow === (width <= 760) && state.paddingTop === expectedTop && state.headerTop === expectedTop
      && Math.abs(state.containerWidth - width) <= 1 && Math.abs(state.containerHeight - height) <= 1;
    const signature = JSON.stringify(state), stable = ready && signature === previous;
    previous = ready ? signature : null; settled = state;
    return stable;
  }, 'Settings responsive CSS did not settle at ' + width + 'x' + height).catch(error => {
    report.viewportFailure = { requested: { width, height }, observed: settled }; throw error;
  });
  (report.viewportSettles ||= []).push(settled);
}
async function click(selector) {
  await evaluate(selector => {
    const node = document.querySelector(selector);
    if (!node || !node.getClientRects().length || node.disabled) throw new Error('Missing enabled visible control: ' + selector);
    node.scrollIntoView({ block: 'nearest' }); node.focus(); node.click();
  }, selector);
}
async function select(selector, value) {
  await evaluate((selector, value) => {
    const node = document.querySelector(selector);
    if (!node || !node.getClientRects().length) throw new Error('Missing visible setting: ' + selector);
    node.value = value; node.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);
}
async function saved() {
  await waitFor(() => evaluate(() => document.getElementById('preferencesSaveStatus')?.dataset.state === 'saved'), 'Settings did not report a saved preference');
}
async function check(name, action) { await action(); report.checks.push({ name, passed: true }); }
async function screenshot(name) {
  await evaluate(() => { document.querySelector('.settings-scroll').scrollTop = 0; });
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  main.webContents.invalidate(); await pause(150);
  await main.webContents.capturePage(); await pause(80);
  const filename = path.join(output, `settings-experience-${name}.png`);
  fs.writeFileSync(filename, (await main.webContents.capturePage()).toPNG()); report.screenshots.push(filename);
}
function finish(code) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(path.join(output, 'settings-experience-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, preferenceWrites: report.preferenceWrites.length, smallTextContrast: report.smallTextContrast?.length }, null, 2));
  if (code === 0 && process.argv.includes('--review')) {
    clearTimeout(deadline); main.setTitle('Olanga Settings Review'); main.show();
    console.log('REVIEW_READY: isolated Settings fixture; no microphone, providers, network or native actions.');
  } else app.exit(code);
}
const deadline = setTimeout(() => { report.error = 'Settings smoke exceeded 120 seconds.'; finish(1); }, 120000);
deadline.unref();
require('../main');
app.whenReady().then(async () => {
  try {
    await waitFor(() => {
      main = BrowserWindow.getAllWindows().find(win => /[\\/]index\.html$/.test(win.webContents.getURL()));
      return main && !main.webContents.isLoading();
    }, 'Main renderer did not load');
    await waitFor(() => evaluate(() => !!window.OlangaSettingsNavigation && !!window.loadSettingsValues), 'Settings navigation did not initialize');
    await evaluate(() => {
      isTtsMuted = true; isMicMuted = true;
      window.settingsSmokeErrors = [];
      window.addEventListener('error', event => settingsSmokeErrors.push(event.message));
      window.addEventListener('unhandledrejection', event => settingsSmokeErrors.push(String(event.reason?.message || event.reason)));
    });
    main.unmaximize(); main.setMinimumSize(360, 480); main.setContentSize(1100, 800); main.webContents.setZoomFactor(1);
    await check('Privacy is readable before setup and returning preserves the unsubmitted setup draft', async () => {
      await evaluate(() => { document.getElementById('apiKeyInput').value = 'fixture-unsubmitted-draft'; });
      await click('#setupPrivacyBtn');
      assert.equal(await evaluate(() => document.getElementById('settingsTabPrivacy').getAttribute('aria-selected')), 'true');
      const setupAccess = await evaluate(() => ({
        otherTabsVisible: ['settingsTabUser', 'settingsTabCore'].some(id => document.getElementById(id).getClientRects().length),
        managementVisible: [...document.querySelectorAll('#settingsPanelPrivacy [data-open-settings-tab], #settingsPanelPrivacy [data-privacy-workspace]')].some(node => node.getClientRects().length),
        selectedUser: window.OlangaSettingsNavigation.select('user'),
        selectedCore: window.OlangaSettingsNavigation.select('core')
      }));
      assert.deepEqual(setupAccess, { otherTabsVisible: false, managementVisible: false, selectedUser: false, selectedCore: false }, 'Reading the privacy notice must not bypass first-run setup');
      assert.ok((await evaluate(() => document.getElementById('privacyNoticeContent').textContent)).length > 500, 'Privacy summary must be available offline');
      await click('#privacyFullNotice summary');
      await waitFor(() => evaluate(() => document.getElementById('privacyFullNoticeBody')?.textContent.length > 5000), 'Full privacy notice did not load offline');
      const privacyLinks = await evaluate(() => [...document.querySelectorAll('#privacyNoticeContent a[href]')].map(link => link.getAttribute('href')));
      assert.ok(privacyLinks.length > 1 && privacyLinks.every(url => /^https:\/\//.test(url)), 'Privacy links must use HTTPS');
      await click('#privacyNoticeContent a[href]');
      await waitFor(() => report.externalLinks.length === 1, 'Privacy link did not use the approved external browser bridge');
      await screenshot('privacy-before-setup');
      await click('#settingsReturnToSetupBtn');
      assert.equal(await evaluate(() => document.getElementById('apiKeyInput').value), 'fixture-unsubmitted-draft');
      assert.equal(await evaluate(() => document.getElementById('setupScreen').classList.contains('hidden')), false);
      assert.equal(await evaluate(() => document.activeElement.id), 'setupPrivacyBtn', 'Returning from Privacy must restore focus to its setup opener');
      assert.equal(await evaluate(() => document.getElementById('settingsTabUser').getAttribute('aria-selected')), 'true');
      assert.equal(await evaluate(() => !document.getElementById('settingsTabUser').hidden && !document.getElementById('settingsTabCore').hidden), true, 'Completing setup must restore normal settings navigation');
      await evaluate(() => { document.getElementById('apiKeyInput').value = ''; });
    });
    await click('#startLocalBtn');
    await click('[data-screen="settingsScreen"]');
    await check('Opening Core during intro replay cancels stale return-to-Home callbacks', async () => {
      const state = await evaluate(() => {
        const nativeTimeout = window.setTimeout, callbacks = [];
        window.setTimeout = (callback, delay, ...args) => {
          const timer = nativeTimeout(callback, delay, ...args);
          if ([6500, 7200, 700].includes(delay)) callbacks.push(callback);
          return timer;
        };
        try {
          playSetupIntroReplay();
          const replayMode = setupScreen.classList.contains('setup-intro-replay');
          window.OlangaSettingsNavigation.open('core', { focus: false });
          callbacks.forEach(callback => callback());
          return { replayMode, settings: !settingsScreen.classList.contains('hidden'), home: !mainScreen.classList.contains('hidden'),
            setup: !setupScreen.classList.contains('hidden'), core: document.getElementById('settingsTabCore').getAttribute('aria-selected'),
            setupRestricted: settingsScreen.classList.contains('settings-before-setup'), navigation: document.querySelector('.floating-icons').classList.contains('visible') };
        } finally { window.setTimeout = nativeTimeout; cancelSetupIntroReplay(); }
      });
      assert.deepEqual(state, { replayMode: true, settings: true, home: false, setup: false, core: 'true', setupRestricted: false, navigation: true });
      await waitFor(() => evaluate(() => getComputedStyle(document.querySelector('.floating-icons')).opacity === '1'), 'Global navigation remained invisible after leaving intro replay');
    });
    await check('Normal navigation exits typed and recording wake enrollment without leaving speech blocked', async () => {
      const states = [];
      for (const phase of ['type', 'record']) {
        const state = await evaluate(phase => {
          openWakeWordCaptureScreen();
          // Exercise recording ownership without opening or requesting a microphone.
          if (phase === 'record') { wakeCapturePhase = 'record'; isWakeWordCapturing = true; }
          const before = { open: wakeCaptureOpen, capturing: isWakeWordCapturing, navigation: document.querySelector('.floating-icons').classList.contains('visible') };
          document.querySelector('.floating-icon[data-screen="' + (phase === 'type' ? 'mainScreen' : 'settingsScreen') + '"]').click();
          return { before, open: wakeCaptureOpen, capturing: isWakeWordCapturing,
            enrollmentHidden: document.getElementById('wakeWordCaptureScreen').classList.contains('hidden'),
            destinationVisible: !(phase === 'type' ? mainScreen : settingsScreen).classList.contains('hidden'),
            navigation: document.querySelector('.floating-icons').classList.contains('visible') };
        }, phase);
        states.push({ phase, ...state });
      }
      assert.deepEqual(states, ['type', 'record'].map(phase => ({ phase, before: { open: true, capturing: phase === 'record', navigation: false }, open: false, capturing: false,
        enrollmentHidden: true, destinationVisible: true, navigation: true })));
      const returned = await evaluate(() => {
        openWakeWordCaptureScreen(); cancelWakeWordCapture();
        return { open: wakeCaptureOpen, capturing: isWakeWordCapturing, settings: !settingsScreen.classList.contains('hidden'),
          enrollmentHidden: document.getElementById('wakeWordCaptureScreen').classList.contains('hidden'),
          navigation: document.querySelector('.floating-icons').classList.contains('visible') };
      });
      assert.deepEqual(returned, { open: false, capturing: false, settings: true, enrollmentHidden: true, navigation: true });
    });
    await check('User, Core and Privacy tabs expose exactly one labelled panel with keyboard navigation', async () => {
      await click('#settingsTabUser');
      main.webContents.debugger.attach('1.3');
      for (const [key, expected] of [['ArrowRight', 'settingsTabCore'], ['End', 'settingsTabPrivacy'], ['Home', 'settingsTabUser'], ['ArrowLeft', 'settingsTabPrivacy']]) {
        const keyCode = { ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35 }[key];
        await main.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: keyCode });
        await main.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode });
        await waitFor(() => evaluate(expected => document.activeElement.id === expected && document.getElementById(expected).getAttribute('aria-selected') === 'true', expected), 'Tab keyboard navigation failed for ' + key);
      }
      main.webContents.debugger.detach();
      const state = await evaluate(() => [...document.querySelectorAll('[data-settings-tab]')].map(tab => ({ selected: tab.getAttribute('aria-selected'), index: tab.tabIndex, panel: document.getElementById(tab.getAttribute('aria-controls'))?.hidden, labelled: document.getElementById(tab.getAttribute('aria-controls'))?.getAttribute('aria-labelledby') === tab.id })));
      assert.equal(state.filter(tab => tab.selected === 'true' && tab.index === 0 && !tab.panel).length, 1);
      assert.ok(state.every(tab => tab.labelled && (tab.selected === 'true' || tab.index === -1 && tab.panel)));
      const hiddenControls = await evaluate(() => [...document.querySelectorAll('.settings-panel[hidden] input, .settings-panel[hidden] button, .settings-panel[hidden] select')].filter(node => node.getClientRects().length).map(node => node.id));
      assert.deepEqual(hiddenControls, [], 'Inactive settings panels must be absent from keyboard and visual flow');
      const duplicateIds = await evaluate(() => [...document.querySelectorAll('[id]')].map(node => node.id).filter((id, index, all) => all.indexOf(id) !== index));
      assert.deepEqual(duplicateIds, []);
    });
    await check('Privacy management actions open the matching Workspace section and return keyboard focus on close', async () => {
      await click('#settingsTabPrivacy');
      for (const tab of ['5', '0', '4']) {
        const selector = '[data-privacy-workspace="' + tab + '"]';
        await click(selector);
        await waitFor(() => evaluate(tab => document.getElementById('workspaceDialog').open && document.querySelector('[data-workspace-tab="' + tab + '"]').getAttribute('aria-pressed') === 'true' && !document.querySelector('[data-workspace-page="' + tab + '"]').hidden, tab), 'Privacy shortcut opened the wrong Workspace section');
        assert.equal(await evaluate(() => document.getElementById('workspaceDialog').contains(document.activeElement)), true, 'Workspace must receive keyboard focus');
        await click('#workspaceClose');
        await waitFor(() => evaluate(selector => !document.getElementById('workspaceDialog').open && document.activeElement === document.querySelector(selector), selector), 'Closing Workspace did not return focus to the Privacy action');
      }
    });
    await check('Every Settings form control has an accessible name and toggle captions work', async () => {
      const unnamed = await evaluate(() => [...document.querySelectorAll('#settingsScreen input, #settingsScreen select, #settingsScreen textarea')].filter(node => !node.hidden && node.type !== 'hidden' && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby') && ![...node.labels || []].some(label => label.textContent.trim())).map(node => node.id));
      assert.deepEqual(unnamed, []);
      await click('#settingsTabUser');
      const before = await evaluate(() => document.getElementById('featureNotepadToggle').checked);
      await click('label[for="featureNotepadToggle"]'); await saved();
      assert.equal(await evaluate(() => document.getElementById('featureNotepadToggle').checked), !before);
      await click('label[for="featureNotepadToggle"]'); await saved();
    });
    await check('Reselecting Settings during the save debounce retains edited text and toggles', async () => {
      const original = await evaluate(() => ({ city: document.getElementById('cityInput').value, bargeIn: document.getElementById('bargeInToggle').checked }));
      const immediate = await evaluate(() => {
        const city = document.getElementById('cityInput'), toggle = document.getElementById('bargeInToggle');
        city.value = 'Debounce fixture city'; city.dispatchEvent(new Event('input', { bubbles: true }));
        toggle.checked = !toggle.checked; toggle.dispatchEvent(new Event('change', { bubbles: true }));
        // Reselect in the same task, before the 150 ms persistence debounce.
        document.querySelector('.floating-icon[data-screen="settingsScreen"]').click();
        return { city: city.value, bargeIn: toggle.checked };
      });
      assert.deepEqual(immediate, { city: 'Debounce fixture city', bargeIn: !original.bargeIn });
      await saved();
      assert.equal(report.preferenceWrites.at(-1).city, 'Debounce fixture city');
      assert.equal(report.preferenceWrites.at(-1).bargeIn, !original.bargeIn);
      await evaluate(async original => { document.getElementById('cityInput').value = original.city; document.getElementById('bargeInToggle').checked = original.bargeIn; await saveAppSettings(); }, original);
      await saved();
    });
    await check('Accent changes immediately and keeps established typography and dark surfaces', async () => {
      const outfitFaces = await evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts].filter(face => face.family.replace(/['"]/g, '') === 'Outfit').map(face => ({ status: face.status, weight: face.weight }));
      });
      assert.ok(outfitFaces.length > 0 && outfitFaces.some(face => face.status === 'loaded'), 'The bundled Outfit font must actually load; a computed family with a fallback is insufficient');
      report.loadedFonts = outfitFaces;
      const initial = await evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, font: getComputedStyle(document.body).fontFamily }));
      for (const color of ['blue', 'mint', 'rose', 'amber', 'violet']) {
        await select('#appearanceAccentSelect', color); await saved();
        const style = await evaluate(() => ({ accent: document.documentElement.dataset.accent, background: getComputedStyle(document.body).backgroundColor, font: getComputedStyle(document.body).fontFamily, buttonFont: getComputedStyle(document.getElementById('settingsTabCore')).fontFamily }));
        assert.equal(style.accent, color); assert.equal(style.background, initial.background); assert.equal(style.font, initial.font); assert.equal(style.buttonFont, initial.font);
      }
      await screenshot('user-violet');
      await select('#appearanceAccentSelect', 'blue'); await saved(); await screenshot('user-blue');
    });
    await check('Contrast and glow change only visual presentation and every accent fits the minimum window size', async () => {
      const presentation = () => evaluate(() => {
        const root = getComputedStyle(document.documentElement), body = getComputedStyle(document.body), halo = getComputedStyle(document.getElementById('orbGlow')), orb = getComputedStyle(document.getElementById('orb'));
        return { state: currentState, text: body.color, background: body.backgroundColor, border: root.getPropertyValue('--border-subtle'), semanticColors: ['--listening', '--thinking', '--speaking', '--success', '--danger'].map(name => root.getPropertyValue(name)), haloDisplay: halo.display, haloOpacity: Number(halo.opacity), haloFilter: halo.filter, orbBackground: orb.backgroundImage, orbAnimation: orb.animationName };
      });
      await select('#appearanceContrastSelect', 'standard'); await select('#appearanceGlowSelect', 'standard'); await saved();
      const normal = await presentation();
      await click('[data-screen="mainScreen"]'); await screenshot('home-normal'); await click('[data-screen="settingsScreen"]');
      await select('#appearanceGlowSelect', 'subtle'); await saved();
      const calm = await presentation();
      assert.ok(calm.haloOpacity < normal.haloOpacity || calm.haloFilter !== normal.haloFilter, 'Subtle glow must visibly reduce the decorative halo');
      assert.equal(calm.orbBackground, normal.orbBackground); assert.equal(calm.orbAnimation, normal.orbAnimation); assert.deepEqual(calm.semanticColors, normal.semanticColors); assert.equal(calm.state, normal.state);
      await click('[data-screen="mainScreen"]'); await screenshot('home-calm'); await click('[data-screen="settingsScreen"]');
      await select('#appearanceGlowSelect', 'off'); await select('#appearanceContrastSelect', 'strong'); await saved();
      const strong = await presentation();
      assert.ok(strong.haloDisplay === 'none' || strong.haloOpacity === 0, 'Glow off must remove the decorative halo');
      assert.notEqual(strong.text, normal.text); assert.notEqual(strong.border, normal.border); assert.notEqual(strong.background, normal.background);
      assert.equal(strong.orbBackground, normal.orbBackground); assert.equal(strong.orbAnimation, normal.orbAnimation); assert.deepEqual(strong.semanticColors, normal.semanticColors); assert.equal(strong.state, normal.state);
      await click('[data-screen="mainScreen"]'); await screenshot('home-high-contrast'); await click('[data-screen="settingsScreen"]');
      await resizeSettings(400, 700);
      const accents = new Set();
      for (const accent of ['violet', 'blue', 'mint', 'rose', 'amber']) {
        await select('#appearanceAccentSelect', accent); await saved();
        const layout = await evaluate(() => {
          const panel = document.getElementById('settingsPanelUser');
          return { width: panel.scrollWidth, client: panel.clientWidth, right: panel.getBoundingClientRect().right, viewport: innerWidth, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), contrast: document.documentElement.dataset.contrast, glow: document.documentElement.dataset.glow };
        });
        assert.ok(layout.width <= layout.client + 1 && layout.right <= layout.viewport + 1, JSON.stringify(layout));
        assert.equal(layout.contrast, 'strong'); assert.equal(layout.glow, 'off'); accents.add(layout.accent);
      }
      assert.equal(accents.size, 5, 'Every accent choice must change the rendered accent color');
      await screenshot('appearance-strong-minimum-width');
      await resizeSettings(1100, 800);
      const originalMode = await evaluate(() => statusLightMode);
      await evaluate(() => { statusLightMode = 'off'; window.electronAPI.setStatusLightMode('off'); });
      for (const state of ['listening', 'thinking', 'speaking']) {
        await evaluate(state => setState(state), state);
        await select('#appearanceGlowSelect', 'standard'); await saved();
        const active = await presentation();
        for (const glow of ['subtle', 'off']) {
          await select('#appearanceGlowSelect', glow); await saved();
          const changed = await presentation();
          assert.equal(changed.state, state); assert.equal(changed.orbBackground, active.orbBackground); assert.equal(changed.orbAnimation, active.orbAnimation); assert.deepEqual(changed.semanticColors, active.semanticColors);
          if (glow === 'off') assert.ok(changed.haloDisplay === 'none' || changed.haloOpacity === 0);
        }
      }
      await evaluate(async originalMode => { setState(State.IDLE); statusLightMode = originalMode; await saveAppSettings(); }, originalMode);
      await saved();
    });
    await check('New accents and stronger contrast keep small News and Notes labels readable', async () => {
      const original = await evaluate(() => ({ accent: document.getElementById('appearanceAccentSelect').value, contrast: document.getElementById('appearanceContrastSelect').value, features: [...document.querySelectorAll('[data-feature]')].map(node => [node.id, node.checked]) }));
      await evaluate(async () => {
        document.getElementById('featureNotepadToggle').checked = true;
        document.getElementById('featureNewsToggle').checked = true;
        await saveAppSettings();
        addNotepadAiMessage('Contrast fixture question', 'user');
        addNotepadAiMessage('Contrast fixture reply', 'ai');
        newsBundleData = { generatedAt: new Date().toISOString(), articles: [{ title: 'Fixture headline', link: 'https://example.com/story', source: 'Fixture publisher', sourceUrl: 'https://example.com/', pubDate: new Date().toISOString(), topics: ['technology'], description: 'This fixture never requests live news.' }] };
        renderNewsBrief(normalizeNewsArticleData(newsBundleData, 'Fixture area'));
        newsLastLocationKey = JSON.stringify([getSavedLocationKey(), getSelectedNewsTopics(), newsPreferences.limit]);
      });
      await saved();
      report.smallTextContrast = [];
      const contrast = selectors => evaluate(selectors => {
        const color = value => {
          const numbers = value.match(/[\d.]+/g)?.map(Number);
          if (!/^rgba?\(/.test(value) || !numbers || numbers.length < 3) throw new Error('Unexpected computed color: ' + value);
          return [...numbers.slice(0, 3), numbers[3] ?? 1];
        };
        const over = (foreground, background) => foreground.slice(0, 3).map((value, index) => value * foreground[3] + background[index] * (1 - foreground[3]));
        const luminance = rgb => rgb.map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        return selectors.map(selector => {
          const node = document.querySelector(selector);
          if (!node || !node.getClientRects().length) throw new Error('Missing visible contrast fixture: ' + selector);
          const ancestry = []; for (let item = node; item; item = item.parentElement) ancestry.unshift(item);
          let backgrounds = [[0, 0, 0]];
          for (const item of ancestry) {
            const style = getComputedStyle(item);
            backgrounds = backgrounds.map(background => over(color(style.backgroundColor), background));
            if (style.backgroundImage !== 'none') {
              const stops = [...style.backgroundImage.matchAll(/rgba?\([^)]*\)/g)].map(match => color(match[0]));
              if (!style.backgroundImage.startsWith('linear-gradient(') || stops.length !== 2) throw new Error('Unhandled background in contrast fixture: ' + style.backgroundImage);
              const samples = Array.from({ length: 21 }, (_, index) => stops[0].map((value, channel) => value + (stops[1][channel] - value) * index / 20));
              backgrounds = backgrounds.flatMap(background => samples.map(stop => over(stop, background)));
            }
          }
          const foreground = color(getComputedStyle(node).color);
          const ratios = backgrounds.map(background => { const a = luminance(over(foreground, background)), b = luminance(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); });
          return { selector, color: getComputedStyle(node).color, minimum: Math.min(...ratios) };
        });
      }, selectors);
      for (const appearanceContrast of ['standard', 'strong']) {
        for (const accent of ['violet', 'blue', 'mint', 'rose', 'amber']) {
          // The original Violet + Standard appearance remains deliberately unchanged.
          if (accent === 'violet' && appearanceContrast === 'standard') continue;
          await select('#appearanceAccentSelect', accent); await select('#appearanceContrastSelect', appearanceContrast); await saved();
          await click('[data-screen="notepadScreen"]');
          if (await evaluate(() => document.getElementById('notepadAiSidebar').classList.contains('hidden'))) await click('#notepadAiToggleBtn');
          const noteRatios = await contrast(['#notepadAiChat .user-message .notepad-ai-label', '#notepadAiChat .ai-message .notepad-ai-label']);
          await click('[data-screen="newsScreen"]');
          const newsRatios = await contrast(['.news-publisher-link', '.news-story-meta', '.news-story-excerpt']);
          for (const sample of [...noteRatios, ...newsRatios]) assert.ok(sample.minimum >= 4.5, JSON.stringify({ accent, appearanceContrast, ...sample }));
          report.smallTextContrast.push({ accent, contrast: appearanceContrast, samples: [...noteRatios, ...newsRatios] });
          await click('[data-screen="settingsScreen"]');
        }
      }
      await select('#appearanceAccentSelect', original.accent); await select('#appearanceContrastSelect', original.contrast);
      await evaluate(async original => { for (const [id, checked] of original.features) document.getElementById(id).checked = checked; await saveAppSettings(); }, original);
      await saved();
    });
    await check('Reduced motion is explicit, persists independently from the operating-system setting, and leaves assistant state unchanged', async () => {
      const overlay = BrowserWindow.getAllWindows().find(win => /[\\/]status-indicator\.html$/.test(win.webContents.getURL()));
      assert.ok(overlay, 'Production status-light renderer must exist');
      await waitFor(() => !overlay.webContents.isLoading(), 'Status-light renderer did not finish loading');
      const overlayReduced = () => overlay.webContents.executeJavaScript("document.body.classList.contains('reduced-motion')");
      main.webContents.debugger.attach('1.3');
      await main.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      const state = await evaluate(() => currentState);
      await select('#appearanceMotionSelect', 'reduced'); await saved();
      assert.equal(await evaluate(() => window.OlangaAppearance.isReducedMotion()), true);
      await waitFor(overlayReduced, 'Explicit reduced motion did not reach the separate status-light renderer');
      assert.equal(await evaluate(() => currentState), state);
      await select('#appearanceMotionSelect', 'system'); await saved();
      assert.equal(await evaluate(() => window.OlangaAppearance.isReducedMotion()), false);
      await waitFor(async () => !(await overlayReduced()), 'Following Windows did not clear reduced motion in the status-light renderer');
      await main.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await waitFor(() => evaluate(() => window.OlangaAppearance.isReducedMotion()), 'OS reduced-motion preference was not honored');
      await waitFor(overlayReduced, 'Windows reduced motion did not reach the separate status-light renderer');
      await select('#appearanceMotionSelect', 'reduced'); await saved();
      main.webContents.debugger.detach();
    });

    await check('Response preferences persist and no manual conversation reset is exposed', async () => {
      await click('#settingsTabUser');
      await select('#responseStyleSelect', 'concise');
      await evaluate(() => { const field = document.getElementById('preferredAddressInput'); field.value = 'Aarav'; field.dispatchEvent(new Event('input', { bubbles: true })); });
      await saved();
      assert.deepEqual(await evaluate(() => window.OlangaResponsePreferences.snapshot()), { responseStyle: 'concise', preferredAddress: 'Aarav' });
      assert.equal(report.preferenceWrites.at(-1).preferredAddress, 'Aarav');
      assert.equal(await evaluate(() => [...document.querySelectorAll('button')].some(node => /new conversation/i.test(node.textContent))), false);
    });
    await check('Core connection testing is explicit, deduplicated and ignores a result from an old key', async () => {
      await click('#settingsTabCore');
      assert.equal(await evaluate(() => document.getElementById('coreConnectionTestBtn').disabled), true);
      assert.equal(report.fixtureConnectionRequests || 0, 0);
      await evaluate(() => { apiKey = 'fixture-key-a'; apiKeys = [apiKey]; currentKeyIndex = 0; refreshCoreConnectionStatus(); });
      assert.match(await evaluate(() => document.getElementById('coreConnectionStatus').textContent), /not been tested/i);
      fixtureConnection = true;
      await click('#coreConnectionTestBtn');
      await waitFor(() => !!pendingConnection, 'Explicit test did not reach the mocked provider bridge');
      assert.equal(await evaluate(() => document.getElementById('coreConnectionTestBtn').disabled), true);
      await evaluate(() => { void testCoreConnection(); apiKey = 'fixture-key-b'; apiKeys = [apiKey]; refreshCoreConnectionStatus(); });
      assert.equal(report.fixtureConnectionRequests, 1);
      pendingConnection({ ok: true, text: 'OK', keyIndex: 0 }); pendingConnection = null;
      await waitFor(() => evaluate(() => !document.getElementById('coreConnectionTestBtn').disabled), 'Test did not finish');
      assert.match(await evaluate(() => document.getElementById('coreConnectionStatus').textContent), /not been tested/i);
      await click('#coreConnectionTestBtn');
      await waitFor(() => !!pendingConnection, 'Second explicit test did not reach the mock');
      pendingConnection({ ok: true, text: 'OK', keyIndex: 0 }); pendingConnection = null;
      await waitFor(() => evaluate(() => document.getElementById('coreConnectionStatus').dataset.state === 'success'), 'Successful connection was not displayed');
      await evaluate(() => { apiKeys = ['fixture-key-a', 'fixture-key-b']; apiKey = apiKeys[0]; currentKeyIndex = 0; renderKeyList(); });
      await click('#coreConnectionTestBtn');
      await waitFor(() => !!pendingConnection, 'Rotation test did not reach the mock');
      pendingConnection({ ok: true, text: 'OK', keyIndex: 1 }); pendingConnection = null;
      await waitFor(() => evaluate(() => document.getElementById('coreConnectionStatus').dataset.state === 'success'), 'Rotated key was not reported ready');
      assert.equal(await evaluate(() => document.querySelector('.key-item.active .select')?.dataset.keyIndex), '1', 'The visible active key must match the key that passed the test');
      fixtureConnection = false;
      await evaluate(() => { apiKey = ''; apiKeys = []; currentKeyIndex = 0; renderKeyList(); });
    });

    await check('Failed saves stay visible and an explicit retry stores the current preference', async () => {
      await click('#settingsTabUser');
      failNextPrefs = true;
      await select('#appearanceAccentSelect', 'mint');
      await waitFor(() => evaluate(() => document.getElementById('preferencesSaveStatus').dataset.state === 'error'), 'Save failure was not displayed');
      assert.equal(await evaluate(() => document.getElementById('preferencesRetryBtn').hidden), false);
      await screenshot('save-retry');
      await click('#preferencesRetryBtn'); await saved();
      assert.equal(report.preferenceWrites.at(-1).appearanceAccent, 'mint');
    });
    await check('A delayed preference write cannot replace a newer choice', async () => {
      holdNextPrefs = true;
      await select('#appearanceAccentSelect', 'blue');
      await waitFor(() => !!pendingPrefs, 'Controlled delayed save was not reached');
      await select('#appearanceAccentSelect', 'violet'); await pause(230);
      pendingPrefs(); pendingPrefs = null; await saved();
      await waitFor(() => report.preferenceWrites.at(-1)?.appearanceAccent === 'violet', 'Latest preference did not win the delayed write');
      assert.equal(await evaluate(() => localStorage.getItem('olanga_appearance_accent')), 'violet');
      assert.equal(await evaluate(() => document.documentElement.dataset.accent), 'violet');
    });
    await check('A completed older save cannot roll back runtime shortcuts and light mode when the latest save fails', async () => {
      const original = await evaluate(() => ({ mode: statusLightMode, actions: structuredClone(quickActions) }));
      holdNextPrefs = true;
      await evaluate(() => {
        statusLightMode = 'active';
        quickActions = quickActions.map((slot, index) => index === 0 ? { ...slot, label: 'Older fixture' } : slot);
        void saveAppSettings();
      });
      await waitFor(() => !!pendingPrefs, 'Earlier preference save did not reach the controlled delay');
      failNextPrefs = true;
      await evaluate(() => {
        statusLightMode = 'off';
        quickActions = quickActions.map((slot, index) => index === 0 ? { ...slot, label: 'Newer fixture' } : slot);
        void saveAppSettings();
      });
      pendingPrefs(); pendingPrefs = null;
      await waitFor(() => evaluate(() => document.getElementById('preferencesSaveStatus').dataset.state === 'error'), 'Latest fixture save did not fail as expected');
      assert.deepEqual(await evaluate(() => ({ mode: statusLightMode, label: quickActions[0].label })), { mode: 'off', label: 'Newer fixture' }, 'Old storage mirroring must not roll back the newest runtime choice');
      assert.equal(report.preferenceWrites.at(-1).quickActions[0].label, 'Older fixture', 'Only the earlier save should be durable before Retry');
      await click('#preferencesRetryBtn'); await saved();
      assert.equal(report.preferenceWrites.at(-1).statusLightMode, 'off');
      assert.equal(report.preferenceWrites.at(-1).quickActions[0].label, 'Newer fixture');
      await evaluate(async original => { statusLightMode = original.mode; quickActions = original.actions; await saveAppSettings(); }, original);
      await saved();
    });
    await check('Settings fills the window and every tab stays readable across narrow, wide and short layouts', async () => {
      await waitFor(() => evaluate(() => !document.querySelector('.error-toast')), 'Dismissed fixture error toast still visible');
      const appearance = await evaluate(() => window.OlangaAppearance.snapshot());
      for (const [id, value] of [['appearanceAccentSelect', 'violet'], ['appearanceContrastSelect', 'standard'], ['appearanceGlowSelect', 'standard'], ['appearanceMotionSelect', 'system']]) await select('#' + id, value);
      await saved();
      report.settingsLayouts = [];
      // Cross the short-window breakpoint in both directions, including rapid
      // superseded native resizes, before taking the full layout baselines.
      report.resizeTransitions = [];
      for (const height of [652, 648, 652, 560]) {
        main.setContentSize(1280, height === 652 ? 560 : 900);
        await resizeSettings(1280, height);
        const state = await evaluate(() => {
          const header = document.querySelector('.settings-screen-header'), scroll = document.querySelector('.settings-scroll');
          const before = header.getBoundingClientRect().top; scroll.scrollTop = scroll.scrollHeight;
          return { height: innerHeight, before, after: header.getBoundingClientRect().top };
        });
        assert.equal(state.before, height <= 650 ? 40 : 48, 'Header must use the requested responsive layout');
        assert.equal(state.after, state.before, 'Tab navigation must remain fixed after a rapid resize and scroll');
        report.resizeTransitions.push(state);
      }
      for (const [width, height] of [[400, 700], [768, 800], [1280, 900], [1536, 960], [2048, 1100], [1280, 560]]) {
        await resizeSettings(width, height);
        for (const tab of ['User', 'Core', 'Privacy']) {
          await click('#settingsTab' + tab);
          await evaluate(() => { document.querySelector('.settings-scroll').scrollTop = 0; });
          const fit = await evaluate(tab => {
            const panel = document.getElementById('settingsPanel' + tab), scroll = document.querySelector('.settings-scroll'), header = document.querySelector('.settings-screen-header'), container = document.querySelector('.settings-container');
            const rect = node => { const box = node.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }; };
            const cards = [...panel.querySelectorAll(':scope > .settings-section')].map(rect);
            const overflow = [...panel.querySelectorAll('button, input, select, textarea, summary')].filter(node => node.getClientRects().length && node.getBoundingClientRect().width > 1).filter(node => { const box = node.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1; }).map(node => node.id || node.tagName);
            return { panelWidth: panel.scrollWidth, panelClient: panel.clientWidth, scrollWidth: scroll.scrollWidth, scrollClient: scroll.clientWidth, panel: rect(panel), header: rect(header), scroll: rect(scroll), container: rect(container), cards, columns: getComputedStyle(panel).gridTemplateColumns.split(' ').length, overflow, scrollable: scroll.scrollHeight > scroll.clientHeight };
          }, tab);
          assert.ok(fit.panelWidth <= fit.panelClient + 1 && fit.scrollWidth <= fit.scrollClient + 1 && fit.panel.right <= width + 1 && fit.header.right <= width + 1, JSON.stringify({ width, height, tab, ...fit }));
          assert.deepEqual(fit.overflow, [], 'Every Settings field must fit at ' + width + 'px: ' + tab);
          assert.ok(Math.abs(fit.container.width - width) <= 1 && Math.abs(fit.container.height - height) <= 1, 'Settings must fill its viewport');
          assert.ok(fit.panel.width >= fit.scrollClient - 24, 'Settings must use available content width, without the old narrow cap');
          assert.ok(fit.scroll.bottom >= height - 30 && fit.scroll.height >= 200 && fit.scroll.top >= fit.header.bottom - 1, 'Settings needs a usable full-height scroller below its fixed header');
          const expectedColumns = tab === 'Privacy' || width < 1100 ? 1 : tab === 'User' && width >= 1800 ? 3 : 2;
          assert.equal(fit.columns, expectedColumns, 'Unexpected card columns at ' + width + 'px: ' + tab);
          if (expectedColumns > 1) assert.ok(Math.abs(fit.cards[0].top - fit.cards[1].top) <= 1 && fit.cards[1].left > fit.cards[0].right, 'Wide cards should share the first row');
          if (tab === 'Privacy') assert.equal(fit.scrollable, true);
          report.settingsLayouts.push({ width, height, tab, ...fit });
          await screenshot('layout-' + width + 'x' + height + '-' + tab.toLowerCase());
          const focus = await evaluate(tab => {
            const panel = document.getElementById('settingsPanel' + tab), scroll = document.querySelector('.settings-scroll'), header = document.querySelector('.settings-screen-header');
            const controls = [...panel.querySelectorAll('button, input, select, textarea, summary, a[href]')].filter(node => !node.disabled && node.getClientRects().length && node.getBoundingClientRect().width > 1);
            const last = controls.at(-1); last.focus();
            const target = last.getBoundingClientRect(), box = scroll.getBoundingClientRect();
            return { focused: document.activeElement === last, visible: target.top >= box.top - 1 && target.bottom <= box.bottom + 1, headerTop: header.getBoundingClientRect().top };
          }, tab);
          assert.ok(focus.focused && focus.visible, 'Keyboard focus must reveal the final control in ' + tab + ' at ' + width + 'x' + height);
          assert.equal(focus.headerTop, fit.header.top, 'Tab navigation must remain fixed while content scrolls');
        }
      }
      main.setContentSize(1100, 800); await click('#settingsTabUser');
      for (const [key, value] of Object.entries(appearance)) await select('#' + key + 'Select', value);
      await saved();
    });
    await check('Short Settings windows keep save errors, retry and focused controls reachable', async () => {
      await resizeSettings(768, 560);
      await click('#settingsTabUser');
      const originalGlow = await evaluate(() => document.getElementById('appearanceGlowSelect').value);
      failNextPrefs = true;
      await select('#appearanceGlowSelect', originalGlow === 'subtle' ? 'off' : 'subtle');
      await waitFor(() => evaluate(() => document.getElementById('preferencesSaveStatus').dataset.state === 'error'), 'Short-window save error did not appear');
      const retry = await evaluate(() => {
        const button = document.getElementById('preferencesRetryBtn'), scroll = document.querySelector('.settings-scroll');
        button.focus();
        const box = button.getBoundingClientRect(), content = scroll.getBoundingClientRect();
        return { focused: document.activeElement === button, visible: box.top >= 0 && box.bottom <= content.top && box.right <= innerWidth, scrollHeight: content.height };
      });
      assert.ok(retry.focused && retry.visible && retry.scrollHeight >= 200, 'Save retry must stay reachable without consuming the content area');
      await screenshot('layout-short-save-error');
      await click('#preferencesRetryBtn'); await saved();
      await select('#appearanceGlowSelect', originalGlow); await saved();
      main.setContentSize(1100, 800);
    });    await check('Appearance persists after a renderer restart without changing existing voice defaults', async () => {
      await click('#settingsTabUser'); await select('#appearanceAccentSelect', 'blue'); await saved();
      main.webContents.reload();
      await waitFor(() => !main.webContents.isLoading(), 'Renderer reload did not finish');
      await waitFor(() => evaluate(() => !!window.OlangaSettingsNavigation && typeof window.loadSettingsValues === 'function'), 'Settings did not reinitialize');
      await click('[data-screen="settingsScreen"]'); await click('#settingsTabUser');
      const prefs = await evaluate(() => ({ accent: document.documentElement.dataset.accent, selected: document.getElementById('appearanceAccentSelect').value, motion: document.getElementById('appearanceMotionSelect').value, contrast: document.getElementById('appearanceContrastSelect').value, glow: document.getElementById('appearanceGlowSelect').value, ttsEngine: document.getElementById('ttsEngineSelect').value, endOfSpeech: document.getElementById('endOfSpeechSelect').value, features: [...document.querySelectorAll('[data-feature]')].filter(node => node.checked).map(node => node.dataset.feature) }));
      assert.deepEqual(await evaluate(() => window.OlangaResponsePreferences.snapshot()), { responseStyle: 'concise', preferredAddress: 'Aarav' });
      assert.deepEqual(prefs, { accent: 'blue', selected: 'blue', motion: 'reduced', contrast: 'strong', glow: 'off', ttsEngine: 'windows', endOfSpeech: 'standard', features: [] });
    });
    await check('Secure preferences restore appearance when only the local appearance mirror is missing', async () => {
      await evaluate(() => {
        localStorage.removeItem('olanga_appearance_accent');
        localStorage.removeItem('olanga_appearance_motion');
        localStorage.removeItem('olanga_appearance_contrast');
        localStorage.removeItem('olanga_appearance_glow');
      });
      main.webContents.reload();
      await waitFor(() => !main.webContents.isLoading(), 'Renderer recovery reload did not finish');
      await waitFor(() => evaluate(() => !!window.OlangaSettingsNavigation && typeof window.loadSettingsValues === 'function'), 'Settings did not initialize from secure preferences');
      await click('[data-screen="settingsScreen"]'); await click('#settingsTabUser');
      const restored = await evaluate(() => ({
        accent: document.documentElement.dataset.accent,
        motion: document.documentElement.dataset.motion,
        contrast: document.documentElement.dataset.contrast,
        glow: document.documentElement.dataset.glow,
        accentControl: document.getElementById('appearanceAccentSelect').value,
        motionControl: document.getElementById('appearanceMotionSelect').value,
        contrastControl: document.getElementById('appearanceContrastSelect').value,
        glowControl: document.getElementById('appearanceGlowSelect').value,
        localAccent: localStorage.getItem('olanga_appearance_accent'),
        localMotion: localStorage.getItem('olanga_appearance_motion'),
        localContrast: localStorage.getItem('olanga_appearance_contrast'),
        localGlow: localStorage.getItem('olanga_appearance_glow'),
        reduced: window.OlangaAppearance.isReducedMotion()
      }));
      assert.deepEqual(restored, { accent: 'blue', motion: 'reduced', contrast: 'strong', glow: 'off', accentControl: 'blue', motionControl: 'reduced', contrastControl: 'strong', glowControl: 'off', localAccent: 'blue', localMotion: 'reduced', localContrast: 'strong', localGlow: 'off', reduced: true });
    });
    await check('Restore appearance resets only visual preferences and preserves personal and voice settings', async () => {
      await evaluate(async () => {
        document.getElementById('cityInput').value = 'Fixture city';
        document.getElementById('ttsRateInput').value = '0.9';
        document.getElementById('featureNotepadToggle').checked = true;
        await saveAppSettings();
      });
      await saved();
      await click('#appearanceResetBtn'); await saved();
      const restored = await evaluate(() => ({
        accent: document.documentElement.dataset.accent, motion: document.documentElement.dataset.motion,
        contrast: document.documentElement.dataset.contrast, glow: document.documentElement.dataset.glow,
        controls: ['appearanceAccentSelect', 'appearanceMotionSelect', 'appearanceContrastSelect', 'appearanceGlowSelect'].map(id => document.getElementById(id).value),
        city: document.getElementById('cityInput').value, rate: document.getElementById('ttsRateInput').value,
        notepad: document.getElementById('featureNotepadToggle').checked,
        storedCity: localStorage.getItem('olanga_city'), storedRate: localStorage.getItem('olanga_tts_rate')
      }));
      assert.deepEqual(restored, { accent: 'violet', motion: 'system', contrast: 'standard', glow: 'standard', controls: ['violet', 'system', 'standard', 'standard'], city: 'Fixture city', rate: '0.9', notepad: true, storedCity: 'Fixture city', storedRate: '0.9' });
      assert.deepEqual(await evaluate(() => window.OlangaResponsePreferences.snapshot()), { responseStyle: 'concise', preferredAddress: 'Aarav' });
      const durable = report.preferenceWrites.at(-1);
      assert.equal(durable.city, 'Fixture city'); assert.equal(durable.ttsRate, 0.9); assert.deepEqual(durable.features, ['notepadScreen']);
      await screenshot('appearance-reset');
    });
    await check('No provider, microphone, updater or native application action was triggered', async () => {
      report.errors.push(...await evaluate(() => window.settingsSmokeErrors || []));
      assert.deepEqual(report.forbiddenCalls, []); assert.deepEqual(report.errors, []);
    });
    report.passed = true; finish(0);
  } catch (error) { report.error = error.stack; finish(1); }
});
