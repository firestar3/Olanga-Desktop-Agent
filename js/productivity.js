/* Local workspace preferences, activity, and reviewed routines. */
(function () {
  const store = OlangaProductivity.createStore(localStorage);
  window.OlangaWorkspace = store;
  window.OlangaActivity = store;
  store.subscribeMemory(detail => window.dispatchEvent(new CustomEvent('olanga:memories-changed', { detail })));
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
    <nav aria-label="Workspace sections">${['Activity', 'Routines', 'Saved names', 'Apps & updates', 'Diagnostics', 'Memories', 'Health', 'Backups'].map((title, i) => `<button type="button" data-workspace-tab="${i}" aria-pressed="${i === 0}">${title}</button>`).join('')}</nav>
    <div class="workspace-actions" aria-label="Popular tools"><button type="button" id="workspaceResume">Resume my work</button><button type="button" id="workspaceProjects">Projects</button><button type="button" id="workspaceSchedules">Schedules</button><button type="button" id="workspaceUpdates">Updates</button></div>
    <p id="workspaceStatus" role="status" aria-live="polite"></p><div id="workspaceRecoveryNotice" hidden><p class="workspace-error" id="workspaceRecoveryMessage" role="alert"></p><button type="button" id="workspaceRecoveryOpen">Review storage recovery</button></div>
    <section data-workspace-page="0"><div class="workspace-heading"><h3>Recent activity</h3><button type="button" id="activityClear">Clear</button></div><p class="workspace-help">Current-session receipts show actual results. Saved history keeps only operation types and statuses, without prompts, screenshots, task names, or document text.</p><label class="workspace-check"><input type="checkbox" id="saveActivity"> Keep activity after restart</label><div id="activityList"></div><h3>Try a request</h3><p class="workspace-help">Choose an example, edit it, then send when ready. Selecting an example runs nothing.</p><div id="workspaceExamples" class="workspace-actions"></div></section>
    <section data-workspace-page="1" hidden><h3>Routines</h3><p class="workspace-help">Save common local commands, one per line. Review every run before it starts. Interrupted runs never restart automatically.</p><form id="routineForm"><label for="routineName">Name</label><input id="routineName" maxlength="100" required placeholder="Focus time"><label for="routineLines">Commands</label><textarea id="routineLines" rows="5" required placeholder="Open Spotify&#10;Set volume to 25%&#10;Set a timer for 25 minutes called Focus"></textarea><div class="workspace-actions"><button type="submit">Save routine</button><button type="button" id="routineReset">New routine</button></div></form><div id="routineList"></div><h3>Previous runs</h3><div id="routineRuns"></div></section>
    <section data-workspace-page="2" hidden><h3>Saved names</h3><p class="workspace-help">Choose your own names for supported apps and private Spotify playlists. Olanga remembers only what you save here.</p><label class="workspace-check"><input type="checkbox" id="memoryEnabled"> Use my saved names</label><form id="memoryForm"><label for="memoryKind">Type</label><select id="memoryKind"><option value="aliases">App alias</option><option value="playlists">Playlist preference</option></select><label for="memoryAlias">Your name</label><input id="memoryAlias" maxlength="100" required placeholder="work browser"><label for="memoryTarget">App or private playlist name</label><input id="memoryTarget" maxlength="100" required placeholder="Chrome"><button type="submit">Save name</button></form><div id="memoryList"></div><button type="button" id="memoryClear">Delete all saved names</button></section>
    <section data-workspace-page="3" hidden><div class="workspace-heading"><h3>App capabilities</h3><button type="button" id="appsRefresh">Refresh</button></div><p class="workspace-help">Check which supported apps Windows can find. Other app names can still use Windows Search, with an unverified result.</p><div id="capabilitiesList">Select Refresh to check installed apps.</div><div class="release-card"><div class="workspace-heading"><h3>Olanga updates</h3><span id="releaseVersion" class="release-version"></span></div><p class="workspace-help">Check when you want, download here, then choose when to install. Olanga never checks, downloads or installs updates automatically.</p><p id="releaseStatus" role="status" aria-live="polite">Check for a newer version of Olanga.</p><progress id="releaseProgress" class="release-progress" max="100" value="0" aria-label="Update download progress" hidden></progress><p id="releaseDetail" class="release-detail" hidden></p><p id="releaseWarning" class="release-warning" hidden></p><div class="workspace-actions release-actions"><button type="button" id="checkRelease">Check for updates</button><button type="button" id="downloadUpdate" class="workspace-primary" hidden>Download update</button><button type="button" id="cancelUpdate" hidden>Cancel download</button><button type="button" id="installUpdate" class="workspace-primary" hidden>Install & restart</button><button type="button" id="releaseNotes" hidden>Release notes</button></div></div></section>
    <section data-workspace-page="4" hidden><h3>Performance</h3><label class="workspace-check"><input type="checkbox" id="diagnosticsEnabled"> Collect local performance measurements</label><p class="workspace-help">Stores timings and success/error categories only. Nothing is uploaded. Turning this off deletes measurements.</p><div class="workspace-actions"><button type="button" id="timingsClear">Clear measurements</button><button type="button" id="timingsExport">Export measurements</button></div><div id="timingList"></div></section>
    <section data-workspace-page="5" hidden><h3>Memories</h3><p class="workspace-help">Things you explicitly asked Olanga to remember, for example “remember that I prefer brief answers”. Olanga can learn clear preferences and everyday details from what you tell it. Learned details stay visible here; you can correct, undo, forget or pause learning by voice. Only relevant enabled memories are included with answers.</p><label class="workspace-check"><input type="checkbox" id="learningEnabled"> Learn useful details from our conversations</label><label class="workspace-check"><input type="checkbox" id="factsEnabled"> Use my memories in answers</label><p class="workspace-help">Say “stop learning”, “what have you learned about me?” or “forget what you just learned”. Passwords and sensitive details are excluded from automatic learning.</p><form id="factForm"><label for="factText">Add a memory</label><input id="factText" maxlength="300" required placeholder="My sister's birthday is June 5"><button type="submit">Save memory</button></form><div class="workspace-actions workspace-memory-tools"><div><label for="factSearch">Search memories</label><input type="search" id="factSearch" maxlength="300" placeholder="Find a saved detail"></div><div><label for="factSort">Sort</label><select id="factSort"><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="alphabetical">A–Z</option></select></div></div><p id="factCount" class="workspace-help" role="status"></p><div id="factList"></div><button type="button" id="factsClear">Delete all memories</button></section>
    <section data-workspace-page="6" hidden><div class="workspace-heading"><h3>Health check</h3><button type="button" id="healthRun">Run check</button></div><p class="workspace-help">Checks the microphone, wake word, speech, voice, Gemini and storage without changing anything. The connection test sends one short request to Gemini.</p><p id="healthSummary" class="health-summary" role="status" aria-live="polite"></p><div id="healthList"></div><button type="button" id="healthTest">Test Gemini connection</button></section>
    <section data-workspace-page="7" hidden><h3>Workspace backups</h3><p class="workspace-help">Export memories, saved app and playlist names, and routine definitions. Files stay on your device unless you share them. Backups do not include API keys, settings, timers, notes, checklist tasks, schedules, activity or run receipts.</p><div class="workspace-actions"><button type="button" id="workspaceExport">Export personal content</button><button type="button" id="workspaceImport">Choose backup to review</button><input type="file" id="workspaceImportFile" aria-label="Choose a Workspace backup" accept=".json,application/json" hidden style="display: none"></div><p class="workspace-help">Import replaces the personal collections listed above after you review them. Existing content is copied locally first. Imported routines never run automatically; each run still requires review.</p><div id="workspaceRecoveryControls" hidden><h3>Recover Workspace storage</h3><p class="workspace-help">Ordinary commands still work in this session. Saving Workspace changes is paused to protect the original record. Retry reading it, or save a verified recovery copy before choosing a reset. Recovery copies may include private activity details; keep them private.</p><div class="workspace-actions"><button type="button" id="workspaceRecoveryRetry">Retry reading storage</button><button type="button" id="workspaceRecoveryBackup">Save recovery copy</button><button type="button" id="workspaceRecoveryDownload" hidden>Download recovery copy</button><button type="button" id="workspaceRecoveryReset" hidden>Review reset</button></div><p id="workspaceRecoveryCopyStatus" class="workspace-help" role="status"></p></div><h3>Local recovery copies</h3><p class="workspace-help">These retain the original Workspace record before a restore or reset, including any saved activity or run details. They stay on this device until you delete them. Review restores only the personal content listed above.</p><button type="button" id="workspaceRecoveryRefresh">Refresh copies</button><div id="workspaceRecoveryCopies"></div></section>`;
  document.body.append(panel);
  const status = panel.querySelector('#workspaceStatus');
  function message(text, error = false) { status.textContent = text; status.classList.toggle('workspace-error', error); }
  function guarded(action) { return async () => { try { await action(); } catch (error) { render(); message(error.message || 'That change could not be completed.', true); } }; }
  let editingRoutine = null, editingMemory = null;
  function open(tab = '0') {
    for (const page of panel.querySelectorAll('[data-workspace-page]')) page.hidden = page.dataset.workspacePage !== String(tab);
    for (const tabButton of panel.querySelectorAll('[data-workspace-tab]')) tabButton.setAttribute('aria-pressed', String(tabButton.dataset.workspaceTab === String(tab)));
    if (!panel.open) panel.showModal();
    if (String(tab) === '7') renderRecoveryCopies();
    if (String(tab) === '6') runHealthCheck().catch(error => message(error.message || 'The health check could not run.', true));
  }
  window.openOlangaWorkspace = open;
  panel.querySelector('#workspaceClose').addEventListener('click', () => panel.close());
  panel.querySelectorAll('[data-workspace-tab]').forEach(node => node.addEventListener('click', () => open(node.dataset.workspaceTab)));
  const launch = button('Workspace', () => open()); launch.className = 'workspace-launch'; launch.id = 'workspaceOpen';
  launch.setAttribute('aria-haspopup', 'dialog'); launch.setAttribute('aria-controls', panel.id);
  document.querySelector('.top-bar')?.append(launch);
  const peek = el('div', undefined, 'activity-peek'); peek.id = 'activityPeek'; peek.setAttribute('aria-live', 'polite');
  document.getElementById('transcriptArea')?.append(peek);
  function row(title, subtitle) { const item = el('div', undefined, 'workspace-item'); const content = el('div'); content.append(el('strong', title), el('p', subtitle, 'workspace-help')); item.append(content); return item; }
  function render() {
    const state = store.snapshot(), recovery = store.recoveryStatus();
    panel.querySelector('#workspaceRecoveryNotice').hidden = !recovery.blocked;
    panel.querySelector('#workspaceRecoveryMessage').textContent = recovery.message;
    panel.querySelector('#workspaceRecoveryControls').hidden = !recovery.blocked;
    panel.querySelector('#workspaceExport').disabled = recovery.blocked;
    panel.querySelector('#workspaceImport').disabled = recovery.blocked;
    panel.querySelector('#workspaceRecoveryDownload').hidden = !recovery.backupKey;
    panel.querySelector('#workspaceRecoveryReset').hidden = !recovery.backupKey;
    panel.querySelector('#workspaceRecoveryCopyStatus').textContent = recovery.backupKey ? 'A verified copy of the original record is saved on this device. You can also download it before resetting.' : '';
    for (const [nodeId, key] of [['saveActivity', 'saveActivity'], ['memoryEnabled', 'memoryEnabled'], ['diagnosticsEnabled', 'diagnostics'], ['factsEnabled', 'factsEnabled'], ['learningEnabled', 'learningEnabled']]) panel.querySelector('#' + nodeId).checked = state[key];
    const factList = panel.querySelector('#factList'); factList.replaceChildren();
    const search = panel.querySelector('#factSearch').value.trim().toLocaleLowerCase(), sort = panel.querySelector('#factSort').value;
    const visibleFacts = state.facts.filter(fact => fact.text.toLocaleLowerCase().includes(search)).sort((a, b) => sort === 'alphabetical' ? a.text.localeCompare(b.text) : sort === 'oldest' ? a.at - b.at : b.at - a.at);
    panel.querySelector('#factCount').textContent = visibleFacts.length + ' of ' + state.facts.length + ' saved memories';
    for (const fact of visibleFacts) {
      const item = row(fact.text, (fact.source === 'conversation' ? 'Learned in conversation' : 'Saved by you') + ' · ' + new Date(fact.at).toLocaleDateString());
      item.append(button('Edit', guarded(() => { const replacement = prompt('Correct this memory, or say update my memory followed by the old and new details.', fact.text); if (replacement !== null) store.updateFact(fact.id, replacement); })), button('Delete', guarded(() => store.deleteFact(fact.id)))); factList.append(item);
    }
    if (!visibleFacts.length) factList.append(el('p', state.facts.length ? 'No memories match your search.' : 'Tell Olanga a clear preference or everyday detail. Say “remember that…” when you want to explicitly keep something.', 'workspace-help'));
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
  const memoryNotice=el('div',undefined,'memory-insight');memoryNotice.hidden=true;memoryNotice.setAttribute('role','status');
  const memoryNoticeText=el('p'),memoryUndo=button('Undo',guarded(()=>{store.undoLearnedMemory(memoryUndo.dataset.token);memoryNotice.hidden=true;}));
  memoryNotice.append(memoryNoticeText,memoryUndo);document.getElementById('transcriptArea')?.append(memoryNotice);
  let noticeMemories=[],lastMemoriesUsed=[];
  store.subscribeMemory(event=>{const removed=new Set(event?.removedIds||[]);if(noticeMemories.some(item=>removed.has(item.id)||!store.snapshot().facts.some(fact=>fact.id===item.id&&fact.text===item.text))){noticeMemories=[];memoryNoticeText.textContent='';memoryUndo.dataset.token='';memoryNotice.hidden=true;}});
  window.OlangaMemoryView={
    learned(result){const changed=[...(result?.learned||[]),...(result?.updated||[])];if(!changed.length)return;noticeMemories=changed.map(({id,text})=>({id,text}));memoryNoticeText.textContent=(result.updated?.length?'Updated memory: ':'Learned: ')+changed.map(item=>item.text).join('; ');memoryUndo.dataset.token=result.undoToken||'';memoryUndo.hidden=!result.undoToken;memoryNotice.hidden=false;},
    used(facts){lastMemoriesUsed=(facts||[]).map(({id,text})=>({id,text}));},
    lastUsed(){return lastMemoriesUsed.filter(item=>store.snapshot().facts.some(fact=>fact.id===item.id&&fact.text===item.text));}
  };
  panel.querySelector('#factSearch').addEventListener('input', render);
  panel.querySelector('#factSort').addEventListener('change', render);
  panel.querySelector('#workspaceUpdates').addEventListener('click', () => open('3'));
  panel.querySelector('#workspaceRecoveryOpen').addEventListener('click', () => open('7'));
  const fullBackups = button('Back up notes, tasks and preferences', guarded(() => { panel.close(); if (typeof window.openOlangaBackups !== 'function') throw new Error('The backup center is still loading.'); window.openOlangaBackups(); }));
  fullBackups.id='workspaceFullBackups'; panel.querySelector('[data-workspace-page="7"]').prepend(fullBackups);
  for (const [control, destination] of [['workspaceResume', 'workspaces'], ['workspaceProjects', 'projects'], ['workspaceSchedules', 'schedules']]) panel.querySelector('#' + control).addEventListener('click', guarded(() => {
    if (typeof window.openOlangaWorkbench !== 'function') throw new Error('Work tools are still loading. Try again in a moment.');
    panel.close(); window.openOlangaWorkbench(destination);
  }));
  for (const [label, example] of [['Focus timer', 'Set a timer for 25 minutes called Focus'], ['Spotify + volume', 'Play Spotify and raise the volume to 75%'], ['Learn a preference', 'I prefer brief answers']]) {
    const chip = button(label, () => {
      const input = document.getElementById('textCommandInput'); if (!input) return;
      panel.close(); document.querySelector('.floating-icon[data-screen="mainScreen"]')?.click();
      input.value = example; input.dataset.localPrefill = 'true';
      try { input.focus(); input.setSelectionRange(0, example.length); } finally { delete input.dataset.localPrefill; }
    });
    chip.setAttribute('aria-label', 'Use example: ' + example); panel.querySelector('#workspaceExamples').append(chip);
  }
  function downloadJson(text, filename) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = el('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function confirmWorkspace(titleText, details, label, action) {
    const review = el('dialog', undefined, 'workspace-dialog'); review.id = 'workspaceBackupReview';
    const title = el('h2', titleText); title.id = 'workspaceBackupReviewTitle'; review.setAttribute('aria-labelledby', title.id);
    const error = el('p', '', 'workspace-error'); error.setAttribute('role', 'alert');
    const controls = el('div', undefined, 'workspace-actions');
    const approve = button(label, async () => {
      approve.disabled = true;
      try { await action(); review.close(); } catch (failure) { error.textContent = failure.message || 'Nothing could be restored.'; approve.disabled = false; }
    });
    controls.append(button('Cancel', () => review.close()), approve);
    review.append(title, ...details, error, controls); document.body.append(review);
    review.addEventListener('close', () => review.remove(), { once: true }); review.showModal();
  }
  panel.querySelector('#workspaceExport').addEventListener('click', guarded(() => downloadJson(JSON.stringify(store.exportPersonal(), null, 2), 'olanga-workspace-backup.json')));
  let importReadSequence = 0;
  panel.querySelector('#workspaceImport').addEventListener('click', () => { importReadSequence++; const input = panel.querySelector('#workspaceImportFile'); input.value = ''; input.click(); });
  function showImportPreview(text) {
    const preview = store.previewImport(text, OlangaIntents.parse);
    const details = [el('p', 'Replace saved memories, app and playlist names, and routine definitions with the content below. Other settings and content stay as they are. A verified local recovery copy is required before replacement. Nothing will run.', 'workspace-help')];
    const names = { facts: 'Memories', aliases: 'App names', playlists: 'Playlist names', routines: 'Routines' };
    for (const kind of Object.keys(names)) {
      const group = el('details'), summary = el('summary', names[kind] + ': ' + preview.currentCounts[kind] + ' current → ' + preview.counts[kind] + ' in backup');
      group.append(summary);
      for (const item of preview.content[kind]) group.append(row(item.text || item.alias || item.name, item.target || (item.lines ? item.lines.join(' · ') : 'Saved ' + new Date(item.at).toLocaleDateString())));
      details.push(group);
    }
    confirmWorkspace('Review Workspace restore', details, 'Replace saved Workspace content', () => {
      store.importPersonal(preview.token, OlangaIntents.parse); editingRoutine = null; editingMemory = null;
      renderRecoveryCopies();
      message('Personal Workspace content restored. Routines have not run. The previous record is retained as a local recovery copy.');
    });
  }
  panel.querySelector('#workspaceImportFile').addEventListener('change', guarded(async () => {
    const sequence = ++importReadSequence, file = panel.querySelector('#workspaceImportFile').files[0]; if (!file) return;
    if (file.size > 1024 * 1024) throw new Error('Choose a Workspace backup smaller than 1 MB.');
    const text = await file.text();
    if (sequence !== importReadSequence) return;
    showImportPreview(text);
  }));
  function renderRecoveryCopies() {
    const list = panel.querySelector('#workspaceRecoveryCopies'); list.replaceChildren();
    try {
      const copies = store.listRecoveryCopies();
      if (!copies.length) list.append(el('p', 'No recovery copies saved.', 'workspace-help'));
      for (const copy of copies) {
        const item = row('Recovery copy', new Date(copy.createdAt).toLocaleString()), controls = el('div', undefined, 'workspace-actions');
        controls.append(button('Download', guarded(() => downloadJson(store.recoveryBackupText(copy.key), 'olanga-workspace-recovery.json'))), button('Review personal content', guarded(() => showImportPreview(JSON.stringify(store.exportRecoveryPersonal(copy.key, OlangaIntents.parse))))), button('Delete copy', () => confirmWorkspace('Delete this recovery copy?', [el('p', 'This deletes only the selected recovery copy. Current Workspace content is unchanged. Download the copy first if you need to keep its original record.', 'workspace-help')], 'Delete recovery copy', () => { store.deleteRecoveryCopy(copy.key); renderRecoveryCopies(); message('Recovery copy deleted.'); })));
        item.append(controls); list.append(item);
      }
    } catch (error) { list.append(el('p', error.message, 'workspace-error')); }
  }
  panel.querySelector('#workspaceRecoveryRefresh').addEventListener('click', renderRecoveryCopies);
  panel.querySelector('#workspaceRecoveryRetry').addEventListener('click', guarded(() => message(store.retryRecovery() ? 'Workspace storage is readable again.' : 'The original record still needs recovery. It has not been replaced.', !!store.recoveryStatus().blocked)));
  panel.querySelector('#workspaceRecoveryBackup').addEventListener('click', guarded(() => { store.createRecoveryBackup(); renderRecoveryCopies(); message('Original Workspace record copied and verified on this device.'); }));
  panel.querySelector('#workspaceRecoveryDownload').addEventListener('click', guarded(() => downloadJson(store.recoveryBackupText(store.recoveryStatus().backupKey), 'olanga-workspace-recovery.json')));
  panel.querySelector('#workspaceRecoveryReset').addEventListener('click', guarded(() => {
    const key = store.recoveryStatus().backupKey;
    confirmWorkspace('Reset unreadable Workspace storage?', [el('p', 'The verified recovery copy is retained. Reset clears Workspace memories, saved names, routines, activity, measurements and their Workspace preferences. Timers, notes, checklist tasks, schedules, API keys and appearance settings are outside this reset. You can import a personal Workspace backup afterward.', 'workspace-help')], 'Reset Workspace storage', () => { store.resetAfterBackup(key); renderRecoveryCopies(); message('Workspace storage reset. The original recovery copy is retained on this device.'); });
  }));
  const providerInfo = el('div'); providerInfo.id = 'providerUsage';
  const providerRefresh = button('Refresh Gemini usage', guarded(async () => {
    const usage = await window.electronAPI.providerStatus();
    const totals = usage.totals;
    providerInfo.textContent = `This session: ${totals.requests} requests, ${totals.succeeded} succeeded, ${totals.failed} failed, ${totals.cancelled} cancelled. ${totals.inputTokens} input tokens (${totals.cachedTokens || 0} served from Gemini's cache) and ${totals.outputTokens} output tokens reported by Gemini. ${usage.active} active requests. These counts contain no prompts and reset when Olanga closes.`;
  }));
  panel.querySelector('[data-workspace-page="4"]').append(el('h3', 'Gemini usage'), providerRefresh, providerInfo);
  for (const [nodeId, key] of [['saveActivity', 'saveActivity'], ['memoryEnabled', 'memoryEnabled'], ['diagnosticsEnabled', 'diagnostics'], ['factsEnabled', 'factsEnabled'], ['learningEnabled', 'learningEnabled']]) panel.querySelector('#' + nodeId).addEventListener('change', guarded(() => { store.preference(key, panel.querySelector('#' + nodeId).checked); message('Preference saved on this device.'); }));
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
      online: navigator.onLine, speechInput: store.snapshot().speechInput, storage: { writable, workspaceRecovery: store.recoveryStatus?.() || null, notesRecovery: window.OlangaNotesController?.snapshot?.() || null }, app: appInfo, audioChecks: window.OlangaAudioSetup?.snapshot?.() || null,
      microphone: { inputs, active: !!(micStream && micStream.active !== false), muted: !!isMicMuted, preferredDeviceId: window.OlangaAudioInput?.snapshot?.().preferredDeviceId || '' },
      wakeWord: { ready: !!isVoskReady },
      gemini: { configured: !!status.configured || !!apiKey, recent: Array.isArray(status.recent) ? status.recent : [], test: isCurrentGeminiTest(lastGeminiTest) ? lastGeminiTest : null },
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
      if (check.fixAction) item.append(button(({ 'audio-setup': 'Open voice setup', 'core-settings': 'Open Core settings', 'test-gemini': 'Test Gemini', 'workspace-recovery': 'Review Workspace recovery', 'notes-recovery': 'Review Notes recovery', 'user-settings': 'Open User settings', 'check-updates': 'Check for updates' })[check.fixAction] || 'Review', guarded(async () => {
        switch (check.fixAction) {
          case 'audio-setup': panel.close(); window.OlangaAudioSetup?.open(); break;
          case 'core-settings': panel.close(); window.OlangaSettingsNavigation?.open('core'); break;
          case 'user-settings': panel.close(); window.OlangaSettingsNavigation?.open('user'); break;
          case 'test-gemini': await testGeminiConnection(); await runHealthCheck(); break;
          case 'workspace-recovery': open('7'); break;
          case 'notes-recovery': window.openOlangaNotesHistory?.(); break;
          case 'check-updates': open('3'); await updateOperation('checkRelease', 'checking', 'Checking the latest release…'); break;
        }
      })));

      list.append(item);
    }
    summary.textContent = OlangaHealth.summarize(checks);
  }
  panel.querySelector('#healthRun').addEventListener('click', guarded(runHealthCheck));
  let healthTestPending = null;
  // Result bindings are deliberately private: diagnostics export only the
  // ordinary ok/ms/message result, never credentials or key identifiers.
  const healthTestBindings = new WeakMap();
  function healthCredentialSnapshot() { return { keys: [...apiKeys], key: apiKey, index: currentKeyIndex }; }
  function sameHealthCredentials(snapshot) {
    return !!snapshot && snapshot.key === apiKey && snapshot.index === currentKeyIndex && snapshot.keys.length === apiKeys.length && snapshot.keys.every((key, index) => key === apiKeys[index]);
  }
  function isCurrentGeminiTest(result) {
    const binding = result && healthTestBindings.get(result);
    return !!binding?.selectionUnchanged && sameHealthCredentials(binding.selection);
  }
  function testGeminiConnection() {
    if (healthTestPending && sameHealthCredentials(healthTestPending.selection)) return healthTestPending.promise;
    const selection = healthCredentialSnapshot(), pending = { selection, promise: null };
    let used = { keyIndex: selection.index, selectionUnchanged: true };
    pending.promise = (async () => {
      const started = performance.now(); let result;
      try {
        await callGeminiGenerate(OlangaGemini.RESPONSE_MODEL, { contents: [{ parts: [{ text: 'Reply with the single word OK.' }] }], generationConfig: { maxOutputTokens: 64, thinkingConfig: { thinkingLevel: 'MINIMAL' } } }, { timeoutMs: 20000, onKeyResult: value => { used = value; } });
        result = { ok: true, ms: performance.now() - started, message: 'Gemini connection is ready.' };
      } catch (error) { result = { ok: false, ms: performance.now() - started, message: error.message || 'The connection test failed.' }; }
      healthTestBindings.set(result, { selectionUnchanged: used.selectionUnchanged, selection: { ...selection, index: used.keyIndex, key: selection.keys[used.keyIndex] } });
      if (isCurrentGeminiTest(result)) lastGeminiTest = result;
      return result;
    })().finally(() => { if (healthTestPending === pending) healthTestPending = null; });
    healthTestPending = pending;
    return pending.promise;
  }
  window.OlangaWorkspaceHealth = { testGemini: testGeminiConnection, isCurrentTest: isCurrentGeminiTest, runCheck: runHealthCheck };
  panel.querySelector('#healthTest').addEventListener('click', guarded(async () => {
    const control = panel.querySelector('#healthTest'); control.disabled = true;
    panel.querySelector('#healthSummary').textContent = 'Testing the Gemini connection…';
    try { await testGeminiConnection(); await runHealthCheck(); } finally { control.disabled = false; }
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
  let updateState = { phase: 'idle' }, updateAction = 0, updateEventRevision = 0;
  const updateControls = Object.fromEntries(['checkRelease', 'downloadUpdate', 'cancelUpdate', 'installUpdate', 'releaseNotes', 'releaseStatus', 'releaseVersion', 'releaseProgress', 'releaseDetail', 'releaseWarning'].map(id => [id, panel.querySelector('#' + id)]));
  function renderUpdate(state) {
    if (!state || typeof state !== 'object') return;
    updateState = state;
    const busy = ['checking', 'downloading', 'verifying', 'installing'].includes(state.phase);
    const downloading = state.phase === 'downloading' || (state.phase === 'verifying' && !state.downloaded);
    updateControls.checkRelease.disabled = busy;
    updateControls.checkRelease.textContent = state.phase === 'checking' ? 'Checking…' : 'Check for updates';
    updateControls.downloadUpdate.hidden = !state.canDownload || busy || state.phase === 'ready';
    updateControls.downloadUpdate.disabled = busy;
    updateControls.cancelUpdate.hidden = !downloading;
    updateControls.installUpdate.hidden = !state.canInstall;
    updateControls.installUpdate.disabled = busy;
    updateControls.installUpdate.textContent = state.phase === 'installing' ? 'Installing…' : 'Install & restart';
    updateControls.releaseNotes.hidden = !state.url || state.phase === 'idle';
    updateControls.releaseStatus.textContent = state.message || 'Check for a newer version of Olanga.';
    updateControls.releaseStatus.classList.toggle('workspace-error', state.phase === 'error' || state.ok === false);
    updateControls.releaseVersion.textContent = state.installedVersion ? `Installed ${state.installedVersion}` : '';
    updateControls.releaseProgress.hidden = !downloading;
    updateControls.releaseProgress.value = Number.isFinite(state.progress) ? Math.max(0, Math.min(100, state.progress)) : 0;
    const size = bytes => (Math.max(0, Number(bytes) || 0) / 1048576).toFixed(1) + ' MB';
    updateControls.releaseDetail.textContent = downloading ? `${size(state.bytesReceived)} of ${size(state.totalBytes)}${state.phase === 'verifying' ? ' · Verifying download…' : ''}` : state.phase === 'ready' ? (state.canInstall ? 'Olanga will close, update your existing installation and reopen. Your settings and saved data stay in place.' : 'Install & restart is available in the installed Windows app.') : '';
    updateControls.releaseDetail.hidden = !updateControls.releaseDetail.textContent;
    updateControls.releaseWarning.textContent = state.assetVerification === 'sha256-verified' ? 'Download checksum verified. A Windows publisher signature has not been verified.' : '';
    updateControls.releaseWarning.hidden = !updateControls.releaseWarning.textContent;
  }
  async function updateOperation(method, pendingPhase, pendingMessage) {
    const operation = ++updateAction;
    renderUpdate({ ...updateState, phase: pendingPhase, message: pendingMessage });
    try {
      if (typeof window.electronAPI[method] !== 'function') throw new Error('This build does not support in-app updates.');
      const result = await window.electronAPI[method]();
      if (operation === updateAction) renderUpdate(result);
    } catch (error) {
      if (operation === updateAction) renderUpdate({ ...updateState, phase: 'error', ok: false, message: error.message || 'The update could not be completed. Try again.' });
    }
  }
  updateControls.checkRelease.addEventListener('click', () => updateOperation('checkRelease', 'checking', 'Checking the latest release…'));
  updateControls.downloadUpdate.addEventListener('click', () => updateOperation('downloadUpdate', 'downloading', 'Starting download…'));
  updateControls.cancelUpdate.addEventListener('click', () => updateOperation('cancelUpdate', 'verifying', 'Cancelling download…'));
  updateControls.installUpdate.addEventListener('click', () => updateOperation('installUpdate', 'installing', 'Preparing to install and restart…'));
  updateControls.releaseNotes.addEventListener('click', () => { if (updateState.url) window.electronAPI.openExternal(updateState.url); });
  window.electronAPI.onUpdateState?.(state => { updateEventRevision++; renderUpdate(state); });
  // Reading local state restores progress after a renderer reload; it does not
  // check the network or start a download.
  if (window.electronAPI.getUpdateState) {
    const initialAction = updateAction, initialRevision = updateEventRevision;
    window.electronAPI.getUpdateState().then(state => { if (initialAction === updateAction && initialRevision === updateEventRevision) renderUpdate(state); }).catch(() => {});
  }

  const openReviews=new Set();let activeRoutineReview=null;
  window.openOlangaRoutineEditor=(name='',editing=false)=>{
    open('1');
    const matches=editing?store.snapshot().routines.filter(item=>item.name.toLowerCase()===String(name).trim().toLowerCase()):[];
    if(editing&&matches.length!==1)throw new Error(matches.length?'Several routines have that name. Choose one in Routines.':'That routine was not found. Your routines are shown here.');
    editingRoutine=matches[0]?.id||null;panel.querySelector('#routineName').value=matches[0]?.name||String(name).trim().slice(0,100);
    panel.querySelector('#routineLines').value=matches[0]?.lines.join('\n')||'';
    panel.querySelector('#routineName').scrollIntoView?.({block:'nearest'});panel.querySelector(matches[0]||name?'#routineLines':'#routineName').focus();
    return{ok:true,message:editing?'The routine is ready to edit.':'The routine editor is open. Give it a name and enter the commands you want.'};
  };
  window.cancelRoutineReviews=()=>{activeRoutineReview=null;for(const review of openReviews)review.close();};
  window.OlangaRoutineControl={
    hasReview:()=>!!activeRoutineReview?.review.open,
    async answerReview(text,request){
      const current=activeRoutineReview;if(!current?.review.open)return{handled:false};
      const clean=String(text||'').trim().replace(/[.!?]+$/,'').toLowerCase();
      if(/^(?:no|cancel|cancel (?:the )?routine|do not run(?: it)?|don't run(?: it)?)$/.test(clean)){current.review.close();return{handled:true,message:'Routine cancelled. No additional steps ran.'};}
      if(/^(?:yes|yes[,]? run(?: it| selected steps)?|run it|run selected steps|start selected steps|confirm)$/.test(clean)){await current.approve(request);return{handled:true,finished:true};}
      const selection=/^(include|skip|exclude) step (\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/.exec(clean);
      if(selection)selection[2]=String(Number(selection[2])||['one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'].indexOf(selection[2])+1);
      if(selection){const choice=current.choices[Number(selection[2])-1];if(!choice||choice.checkbox.disabled)return{handled:true,message:'That step cannot be selected. Completed steps never repeat.'};if(['uncertain','unverified','working'].includes(current.actions[choice.index].state))return{handled:true,message:'Check the actual result of that uncertain step before selecting it in the review.'};choice.checkbox.checked=selection[1]==='include';return{handled:true,message:'Step '+selection[2]+(choice.checkbox.checked?' included.':' excluded.')+' Say run selected steps when ready.'};}
      return{handled:false};
    }
  };
  async function reviewRoutine(routine,previousRun,request,{transient=false,actions:transientActions=null}={}){
    if(OlangaProductivity.isRunning(store))throw new Error('A routine is already running. Finish or cancel it before starting another.');
    if(previousRun?.state==='working')throw new Error('This routine is already running.');
    window.cancelRoutineReviews();
    const actions=transient?transientActions:previousRun?previousRun.steps:routine.lines.flatMap(line=>{const result=OlangaIntents.parse(line,store.options());if(!result)throw new Error('A saved command is no longer supported. Edit the routine before running.');return result.map(action=>({...action,state:'pending'}));});
    if(!actions.length||actions.length>12)throw new Error('A routine must contain 1–12 supported actions.');
    for(const action of actions)parseSimpleActionProposal(JSON.stringify({kind:'commands',commands:[action.command]}),[...SIMPLE_ACTION_NAMES]);
    const review=el('dialog',undefined,'workspace-dialog routine-review'),reviewedAt=Date.now();
    const routineFingerprint=routine&&!transient?JSON.stringify(store.snapshot().routines.find(item=>item.id===routine.id)):null;
    let approved=false;const title=el('h2',previousRun?'Resume: '+previousRun.name:routine.name);title.id='workspaceRoutineTitle-'+(++dialogSequence);review.setAttribute('aria-labelledby',title.id);
    review.append(title,el('p','Only selected unfinished steps will run, in order. Completed steps cannot repeat. Check any uncertain result before selecting it. Say run selected steps, skip step two, or cancel.','workspace-help'));
    const choices=[];actions.forEach((step,index)=>{const label=el('label',undefined,'workspace-check'),checkbox=el('input');checkbox.type='checkbox';checkbox.disabled=['completed','skipped'].includes(step.state);checkbox.checked=!checkbox.disabled&&!['uncertain','unverified','failed','cancelled','working'].includes(step.state);label.append(checkbox,el('span',OlangaProductivity.formatCommand(step.command)+' · '+pretty(step.state)));review.append(label);choices.push({checkbox,index});});
    const reviewStatus=el('p',undefined,'workspace-error');reviewStatus.setAttribute('role','alert');review.append(reviewStatus);
    const controls=el('div',undefined,'workspace-actions');
    const approveRun=async requestOverride=>{
      approve.disabled=true;
      try{
        if(!review.open||approved||activeRoutineReview?.review!==review||Date.now()-reviewedAt>5*60000)throw new Error('This review has expired. Open the routine again.');
        if(routine&&!transient&&JSON.stringify(store.snapshot().routines.find(item=>item.id===routine.id))!==routineFingerprint)throw new Error('The routine changed after review. Open it again before running.');
        if(OlangaProductivity.isRunning(store))throw new Error('A routine is already running. Finish or cancel it first.');
        const selected=choices.filter(choice=>choice.checkbox.checked&&!choice.checkbox.disabled).map(choice=>choice.index);if(!selected.length)throw new Error('Select at least one unfinished step.');
        const run=previousRun||store.createRun(routine,actions,selected);if(previousRun)store.selectRunSteps(run.id,selected);
        approved=true;activeRoutineReview=null;review.close();panel.close();openReviews.delete(review);review.remove();await runReviewedRoutine(run,selected,requestOverride);
      }catch(error){reviewStatus.textContent=error.message;approve.disabled=false;if(requestOverride)throw error;}
    };
    const approve=button('Run selected steps',()=>approveRun());controls.append(button('Cancel',()=>review.close()),approve);review.append(controls);document.body.append(review);openReviews.add(review);activeRoutineReview={review,approve:approveRun,choices,actions};
    review.addEventListener('close',()=>{openReviews.delete(review);if(activeRoutineReview?.review===review)activeRoutineReview=null;review.remove();if(!approved&&request)window.OlangaActivity?.finish(request.activityId,'cancelled');},{once:true});review.showModal();
    return{ok:true,name:previousRun?.name||routine.name,steps:actions.map(action=>OlangaProductivity.formatCommand(action.command)),message:'Ready to run '+(previousRun?.name||routine.name)+'. '+actions.slice(0,4).map(action=>OlangaProductivity.formatCommand(action.command)).join('; ')+(actions.length>4?'; plus '+(actions.length-4)+' more steps in the review.':'.')+' Say run selected steps or cancel.'};
  }
  window.reviewOlangaRoutine=(name,request)=>{const matches=store.snapshot().routines.filter(routine=>routine.name.toLowerCase()===name.trim().toLowerCase());if(matches.length!==1)throw new Error(matches.length?'Several routines have that name. Choose one in Workspace.':'No routine with that name was found.');return reviewRoutine(matches[0],null,request);};
  window.reviewOlangaUnfinished=(record,request)=>{
    const eligible=(record?.steps||[]).filter(step=>['failed','skipped'].includes(step.state)&&step.command);
    if(!eligible.length)throw new Error('There are no confirmed unfinished steps to review.');
    const routine={id:null,name:'Unfinished steps',lines:eligible.map(step=>step.command)};
    // A temporary review uses already validated command strings, never a saved definition.
    const previous={name:routine.name,steps:eligible.map(step=>({...step,state:'pending'}))};
    return reviewRoutine(routine,null,request,{transient:true,actions:previous.steps});
  };
  window.OlangaWorkspaceRoutines={list:()=>store.snapshot().routines.map(({id,name})=>({id,name})),review:async id=>{const routine=store.snapshot().routines.find(item=>item.id===id);if(!routine)throw new Error('This routine was removed. Choose another.');const result=await reviewRoutine(routine);return{...result,status:'awaiting-review'};}};
  async function runReviewedRoutine(run,indices,requestOverride){
    const request=requestOverride||beginAssistantRequest();if(!requestOverride)acknowledgeAssistantRequest(request);
    window.OlangaActivity?.plan(request.activityId,indices.map(index=>/^\[([A-Z_]+)/.exec(run.steps[index].command)[1]));setAssistantPlan(request,indices.map(index=>run.steps[index].command));
    try{const outcome=await OlangaProductivity.executeRun(store,run.id,indices,{signal:request.signal,validate:command=>parseSimpleActionProposal(JSON.stringify({kind:'commands',commands:[command]}),[...SIMPLE_ACTION_NAMES]),dispatch:async command=>{const index=request.steps?.findIndex(step=>step.command===command&&step.state==='pending');if(index>=0)updateAssistantStep(request,index,'working');const result=await applyAssistantCommands(command,request);if(index>=0)updateAssistantStep(request,index,typeof assistantStepResultState==='function'?assistantStepResultState(result):result.results?.some(item=>!item.ok)?'failed':result.results?.some(item=>item.verified===false)?'unverified':'completed');return result;}});request.failed=['failed','interrupted'].includes(outcome.state);if(!request.signal.aborted)await finishAssistantTurn(outcome.messages.join(' ')||'No steps ran.',false,request);}
    catch(error){request.failed=true;if(!request.signal.aborted)await finishAssistantTurn('The routine did not run. '+error.message,false,request);}
  }
})();
