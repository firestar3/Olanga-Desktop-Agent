// Conversational routine acceptance in the production renderer. Only transcript
// and speech output are fixtures; actual routine review/selection/dispatch runs.
const { app, BrowserWindow, ipcMain, session, net } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../build/qa/routine-conversation'); fs.mkdirSync(output, { recursive: true });
app.disableHardwareAcceleration(); app.setPath('userData', fs.mkdtempSync(path.join(output, 'profile-'))); if (!process.argv.includes('--hidden')) process.argv.push('--hidden');
const report = { passed: false, runtime: process.versions.electron, checks: [], forbidden: [], errors: [], fallback: [] };
const forbidden = new Set(['provider-generate','provider-generate-stream','nvidia-tts-config','nvidia-tts-synthesize','open-app','close-app','arrange-app','play-spotify','media-control','desktop-capture','desktop-run','desktop-undo','fetch-news-bundle','check-release','update-download','update-install','set-open-at-login']);
const handle = ipcMain.handle.bind(ipcMain); ipcMain.handle = (channel, callback) => handle(channel, (event, ...args) => { if (forbidden.has(channel)) { report.forbidden.push(channel); throw Error('Fixture blocked ' + channel); } return callback(event, ...args); });
globalThis.fetch = net.fetch = async () => { report.forbidden.push('network'); throw Error('Fixture network disabled'); };
app.on('web-contents-created', (_event, contents) => { contents.on('preload-error', (_e, _file, error) => report.errors.push(error.message)); contents.on('render-process-gone', (_e, details) => report.errors.push(details.reason)); });
app.whenReady().then(() => { session.defaultSession.setPermissionCheckHandler(() => false); session.defaultSession.setPermissionRequestHandler((_contents, permission, reply) => { report.forbidden.push('permission:' + permission); reply(false); }); session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (_request, reply) => { report.forbidden.push('renderer-network'); reply({ cancel: true }); }); });
let main, finished = false; const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = async (fn, ...args) => { const code = '(() => { try { return Promise.resolve((' + fn.toString() + ')(...' + JSON.stringify(args) + ')).then(value => ({value}), error => ({fixtureError:error.stack||error.message})); } catch(error) { return {fixtureError:error.stack||error.message}; } })()'; const result = await main.webContents.executeJavaScript(code, true); if (result?.fixtureError) throw Error(result.fixtureError); return result?.value; };
async function until(fn, label) { for (let i = 0; i < 240; i++) { if (await fn()) return; await pause(25); } throw Error(label); }
async function say(text) { return evaluate(async text => { window.fixtureTranscript = text; await processAudioBlobWithGemini(new Blob(['fixture-only']), { rough: text }); return { response: aiText.textContent, tasks: activeTasks.map(item => item.text), review: window.OlangaRoutineControl.hasReview(), run: OlangaWorkspace.snapshot().runs.at(-1) }; }, text); }
async function check(name, fn) { await fn(); report.checks.push(name); }
async function reset() { await evaluate(() => { cancelAssistantRequest(); window.cancelRoutineReviews(); document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); applyAssistantCommands = fixtureActualDispatch; clearAllTasks(); const routine = OlangaWorkspace.snapshot().routines.find(item => item.name === 'Fixture focus'); window.fixtureRoutine = OlangaWorkspace.saveRoutine({ id: routine?.id, name: 'Fixture focus', lines: ['Add Alpha fixture task to my checklist','Add Beta fixture task to my checklist','Add Gamma fixture task to my checklist'] }, OlangaIntents.parse); setState(State.IDLE); }); }
function finish(code) { if (finished) return; finished = true; report.passed = code === 0; fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); app.exit(code); }
setTimeout(() => { report.error = 'Routine fixture exceeded 90 seconds'; finish(1); }, 90000).unref(); process.on('uncaughtException', error => { report.error = error.stack; finish(1); }); process.on('unhandledRejection', error => { report.error = error.stack; finish(1); });
require('../main');
app.whenReady().then(async () => { try {
  await until(() => { main = BrowserWindow.getAllWindows().find(win => /index\.html$/.test(win.webContents.getURL())); return main && !main.webContents.isLoading(); }, 'Renderer missing');
  await until(() => evaluate(() => !!window.OlangaRoutineControl && !!window.OlangaConversationalControls && !!window.OlangaTurns && window.OlangaAppInitialized === true), 'Routine controls missing');
  await evaluate(() => {
    isMicMuted = true; isTtsMuted = true; apiKey = 'fixture-key-never-saved'; streamRepliesEnabled = false;
    document.getElementById('startLocalBtn').click(); window.fixtureFallback = []; window.fixtureSpoken = []; window.fixtureAlerts = [];
    window.alert = message => fixtureAlerts.push(message); window.confirm = () => true; warmProviderConnection = () => {};
    transcribeAssistantAudio = async () => fixtureTranscript;
    speakResponse = async text => { fixtureSpoken.push(text); return { ok: true, status: 'muted' }; };
    speakResponseAndThen = async (text, callback) => { fixtureSpoken.push(text); callback(); return { ok: true, status: 'muted' }; };
    sendTextToGemini = async goal => { fixtureFallback.push(goal); throw Error('Unexpected provider fallback: ' + goal); };
    window.fixtureActualDispatch = applyAssistantCommands;
  });
  await check('Spoken create routine opens the actual editor with the requested name and no actions', async () => {
    const state = await say('Create a routine called Fixture focus'); assert.match(state.response, /routine editor is open/i); assert.deepEqual(state.tasks, []);
    assert.deepEqual(await evaluate(() => ({ open: document.getElementById('workspaceDialog').open, name: document.getElementById('routineName').value, focus: document.activeElement.id })), { open: true, name: 'Fixture focus', focus: 'routineLines' });
    await evaluate(() => { document.getElementById('routineLines').value = 'Add Alpha fixture task to my checklist\nAdd Beta fixture task to my checklist\nAdd Gamma fixture task to my checklist'; document.getElementById('routineForm').requestSubmit(); document.getElementById('workspaceDialog').close(); });
    assert.equal(await evaluate(() => OlangaWorkspace.snapshot().routines.length), 1);
  });
  await check('Exact-name spoken run opens review; skip step two changes selection before approved dispatch', async () => {
    await reset(); let state = await say('Run routine Fixture focus.'); assert.equal(state.review, true); assert.deepEqual(state.tasks, []);
    state = await say('Skip step two'); assert.match(state.response, /Step 2 excluded/); assert.equal(state.review, true);
    assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.routine-review[open] input')].map(item => item.checked)), [true,false,true]);
    state = await say('Run selected steps'); assert.deepEqual(state.tasks, ['Alpha fixture task','Gamma fixture task']); assert.equal(state.review, false); assert.equal(state.run.state, 'completed');
  });
  await check('Spoken include restores a previously excluded step without running anything early', async () => {
    await reset(); await say('Run routine Fixture focus'); await say('Skip step two'); await say('Include step two');
    assert.equal(await evaluate(() => activeTasks.length), 0); const state = await say('Yes, run selected steps'); assert.deepEqual(state.tasks, ['Alpha fixture task','Beta fixture task','Gamma fixture task']);
  });
  await check('Cancelling the spoken review dispatches no step and a missing exact name never guesses', async () => {
    await reset(); await say('Run routine Fixture focus'); const cancelled = await say('Cancel'); assert.deepEqual(cancelled.tasks, []); assert.equal(cancelled.review, false);
    const missing = await say('Run routine Fixture'); assert.match(missing.response, /No routine with that name/); assert.deepEqual(missing.tasks, []);
  });
  await check('Deselecting every step refuses confirmation without dispatch and can recover by including one', async () => {
    await reset(); await say('Run routine Fixture focus'); for (const step of ['one','two','three']) await say('Skip step ' + step);
    let state = await say('Run selected steps'); assert.match(state.response, /Select at least one/); assert.deepEqual(state.tasks, []); assert.equal(state.review, true);
    await say('Include step three'); state = await say('Run selected steps'); assert.deepEqual(state.tasks, ['Gamma fixture task']);
  });
  await check('A changed saved routine invalidates an already spoken review', async () => {
    await reset(); await say('Run routine Fixture focus'); await evaluate(() => OlangaWorkspace.saveRoutine({ ...fixtureRoutine, lines: ['Add Changed fixture task to my checklist'] }, OlangaIntents.parse));
    const state = await say('Run selected steps'); assert.match(state.response, /changed after review/); assert.deepEqual(state.tasks, []);
  });
  await check('A review older than five minutes refuses spoken confirmation', async () => {
    await reset(); await say('Run routine Fixture focus'); await evaluate(() => { window.fixtureNow = Date.now; Date.now = () => fixtureNow() + 301000; });
    try { const state = await say('Run selected steps'); assert.match(state.response, /review has expired/); assert.deepEqual(state.tasks, []); } finally { await evaluate(() => { Date.now = fixtureNow; }); }
  });
  await check('Repeated UI confirmation cannot execute any routine step twice', async () => {
    await reset(); await say('Run routine Fixture focus');
    await evaluate(() => { const button = [...document.querySelectorAll('.routine-review[open] button')].find(item => item.textContent === 'Run selected steps'); button.click(); button.click(); });
    await until(() => evaluate(() => OlangaWorkspace.snapshot().runs.at(-1)?.state === 'completed'), 'Double-confirm run never finished');
    assert.deepEqual(await evaluate(() => activeTasks.map(item => item.text)), ['Alpha fixture task','Beta fixture task','Gamma fixture task']);
  });
  await check('Duplicate spoken confirmation after completion cannot dispatch or ask a provider to reinterpret approval', async () => {
    const before = await evaluate(() => activeTasks.map(item => item.text)); const state = await say('Run selected steps');
    assert.deepEqual(state.tasks, before); assert.equal(state.review, false); assert.match(state.response, /(?:no|fresh|open|review)/i);
  });
  await check('Cancelling during an awaited step prevents the undispatched remaining steps', async () => {
    await reset(); await say('Run routine Fixture focus');
    await evaluate(() => { applyAssistantCommands = async (command, request) => { if (command.includes('Beta fixture')) { window.fixtureHeldStep = true; await new Promise(resolve => { window.fixtureRelease = resolve; }); } return fixtureActualDispatch(command, request); }; window.fixtureTranscript = 'Run selected steps'; window.fixturePendingRun = processAudioBlobWithGemini(new Blob(['fixture']), { rough: fixtureTranscript }); });
    await until(() => evaluate(() => !!window.fixtureHeldStep), 'Second step never paused');
    await say('Cancel'); await evaluate(async () => { fixtureRelease(); await fixturePendingRun; applyAssistantCommands = fixtureActualDispatch; });
    assert.deepEqual(await evaluate(() => activeTasks.map(item => item.text)), ['Alpha fixture task']);
  });
  await check('Unfinished-step review retries only failed or unstarted work and retains completed actions', async () => {
    await reset(); await say('Run routine Fixture focus');
    await evaluate(() => { applyAssistantCommands = async (command, request) => command.includes('Beta fixture') ? { spokenResponse: 'Fixture step failed.', results: [{ ok: false, message: 'Fixture step failed.' }] } : fixtureActualDispatch(command, request); });
    let state = await say('Run selected steps'); assert.deepEqual(state.tasks, ['Alpha fixture task']); assert.equal(state.run.state, 'failed');
    await evaluate(() => { applyAssistantCommands = fixtureActualDispatch; }); state = await say('Review unfinished steps'); assert.equal(state.review, true);
    assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.routine-review[open] label span')].map(item => item.textContent.includes('Alpha fixture'))), [false,false]);
    state = await say('Run selected steps'); assert.deepEqual(state.tasks, ['Alpha fixture task','Beta fixture task','Gamma fixture task']); assert.equal(new Set(state.tasks).size, 3);
  });
  await check('Polite spoken create, selection and confirmation stay local and preserve one-shot review', async () => {
    await reset();
    let state = await say('Olanga, can you please create a routine called Polite fixture?');
    assert.match(state.response, /routine editor is open/i); assert.deepEqual(state.tasks, []);
    assert.equal(await evaluate(() => document.getElementById('routineName').value), 'Polite fixture');
    await evaluate(() => document.getElementById('workspaceDialog').close());
    state = await say('Could you please run my Fixture focus routine?'); assert.equal(state.review, true);
    state = await say('Olanga, please skip step two'); assert.match(state.response, /Step 2 excluded/); assert.deepEqual(state.tasks, []);
    state = await say('Can you please run selected steps?'); assert.deepEqual(state.tasks, ['Alpha fixture task','Gamma fixture task']);
    state = await say('Can you please run selected steps?'); assert.match(state.response, /no open review/); assert.deepEqual(state.tasks, ['Alpha fixture task','Gamma fixture task']);
  });
  report.fallback = await evaluate(() => fixtureFallback); assert.deepEqual(report.fallback, []); assert.deepEqual(report.forbidden, []); assert.deepEqual(report.errors, []); finish(0);
} catch (error) { report.error = error.stack; try { report.state = await evaluate(() => ({ response: aiText.textContent, fallback: fixtureFallback, tasks: activeTasks, review: document.querySelector('.routine-review[open]')?.textContent, turn: OlangaTurns.snapshot() })); } catch (_) {} finish(1); } });
