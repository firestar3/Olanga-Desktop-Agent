// Production renderer and preload, isolated profile and disposable file fixtures.
// Provider/native app/companion endpoints are fixtures; no user apps or mic input.
const { app, BrowserWindow, ipcMain, dialog, session, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../build/qa'); fs.mkdirSync(output, { recursive: true });
const fixture = fs.mkdtempSync(path.join(output, 'workbench-fixture-')), profile = path.join(fixture, 'profile');
const projects = path.join(fixture, 'project'); fs.mkdirSync(projects); fs.writeFileSync(path.join(projects, 'notes.md'), 'Storage decision\nUse SQLite for offline notes.\n');
const source = path.join(fixture, 'draft.txt'); fs.writeFileSync(source, 'fixture notes');
const calendar = path.join(fixture, 'calendar.ics'), start = new Date(Date.now() + 86400000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
fs.writeFileSync(calendar, `BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:${start}\nSUMMARY:Fixture review\nDESCRIPTION:Prepare the local draft.\nEND:VEVENT\nEND:VCALENDAR`);
app.disableHardwareAcceleration(); app.setPath('userData', profile);
const report = { passed: false, checks: [], errors: [], calls: [], forbidden: [], screenshots: [], coverage: { realRenderer: true, realPreload: true, realProjectSearch: true, realFileRenameUndo: true, realCalendarImport: true, simulatedProviders: true, physicalMicrophone: false, externalCompanions: false } };
let chosen = [], main, done = false, delaySessionPreview = false, releaseSessionPreview = null;
const phoneFixture = require('../desktop/phone-dispatch').createPhoneDispatch({ getWindow: () => main });
dialog.showOpenDialog = async () => ({ canceled: !chosen.length, filePaths: chosen });
const forbidden = new Set(['provider-generate', 'provider-stream', 'provider-warm', 'nvidia-tts-synthesize', 'open-app', 'arrange-app', 'close-app', 'play-spotify', 'reload-spotify', 'media-control', 'desktop-capture', 'desktop-run', 'execute-command', 'terminal-session-create', 'terminal-session-execute', 'fetch-news-bundle', 'check-release', 'update-download', 'update-install', 'conversation-live-start']);
const mocks = {
  'phone-claim': (_, id) => phoneFixture.claim(id),
  'phone-complete': (_, payload) => phoneFixture.complete(payload),
  'work-session-capture': () => ({ ok: true, captureId: 'fixture-capture', windows: [{ id: 'fixture-window', appId: 'notepad', appName: 'Notepad', title: 'Fixture note' }] }),
  'work-session-save': (_, payload) => { assert.deepEqual(payload.windowIds, ['fixture-window']); return { ok: true }; },
  'work-session-list': () => ({ ok: true, sessions: [{ id: 'fixture-session', name: 'Fixture session' }] }),
  'work-session-preview': () => { const result = { ok: true, previewId: 'fixture-preview', name: 'Fixture session', steps: [{ appName: 'Notepad', status: 'existing', message: 'Restore the selected existing window.' }] }; if (!delaySessionPreview) return result; delaySessionPreview = false; return new Promise(resolve => { releaseSessionPreview = () => resolve(result); }); },
  'work-session-restore': () => ({ ok: true, status: 'completed', receipts: [{ verified: true, message: 'Notepad layout restored.' }] }),
  'conversation-local-reply': () => ({ ok: true, text: 'Local fixture answer.' }),
  'integration-configure': () => ({ ok: true, endpoint: 'https://fixture.example/mcp' }),
  'integration-list': () => ({ tools: [{ name: 'read_fixture', description: 'Fixture tool <script>never execute</script>', inputSchema: { type: 'object' } }], protocolVersion: '2025-06-18' }),
  'integration-preview': (_, value) => ({ approvalId: 'fixture-approval', name: value.name, arguments: value.arguments, endpoint: 'https://fixture.example/mcp' }),
  'integration-call': (_, value) => { assert.equal(value.approvalId, 'fixture-approval'); return { ok: true, status: 'completed', result: { text: '<img src=x onerror=alert(1)>Safe text' } }; },
  'companion-pair': () => ({ ok: true, endpoint: 'http://127.0.0.1:12345', code: 'fixture-code', expiresAt: Date.now() + 300000 }),
  'companion-list': () => ({ connections: [], inbox: [] })
};
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, (event, ...args) => { report.calls.push(channel); if (forbidden.has(channel)) { report.forbidden.push(channel); throw new Error('Forbidden external operation: ' + channel); } return (mocks[channel] || callback)(event, ...args); });
globalThis.fetch = net.fetch = async () => { report.forbidden.push('fetch'); throw new Error('Network disabled in workbench smoke.'); };
app.on('web-contents-created', (_, contents) => {
  contents.on('console-message', (event, ...legacy) => { const value = event?.message ? event : { level: legacy[0], message: legacy[1] }; if (['error', 3].includes(value.level) && !/ERR_BLOCKED_BY_CLIENT|ERR_INTERNET_DISCONNECTED/.test(value.message)) report.errors.push(value.message); });
  contents.on('preload-error', (_, _file, error) => report.errors.push(error.message));
});
app.whenReady().then(() => { session.defaultSession.setPermissionCheckHandler(() => false); session.defaultSession.setPermissionRequestHandler((_, _permission, callback) => callback(false)); session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, callback) => callback({ cancel: true })); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => main.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function waitFor(fn, message) { for (let i = 0; i < 120; i++) { if (await evaluate(fn)) return; await pause(50); } throw new Error(message); }
async function button(label) { await evaluate(label => { const page = document.querySelector('#workbenchDialog section:not([hidden])'); const item = [...page.querySelectorAll('button')].find(item => item.textContent === label && !item.disabled); if (!item) throw new Error('Missing control: ' + label); item.scrollIntoView({ block: 'nearest' }); item.click(); }, label); }
async function field(label, value) { await evaluate((label, value) => { const item = document.querySelector(`[aria-label="${label}"]`); if (!item) throw new Error('Missing field: ' + label); item.value = value; item.dispatchEvent(new Event('input', { bubbles: true })); item.dispatchEvent(new Event('change', { bubbles: true })); }, label, value); }
const page = name => evaluate(name => window.openOlangaWorkbench(name), name);
async function check(name, fn) { await fn(); report.checks.push(name); }
async function screenshot(name) { await pause(400); main.webContents.invalidate(); await main.webContents.capturePage(); await pause(400); const filename = path.join(output, `workbench-${name}.png`); fs.writeFileSync(filename, (await main.webContents.capturePage()).toPNG()); report.screenshots.push(filename); }
function finish(code) { if (done) return; done = true; fs.writeFileSync(path.join(output, 'workbench-smoke.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); app.exit(code); }
require('../main');
app.whenReady().then(async () => {
  try {
    for (let i = 0; i < 100 && !main; i++) { main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html')); if (!main) await pause(50); }
    if (!main) throw new Error('Main window missing.');
    await waitFor(() => !!window.OlangaWorkbench && !!window.OlangaScheduleStore, 'Work tools did not initialize.');
    await evaluate(() => { isTtsMuted = true; isMicMuted = true; document.getElementById('setupScreen').classList.add('hidden'); document.getElementById('mainScreen').classList.remove('hidden'); navigator.mediaDevices.getUserMedia = async () => { throw new Error('Microphone disabled.'); }; });
    await check('Opening all optional pages starts no service or provider', async () => { const workCalls = () => report.calls.filter(channel => /^(?:work-session|file-workflow|project-|calendar-|conversation-|integration-|companion-|phone-)/.test(channel)).length; const before = workCalls(); for (const name of ['sessions', 'files', 'projects', 'selection', 'conversation', 'schedules', 'calendar', 'integrations', 'companions', 'phone']) await page(name); assert.equal(workCalls(), before); });
    await check('Working sessions require selection, preview and a separate restore click', async () => {
      await page('sessions'); await field('Session name', 'Fixture session'); await button('Choose from open windows'); await waitFor(() => !!document.querySelector('[data-workbench-page="sessions"] input[type="checkbox"]'), 'Capture missing');
      await evaluate(() => { document.querySelector('[data-workbench-page="sessions"] input[type="checkbox"]').checked = true; }); await button('Save selected windows'); await waitFor(() => document.querySelector('[data-workbench-page="sessions"]').textContent.includes('Preview restore'), 'Session missing'); await button('Preview restore'); await waitFor(() => document.querySelector('[data-workbench-page="sessions"]').textContent.includes('Restore this session'), 'Preview missing'); assert.equal(report.calls.filter(value => value === 'work-session-restore').length, 0); await button('Restore this session');
    });
    await check('Actual selected file rename and identity-checked undo work through preload', async () => {
      chosen = [source]; await page('files'); await button('Choose files'); await waitFor(() => !!document.querySelector('[aria-label="draft.txt"]'), 'File picker result missing'); await field('draft.txt', 'final.txt'); await button('Preview renames'); await waitFor(() => document.querySelector('[data-workbench-page="files"]').textContent.includes('Apply these changes'), 'File preview missing'); assert.ok(fs.existsSync(source)); await button('Apply these changes'); await waitFor(() => document.querySelector('[data-workbench-page="files"]').textContent.includes('Undo checked changes'), 'File receipt missing'); assert.ok(fs.existsSync(path.join(fixture, 'final.txt'))); await button('Undo checked changes');
      // Undo creates the original name as a temporary hard link before finishing
      // verification and removing the renamed path. Path existence is not completion.
      await waitFor(() => {
        const section = document.querySelector('[data-workbench-page="files"]'), undoButtons = [...section.querySelectorAll('button')].filter(button => button.textContent === 'Undo checked changes');
        return section.textContent.includes('Original location restored and verified.') && section.textContent.includes('undone ·') && undoButtons.length === 1 && undoButtons[0].disabled;
      }, 'Verified Undo receipt and refreshed history missing');
      assert.equal(fs.readFileSync(source, 'utf8'), 'fixture notes'); assert.equal(fs.statSync(source).nlink, 1); assert.equal(fs.existsSync(path.join(fixture, 'final.txt')), false);
    });
    await check('Cancelling a native file picker is quiet and changed names invalidate a preview', async () => {
      await page('files'); chosen = []; await button('Choose files'); await waitFor(() => ![...document.querySelectorAll('[data-workbench-page="files"] button')].find(button => button.textContent === 'Choose files').disabled, 'File picker did not settle'); assert.equal(await evaluate(() => document.getElementById('workbenchStatus').classList.contains('workspace-error')), false);
      const previousFileId = await evaluate(() => document.querySelector('[aria-label="draft.txt"]').dataset.fileId);
      chosen = [source]; await button('Choose files'); await waitFor(() => ![...document.querySelectorAll('[data-workbench-page="files"] button')].find(button => button.textContent === 'Choose files').disabled, 'Selected file picker did not settle');
      assert.notEqual(await evaluate(() => document.querySelector('[aria-label="draft.txt"]').dataset.fileId), previousFileId);
      await field('draft.txt', 'reviewed.txt'); await button('Preview renames'); await waitFor(() => document.querySelector('[data-workbench-page="files"]').textContent.includes('Apply these changes'), 'Preview missing'); await field('draft.txt', 'changed.txt'); assert.equal(await evaluate(() => document.querySelector('[data-workbench-page="files"]').textContent.includes('Apply these changes')), false); assert.ok(fs.existsSync(source));
    });
    await check('A late session preview cannot survive close and reopen', async () => {
      await page('sessions'); delaySessionPreview = true; await button('Preview restore'); for (let i = 0; i < 100 && !releaseSessionPreview; i++) await pause(25); assert.equal(typeof releaseSessionPreview, 'function'); await evaluate(() => document.getElementById('workbenchDialog').close()); await pause(100); releaseSessionPreview(); await page('sessions'); await waitFor(() => ![...document.querySelectorAll('[data-workbench-page="sessions"] button')].find(button => button.textContent === 'Preview restore').disabled, 'Preview did not settle'); assert.equal(await evaluate(() => document.querySelector('[data-workbench-page="sessions"]').textContent.includes('Restore this session')), false);
    });
    await check('Local project search renders citations without provider work', async () => {
      chosen = [projects]; await page('projects'); await button('Choose project folder'); await waitFor(() => !!document.querySelector('[aria-label="Selected project"] option'), 'Project missing'); await field('Question or search', 'storage decision'); await button('Search locally'); await waitFor(() => document.querySelector('[data-workbench-page="projects"]').textContent.includes('[S1]'), 'Citation missing'); assert.equal(await evaluate(() => document.querySelector('[data-workbench-page="projects"]').textContent.includes('Use SQLite')), true); await screenshot('projects');
    });
    await check('Calendar import and explicit preparation reminder remain local', async () => {
      chosen = [calendar]; await page('calendar'); await button('Import calendar export'); await waitFor(() => document.querySelector('[data-workbench-page="calendar"]').textContent.includes('Fixture review'), 'Calendar missing'); await button('Remind me 10 minutes before'); assert.equal(await evaluate(() => window.OlangaScheduleStore.snapshot().items.length), 1); await page('schedules'); await button('Refresh schedules'); assert.equal(await evaluate(() => document.querySelector('[data-workbench-page="schedules"]').textContent.includes('Prepare: Fixture review')), true);
    });
    await check('Optional local answers and disabled microphone Live errors are visible', async () => { await page('conversation'); await field('Local model name', 'fixture'); await field('Local question', 'hello'); await button('Ask local model'); await waitFor(() => document.querySelector('[data-workbench-page="conversation"]').textContent.includes('Local fixture answer'), 'Local response missing'); await button('Start live conversation (preview)'); await waitFor(() => /Unmute and enable/.test(document.getElementById('workbenchStatus').textContent), 'Live disabled mic error missing'); });
    await check('MCP execution needs a distinct approval and outputs stay text', async () => { await page('integrations'); await field('MCP HTTPS endpoint', 'https://fixture.example/mcp'); await button('Connect and load tools'); await waitFor(() => !!document.querySelector('[aria-label="MCP tool"] option'), 'Tool list missing'); await button('Review tool call'); await waitFor(() => document.querySelector('[data-workbench-page="integrations"]').textContent.includes('Approve and run this tool'), 'Tool review missing'); assert.equal(report.calls.filter(value => value === 'integration-call').length, 0); await button('Approve and run this tool'); await waitFor(() => document.querySelector('[data-workbench-page="integrations"]').textContent.includes('Safe text'), 'Tool result missing'); assert.equal(await evaluate(() => document.querySelectorAll('[data-workbench-page="integrations"] script, [data-workbench-page="integrations"] img').length), 0); });
    await check('Shared controls retain theme and fit at 100 and 150 percent zoom', async () => { await page('sessions'); for (const zoom of [1, 1.5]) { main.webContents.setZoomFactor(zoom); const styles = await evaluate(() => { const panel = document.getElementById('workbenchDialog'), button = panel.querySelector('button'), rect = panel.getBoundingClientRect(); return { font: getComputedStyle(button).fontFamily, root: getComputedStyle(document.body).fontFamily, fits: rect.width <= innerWidth && rect.height <= innerHeight, border: getComputedStyle(panel.querySelector('nav button')).borderStyle }; }); assert.equal(styles.font, styles.root); assert.equal(styles.fits, true); assert.equal(styles.border, 'solid'); await screenshot(`sessions-${zoom}`); } main.webContents.setZoomFactor(1); });
    await check('Workspace is the sole top-bar action, opens with focus, and closing Work tools clears optional connections', async () => {
      await evaluate(() => document.getElementById('workbenchDialog').close());
      const navigation = await evaluate(() => {
        const launch = document.getElementById('workspaceOpen'), topBar = document.querySelector('.top-bar');
        const shortcut = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }); document.dispatchEvent(shortcut);
        return { actions: [...topBar.querySelectorAll('button')].map(button => button.textContent), rightmost: topBar.lastElementChild === launch, font: getComputedStyle(launch).fontFamily, rootFont: getComputedStyle(document.body).fontFamily, quickAskAbsent: !document.getElementById('quickAskDialog') && typeof window.openOlangaQuickAsk === 'undefined', shortcutHandled: shortcut.defaultPrevented };
      });
      assert.deepEqual(navigation.actions, ['Workspace']); assert.equal(navigation.rightmost, true); assert.equal(navigation.font, navigation.rootFont); assert.equal(navigation.quickAskAbsent, true); assert.equal(navigation.shortcutHandled, false);
      await screenshot('main-workspace');
      await evaluate(() => document.getElementById('workspaceOpen').click());
      assert.equal(await evaluate(() => document.getElementById('workspaceDialog').open && document.getElementById('workspaceDialog').contains(document.activeElement)), true);
      await evaluate(() => document.getElementById('workspaceDialog').close());
      for (let i = 0; i < 100 && !report.calls.includes('integration-disconnect'); i++) await pause(50); assert.ok(report.calls.includes('integration-disconnect'));
    });
    await check('Phone IPC refuses a pending review, then verifies an explicitly requested local timer', async () => {
      const payload = () => ({ requestId: require('node:crypto').randomUUID(), text: 'set a timer for five minutes', command: '[SET_TIMER: 300, Timer]', signal: new AbortController().signal });
      await page('phone'); const busy = await phoneFixture.execute(payload()); assert.equal(busy.ok, false); assert.match(busy.message, /busy|review/i);
      await evaluate(() => { document.getElementById('workbenchDialog').close(); setState(State.IDLE); }); const result = await phoneFixture.execute(payload()); assert.equal(result.ok, true); assert.equal(result.verified, true);
      assert.equal(await evaluate(() => activeTimers.some(timer => timer.label === 'Timer')), true); await evaluate(() => { for (const timer of activeTimers.slice()) cancelTimer(timer.id); });
    });
    assert.deepEqual(report.forbidden, []); assert.deepEqual(report.errors, []); report.passed = true; finish(0);
  } catch (error) { report.error = error.stack; await screenshot('failure').catch(() => {}); finish(1); }
});
setTimeout(() => { report.error = 'Workbench smoke timed out.'; finish(1); }, 60000).unref();
