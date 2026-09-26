/* Local workspace preferences, activity, and reviewed routines. */
(function () {
  const store = OlangaProductivity.createStore(localStorage);
  window.OlangaWorkspace = store;
  window.OlangaActivity = store;
  let dialogSequence = 0;
  window.reviewOfflineTranscript = (transcript, signal) => new Promise(resolve => {
    const review = document.createElement('dialog'); review.className = 'workspace-dialog';
    const title = document.createElement('h2'); title.textContent = 'Review what Olanga heard'; title.id = `workspaceOfflineTitle-${++dialogSequence}`;
    review.setAttribute('aria-labelledby', title.id);
    const hint = document.createElement('p'); hint.className = 'workspace-help'; hint.textContent = 'On-device recognition may miss words. Correct the transcript before sending. Nothing has run yet.';
    const input = document.createElement('textarea'); input.value = transcript; input.rows = 4; input.maxLength = 1000; input.setAttribute('aria-label', 'Recognized request');
    const controls = document.createElement('div'); controls.className = 'workspace-actions';
    let settled = false;
    const finish = value => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); review.close(); review.remove(); resolve(value); };
    const abort = () => finish(null);
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => finish(null);
    const send = document.createElement('button'); send.type = 'button'; send.textContent = 'Send request'; send.onclick = () => { if (input.value.trim()) finish(input.value.trim()); else input.focus(); };
    controls.append(cancel, send); review.append(title, hint, input, controls); document.body.append(review);
    review.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { finish(null); return; }
    review.showModal(); input.focus();
  });
  const labels = { OPEN_APP: 'Open app', ARRANGE_APP: 'Arrange app', SET_TIMER: 'Start timer', CANCEL_TIMER: 'Cancel timer', CLEAR_ALL_TIMERS: 'Clear timers', TIMER_STATUS: 'Check timers', ADD_TASK: 'Add task', REMOVE_TASK: 'Remove task', COMPLETE_TASK: 'Complete task', UNCOMPLETE_TASK: 'Reopen task', SET_TASK_DUE: 'Change due date', CLEAR_ALL_TASKS: 'Clear checklist', TASK_STATUS: 'Check tasks', VOLUME_SET: 'Set volume', VOLUME_STATUS: 'Check volume', VOLUME_MUTE_ON: 'Mute audio', VOLUME_MUTE_OFF: 'Unmute audio', VOLUME_MUTE: 'Toggle mute',
    SET_REMINDER: 'Set reminder', SET_ALARM: 'Set alarm', STOP_TIMER: 'Stop alarm', REMEMBER: 'Remember', FORGET: 'Forget memory', MEMORY_STATUS: 'List memories', CLEAR_MEMORIES: 'Delete memories', DAILY_BRIEFING: 'Daily briefing', TIME_STATUS: 'Tell the time', DATE_STATUS: 'Tell the date', HELP: 'Help', DISMISS: 'Dismiss' };
  const pretty = value => String(value).replaceAll('_', ' ').replaceAll('-', ' ').toLowerCase();
  const operationLabel = value => labels[value] || pretty(value);
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const button = (text, handler) => { const node = el('button', text); node.type = 'button'; node.addEventListener('click', handler); return node; };
  const panel = el('dialog', undefined, 'workspace-dialog');
  panel.id = 'workspaceDialog';
  panel.setAttribute('aria-labelledby', 'workspaceTitle');
  panel.innerHTML = `<header><div><p class="workspace-eyebrow">YOUR DESKTOP</p><h2 id="workspaceTitle">Workspace</h2></div><button type="button" id="workspaceClose" aria-label="Close workspace">×</button></header>
    <nav aria-label="Workspace sections">${['Activity', 'Routines', 'Saved names', 'Apps', 'Diagnostics', 'Memories', 'Health'].map((title, i) => `<button type="button" data-workspace-tab="${i}" aria-pressed="${i === 0}">${title}</button>`).join('')}</nav>
    <p id="workspaceStatus" role="status" aria-live="polite"></p>
    <section data-workspace-page="0"><div class="workspace-heading"><h3>Recent activity</h3><button type="button" id="activityClear">Clear</button></div><p class="workspace-help">Current-session receipts show actual results. Saved history keeps only operation types and statuses, without prompts, screenshots, task names, or document text.</p><label class="workspace-check"><input type="checkbox" id="saveActivity"> Keep activity after restart</label><div id="activityList"></div></section>
    <section data-workspace-page="1" hidden><h3>Routines</h3><p class="workspace-help">Save common local commands, one per line. Review every run before it starts. Interrupted runs never restart automatically.</p><form id="routineForm"><label for="routineName">Name</label><input id="routineName" maxlength="100" required placeholder="Focus time"><label for="routineLines">Commands</label><textarea id="routineLines" rows="5" required placeholder="Open Spotify&#10;Set volume to 25%&#10;Set a timer for 25 minutes called Focus"></textarea><div class="workspace-actions"><button type="submit">Save routine</button><button type="button" id="routineReset">New routine</button></div></form><div id="routineList"></div><h3>Previous runs</h3><div id="routineRuns"></div></section>
    <section data-workspace-page="2" hidden><h3>Saved names</h3><p class="workspace-help">Choose your own names for supported apps and private Spotify playlists. Olanga remembers only what you save here.</p><label class="workspace-check"><input type="checkbox" id="memoryEnabled"> Use my saved names</label><form id="memoryForm"><label for="memoryKind">Type</label><select id="memoryKind"><option value="aliases">App alias</option><option value="playlists">Playlist preference</option></select><label for="memoryAlias">Your name</label><input id="memoryAlias" maxlength="100" required placeholder="work browser"><label for="memoryTarget">App or private playlist name</label><input id="memoryTarget" maxlength="100" required placeholder="Chrome"><button type="submit">Save name</button></form><div id="memoryList"></div><button type="button" id="memoryClear">Delete all saved names</button></section>
    <section data-workspace-page="3" hidden><div class="workspace-heading"><h3>App capabilities</h3><button type="button" id="appsRefresh">Refresh</button></div><p class="workspace-help">Check which supported apps Windows can find. Other app names can still use Windows Search, with an unverified result.</p><div id="capabilitiesList">Select Refresh to check installed apps.</div><hr><h3>Updates</h3><p class="workspace-help">Check releases manually. Olanga never downloads or installs an update automatically.</p><button type="button" id="checkRelease">Check for updates</button><div id="releaseStatus" role="status"></div></section>
    <section data-workspace-page="4" hidden><h3>Performance</h3><label class="workspace-check"><input type="checkbox" id="diagnosticsEnabled"> Collect local performance measurements</label><p class="workspace-help">Stores timings and success/error categories only. Nothing is uploaded. Turning this off deletes measurements.</p><div class="workspace-actions"><button type="button" id="timingsClear">Clear measurements</button><button type="button" id="timingsExport">Export measurements</button></div><div id="timingList"></div></section>
    <section data-workspace-page="5" hidden><h3>Memories</h3><p class="workspace-help">Things you asked Olanga to remember, for example “remember that my locker code is 4312”. Olanga never adds memories on its own. While enabled, memories are sent to Gemini with your requests so answers can use them.</p><label class="workspace-check"><input type="checkbox" id="factsEnabled"> Use my memories in answers</label><form id="factForm"><label for="factText">Add a memory</label><input id="factText" maxlength="300" required placeholder="My sister's birthday is June 5"><button type="submit">Save memory</button></form><div id="factList"></div><button type="button" id="factsClear">Delete all memories</button></section>
    <section data-workspace-page="6" hidden><div class="workspace-heading"><h3>Health check</h3><button type="button" id="healthRun">Run check</button></div><p class="workspace-help">Checks the microphone, wake word, speech, voice, Gemini and storage without changing anything. The connection test sends one short request to Gemini.</p><p id="healthSummary" class="health-summary" role="status" aria-live="polite"></p><div id="healthList"></div><button type="button" id="healthTest">Test Gemini connection</button></section>`;
  document.body.append(panel);
  const status = panel.querySelector('#workspaceStatus');
  function message(text, error = false) { status.textContent = text; status.classList.toggle('workspace-error', error); }
  function guarded(action) { return async () => { try { await action(); } catch (error) { message(error.message || 'That change could not be completed.', true); } }; }
  let editingRoutine = null, editingMemory = null;
  function open(tab = '0') {
    for (const page of panel.querySelectorAll('[data-workspace-page]')) page.hidden = page.dataset.workspacePage !== String(tab);
    for (const tabButton of panel.querySelectorAll('[data-workspace-tab]')) tabButton.setAttribute('aria-pressed', String(tabButton.dataset.workspaceTab === String(tab)));
    if (!panel.open) panel.showModal();
    if (String(tab) === '6') runHealthCheck().catch(error => message(error.message || 'The health check could not run.', true));
  }
  window.openOlangaWorkspace = open;
  panel.querySelector('#workspaceClose').addEventListener('click', () => panel.close());
  panel.querySelectorAll('[data-workspace-tab]').forEach(node => node.addEventListener('click', () => open(node.dataset.workspaceTab)));
  const launch = button('Workspace', () => open()); launch.className = 'workspace-launch'; launch.id = 'workspaceOpen';
  document.querySelector('.top-bar')?.append(launch);
  const peek = el('div', undefined, 'activity-peek'); peek.id = 'activityPeek'; peek.setAttribute('aria-live', 'polite');
  document.getElementById('transcriptArea')?.append(peek);
  function row(title, subtitle) { const item = el('div', undefined, 'workspace-item'); const content = el('div'); content.append(el('strong', title), el('p', subtitle, 'workspace-help')); item.append(content); return item; }
  function render() {
    const state = store.snapshot();
    for (const [nodeId, key] of [['saveActivity', 'saveActivity'], ['memoryEnabled', 'memoryEnabled'], ['diagnosticsEnabled', 'diagnostics'], ['factsEnabled', 'factsEnabled']]) panel.querySelector('#' + nodeId).checked = state[key];
    const factList = panel.querySelector('#factList'); factList.replaceChildren();
    for (const fact of state.facts.slice().reverse()) {
      const item = row(fact.text, `Saved ${new Date(fact.at).toLocaleDateString()}`);
      item.append(button('Delete', guarded(() => store.deleteFact(fact.id)))); factList.append(item);
    }
    if (!state.facts.length) factList.append(el('p', 'Nothing saved yet. Say “remember that…” or add a memory above.', 'workspace-help'));
    const activity = panel.querySelector('#activityList'); activity.replaceChildren();
    const latest = state.activity.at(-1);
    const currentStep = latest?.steps.find(step => step.state === 'working') || latest?.steps.findLast(step => step.state !== 'pending' && step.state !== 'skipped');
    peek.textContent = latest ? `${currentStep ? operationLabel(currentStep.operation) + ' · ' : ''}${pretty(latest.state)}` : '';
    peek.hidden = !latest;
    for (const entry of state.activity.slice().reverse()) {
      const item = row(new Date(entry.at).toLocaleTimeString(), pretty(entry.state));
      const steps = el('ol'); entry.steps.forEach(step => { const line = el('li', `${operationLabel(step.operation)} — ${pretty(step.state)}`); if (step.details) line.append(el('p', step.details, 'workspace-help')); steps.append(line); }); item.firstChild.append(steps);
      if (entry.id === state.activity.at(-1)?.id && ['working', 'awaiting-input'].includes(entry.state)) item.append(button('Cancel request', () => { cancelAssistantRequest(); setState(State.IDLE); }));
      item.append(button('Delete', guarded(() => store.clearActivity(entry.id)))); activity.append(item);
    }
    if (!state.activity.length) activity.append(el('p', 'Your next request will appear here.', 'workspace-help'));
    const routineList = panel.querySelector('#routineList'); routineList.replaceChildren();
    for (const routine of state.routines) {
      const item = row(routine.name, `${routine.lines.length} command${routine.lines.length === 1 ? '' : 's'}`);
      const actions = el('div', undefined, 'workspace-actions');
      actions.append(button('Review & run', guarded(() => reviewRoutine(routine))), button('Edit', () => { editingRoutine = routine.id; panel.querySelector('#routineName').value = routine.name; panel.querySelector('#routineLines').value = routine.lines.join('\n'); panel.querySelector('#routineName').focus(); }), button('Delete', guarded(() => store.deleteRoutine(routine.id))));
      item.append(actions); routineList.append(item);
    }
    const runs = panel.querySelector('#routineRuns'); runs.replaceChildren();
    for (const run of state.runs.slice().reverse()) {
      const item = row(run.name, `${pretty(run.state)} · ${run.steps.filter(step => step.state === 'completed').length}/${run.steps.length} completed`);
      if (run.steps.some(step => !['completed', 'skipped'].includes(step.state)) && run.state !== 'working') item.append(button('Review unfinished steps', guarded(() => reviewRoutine(null, run))));
      if (run.state !== 'working') item.append(button('Delete record', guarded(() => store.deleteRun(run.id))));
      runs.append(item);
    }
    const memoryList = panel.querySelector('#memoryList'); memoryList.replaceChildren();
    for (const kind of ['aliases', 'playlists']) for (const item of state[kind]) {
      const line = row(item.alias, `${kind === 'aliases' ? 'App' : 'Private playlist'}: ${item.target}`);
      line.append(button('Edit', () => { editingMemory = { kind, alias: item.alias }; panel.querySelector('#memoryKind').value = kind; panel.querySelector('#memoryAlias').value = item.alias; panel.querySelector('#memoryTarget').value = item.target; panel.querySelector('#memoryTarget').focus(); }), button('Delete', guarded(() => {
        store.forget(kind, item.alias);
        if (editingMemory?.kind === kind && editingMemory.alias === item.alias) { editingMemory = null; panel.querySelector('#memoryForm').reset(); }
      }))); memoryList.append(line);
    }
    const timings = panel.querySelector('#timingList'); timings.replaceChildren();
    for (const sample of OlangaProductivity.statistics(state.timings)) timings.append(row(pretty(sample.phase), `${sample.count} samples · median ${Math.round(sample.median)} ms · p95 ${Math.round(sample.p95)} ms · ${sample.failures} errors/cancellations`));
    if (!state.timings.length) timings.append(el('p', 'No measurements collected.', 'workspace-help'));
  }
  store.subscribe(render); render();
  const providerInfo = el('div'); providerInfo.id = 'providerUsage';
  const providerRefresh = button('Refresh Gemini usage', guarded(async () => {
    const usage = await window.electronAPI.providerStatus();
    const totals = usage.totals;
    providerInfo.textContent = `This session: ${totals.requests} requests, ${totals.succeeded} succeeded, ${totals.failed} failed, ${totals.cancelled} cancelled. ${totals.inputTokens} input tokens (${totals.cachedTokens || 0} served from Gemini's cache) and ${totals.outputTokens} output tokens reported by Gemini. ${usage.active} active requests. These counts contain no prompts and reset when Olanga closes.`;
  }));
  panel.querySelector('[data-workspace-page="4"]').append(el('h3', 'Gemini usage'), providerRefresh, providerInfo);
  for (const [nodeId, key] of [['saveActivity', 'saveActivity'], ['memoryEnabled', 'memoryEnabled'], ['diagnosticsEnabled', 'diagnostics'], ['factsEnabled', 'factsEnabled']]) panel.querySelector('#' + nodeId).addEventListener('change', guarded(() => { store.preference(key, panel.querySelector('#' + nodeId).checked); message('Preference saved on this device.'); }));
  panel.querySelector('#factForm').addEventListener('submit', event => {
    event.preventDefault(); guarded(() => {
      const input = panel.querySelector('#factText');
      store.rememberFact(input.value); input.value = ''; message('Memory saved on this device.');
    })();
  });
  panel.querySelector('#factsClear').addEventListener('click', guarded(() => { const count = store.clearFacts(); message(count ? 'All memories deleted.' : 'There were no memories to delete.'); }));

  // Health checks read local state only; the optional connection test is the
  // single provider request, and it runs only when the user asks for it.
  const HEALTH_ICONS = { ok: '✓', info: 'i', warn: '!', fail: '✕' };
  let lastGeminiTest = null;
  async function healthSnapshot() {
    let inputs = null, status = {}, appInfo = null, writable = true;
    try { inputs = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput').length; } catch (_) {}
    try { status = await window.electronAPI.providerStatus() || {}; } catch (_) {}
    try { appInfo = await window.electronAPI.getAppInfo?.() || null; } catch (_) {}
    try { localStorage.setItem('olanga_health_probe', '1'); localStorage.removeItem('olanga_health_probe'); } catch (_) { writable = false; }
    return {
      online: navigator.onLine, speechInput: store.snapshot().speechInput, storage: { writable }, app: appInfo,
      microphone: { inputs, active: !!(micStream && micStream.active !== false), muted: !!isMicMuted },
      wakeWord: { ready: !!isVoskReady },
      gemini: { configured: !!status.configured || !!apiKey, recent: Array.isArray(status.recent) ? status.recent : [], test: lastGeminiTest },
      voice: { engine: ttsEngine, magpieKey: !!nvidiaApiKey, magpieCoolingDown: typeof magpieUnavailableUntil === 'number' && magpieUnavailableUntil > Date.now(), windowsVoices: synthesis?.getVoices?.().length ?? null, muted: !!isTtsMuted },
      pushToTalk: typeof pushToTalkStatus === 'object' ? pushToTalkStatus : null
    };
  }
  async function runHealthCheck() {
    const summary = panel.querySelector('#healthSummary'), list = panel.querySelector('#healthList');
    summary.textContent = 'Checking…';
    const checks = OlangaHealth.sort(OlangaHealth.evaluate(await healthSnapshot()));
    list.replaceChildren();
    for (const check of checks) {
      const item = row(`${HEALTH_ICONS[check.status]}  ${check.label}`, check.detail);
      item.dataset.health = check.status;
      if (check.fix) item.firstChild.append(el('p', check.fix, 'workspace-help health-fix'));
      list.append(item);
    }
    summary.textContent = OlangaHealth.summarize(checks);
  }
  panel.querySelector('#healthRun').addEventListener('click', guarded(runHealthCheck));
  panel.querySelector('#healthTest').addEventListener('click', guarded(async () => {
    const control = panel.querySelector('#healthTest'); control.disabled = true;
    panel.querySelector('#healthSummary').textContent = 'Testing the Gemini connection…';
    const started = performance.now();
    try {
      await callGeminiGenerate(OlangaGemini.RESPONSE_MODEL, { contents: [{ parts: [{ text: 'Reply with the single word OK.' }] }], generationConfig: { maxOutputTokens: 64, thinkingConfig: { thinkingLevel: 'MINIMAL' } } }, { timeoutMs: 20000 });
      lastGeminiTest = { ok: true, ms: performance.now() - started };
    } catch (error) { lastGeminiTest = { ok: false, message: error.message || 'The connection test failed.' }; }
    finally { control.disabled = false; }
    await runHealthCheck();
  }));
  panel.querySelector('#activityClear').addEventListener('click', guarded(() => store.clearActivity()));
  panel.querySelector('#memoryClear').addEventListener('click', guarded(() => { store.clearMemory(); editingMemory = null; panel.querySelector('#memoryForm').reset(); message('Saved app and playlist names deleted.'); }));
  panel.querySelector('#timingsClear').addEventListener('click', guarded(() => store.clearTimings()));
  panel.querySelector('#timingsExport').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ timings: store.snapshot().timings }, null, 2)], { type: 'application/json' }));
    const link = el('a'); link.href = url; link.download = 'olanga-performance.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  panel.querySelector('#memoryForm').addEventListener('submit', event => {
    event.preventDefault(); guarded(() => {
      const kind = panel.querySelector('#memoryKind').value, alias = panel.querySelector('#memoryAlias').value, target = panel.querySelector('#memoryTarget').value;
      if (kind === 'aliases' && OlangaIntents.parse('open ' + target)?.[0]?.command !== `[OPEN_APP: ${target.trim()}]`) throw new Error('Choose a supported app name, such as Chrome, Spotify, Notepad, or VS Code.');
      store.remember(kind, alias, target, editingMemory); editingMemory = null; message('Saved. Enable “Use my saved names” to apply it.'); panel.querySelector('#memoryForm').reset();
    })();
  });
  panel.querySelector('#routineReset').addEventListener('click', () => { editingRoutine = null; panel.querySelector('#routineForm').reset(); });
  panel.querySelector('#routineForm').addEventListener('submit', event => {
    event.preventDefault(); guarded(() => {
      store.saveRoutine({ id: editingRoutine, name: panel.querySelector('#routineName').value, lines: panel.querySelector('#routineLines').value.split('\n') }, OlangaIntents.parse);
      editingRoutine = null; panel.querySelector('#routineForm').reset(); message('Routine saved. Review it before running.');
    })();
  });
  panel.querySelector('#appsRefresh').addEventListener('click', guarded(async () => {
    const control = panel.querySelector('#appsRefresh'); control.disabled = true;
    const list = panel.querySelector('#capabilitiesList'); list.textContent = 'Checking installed apps…';
    try {
      const result = await window.electronAPI.listAppCapabilities();
      if (!result?.ok) throw new Error(result?.message || 'App discovery is unavailable.');
      list.replaceChildren(); for (const app of result.apps) list.append(row(app.name, `${pretty(app.status || (app.installed ? 'installed' : 'missing'))} · ${(app.operations || []).map(pretty).join(', ') || 'No verified adapter available'}`));
    } finally { control.disabled = false; }
  }));
  panel.querySelector('#checkRelease').addEventListener('click', guarded(async () => {
    const target = panel.querySelector('#releaseStatus'); target.textContent = 'Checking the latest release…';
    if (!window.electronAPI.checkRelease) { target.textContent = 'Open GitHub Releases to compare versions.'; target.append(button('Open releases', () => window.electronAPI.openExternal('https://github.com/firestar3/Olanga-Desktop-Agent/releases'))); return; }
    const result = await window.electronAPI.checkRelease(); target.textContent = result.message;
    if (result.url) target.append(button('View release', () => window.electronAPI.openExternal(result.url)));
  }));

  const openReviews = new Set();
  window.cancelRoutineReviews = () => { for (const review of openReviews) review.close(); };
  async function reviewRoutine(routine, previousRun, request) {
    if (OlangaProductivity.isRunning(store)) throw new Error('A routine is already running. Finish or cancel it before starting another.');
    if (previousRun?.state === 'working') throw new Error('This routine is already running.');
    const actions = previousRun ? previousRun.steps : routine.lines.flatMap(line => { const result = OlangaIntents.parse(line, store.options()); if (!result) throw new Error('A saved command is no longer supported. Edit the routine before running.'); return result.map(action => ({ ...action, state: 'pending' })); });
    if (!actions.length || actions.length > 12) throw new Error('A routine must contain 1–12 supported actions.');
    // Validate the entire immutable proposal before showing any runnable step.
    for (const action of actions) parseSimpleActionProposal(JSON.stringify({ kind: 'commands', commands: [action.command] }), [...SIMPLE_ACTION_NAMES]);
    const review = el('dialog', undefined, 'workspace-dialog routine-review');
    const reviewVersion = assistantRequestVersion;
    let approved = false;
    const title = el('h2', previousRun ? `Resume: ${previousRun.name}` : routine.name); title.id = `workspaceRoutineTitle-${++dialogSequence}`;
    review.setAttribute('aria-labelledby', title.id);
    review.append(title, el('p', 'Only selected unfinished steps will run, in order. Completed steps cannot repeat. An uncertain or unverified step may already have taken effect; check its result before selecting it.', 'workspace-help'));
    const choices = [];
    actions.forEach((step, index) => {
      const label = el('label', undefined, 'workspace-check'); const checkbox = el('input'); checkbox.type = 'checkbox';
      checkbox.disabled = ['completed', 'skipped'].includes(step.state);
      checkbox.checked = !checkbox.disabled && !['uncertain', 'unverified', 'failed', 'cancelled', 'working'].includes(step.state);
      label.append(checkbox, el('span', `${OlangaProductivity.formatCommand(step.command)} · ${pretty(step.state)}`)); review.append(label); choices.push({ checkbox, index });
    });
    const reviewStatus = el('p', undefined, 'workspace-error'); reviewStatus.setAttribute('role', 'alert'); review.append(reviewStatus);
    const controls = el('div', undefined, 'workspace-actions');
    const approve = button('Run selected steps', async () => {
      approve.disabled = true;
      try {
      if (!review.open || approved || reviewVersion !== assistantRequestVersion || request?.signal.aborted) throw new Error('This review has expired. Open the routine again.');
      if (OlangaProductivity.isRunning(store)) throw new Error('A routine is already running. Finish or cancel it first.');
      const selected = choices.filter(choice => choice.checkbox.checked && !choice.checkbox.disabled).map(choice => choice.index);
      if (!selected.length) throw new Error('Select at least one unfinished step.');
      const run = previousRun || store.createRun(routine, actions, selected);
      if (previousRun) store.selectRunSteps(run.id, selected);
      approved = true;
      // Chromium can deliver the close event late; an approved review must not
      // linger in the page while its steps run.
      review.close(); panel.close(); openReviews.delete(review); review.remove();
      await runReviewedRoutine(run, selected);
      } catch (error) { reviewStatus.textContent = error.message; approve.disabled = false; }
    });
    controls.append(button('Cancel', () => review.close()), approve);
    review.append(controls); document.body.append(review); openReviews.add(review);
    review.addEventListener('close', () => {
      openReviews.delete(review); review.remove();
      if (!approved && request) window.OlangaActivity?.finish(request.activityId, 'cancelled');
    }, { once: true }); review.showModal();
  }
  window.reviewOlangaRoutine = (name, request) => {
    const matches = store.snapshot().routines.filter(routine => routine.name.toLowerCase() === name.trim().toLowerCase());
    if (matches.length !== 1) throw new Error(matches.length ? 'Several routines have that name. Choose one in Workspace.' : 'No routine with that name was found.');
    return reviewRoutine(matches[0], null, request);
  };
  async function runReviewedRoutine(run, indices) {
    const request = beginAssistantRequest(); acknowledgeAssistantRequest(request);
    window.OlangaActivity?.plan(request.activityId, indices.map(index => /^\[([A-Z_]+)/.exec(run.steps[index].command)[1]));
    try {
      const outcome = await OlangaProductivity.executeRun(store, run.id, indices, {
        signal: request.signal,
        validate: command => parseSimpleActionProposal(JSON.stringify({ kind: 'commands', commands: [command] }), [...SIMPLE_ACTION_NAMES]),
        dispatch: command => applyAssistantCommands(command, request)
      });
      request.failed = outcome.state === 'failed';
      if (!request.signal.aborted) await finishAssistantTurn(outcome.messages.join(' ') || 'No steps ran.', false, request);
    } catch (error) {
      request.failed = true;
      if (!request.signal.aborted) await finishAssistantTurn(`The routine did not run. ${error.message}`, false, request);
    }
  }
})();
