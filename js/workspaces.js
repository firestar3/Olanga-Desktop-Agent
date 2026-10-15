/* Named, explicitly reviewed setups built from existing local records. */
(function () {
  const workbench = window.OlangaWorkbench, api = window.electronAPI, bundles = window.OlangaWorkspaceBundles;
  if (!workbench || !api || !bundles) return;
  const store = bundles.createStore(localStorage), labels = { windows: 'Window layout', browser: 'Browser session', editor: 'Editor session', project: 'Project', routine: 'Focus routine' };
  let epoch = 0, pending = null, controller = null, catalog = [], ui;
  const clone = value => JSON.parse(JSON.stringify(value));
  function check(value) { if (value?.ok === false) throw new Error(value.message || 'This workspace step is unavailable.'); return value; }
  function open() { document.getElementById('workspaceDialog')?.close(); window.openOlangaWorkbench('workspaces'); }
  async function choices() {
    const [windows, projects] = await Promise.all([api.workSessionList(), api.projectList()]); check(windows);
    const companion = window.OlangaCompanionSessions?.list() || [], routines = window.OlangaWorkspaceRoutines?.list() || [];
    return [...(windows.sessions || []).map(item => ({ kind: 'windows', id: item.id, name: item.name })), ...companion.map(item => ({ kind: item.kind === 'browser' ? 'browser' : 'editor', id: item.id, name: item.name })), ...projects.map(item => ({ kind: 'project', id: item.id, name: item.name })), ...routines.map(item => ({ kind: 'routine', id: item.id, name: item.name }))];
  }
  function invalidate() { epoch++; pending = null; ui?.preview.replaceChildren(); }
  async function cancel() { invalidate(); controller?.abort(); if (controller) await Promise.allSettled([api.workSessionCancel?.(), api.companionCancel?.()]); ui?.showMessage('Workspace resume cancelled. Completed steps stay in place; check any step that was already in progress.'); render(); return { ok: true, cancelled: true, message: 'Workspace review cancelled. Completed actions stay in place.' }; }
  function selections() { return catalog.filter(item => ui.selects.get(item.kind)?.value === item.id); }
  async function loadChoices(expectedEpoch = epoch) {
    const previous = new Map([...ui.selects].map(([kind, select]) => [kind, select.value]));
    const current = await choices(); if (expectedEpoch !== epoch) return; catalog = current;
    for (const [kind, select] of ui.selects) {
      select.replaceChildren(ui.node('option', 'Do not include'));
      select.firstElementChild.value = '';
      for (const item of catalog.filter(item => item.kind === kind)) { const option = ui.node('option', item.name); option.value = item.id; select.append(option); }
      if (catalog.some(item => item.kind === kind && item.id === previous.get(kind))) select.value = previous.get(kind);
      else select.value = '';
    }
  }
  async function save(name) {
    if (controller) throw new Error('Cancel the current resume before saving another workspace.');
    const title = bundles.name(name); invalidate(); const run = epoch; open(); ui.name.value = title; ui.builder.open = true;
    await loadChoices(); if (run !== epoch) return { ok: false, cancelled: true, message: 'Workspace save cancelled.' };
    pending = { mode: 'save', name: title, epoch: run };
    ui.showMessage('Choose the saved components to include, then say “save workspace” or choose Save selected setup.'); ui.name.focus(); render();
    return { ok: true, status: 'awaiting-review', message: `Choose the components for ${title}, then say save workspace. No actions have run.` };
  }
  async function confirmSave() {
    if (controller) throw new Error('Cancel the current resume before saving another workspace.');
    const name = bundles.name(ui.name.value), refs = selections(), approvedEpoch = epoch;
    const current = await choices();
    if (approvedEpoch !== epoch || controller) throw new Error('This workspace save was cancelled or replaced. Review the selected setup again.');
    if (refs.some(ref => !current.some(item => item.kind === ref.kind && item.id === ref.id && item.name === ref.name))) throw new Error('A selected component changed. Refresh the choices and review them again.');
    const item = store.save(name, refs); invalidate(); ui.builder.open = false; render(); ui.showMessage(`Saved ${item.name}. Its components will be reviewed each time you resume.`);
    return { ok: true, message: `Saved workspace ${item.name}. Nothing has run.` };
  }
  async function prepare(component) {
    const current = await choices(), match = current.find(item => item.kind === component.kind && item.id === component.id);
    if (!match || match.name !== component.name) throw new Error('This component was removed or renamed. Save a new setup with the current record.');
    if (component.kind === 'windows') {
      const preview = check(await api.workSessionPreview(component.id));
      const available = (preview.steps || []).some(step => step.status !== 'blocked');
      return { component, available, preview, details: (preview.steps || []).map(step => `${step.appName}: ${step.message || step.status}`), message: available ? 'Restore only the verified windows in this fresh preview.' : 'No saved window has a safe restore target.' };
    }
    if (['browser', 'editor'].includes(component.kind)) { const preview = await window.OlangaCompanionSessions.preview(component.id); return { component, available: true, preview, details: preview.targets, message: preview.message }; }
    return { component, available: true, message: component.kind === 'project' ? 'Select this project. Refreshing its index or sending source excerpts remains manual.' : 'Open its separate routine review. Starting routine actions needs another explicit confirmation.' };
  }
  async function review(name, runId = null) {
    if (controller) throw new Error('Cancel the current resume before reviewing another workspace.');
    invalidate(); const run = epoch; open();
    const snapshot = store.snapshot(); if (snapshot.error) throw new Error(snapshot.error);
    const previous = runId && snapshot.runs.find(item => item.id === runId), matches = snapshot.items.filter(item => item.name.toLocaleLowerCase() === bundles.name(name).toLocaleLowerCase());
    if (!previous && matches.length !== 1) throw new Error('No workspace with that exact name was found. Open saved setups to choose one.');
    const item = previous ? { id: previous.workspaceId, name: previous.name, components: previous.steps.map(step => step.component) } : matches[0];
    const steps = [];
    ui.showMessage(`Preparing a fresh preview of ${item.name}…`);
    for (const component of item.components) {
      const old = previous?.steps.find(step => step.component.kind === component.kind);
      if (old && ['completed', 'skipped'].includes(old.state)) { steps.push({ component, available: false, previous: old, message: old.message || 'This step will not repeat.' }); continue; }
      try { steps.push({ ...(await prepare(component)), previous: old }); }
      catch (error) { steps.push({ component, available: false, previous: old, message: error.message }); }
      if (run !== epoch) return { ok: false, cancelled: true, message: 'Workspace review cancelled.' };
    }
    if (run !== epoch) return { ok: false, cancelled: true, message: 'Workspace review cancelled.' };
    const checks = new Map(); ui.builder.open = false; ui.preview.replaceChildren(ui.node('h3', `Resume ${item.name}`));
    ui.detail(ui.preview, 'Only selected steps run. Companion changes and the focus routine retain their separate confirmations. Completed steps in a previous run cannot repeat.');
    let stepNumber = 0;
    for (const step of steps) {
      stepNumber++;
      const label = ui.node('label', undefined, 'workspace-check'), input = ui.node('input'); input.type = 'checkbox'; input.disabled = !step.available;
      input.checked = step.available && (!step.previous || step.previous.state === 'pending'); input.setAttribute('aria-label', `Resume ${labels[step.component.kind]}: ${step.component.name}`);
      label.append(input, ui.node('span', `${stepNumber}. ${labels[step.component.kind]}: ${step.component.name}${step.previous ? ` · ${step.previous.state}` : ''}`)); ui.preview.append(label); ui.detail(ui.preview, step.message);
      if (step.details?.length) { const details = ui.node('details'), summary = ui.node('summary', 'Show exact targets'); details.append(summary, ui.node('pre', step.details.join('\n'), 'workbench-result')); ui.preview.append(details); }
      checks.set(step.component.kind, input);
    }
    pending = { mode: 'resume', name: item.name, item: clone(item), steps, checks, epoch: run, runId: previous?.id || null };
    ui.actions(ui.preview, ui.button('Resume selected workspace', confirmResume, true), ui.button('Cancel workspace review', cancel));
    ui.preview.scrollIntoView?.({ block: 'start' });
    checks.values().next().value?.focus();
    ui.showMessage('Review the selected steps, then say “resume workspace” or choose Resume selected workspace.');
    const ready = steps.filter(step => step.available), unavailable = steps.length - ready.length;
    return { ok: true, status: 'awaiting-review', message: `Ready to review ${item.name}: ${ready.map(step => `${labels[step.component.kind]} ${step.component.name.slice(0, 60)}`).join('; ') || 'no available steps'}.${unavailable ? ` ${unavailable} step${unavailable === 1 ? ' is' : 's are'} unavailable or already finished.` : ''} Say resume workspace or cancel after checking the selected steps.` };
  }
  async function confirmResume() {
    const approval = pending;
    if (!approval || approval.mode !== 'resume' || approval.epoch !== epoch || controller) throw new Error('Review this workspace again before resuming.');
    const selected = approval.steps.filter(step => step.available && approval.checks.get(step.component.kind).checked).map(step => step.component.kind);
    if (!selected.length) throw new Error('Select at least one available unfinished step.');
    const latest = store.snapshot();
    if (!approval.runId && JSON.stringify(latest.items.find(item => item.id === approval.item.id)) !== JSON.stringify(approval.item)) throw new Error('This workspace changed. Review it again.');
    const run = approval.runId ? store.select(approval.runId, selected) : store.createRun(approval.item.id, selected);
    const signal = (controller = new AbortController()).signal; pending = null; ui.preview.replaceChildren(); render();
    let outcome;
    try {
      outcome = await bundles.executeRun(store, run.id, selected, { signal, onChange: render, dispatch: async component => {
        const prepared = approval.steps.find(step => step.component.kind === component.kind);
        const current = await choices();
        if (signal.aborted) return { ok: false, status: 'blocked', message: 'Cancelled before dispatch.' };
        if (!current.some(item => item.kind === component.kind && item.id === component.id && item.name === component.name)) return { ok: false, status: 'blocked', message: 'The linked component changed after review. Save a new setup.' };
        if (component.kind === 'windows') {
          const result = await api.workSessionRestore(prepared.preview.previewId), receipts = result.receipts || [];
          const verified = result.ok === true && (result.verified === true || receipts.length > 0 && receipts.every(receipt => receipt.verified === true && receipt.ok !== false));
          const partial = !verified && receipts.some(receipt => receipt.ok || receipt.verified);
          return { ...result, verified, ...(partial ? { status: 'uncertain' } : {}), message: [result.message, ...receipts.map(receipt => `${receipt.appName || 'Window'}: ${receipt.message || receipt.status || 'Result not verified'}`)].filter(Boolean).join('\n') };
        }
        if (['browser', 'editor'].includes(component.kind)) return window.OlangaCompanionSessions.restore(prepared.preview);
        if (component.kind === 'project') return workbench.selectProject(component.id);
        return window.OlangaWorkspaceRoutines.review(component.id);
      } });
    } finally { controller = null; render(); }
    const complete = outcome.steps.filter(step => step.state === 'completed').length, awaiting = outcome.steps.some(step => step.state === 'awaiting-review'), failed = outcome.steps.some(step => ['failed', 'uncertain', 'blocked', 'cancelled'].includes(step.state));
    const message = `${complete} workspace step${complete === 1 ? '' : 's'} completed.${awaiting ? ' The focus routine still needs its own review.' : ''}${failed ? ' Some steps need attention; check their individual results.' : ''}`;
    ui.history.scrollIntoView?.({ block: 'nearest' });
    ui.showMessage(message, failed); return { ok: !failed, status: failed ? 'partial' : awaiting ? 'awaiting-review' : 'completed', message, run: outcome };
  }
  function render() {
    if (!ui) return; ui.saved.replaceChildren(); ui.history.replaceChildren(); const state = store.snapshot();
    if (state.error) { ui.detail(ui.saved, state.error); return; }
    for (const item of state.items) {
      const row = ui.node('article', undefined, 'workbench-source'); row.append(ui.node('h3', item.name)); ui.detail(row, item.components.map(part => `${labels[part.kind]}: ${part.name}`).join(' · '));
      const resume = ui.button('Review workspace', () => review(item.name)), remove = ui.button('Remove workspace', () => { invalidate(); store.remove(item.id); render(); }); resume.disabled = remove.disabled = !!controller;
      ui.actions(row, resume, remove); ui.saved.append(row);
    }
    if (!state.items.length) ui.detail(ui.saved, 'No named workspaces saved. Choose existing components above; saving does not run them.');
    for (const run of state.runs.slice().reverse()) {
      const row = ui.node('article', undefined, 'workbench-source'); row.append(ui.node('h3', `${run.name} · ${new Date(run.at).toLocaleString()}`));
      for (const step of run.steps) ui.detail(row, `${labels[step.component.kind]}: ${step.component.name} · ${step.state}${step.message ? ` — ${step.message}` : ''}`);
      if (run.steps.some(step => !['completed', 'skipped', 'working'].includes(step.state))) { const retry = ui.button('Review unfinished workspace steps', () => review(run.name, run.id)); retry.disabled = !!controller; ui.actions(row, retry); }
      ui.history.append(row);
    }
  }
  async function answerReview(value) {
    const text = String(value || '').trim().replace(/[.!?]+$/, '').toLocaleLowerCase(); if (!pending) return { handled: false };
    if (/^(?:cancel|cancel workspace|cancel workspace review|never mind)$/.test(text)) return { handled: true, ...(await cancel()) };
    if (pending.mode === 'save') {
      if (/^(?:save workspace|save selected setup|confirm workspace save)$/.test(text)) return { handled: true, ...(await confirmSave()) };
      const include = /^include (window layout|browser session|editor session|project|routine) (.+)$/.exec(text), without = /^without (window layout|browser session|editor session|project|routine)$/.exec(text);
      const keys = { 'window layout': 'windows', 'browser session': 'browser', 'editor session': 'editor', project: 'project', routine: 'routine' };
      if (include || without) {
        const kind = keys[(include || without)[1]], matches = include ? catalog.filter(item => item.kind === kind && item.name.toLocaleLowerCase() === include[2]) : [];
        if (include && matches.length !== 1) return { handled: true, ok: false, message: 'No unique component with that exact name was found. Choose it from the workspace list.' };
        ui.selects.get(kind).value = include ? matches[0].id : ''; return { handled: true, ok: true, status: 'awaiting-review', message: include ? `Included ${matches[0].name}. Say save workspace when the setup is ready.` : `Removed ${labels[kind]} from this setup.` };
      }
    }
    if (pending.mode === 'resume') {
      const selection = /^(include|skip|exclude) step ([1-5])$/.exec(text);
      if (selection) {
        const step = pending.steps[Number(selection[2]) - 1], input = step && pending.checks.get(step.component.kind);
        if (!input || input.disabled) return { handled: true, ok: false, message: 'That step is unavailable or already completed. It cannot repeat.' };
        if (selection[1] === 'include' && ['uncertain', 'awaiting-review', 'working'].includes(step.previous?.state)) return { handled: true, ok: false, message: 'Check the actual result of this earlier step before selecting it in the on-screen review.' };
        input.checked = selection[1] === 'include'; return { handled: true, ok: true, status: 'awaiting-review', message: `Step ${selection[2]} ${input.checked ? 'included' : 'excluded'}. Say resume workspace when ready.` };
      }
      if (/^(?:resume workspace|resume selected workspace|confirm workspace resume)$/.test(text)) return { handled: true, ...(await confirmResume()) };
    }
    return { handled: false };
  }
  workbench.addPage('workspaces', 'Resume my work', helpers => {
    ui = { ...helpers, selects: new Map(), preview: helpers.node('div'), saved: helpers.node('div'), history: helpers.node('div') };
    const { section, node, field, detail, actions, button } = helpers;
    detail(section, 'Save one named setup from existing window layouts, browser or editor sessions, a project and an optional routine. Every resume starts with a fresh review. Saving never runs actions or shares source text.');
    ui.builder = node('details'); ui.builder.open = true; ui.builder.append(node('summary', 'Create a named workspace')); section.append(ui.builder);
    ui.name = field(ui.builder, 'Workspace name', 'text', 'Coursework'); ui.name.maxLength = 80;
    for (const kind of bundles.KINDS) { const label = node('label', labels[kind]), select = node('select'), none = node('option', 'Do not include'); none.value = ''; select.setAttribute('aria-label', `Workspace ${labels[kind].toLocaleLowerCase()}`); select.append(none); label.append(select); ui.builder.append(label); ui.selects.set(kind, select); select.addEventListener('change', () => { if (pending?.mode === 'resume') invalidate(); }); }
    actions(ui.builder, button('Load saved components', async () => { invalidate(); await loadChoices(); ui.showMessage('Choose components, then save your named setup.'); }), button('Save selected setup', confirmSave, true));
    detail(ui.builder, 'For voice setup, say “save workspace named Coursework”, then “include project My project” or the exact saved layout, browser session, editor session or routine name. Say “save workspace” when ready.');
    detail(ui.builder, 'Create window layouts in Working sessions and tab/document sessions in Browser & editor first. Workspaces keep references to those records, so removing a component leaves a clear blocked step.');
    section.append(ui.preview, node('h3', 'Saved workspaces'), ui.saved, node('h3', 'Resume results'), ui.history);
    actions(section, button('Refresh saved workspaces', render), button('Clear workspace run history', () => { store.clearHistory(); render(); }), button('Cancel remaining workspace steps', cancel)); render();
  });
  workbench.onClose(() => { cancel().catch(() => {}); });
  window.OlangaWorkspaces = { save, review, cancel, choices, list: () => store.snapshot().items, hasReview: () => !!pending, answerReview, snapshot: () => store.snapshot(), isRunning: () => !!controller };
})();
