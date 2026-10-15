// Real production renderer, disposable profile, fixture-only personal data.
const { app, BrowserWindow, ipcMain, session, net } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../build/qa/personal-backup'); fs.mkdirSync(output, { recursive: true });
app.disableHardwareAcceleration(); app.setPath('userData', fs.mkdtempSync(path.join(output, 'profile-')));
if (!process.argv.includes('--hidden')) process.argv.push('--hidden');
const report = { passed: false, runtime: process.versions.electron, checks: [], forbidden: [], errors: [], downloads: [], screenshots: [] };
const forbidden = new Set(['provider-generate','provider-generate-stream','nvidia-tts-config','nvidia-tts-synthesize','open-app','close-app','arrange-app','play-spotify','media-control','desktop-capture','desktop-run','desktop-undo','fetch-news-bundle','check-release','update-download','update-install','set-open-at-login','notify']);
const handle = ipcMain.handle.bind(ipcMain); ipcMain.handle = (channel, callback) => handle(channel, (event, ...args) => { if (forbidden.has(channel)) { report.forbidden.push(channel); throw Error('Fixture blocked ' + channel); } return callback(event, ...args); });
const send = ipcMain.on.bind(ipcMain); ipcMain.on = (channel, callback) => send(channel, (event, ...args) => { if (channel === 'notify') { report.forbidden.push(channel); return; } return callback(event, ...args); });
globalThis.fetch = net.fetch = async () => { report.forbidden.push('network'); throw Error('Fixture network disabled'); };
app.on('web-contents-created', (_event, contents) => { contents.on('preload-error', (_e, _file, error) => report.errors.push(error.message)); contents.on('render-process-gone', (_e, details) => report.errors.push(details.reason)); });
app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler(() => false); session.defaultSession.setPermissionRequestHandler((_contents, permission, reply) => { report.forbidden.push('permission:' + permission); reply(false); });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (_request, reply) => { report.forbidden.push('renderer-network'); reply({ cancel: true }); });
  session.defaultSession.on('will-download', (_event, item) => {
    if (!['olanga-personal-backup.json','olanga-personal-recovery.json','olanga-notes-recovery.json','olanga-notes-retained-recovery.json'].includes(item.getFilename())) { report.forbidden.push('download:' + item.getFilename()); item.cancel(); return; }
    const target = path.join(output, (report.downloads.length + 1) + '-' + item.getFilename()); item.setSavePath(target); item.once('done', (_e, state) => report.downloads.push({ filename: item.getFilename(), path: target, state }));
  });
});
let main, finished = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = async (fn, ...args) => { const code = '(() => { try { return Promise.resolve((' + fn.toString() + ')(...' + JSON.stringify(args) + ')).then(value => ({value}), error => ({fixtureError:error.stack||error.message})); } catch(error) { return {fixtureError:error.stack||error.message}; } })()'; const result = await main.webContents.executeJavaScript(code, true); if(result?.fixtureError) throw Error(result.fixtureError); return result?.value; };
async function until(fn, label) { for (let i = 0; i < 240; i++) { if (await fn()) return; await pause(25); } throw Error(label); }
async function click(selector) { await evaluate(selector => { const item = document.querySelector(selector); if (!item || !item.getClientRects().length || item.disabled) throw Error('Missing visible control ' + selector); item.scrollIntoView({ block: 'center' }); item.focus(); item.click(); }, selector); await pause(35); }
async function choose(text) { await evaluate(text => { const files = new DataTransfer(); files.items.add(new File([text], 'personal-fixture.json', { type: 'application/json' })); const input = document.getElementById('backupCenterFile'); input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true })); }, text); await until(() => evaluate(() => !document.getElementById('backupCenterPreview').hidden), 'Import preview missing'); }
async function check(name, fn) { await fn(); report.checks.push(name); }
function finish(code) { if (finished) return; finished = true; report.passed = code === 0; fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); app.exit(code); }
setTimeout(() => { report.error = 'Backup renderer fixture exceeded 120 seconds'; finish(1); }, 120000).unref();
process.on('uncaughtException', error => { report.error = error.stack; finish(1); }); process.on('unhandledRejection', error => { report.error = error.stack; finish(1); });
require('../main');
app.whenReady().then(async () => { try {
  await until(() => { main = BrowserWindow.getAllWindows().find(win => /index\.html$/.test(win.webContents.getURL())); return main && !main.webContents.isLoading(); }, 'Renderer missing');
  await until(() => evaluate(() => !!window.OlangaBackupCenter && !!window.OlangaPortablePreferences && !!window.OlangaSchedulesAdapter && window.OlangaAppInitialized === true), 'Backup modules missing');
  await evaluate(() => { isMicMuted = true; isTtsMuted = true; window.fixtureAlerts = []; window.alert = message => fixtureAlerts.push(message); window.confirm = () => true; navigator.mediaDevices.getUserMedia = async () => { throw Error('Fixture microphone disabled'); }; warmProviderConnection = () => {}; window.addEventListener('error', event => { window.fixtureErrors ||= []; fixtureErrors.push(event.message); }); });
  await click('#startLocalBtn');
  await check('Complete export contains the six promised scopes and excludes device and credential state', async () => {
    const result = await evaluate(async () => {
      OlangaNotesController.replace([{ id: 10, name: 'Fixture notes', content: '<b>Original</b> personal note' }]);
      OlangaChecklistAdapter.replace([{ id: 'fixture-task', text: 'Fixture checklist item', completed: false, dueDate: null }]);
      OlangaTimersAdapter.replacePaused([{ label: 'Fixture timer', kind: 'timer', remainingMs: 45000 }]);
      OlangaScheduleStore.add({ kind: 'reminder', title: 'Fixture daily', repeat: 'daily', time: '23:59', online: false });
      OlangaWorkspace.rememberFact('I prefer fixture examples.');
      const pref = OlangaPortablePreferences.snapshot(); await OlangaPortablePreferences.apply({ ...pref, appearanceAccent: 'blue', responseStyle: 'concise' });
      window.fixtureBackup = await OlangaBackupCenter.export(OlangaPersonalBackup.COLLECTIONS); return fixtureBackup;
    });
    assert.deepEqual(Object.keys(result.collections), ['notes','checklist','timers','schedules','preferences','workspace']);
    assert.equal(result.collections.notes[0].content, '<b>Original</b> personal note'); assert.equal(result.collections.preferences.appearanceAccent, 'blue');
    assert.deepEqual(Object.keys(result.collections.preferences).sort(), ['appearanceAccent','appearanceMotion','appearanceContrast','appearanceGlow','responseStyle','preferredAddress','ttsRate','endOfSpeech','bargeIn','streamReplies','features'].sort());
    assert.equal(JSON.stringify(result).includes('gemini_api_keys'), false);
  });
  await check('Export button writes a usable private JSON file inside the fixture directory', async () => {
    await evaluate(() => openOlangaBackups()); await click('#backupCenterExport'); await until(() => report.downloads.some(item => item.filename === 'olanga-personal-backup.json'), 'Export download missing');
    const file = report.downloads.find(item => item.filename === 'olanga-personal-backup.json'); assert.equal(file.state, 'completed'); assert.equal(JSON.parse(fs.readFileSync(file.path, 'utf8')).format, 'olanga-personal-backup');
  });
  let imported;
  await check('Restore requires a collection preview and leaves unchecked data untouched', async () => {
    imported = await evaluate(() => { const backup = structuredClone(fixtureBackup); backup.collections.notes = [{ id: 20, name: 'Imported', content: '<img src="https://example.org/pixel" onerror="bad()"><b>Safe imported note</b><script>bad()</script>' }]; backup.collections.checklist = []; backup.collections.timers = [{ label: 'Imported due alarm', kind: 'alarm', remainingMs: 0 }]; backup.collections.schedules = [{ kind: 'reminder', title: 'Imported past schedule', repeat: 'once', onceAt: Date.now() - 100000, online: false }]; backup.collections.preferences.appearanceAccent = 'mint'; backup.collections.preferences.responseStyle = 'natural'; return JSON.stringify(backup); });
    await choose(imported); assert.equal(await evaluate(() => notepadTabsData[0].name), 'Fixture notes');
    await evaluate(() => document.querySelector('[data-restore-collection="checklist"]').checked = false);
    await click('#backupCenterRestore'); await until(() => evaluate(() => /Restored/.test(document.getElementById('backupCenterStatus').textContent)), 'Restore never completed');
    const state = await evaluate(() => ({ note: OlangaNotesController.portable()[0], task: activeTasks[0], timer: activeTimers[0], schedule: OlangaScheduleStore.snapshot().items[0], prefs: OlangaPortablePreferences.snapshot() }));
    assert.equal(state.note.name, 'Imported'); assert.equal(state.note.content, '<b>Safe imported note</b>'); assert.equal(state.task.id, 'fixture-task');
    assert.equal(state.timer.paused, true); assert.equal(state.timer.ringing, false); assert.equal(state.schedule.enabled, false); assert.equal(state.schedule.nextAt, null); assert.equal(state.prefs.appearanceAccent, 'mint');
    await pause(1300); assert.equal(await evaluate(() => activeTimers[0].ringing), false); assert.deepEqual(report.forbidden, []);
  });
  await check('Imported clocks remain paused after reload and become active only after a deliberate resume', async () => {
    await click('#backupCenterClose'); await new Promise(resolve => { main.webContents.once('did-finish-load', resolve); main.webContents.reload(); });
    await until(() => evaluate(() => !!window.OlangaBackupCenter && window.OlangaAppInitialized === true), 'Reload initialization missing');
    await evaluate(() => { isMicMuted = true; isTtsMuted = true; window.confirm = () => true; window.alert = () => {}; });
    assert.deepEqual(await evaluate(() => ({ paused: activeTimers[0].paused, ringing: activeTimers[0].ringing, enabled: OlangaScheduleStore.snapshot().items[0].enabled })), { paused: true, ringing: false, enabled: false });
    const resumed = await evaluate(() => { activeTimers[0].remainingMs = 600000; return resumeImportedTimer(activeTimers[0].id); }); assert.equal(resumed.ok, true);
    assert.equal(await evaluate(() => activeTimers[0].paused === true), false); await evaluate(() => cancelTimer(activeTimers[0].id));
  });
  await check('Pre-restore recovery supports review, download and explicit deletion', async () => {
    await evaluate(() => openOlangaBackups()); await click('#backupCenterRecoveryDownload'); await until(() => report.downloads.some(item => item.filename === 'olanga-personal-recovery.json'), 'Recovery download missing');
    const file = report.downloads.find(item => item.filename === 'olanga-personal-recovery.json'), recovery = JSON.parse(fs.readFileSync(file.path, 'utf8'));
    assert.equal(JSON.parse(recovery.originals.notes.notesRaw)[0].name, 'Fixture notes'); assert.equal(recovery.originals.preferences.appearanceAccent, 'blue');
    await click('#backupCenterRecoveryReview'); assert.equal(await evaluate(() => document.querySelectorAll('[data-restore-collection]').length), 5);
    await click('#backupCenterRecoveryDelete'); assert.equal(await evaluate(() => localStorage.getItem(OlangaPersonalBackup.RECOVERY_KEY)), null);
    await click('#backupCenterClose');
  });
  await check('A later durable preference failure rolls an earlier note replacement back and reports failure', async () => {
    await evaluate(() => openOlangaBackups());
    const failing = await evaluate(async () => { const backup = await OlangaBackupCenter.export(['notes','preferences']); backup.collections.notes = [{ id: 99, name: 'Must roll back', content: 'temporary replacement' }]; backup.collections.preferences.appearanceAccent = 'amber'; window.backupBeforeFailure = { notes: OlangaNotesController.original(), prefs: OlangaPortablePreferences.snapshot() }; return JSON.stringify(backup); });
    await choose(failing);
    await evaluate(() => { window.fixturePersist = persistAppPreferences; let fail = true; persistAppPreferences = async prefs => { if (fail) { fail = false; throw new Error('Fixture disk failure'); } return fixturePersist(prefs); }; });
    try {
      await click('#backupCenterRestore'); await until(() => evaluate(() => /rolled back/.test(document.getElementById('backupCenterStatus').textContent)), 'Failed restore did not report rollback');
      assert.deepEqual(await evaluate(() => OlangaNotesController.original()), await evaluate(() => backupBeforeFailure.notes));
      assert.deepEqual(await evaluate(() => OlangaPortablePreferences.snapshot()), await evaluate(() => backupBeforeFailure.prefs));
      assert.equal(await evaluate(() => JSON.parse(localStorage.getItem(OlangaPersonalBackup.RECOVERY_KEY)).status), 'rolled-back');
    } finally { await evaluate(() => { persistAppPreferences = fixturePersist; }); }
    await click('#backupCenterClose');
  });
  await check('A local preference mirror failure rejects restore and recovers original secure preferences', async () => {
    await evaluate(() => openOlangaBackups());
    const failing = await evaluate(async () => { const backup = await OlangaBackupCenter.export(['preferences']); window.fixtureMirrorBefore = OlangaPortablePreferences.snapshot(); backup.collections.preferences.appearanceAccent = 'rose'; return JSON.stringify(backup); });
    await choose(failing);
    await evaluate(() => { window.fixtureStorageSet = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === 'olanga_appearance_accent') throw Error('Fixture local mirror unavailable'); return fixtureStorageSet.call(this, key, value); }; });
    try {
      await click('#backupCenterRestore'); await until(() => evaluate(() => /rolled back/.test(document.getElementById('backupCenterStatus').textContent)), 'Mirror failure did not reject and roll back restore');
      const result = await evaluate(async () => { const secure = JSON.parse(await window.electronAPI.secureStoreGet('app_preferences')); return { rendered: document.documentElement.dataset.accent, saved: secure.appearanceAccent, before: fixtureMirrorBefore.appearanceAccent }; });
      assert.equal(result.rendered, result.before); assert.equal(result.saved, result.before);
    } finally { await evaluate(() => { Storage.prototype.setItem = fixtureStorageSet; }); }
    await click('#backupCenterClose'); await new Promise(resolve => { main.webContents.once('did-finish-load', resolve); main.webContents.reload(); });
    await until(() => evaluate(() => !!window.OlangaBackupCenter && window.OlangaAppInitialized === true), 'Mirror recovery reload failed');
    await evaluate(() => { isMicMuted = true; isTtsMuted = true; window.confirm = () => true; window.alert = () => {}; });
    assert.deepEqual(await evaluate(() => ({ rendered: document.documentElement.dataset.accent, stored: localStorage.getItem('olanga_appearance_accent') })), { rendered: 'mint', stored: 'mint' });
  });
  await check('Notes history restores prior content and deleted tabs without touching live services', async () => {
    await evaluate(() => { OlangaNotesController.replace([{ id: 30, name: 'History fixture', content: 'Before revision' }, { id: 31, name: 'Deleted fixture', content: 'Deleted content' }]); OlangaNotesController.replace([{ id: 30, name: 'History fixture', content: 'After revision' }]); currentTabId = 30; switchNotepadTab(30); openOlangaNotesHistory(); });
    await evaluate(() => [...document.querySelectorAll('#notesHistoryDialog button')].find(button => button.textContent === 'Restore this version').click());
    assert.equal(await evaluate(() => OlangaNotesController.portable().find(note => note.id === 30).content), 'Before revision');
    await evaluate(() => [...document.querySelectorAll('#notesHistoryDialog button')].find(button => button.textContent === 'Restore deleted note').click());
    assert.equal(await evaluate(() => OlangaNotesController.portable().some(note => note.content === 'Deleted content')), true); await click('#notesHistoryClose');
  });
  await check('Malformed note recovery preserves original bytes, downloads them and starts clean only by choice', async () => {
    await evaluate(() => { localStorage.setItem(OlangaNotes.KEY, '{fixture damaged notes'); OlangaNotesController.reload(); openOlangaNotesHistory(); });
    assert.equal(await evaluate(() => OlangaNotesController.snapshot().blocked), true);
    await evaluate(() => [...document.querySelectorAll('#notesHistoryDialog button')].find(button => button.textContent === 'Download original records').click());
    await until(() => report.downloads.some(item => item.filename === 'olanga-notes-recovery.json'), 'Original notes download missing');
    const file = report.downloads.find(item => item.filename === 'olanga-notes-recovery.json'); assert.equal(JSON.parse(fs.readFileSync(file.path, 'utf8')).records.olangaNotepadTabs, '{fixture damaged notes');
    await evaluate(() => [...document.querySelectorAll('#notesHistoryDialog button')].find(button => button.textContent === 'Start new notes after preserving original').click());
    assert.equal(await evaluate(() => OlangaNotesController.snapshot().blocked), false); assert.equal(await evaluate(() => JSON.parse(localStorage.getItem(OlangaNotes.RECOVERY_KEY)).records.olangaNotepadTabs), '{fixture damaged notes');
    await click('#notesHistoryClose');
  });
  await check('Backup and history dialogs fit narrow enlarged layouts and return focus on close', async () => {
    main.setMinimumSize(0,0); main.setContentSize(400,650); main.webContents.setZoomFactor(1.25); main.showInactive();
    for (const [name, open, selector] of [['backup', () => openOlangaBackups(), '#backupCenterDialog'], ['history', () => openOlangaNotesHistory(), '#notesHistoryDialog']]) {
      await evaluate(() => document.getElementById('workspaceOpen').focus()); await evaluate(open); main.webContents.invalidate(); await pause(160); await main.webContents.capturePage(); await pause(90);
      const metrics = await evaluate(selector => { const dialog = document.querySelector(selector), box = dialog.getBoundingClientRect(); return { left: box.left, right: box.right, width: innerWidth, overflow: dialog.scrollWidth > dialog.clientWidth + 1, scrollTop: dialog.scrollTop, headingVisible: dialog.querySelector('h2').getBoundingClientRect().top >= box.top }; }, selector);
      assert.ok(metrics.left >= -1 && metrics.right <= metrics.width + 1); assert.equal(metrics.overflow, false); assert.equal(metrics.scrollTop, 0); assert.equal(metrics.headingVisible, true);
      const target = path.join(output, name + '-narrow.png'); fs.writeFileSync(target, (await main.webContents.capturePage()).toPNG()); report.screenshots.push(target);
      await evaluate(selector => document.querySelector(selector).close(), selector); await until(() => evaluate(() => document.activeElement.id === 'workspaceOpen'), 'Dialog did not return focus to its opener');
    }
  });
  assert.deepEqual(report.forbidden, []); assert.deepEqual(report.errors, []); finish(0);
} catch (error) { report.error = error.stack; try { report.rendererState = await evaluate(() => ({ dialogs: [...document.querySelectorAll('dialog[open]')].map(item => ({ id: item.id, text: item.textContent })), notes: OlangaNotesController.snapshot(), retained: localStorage.getItem(OlangaNotes.RECOVERY_KEY) })); } catch (_) {} finish(1); } });
