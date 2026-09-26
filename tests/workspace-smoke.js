// Real Workspace UI in an isolated profile. No user profile, microphone,
// remote provider, live app control, or system audio changes are permitted.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, '../build/qa');
fs.mkdirSync(output, { recursive: true });
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(output, 'workspace-profile-')));
const report = { passed: false, startedAt: new Date().toISOString(), checks: [], screenshots: [], blockedNetwork: [], forbiddenCalls: [], rendererErrors: [], permissionChecks: [], permissionRequests: [],
  coverage: { realDom: true, isolatedProfile: true, providerCalls: false, microphone: false, desktopActions: false, speechPlayback: false, zoomFactor: 1 } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
globalThis.fetch = async () => { report.forbiddenCalls.push('main-fetch'); throw new Error('Remote HTTP disabled in Workspace smoke.'); };
const forbidden = new Set(['provider-generate', 'nvidia-tts-config', 'nvidia-tts-synthesize', 'open-app', 'arrange-app', 'close-app', 'play-spotify', 'reload-spotify', 'media-control', 'desktop-capture', 'desktop-run', 'desktop-undo', 'execute-command', 'terminal-session-create', 'terminal-session-execute', 'fetch-news-bundle']);
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, (event, ...args) => {
  if (forbidden.has(channel)) { report.forbiddenCalls.push(channel); throw new Error('Native/provider work disabled in Workspace smoke.'); }
  return callback(event, ...args);
});
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event, ...legacy) => {
    const details = event?.message ? event : { level: legacy[0], message: legacy[1] };
    if (['error', 3].includes(details.level) && !/ERR_INTERNET_DISCONNECTED|ERR_BLOCKED_BY_CLIENT/.test(details.message)) report.rendererErrors.push(details.message);
  });
  contents.on('preload-error', (_event, _file, error) => report.rendererErrors.push(error.message));
  contents.on('render-process-gone', (_event, details) => report.rendererErrors.push('Renderer stopped: ' + details.reason));
});
app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => { report.permissionChecks.push(permission); return false; });
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => { report.permissionRequests.push(permission); callback(false); });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    report.blockedNetwork.push(new URL(details.url).origin); callback({ cancel: true });
  });
  session.defaultSession.on('will-download', (_event, item) => {
    if (item.getFilename() !== 'olanga-performance.json') { item.cancel(); report.forbiddenCalls.push('unexpected-download'); return; }
    const target = path.join(output, 'workspace-performance.json');
    item.setSavePath(target);
    item.once('done', (_downloadEvent, state) => { report.export = { state, path: target }; });
  });
});
try { require('../main'); } catch (error) { report.error = error.message; finish(1); }
let main;
async function evaluate(fn, ...args) { return main.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true); }
async function waitFor(fn, message, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await evaluate(fn)) return; await pause(75); }
  throw new Error(message);
}
async function click(selector) {
  await evaluate(selector => {
    const node = document.querySelector(selector);
    if (!node || !node.getClientRects().length || node.disabled) throw new Error('Control is missing, hidden or disabled: ' + selector);
    node.scrollIntoView({ block: 'center' }); node.focus(); node.click();
  }, selector);
}
async function tab(index) { await click(`#workspaceDialog [data-workspace-tab="${index}"]`); }
async function open() {
  if (!await evaluate(() => document.getElementById('workspaceDialog').open)) await click('#workspaceOpen');
  assert.equal(await evaluate(() => document.getElementById(document.getElementById('workspaceDialog').getAttribute('aria-labelledby'))?.textContent), 'Workspace');
}
async function fill(values) {
  await evaluate(values => {
    for (const [selector, value] of Object.entries(values)) {
      const node = document.querySelector(selector);
      if (!node || !node.getClientRects().length) throw new Error('Field missing or hidden: ' + selector);
      node.focus(); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, values);
}
async function rowButton(container, title, label) {
  await evaluate((container, title, label) => {
    const row = [...document.querySelectorAll(container + ' .workspace-item')].find(node => node.querySelector('strong')?.textContent === title);
    const control = [...(row?.querySelectorAll('button') || [])].find(node => node.textContent === label);
    if (!control || control.disabled || !control.getClientRects().length) throw new Error(`Missing ${label} for ${title}`);
    control.scrollIntoView({ block: 'center' }); control.focus(); control.click();
  }, container, title, label);
}
async function reviewButton(label) {
  await evaluate(label => {
    const review = document.querySelector('.routine-review[open]');
    const control = [...(review?.querySelectorAll('button') || [])].find(node => node.textContent === label);
    if (!control || control.disabled || !control.getClientRects().length) throw new Error('Missing visible review control: ' + label);
    control.scrollIntoView({ block: 'center' }); control.focus(); control.click();
  }, label);
}
async function screenshot(name) {
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  main.webContents.invalidate();
  await pause(180);
  // capturePage can deliver a previously committed compositor frame on Windows
  // immediately after a modal mutation. Discard that first capture explicitly.
  await main.webContents.capturePage(); await pause(80);
  const filename = path.join(output, `workspace-${name}.png`);
  fs.writeFileSync(filename, (await main.webContents.capturePage()).toPNG());
  report.screenshots.push(filename);
}
async function quiet() {
  await evaluate(() => {
    isTtsMuted = true;
    window.__workspaceSmokeMicCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__workspaceSmokeMicCalls++; throw new Error('Microphone disabled in Workspace smoke.'); };
  });
}
async function reload() {
  await new Promise(resolve => { main.webContents.once('did-finish-load', resolve); main.webContents.reload(); });
  await waitFor(() => !!window.OlangaWorkspace && !!document.getElementById('workspaceOpen') && document.querySelectorAll('#quickActionsEditor fieldset').length === 5, 'Workspace did not initialize after reload');
  await pause(300); await quiet();
}
async function scenario(name, task) {
  try { await task(); report.checks.push({ name, passed: true }); }
  catch (error) {
    const detail = await evaluate(() => ({ status: document.getElementById('workspaceStatus')?.textContent, reviews: [...document.querySelectorAll('.routine-review')].map(node => ({ open: node.open, text: node.innerText })), runs: window.OlangaWorkspace.snapshot().runs, activity: window.OlangaWorkspace.snapshot().activity })).catch(() => null);
    report.checks.push({ name, passed: false, error: error.message, detail }); console.error(`Workspace check failed (${name}): ${error.message}\n${JSON.stringify(detail)}`);
  }
}
function finish(code) {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'workspace-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(code);
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
    await waitFor(() => !!window.OlangaWorkspace && !!document.getElementById('workspaceOpen') && document.querySelectorAll('#quickActionsEditor fieldset').length === 5, 'Workspace did not initialize');
    await pause(300); await quiet();
    report.window = { bounds: main.getBounds(), zoomFactor: main.webContents.getZoomFactor() };

    await scenario('Keyless setup enters the home screen without microphone or model initialization', async () => {
      assert.equal(await evaluate(() => document.getElementById('setupScreen').classList.contains('hidden')), false);
      await click('#startLocalBtn');
      assert.deepEqual(await evaluate(() => ({ main: !document.getElementById('mainScreen').classList.contains('hidden'), setup: document.getElementById('setupScreen').classList.contains('hidden'), mic: !!micStream, micCalls: window.__workspaceSmokeMicCalls, modelReady: isVoskReady, local: localStorage.getItem('olanga_local_setup') })), { main: true, setup: true, mic: false, micCalls: 0, modelReady: false, local: 'true' });
      await screenshot('home');
    });

    await scenario('Saved app aliases and playlists can be saved, edited, enabled, disabled and restored', async () => {
      await open(); await tab(2);
      assert.equal(await evaluate(() => document.getElementById('memoryEnabled').checked), false);
      await fill({ '#memoryKind': 'aliases', '#memoryAlias': 'work browser', '#memoryTarget': 'Chrome' }); await click('#memoryForm button[type="submit"]');
      await rowButton('#memoryList', 'work browser', 'Edit');
      assert.equal(await evaluate(() => document.activeElement.id), 'memoryTarget');
      await fill({ '#memoryAlias': 'temporary browser name' }); await click('#memoryForm button[type="submit"]');
      assert.deepEqual(await evaluate(() => window.OlangaWorkspace.snapshot().aliases), [{ alias: 'temporary browser name', target: 'Chrome' }]);
      await rowButton('#memoryList', 'temporary browser name', 'Edit');
      await fill({ '#memoryAlias': 'work browser' });
      await fill({ '#memoryTarget': 'Firefox' }); await click('#memoryForm button[type="submit"]');
      await fill({ '#memoryKind': 'playlists', '#memoryAlias': 'deep focus', '#memoryTarget': 'Quiet Coding' }); await click('#memoryForm button[type="submit"]');
      await rowButton('#memoryList', 'deep focus', 'Edit');
      await fill({ '#memoryTarget': 'Evening Focus' }); await click('#memoryForm button[type="submit"]');
      const saved = await evaluate(() => window.OlangaWorkspace.snapshot());
      assert.deepEqual(saved.aliases, [{ alias: 'work browser', target: 'Firefox' }]);
      assert.deepEqual(saved.playlists, [{ alias: 'deep focus', target: 'Evening Focus' }]);
      assert.equal(await evaluate(() => OlangaIntents.parse('open work browser', window.OlangaWorkspace.options())), null);
      await click('#memoryEnabled');
      assert.deepEqual(await evaluate(() => [OlangaIntents.parse('open work browser', window.OlangaWorkspace.options())[0].command, OlangaIntents.parse('play deep focus', window.OlangaWorkspace.options())[0].command]), ['[OPEN_APP: Firefox]', '[SPOTIFY_LIBRARY: Evening Focus]']);
      await click('#memoryEnabled');
      assert.deepEqual(await evaluate(() => window.OlangaWorkspace.options()), {});
      await click('#memoryEnabled'); await screenshot('saved-names');
      await reload(); await open(); await tab(2);
      assert.equal(await evaluate(() => document.getElementById('memoryEnabled').checked), true);
      assert.deepEqual(await evaluate(() => window.OlangaWorkspace.snapshot().aliases), saved.aliases);
      assert.deepEqual(await evaluate(() => window.OlangaWorkspace.snapshot().playlists), saved.playlists);
    });

    await scenario('Saved names delete controls remove only the selected records and persist', async () => {
      await open(); await tab(2);
      await rowButton('#memoryList', 'work browser', 'Delete'); await rowButton('#memoryList', 'deep focus', 'Delete');
      await reload(); await open(); await tab(2);
      assert.deepEqual(await evaluate(() => [window.OlangaWorkspace.snapshot().aliases.length, window.OlangaWorkspace.snapshot().playlists.length]), [0, 0]);
    });

    let originalTimer;
    await scenario('Routine form and review cancel execute no steps; reviewed run makes exactly the two local changes', async () => {
      await open(); await tab(1);
      await fill({ '#routineName': 'Fixture focus', '#routineLines': 'Set a timer for 20 minutes called Workspace QA\nAdd Workspace fixture task to my checklist' }); await click('#routineForm button[type="submit"]');
      assert.equal(await evaluate(() => window.OlangaWorkspace.snapshot().routines.length), 1);
      await rowButton('#routineList', 'Fixture focus', 'Edit');
      assert.equal(await evaluate(() => document.activeElement.id), 'routineName');
      await fill({ '#routineName': 'Workspace fixture' }); await click('#routineForm button[type="submit"]');
      await rowButton('#routineList', 'Workspace fixture', 'Review & run');
      assert.deepEqual(await evaluate(() => ({ open: document.querySelector('.routine-review').open, selected: [...document.querySelectorAll('.routine-review input')].map(node => node.checked), timers: activeTimers.length, tasks: activeTasks.length })), { open: true, selected: [true, true], timers: 0, tasks: 0 });
      assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.routine-review label span')].map(node => node.textContent)), ['Start timer: 20 minutes · “Workspace QA” · pending', 'Add task: “Workspace fixture task” · pending']);
      assert.equal(await evaluate(() => { const review = document.querySelector('.routine-review'); return document.getElementById(review.getAttribute('aria-labelledby'))?.textContent; }), 'Workspace fixture');
      await screenshot('routine-review');
      await evaluate(() => document.querySelectorAll('.routine-review[open] input').forEach(node => node.click()));
      await reviewButton('Run selected steps');
      await waitFor(() => /Select at least one/.test(document.querySelector('.routine-review [role="alert"]')?.textContent || ''), 'Empty selection did not show an error inside the review');
      assert.deepEqual(await evaluate(() => ({ open: document.querySelector('.routine-review').open, visible: !!document.querySelector('.routine-review [role="alert"]').getClientRects().length, timers: activeTimers.length, tasks: activeTasks.length })), { open: true, visible: true, timers: 0, tasks: 0 });
      await reviewButton('Cancel');
      await waitFor(() => document.querySelectorAll('.routine-review').length === 0, 'Cancelled review was not removed');
      assert.deepEqual(await evaluate(() => [activeTimers.length, activeTasks.length, window.OlangaWorkspace.snapshot().runs.length]), [0, 0, 0]);
      await rowButton('#routineList', 'Workspace fixture', 'Review & run');
      await evaluate(() => {
        const review = document.querySelector('.routine-review[open]');
        const buttons = [...review.querySelectorAll('button')];
        const staleApproval = buttons.find(node => node.textContent === 'Run selected steps');
        buttons.find(node => node.textContent === 'Cancel').click();
        // A queued event on a closing dialog must not resurrect its approval.
        staleApproval.click();
      });
      await waitFor(() => document.querySelectorAll('.routine-review').length === 0, 'Stale review did not close');
      assert.deepEqual(await evaluate(() => [activeTimers.length, activeTasks.length, window.OlangaWorkspace.snapshot().runs.length]), [0, 0, 0]);
      await rowButton('#routineList', 'Workspace fixture', 'Review & run');
      await reviewButton('Run selected steps');
      await waitFor(() => window.OlangaWorkspace.snapshot().runs.at(-1)?.state === 'completed', 'Reviewed routine did not complete');
      const outcome = await evaluate(() => ({ timers: activeTimers.map(item => ({ id: item.id, label: item.label, endTime: item.endTime })), tasks: activeTasks.map(item => item.text), run: window.OlangaWorkspace.snapshot().runs.at(-1) }));
      assert.equal(outcome.timers.length, 1); assert.equal(outcome.timers[0].label, 'Workspace QA');
      assert.deepEqual(outcome.tasks, ['Workspace fixture task']); assert.deepEqual(outcome.run.steps.map(step => step.state), ['completed', 'completed']);
      originalTimer = outcome.timers[0];
      await open(); await tab(1); await screenshot('routines');
    });

    await scenario('Session activity shows actual receipts and is not retained by default', async () => {
      await open(); await tab(0);
      const state = await evaluate(() => ({ visible: document.getElementById('activityList').innerText, state: window.OlangaWorkspace.snapshot().activity, stored: JSON.parse(localStorage.getItem(OlangaProductivity.KEY)).activity, enabled: document.getElementById('saveActivity').checked }));
      assert.ok(state.state.length); assert.equal(state.enabled, false); assert.deepEqual(state.stored, []);
      assert.match(state.visible, /Start timer/); assert.match(state.visible, /Add task/);
      assert.match(state.visible, /Workspace QA/); assert.match(state.visible, /Workspace fixture task/);
      assert.doesNotMatch(JSON.stringify(state.stored), /Workspace QA|fixture task|details/);
      await screenshot('activity-private');
    });

    await scenario('Reload retains completed routine receipts, timer deadline and checklist without replay', async () => {
      await reload(); await open(); await tab(1);
      const state = await evaluate(() => ({ timers: activeTimers.map(item => ({ id: item.id, label: item.label, endTime: item.endTime })), tasks: activeTasks.map(item => item.text), run: window.OlangaWorkspace.snapshot().runs.at(-1), activity: window.OlangaWorkspace.snapshot().activity, resumeButtons: [...document.querySelectorAll('#routineRuns button')].filter(node => node.textContent === 'Review unfinished steps').length }));
      assert.deepEqual(state.timers, [originalTimer]); assert.deepEqual(state.tasks, ['Workspace fixture task']);
      assert.equal(state.run.state, 'completed'); assert.deepEqual(state.run.steps.map(step => step.state), ['completed', 'completed']);
      assert.deepEqual(state.activity, []); assert.equal(state.resumeButtons, 0);
      await rowButton('#routineList', 'Workspace fixture', 'Delete');
      assert.equal(await evaluate(() => window.OlangaWorkspace.snapshot().routines.length), 0);
    });

    await scenario('Enabled activity persists operation-only records and Clear removes them', async () => {
      await open(); await tab(0); await click('#saveActivity'); await click('#workspaceClose');
      await fill({ '#textCommandInput': 'Show my tasks' }); await click('#textCommandBtn');
      await waitFor(() => window.OlangaWorkspace.snapshot().activity.at(-1)?.state === 'completed', 'Local status request did not complete');
      const persisted = await evaluate(() => JSON.parse(localStorage.getItem(OlangaProductivity.KEY)).activity);
      assert.ok(persisted.length);
      assert.doesNotMatch(JSON.stringify(persisted), /Workspace|fixture task|Show my tasks|details/);
      for (const item of persisted) for (const step of item.steps) assert.deepEqual(Object.keys(step).sort(), ['operation', 'state']);
      await reload(); await open(); await tab(0);
      const state = await evaluate(() => ({ items: window.OlangaWorkspace.snapshot().activity, saved: JSON.parse(localStorage.getItem(OlangaProductivity.KEY)).activity, visible: document.getElementById('activityList').innerText }));
      assert.ok(state.items.length); assert.deepEqual(state.saved, state.items);
      assert.doesNotMatch(JSON.stringify(state.items), /Workspace|fixture task|Show my tasks/);
      assert.match(state.visible, /Check tasks/);
      await screenshot('activity-retained');
      await click('#activityClear'); assert.equal(await evaluate(() => window.OlangaWorkspace.snapshot().activity.length), 0);
    });

    await scenario('Punctuated typed routine requests open review; cancel and superseding requests invalidate it', async () => {
      await open(); await tab(1);
      await fill({ '#routineName': 'Focus', '#routineLines': 'Add Focus fixture task to my checklist' }); await click('#routineForm button[type="submit"]');
      await click('#workspaceClose'); await fill({ '#textCommandInput': 'Run routine Focus.' }); await click('#textCommandBtn');
      await waitFor(() => document.querySelector('.routine-review')?.open && window.OlangaWorkspace.snapshot().activity.at(-1)?.state === 'awaiting-input', 'Punctuated routine request did not reach review');
      assert.equal(await evaluate(() => document.querySelector('.routine-review h2').textContent), 'Focus');
      await reviewButton('Cancel');
      await waitFor(() => window.OlangaWorkspace.snapshot().activity.at(-1)?.state === 'cancelled', 'Cancelling review did not leave activity cancelled');
      assert.deepEqual(await evaluate(() => [activeTimers.length, activeTasks.length]), [1, 1]);
      await fill({ '#textCommandInput': 'Run routine Focus.' }); await click('#textCommandBtn');
      await waitFor(() => document.querySelector('.routine-review')?.open, 'Second routine review did not open');
      // Simulate a new spoken request at the same production entry point. The
      // previous modal makes the main text field inert, as it should.
      await evaluate(async () => { await processTextCommandWithGemini('Show my tasks'); });
      assert.equal(await evaluate(() => document.querySelectorAll('.routine-review[open]').length), 0);
      assert.deepEqual(await evaluate(() => [activeTimers.length, activeTasks.length]), [1, 1]);
    });

    await scenario('Activity step updates preserve saved names and in-progress memory form text', async () => {
      await open(); await tab(2);
      await fill({ '#memoryKind': 'aliases', '#memoryAlias': 'persistent browser', '#memoryTarget': 'Chrome' }); await click('#memoryForm button[type="submit"]');
      await fill({ '#memoryKind': 'aliases', '#memoryAlias': 'draft alias', '#memoryTarget': 'Edge' });
      await evaluate(() => { const entry = window.OlangaActivity.begin(); const step = window.OlangaActivity.step(entry, 'TASK_STATUS'); window.OlangaActivity.receipt(entry, step, 'completed'); window.OlangaActivity.finish(entry, 'completed'); });
      assert.deepEqual(await evaluate(() => ({ aliases: window.OlangaWorkspace.snapshot().aliases, aliasDraft: document.getElementById('memoryAlias').value, targetDraft: document.getElementById('memoryTarget').value })), { aliases: [{ alias: 'persistent browser', target: 'Chrome' }], aliasDraft: 'draft alias', targetDraft: 'Edge' });
      await click('#memoryClear');
      assert.deepEqual(await evaluate(() => [window.OlangaWorkspace.snapshot().aliases.length, window.OlangaWorkspace.snapshot().playlists.length, document.getElementById('memoryEnabled').checked]), [0, 0, false]);
    });

    await scenario('Interrupted run review disables completed steps and selects only untouched unfinished steps', async () => {
      await open(); await tab(1);
      await fill({ '#routineName': 'Resume fixture', '#routineLines': 'Set a timer for 20 minutes called Workspace QA\nAdd Uncertain fixture task to my checklist\nAdd Unverified fixture task to my checklist\nAdd Resumed fixture task to my checklist' }); await click('#routineForm button[type="submit"]');
      // Persist the exact journal state of a crash after step one completed and
      // step two was dispatched. The timer from the prior real run is its effect.
      await evaluate(() => {
        const routine = window.OlangaWorkspace.snapshot().routines.find(item => item.name === 'Resume fixture');
        const actions = routine.lines.flatMap(line => OlangaIntents.parse(line));
        const run = window.OlangaWorkspace.createRun(routine, actions);
        window.OlangaWorkspace.transitionRun(run.id, 0, 'completed');
        window.OlangaWorkspace.transitionRun(run.id, 1, 'working');
        window.OlangaWorkspace.transitionRun(run.id, 2, 'unverified');
      });
      await reload();
      assert.deepEqual(await evaluate(() => [activeTimers.length, activeTasks.length]), [1, 1]);
      await open(); await tab(1); await rowButton('#routineRuns', 'Resume fixture', 'Review unfinished steps');
      assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.routine-review input')].map(node => ({ disabled: node.disabled, checked: node.checked }))), [{ disabled: true, checked: false }, { disabled: false, checked: false }, { disabled: false, checked: false }, { disabled: false, checked: true }]);
      assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.routine-review label span')].map(node => node.textContent)), ['Start timer: 20 minutes · “Workspace QA” · completed', 'Add task: “Uncertain fixture task” · uncertain', 'Add task: “Unverified fixture task” · unverified', 'Add task: “Resumed fixture task” · pending']);
      assert.equal(await evaluate(() => { const review = document.querySelector('.routine-review'); return document.getElementById(review.getAttribute('aria-labelledby'))?.textContent; }), 'Resume: Resume fixture');
      await screenshot('resume-review');
      await reviewButton('Run selected steps');
      await waitFor(() => window.OlangaWorkspace.snapshot().runs.find(run => run.name === 'Resume fixture')?.state === 'completed', 'Selected unfinished step did not complete');
      assert.deepEqual(await evaluate(() => ({ timers: activeTimers.map(item => ({ id: item.id, label: item.label, endTime: item.endTime })), tasks: activeTasks.map(item => item.text), states: window.OlangaWorkspace.snapshot().runs.find(run => run.name === 'Resume fixture').steps.map(step => step.state) })), { timers: [originalTimer], tasks: ['Workspace fixture task', 'Resumed fixture task'], states: ['completed', 'skipped', 'skipped', 'completed'] });
    });

    await scenario('Routine review shows faithful app, layout, volume and playlist labels without command syntax', async () => {
      await open(); await tab(1);
      const lines = 'Open Spotify\nSet volume to 75%\nMove Chrome to the left\nPlay my playlist Quiet Coding\nSet a timer for 1 minute and 30 seconds called Short break';
      await fill({ '#routineName': 'Readable review', '#routineLines': lines }); await click('#routineForm button[type="submit"]');
      const before = await evaluate(() => ({ timers: activeTimers.length, tasks: activeTasks.length, runs: window.OlangaWorkspace.snapshot().runs.length }));
      await rowButton('#routineList', 'Readable review', 'Review & run');
      assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.routine-review label span')].map(node => node.textContent)), ['Open app: “Spotify” · pending', 'Set system volume to 75% · pending', 'Move “Chrome” to the left half · pending', 'Play private Spotify playlist: “Quiet Coding” · pending', 'Start timer: 1 minute 30 seconds · “Short break” · pending']);
      assert.doesNotMatch(await evaluate(() => document.querySelector('.routine-review').innerText), /\[(?:OPEN_APP|VOLUME_SET|ARRANGE_APP|SPOTIFY_LIBRARY|SET_TIMER)/);
      await screenshot('routine-labels');
      await reviewButton('Cancel');
      assert.deepEqual(await evaluate(() => ({ timers: activeTimers.length, tasks: activeTasks.length, runs: window.OlangaWorkspace.snapshot().runs.length })), before);
      assert.equal(await evaluate(() => window.OlangaWorkspace.snapshot().routines.find(routine => routine.name === 'Readable review').lines.join('\n')), lines);
      await rowButton('#routineList', 'Readable review', 'Delete');
    });

    await scenario('Diagnostics opt-in renders timings, exports local metadata and clears on request or opt-out', async () => {
      await open(); await tab(4);
      assert.equal(await evaluate(() => document.getElementById('diagnosticsEnabled').checked), false);
      await click('#diagnosticsEnabled');
      await evaluate(() => { window.OlangaActivity.timing('execution', 123, 'ok'); window.OlangaActivity.timing('execution', 456, 'error'); });
      assert.match(await evaluate(() => document.getElementById('timingList').innerText), /2 samples.*1 errors/);
      await evaluate(() => {
        const refresh = [...document.querySelectorAll('[data-workspace-page="4"] button')].find(node => node.textContent === 'Refresh Gemini usage');
        if (!refresh || !refresh.getClientRects().length) throw new Error('Gemini diagnostics refresh is unavailable');
        refresh.focus(); refresh.click();
      });
      await waitFor(() => /0 requests/.test(document.getElementById('providerUsage')?.textContent || ''), 'Provider diagnostics did not return the empty local session totals');
      await screenshot('diagnostics'); await click('#timingsExport');
      for (let attempt = 0; attempt < 50 && !report.export; attempt++) await pause(100);
      assert.equal(report.export?.state, 'completed');
      assert.deepEqual(JSON.parse(fs.readFileSync(report.export.path, 'utf8')).timings, [{ phase: 'execution', ms: 123, outcome: 'ok' }, { phase: 'execution', ms: 456, outcome: 'error' }]);
      await click('#timingsClear'); assert.equal(await evaluate(() => window.OlangaWorkspace.snapshot().timings.length), 0);
      await evaluate(() => window.OlangaActivity.timing('planning', 99, 'ok'));
      await click('#diagnosticsEnabled');
      assert.deepEqual(await evaluate(() => [window.OlangaWorkspace.snapshot().timings.length, JSON.parse(localStorage.getItem(OlangaProductivity.KEY)).timings.length]), [0, 0]);
    });

    await scenario('Offline transcript review supports cancel, correction, send and abort without executing anything', async () => {
      if (await evaluate(() => document.getElementById('workspaceDialog').open)) await click('#workspaceClose');
      const beforeReview = await evaluate(() => [activeTimers.length, activeTasks.length]);
      for (const mode of ['cancel', 'edit', 'abort']) {
        await evaluate(() => {
          window.__workspaceReviewResult = 'pending'; window.__workspaceReviewController = new AbortController();
          window.reviewOfflineTranscript('set timer seven minutes', window.__workspaceReviewController.signal).then(value => { window.__workspaceReviewResult = value; });
        });
        assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-label')), 'Recognized request');
        assert.equal(await evaluate(() => { const review = document.querySelector('dialog[open]'); return document.getElementById(review.getAttribute('aria-labelledby'))?.textContent; }), 'Review what Olanga heard');
        if (mode === 'cancel') await evaluate(() => [...document.querySelectorAll('dialog[open] button')].find(node => node.textContent === 'Cancel').click());
        else if (mode === 'edit') { await fill({ 'dialog[open] textarea[aria-label="Recognized request"]': 'Set a timer for five minutes' }); await screenshot('offline-review'); await evaluate(() => [...document.querySelectorAll('dialog[open] button')].find(node => node.textContent === 'Send request').click()); }
        else await evaluate(() => window.__workspaceReviewController.abort());
        await waitFor(() => window.__workspaceReviewResult !== 'pending', 'Transcript review did not settle');
        assert.equal(await evaluate(() => window.__workspaceReviewResult), mode === 'edit' ? 'Set a timer for five minutes' : null);
        assert.equal(await evaluate(() => document.querySelectorAll('dialog[open]').length), 0);
      }
      assert.deepEqual(await evaluate(() => [activeTimers.length, activeTasks.length]), beforeReview, 'Transcript review itself must never execute an action');
    });

    await scenario('Manual checklist save failure retains input, rolls back the checkbox and displays the problem', async () => {
      if (await evaluate(() => document.getElementById('workspaceDialog').open)) await click('#workspaceClose');
      const before = await evaluate(() => activeTasks.map(task => ({ ...task })));
      await evaluate(() => {
        window.__workspaceOriginalStorageSet = Storage.prototype.setItem;
        window.__workspaceOriginalConsoleError = console.error;
        console.error = (...args) => { if (args[0] !== 'Failed to save tasks:') window.__workspaceOriginalConsoleError(...args); };
        Storage.prototype.setItem = function (key, value) { if (key === 'olanga_tasks') throw new Error('Simulated disk full'); return window.__workspaceOriginalStorageSet.call(this, key, value); };
      });
      try {
        await fill({ '#taskInput': 'Unsaved fixture task' }); await click('#addTaskBtn');
        assert.equal(await evaluate(() => document.getElementById('taskInput').value), 'Unsaved fixture task');
        assert.deepEqual(await evaluate(() => activeTasks.map(task => ({ ...task }))), before);
        assert.match(await evaluate(() => document.getElementById('tasksSaveStatus').textContent), /Nothing was changed/);
        await click('#tasksList .task-checkbox');
        assert.deepEqual(await evaluate(() => activeTasks.map(task => ({ ...task }))), before);
        assert.equal(await evaluate(() => document.querySelector('#tasksList .task-checkbox').checked), before[0].completed);
      } finally {
        await evaluate(() => { Storage.prototype.setItem = window.__workspaceOriginalStorageSet; console.error = window.__workspaceOriginalConsoleError; document.getElementById('taskInput').value = ''; });
      }
    });

    await scenario('Apps tab explains manual discovery and updates without doing native or network work', async () => {
      await open(); await tab(3);
      assert.match(await evaluate(() => document.querySelector('[data-workspace-page="3"]').innerText), /App capabilities/);
      await screenshot('apps');
    });

    await scenario('Smoke made no microphone, provider or privileged native call and no renderer error', async () => {
      assert.equal(await evaluate(() => window.__workspaceSmokeMicCalls), 0);
      assert.deepEqual(report.forbiddenCalls, []);
      assert.deepEqual(report.permissionRequests.filter(permission => permission === 'media'), []);
      assert.deepEqual(report.rendererErrors, []);
    });
    report.passed = report.checks.every(check => check.passed);
    finish(report.passed ? 0 : 1);
  } catch (error) { report.error = error.stack || error.message; finish(1); }
});
setTimeout(() => { report.error = 'Workspace smoke exceeded its 90-second deadline.'; finish(1); }, 90000).unref();
