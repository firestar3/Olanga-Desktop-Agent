// Real renderer for the guided Audio setup view, with every audio operation
// replaced by a fixture. No microphone, provider, speech or native action runs.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, '../build/qa');
fs.mkdirSync(output, { recursive: true });
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(output, 'audio-setup-profile-')));
const report = { passed: false, checks: [], errors: [], coverage: { realRenderer: true, mockedAudioOnly: true, liveMicrophone: false, providers: false } };
let main;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(fn, ...args) { return main.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true); }
async function waitFor(fn) { for (let i = 0; i < 100; i++) { if (await evaluate(fn)) return; await pause(20); } throw new Error('Audio setup fixture did not settle.'); }
async function check(name, action) { await action(); report.checks.push({ name, passed: true }); }
const deadline = setTimeout(() => { report.error = 'Audio setup fixture timed out.'; finish(1); }, 30000); deadline.unref();
let finished = false;
function finish(code) {
  if (finished) return; finished = true; clearTimeout(deadline);
  fs.writeFileSync(path.join(output, 'audio-setup-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); app.exit(code);
}
app.whenReady().then(async () => {
  try {
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    main = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    main.webContents.on('console-message', (_event, _level, message) => { if (/Uncaught|Error:/.test(message)) report.errors.push(message); });
    await main.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><html><body><section id="settingsScreen" class="hidden"><div id="settingsPanelCore" hidden><section><h3 id="speechSettingsHeading">Speech</h3></section></div></section><select id="ttsEngineSelect"><option value="windows">Windows</option></select></body></html>'));
    await evaluate(() => {
      window.fixture = { documentHidden: false, visible: true, listeners: [], intervals: new Set(), snapshots: 0, devices: 0, chooses: [], phrases: 0, replies: 0, failDevices: false, failChoose: false,
        state: { preferredDeviceId: 'mic-one', label: 'Desk mic', active: true, muted: false, level: 25, modelReady: true } };
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => fixture.documentHidden });
      const interval = window.setInterval, clear = window.clearInterval;
      window.setInterval = (...args) => { const id = interval(...args); fixture.intervals.add(id); return id; };
      window.clearInterval = id => { fixture.intervals.delete(id); return clear(id); };
      window.OlangaVisibility = { isVisible: () => fixture.visible, subscribe: callback => { fixture.listeners.push(callback); callback(fixture.visible); return () => { fixture.listeners = fixture.listeners.filter(item => item !== callback); }; } };
      window.OlangaSettingsNavigation = { open: tab => { fixture.openedTab = tab; document.getElementById('settingsScreen').classList.remove('hidden'); document.getElementById('settingsPanelCore').hidden = false; } };
      window.ttsEngine = 'windows';
      window.OlangaAudioInput = {
        snapshot: () => { fixture.snapshots++; return { ...fixture.state }; },
        devices: async () => { fixture.devices++; if (fixture.failDevices) throw new Error('Fixture: device enumeration unavailable'); return [{ deviceId: 'default', label: 'Default' }, { deviceId: 'mic-one', label: 'Desk mic' }, { deviceId: 'mic-two', label: '<img src=x onerror=alert(1)>' }]; },
        choose: async id => { fixture.chooses.push(id); if (fixture.failChoose) throw new Error('Fixture: microphone disconnected'); fixture.state.preferredDeviceId = id; fixture.state.label = id === 'mic-two' ? 'Headset' : id ? 'Desk mic' : 'Windows default'; return { ...fixture.state }; },
        testPhrase: () => { fixture.phrases++; return new Promise((resolve, reject) => { fixture.resolvePhrase = resolve; fixture.rejectPhrase = reject; }); },
        testReply: () => { fixture.replies++; return new Promise((resolve, reject) => { fixture.resolveReply = resolve; fixture.rejectReply = reject; }); }
      };
    });
    await main.webContents.executeJavaScript(fs.readFileSync(path.resolve(__dirname, '../js/audio-setup.js'), 'utf8'), true);
    await check('Mounting and reading settings never activate audio or create hidden polling', async () => {
      const state = await evaluate(() => ({ exists: !!document.getElementById('audioSetupSection'), intervals: fixture.intervals.size, phrases: fixture.phrases, replies: fixture.replies, devices: fixture.devices, value: document.getElementById('audioSetupDevice').value }));
      assert.deepEqual(state, { exists: true, intervals: 0, phrases: 0, replies: 0, devices: 0, value: 'mic-one' });
    });
    await check('Opening goes to Core, reads devices safely and runs one visible level meter', async () => {
      await evaluate(() => window.OlangaAudioSetup.open());
      await waitFor(() => fixture.devices === 1 && document.getElementById('audioSetupDevice').options.length === 3);
      const state = await evaluate(() => ({ tab: fixture.openedTab, intervals: fixture.intervals.size, level: document.getElementById('audioSetupLevel').value, options: [...document.getElementById('audioSetupDevice').options].map(item => item.textContent), images: document.querySelectorAll('img').length }));
      assert.equal(state.tab, 'core'); assert.equal(state.intervals, 1); assert.equal(state.level, 25); assert.equal(state.images, 0); assert.ok(state.options.includes('<img src=x onerror=alert(1)>'));
    });
    await check('A user selection changes only the chosen microphone and errors restore the actual selection', async () => {
      await evaluate(() => { const select = document.getElementById('audioSetupDevice'); select.value = 'mic-two'; select.dispatchEvent(new Event('change')); });
      await waitFor(() => !document.getElementById('audioSetupDevice').disabled);
      assert.deepEqual(await evaluate(() => fixture.chooses), ['mic-two']);
      await evaluate(() => { fixture.failChoose = true; const select = document.getElementById('audioSetupDevice'); select.value = ''; select.dispatchEvent(new Event('change')); });
      await waitFor(() => !document.getElementById('audioSetupDevice').disabled);
      assert.equal(await evaluate(() => document.getElementById('audioSetupDevice').value), 'mic-two');
      assert.match(await evaluate(() => document.getElementById('audioSetupStatus').textContent), /disconnected/);
      await evaluate(() => { fixture.failChoose = false; });
    });
    await check('Phrase checks are explicit, non-overlapping and retain truthful device-bound results', async () => {
      await evaluate(() => { document.getElementById('audioSetupPhrase').click(); document.getElementById('audioSetupPhrase').click(); document.getElementById('audioSetupReply').click(); });
      assert.deepEqual(await evaluate(() => [fixture.phrases, fixture.replies]), [1, 0]);
      await evaluate(() => fixture.resolvePhrase({ heard: 'olanga audio check', verified: true, checkedAt: Date.now() }));
      await waitFor(() => !document.getElementById('audioSetupPhrase').disabled);
      const result = await evaluate(() => window.OlangaAudioSetup.snapshot());
      assert.equal(result.phrase.verified, true); assert.equal(result.phrase.deviceId, 'mic-two'); assert.equal(result.phrase.currentDevice, true);
      await evaluate(() => { fixture.state.label = 'A different physical mic'; });
      assert.equal((await evaluate(() => window.OlangaAudioSetup.snapshot())).phrase.currentDevice, false);
      await evaluate(() => { fixture.state.label = 'Headset'; });
    });
    await check('Changing devices during a check cannot credit the new device', async () => {
      await evaluate(() => { document.getElementById('audioSetupPhrase').click(); fixture.state.preferredDeviceId = 'mic-one'; fixture.state.label = 'Desk mic'; fixture.resolvePhrase({ heard: 'olanga audio check', verified: true, checkedAt: Date.now() }); });
      await waitFor(() => !document.getElementById('audioSetupPhrase').disabled);
      const result = await evaluate(() => window.OlangaAudioSetup.snapshot()); assert.equal(result.phrase.verified, false); assert.equal(result.phrase.currentDevice, false);
      assert.match(await evaluate(() => document.getElementById('audioSetupStatus').textContent), /changed during/);
    });
    await check('Reply completion never claims acoustic proof and changing engines invalidates that evidence', async () => {
      await evaluate(() => { document.getElementById('audioSetupReply').click(); fixture.resolveReply({ status: 'completed' }); });
      await waitFor(() => !document.getElementById('audioSetupReply').disabled);
      assert.match(await evaluate(() => document.getElementById('audioSetupStatus').textContent), /cannot determine whether you heard/);
      assert.equal((await evaluate(() => window.OlangaAudioSetup.snapshot())).reply.status, 'completed');
      await evaluate(() => { window.ttsEngine = 'magpie'; });
      assert.equal((await evaluate(() => window.OlangaAudioSetup.snapshot())).reply.currentEngine, false);
    });
    await check('Phrase failures and muted/off input stay actionable without opening capture', async () => {
      await evaluate(() => { document.getElementById('audioSetupPhrase').click(); fixture.rejectPhrase(new Error('Fixture: recognizer busy')); });
      await waitFor(() => !document.getElementById('audioSetupPhrase').disabled);
      assert.equal((await evaluate(() => window.OlangaAudioSetup.snapshot())).phrase.verified, false);
      assert.match(await evaluate(() => document.getElementById('audioSetupStatus').textContent), /recognizer busy/);
      await evaluate(() => { fixture.state.muted = true; }); await pause(300);
      assert.equal(await evaluate(() => document.getElementById('audioSetupPhrase').disabled), true);
      const before = await evaluate(() => fixture.phrases); await evaluate(() => document.getElementById('audioSetupPhrase').click());
      assert.equal(await evaluate(() => fixture.phrases), before);
      await evaluate(() => { fixture.state.muted = false; fixture.state.active = false; }); await pause(300);
      assert.equal(await evaluate(() => document.getElementById('audioSetupLevel').value), 0);
    });
    await check('Closing the Core tab, hiding Settings and hiding the native window stop meter polling', async () => {
      await evaluate(() => { document.getElementById('settingsPanelCore').hidden = true; }); await pause(50);
      assert.equal(await evaluate(() => fixture.intervals.size), 0);
      await evaluate(() => { document.getElementById('settingsPanelCore').hidden = false; }); await pause(50);
      assert.equal(await evaluate(() => fixture.intervals.size), 1);
      await evaluate(() => { document.getElementById('settingsScreen').classList.add('hidden'); }); await pause(50);
      assert.equal(await evaluate(() => fixture.intervals.size), 0);
      await evaluate(() => { document.getElementById('settingsScreen').classList.remove('hidden'); fixture.visible = false; fixture.listeners.forEach(callback => callback(false)); }); await pause(50);
      assert.equal(await evaluate(() => fixture.intervals.size), 0);
      const before = await evaluate(() => fixture.snapshots); await pause(600);
      assert.equal(await evaluate(() => fixture.snapshots), before);
    });
    assert.deepEqual(report.errors, []); report.passed = true; finish(0);
  } catch (error) { report.error = error.stack || error.message; finish(1); }
});
