(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaWorkspaceBundles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const KEY = 'olanga_workspaces_v1', LIMIT = 20;
  const KINDS = ['windows', 'browser', 'editor', 'project', 'routine'];
  const STATES = ['pending', 'skipped', 'working', 'completed', 'failed', 'uncertain', 'cancelled', 'blocked', 'awaiting-review'];
  const copy = value => JSON.parse(JSON.stringify(value));
  const active = new WeakMap();
  const text = (value, maximum = 100) => typeof value === 'string' && !!value.trim() && value === value.trim() && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
  function name(value) { const result = typeof value === 'string' ? value.trim() : ''; if (!text(result, 80)) throw new Error('Use a workspace name between 1 and 80 characters.'); return result; }
  function components(values) {
    if (!Array.isArray(values) || !values.length || values.length > KINDS.length) throw new Error('Choose at least one workspace component.');
    const found = new Set();
    return values.map(item => {
      if (!item || !KINDS.includes(item.kind) || found.has(item.kind) || !text(item.id) || !text(item.name, 260) || Object.keys(item).some(key => !['kind', 'id', 'name'].includes(key))) throw new Error('This workspace component is invalid. Choose it again.');
      found.add(item.kind); return { kind: item.kind, id: item.id, name: item.name };
    }).sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  }
  function validate(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.items) || value.items.length > LIMIT || !Array.isArray(value.runs) || value.runs.length > LIMIT) throw new Error('Saved workspaces use an unsupported format.');
    const ids = new Set(), names = new Set(), runs = new Set();
    const items = value.items.map(item => {
      if (!text(item?.id) || ids.has(item.id) || !text(item.name, 80) || names.has(item.name.toLocaleLowerCase()) || !Number.isSafeInteger(item.at) || item.at < 0) throw new Error('Saved workspaces could not be validated.');
      ids.add(item.id); names.add(item.name.toLocaleLowerCase()); return { id: item.id, name: item.name, at: item.at, components: components(item.components) };
    });
    const history = value.runs.map(run => {
      if (!text(run?.id) || runs.has(run.id) || !text(run.workspaceId) || !text(run.name, 80) || !Number.isSafeInteger(run.at) || run.at < 0 || !Array.isArray(run.steps) || !run.steps.length || run.steps.length > KINDS.length) throw new Error('Workspace run history could not be validated.');
      runs.add(run.id); const refs = components(run.steps.map(step => step.component));
      if (refs.length !== run.steps.length) throw new Error('Workspace run history could not be validated.');
      return { id: run.id, workspaceId: run.workspaceId, name: run.name, at: run.at, steps: run.steps.map(step => {
        if (!STATES.includes(step.state) || typeof step.message !== 'string' || step.message.length > 2000) throw new Error('Workspace run history could not be validated.');
        return { component: components([step.component])[0], state: step.state === 'working' ? 'uncertain' : step.state, message: step.state === 'working' ? 'Olanga closed during this step. Check what happened before selecting it again.' : step.message };
      }) };
    });
    return { version: 1, items, runs: history };
  }
  function createStore(storage, { id = () => globalThis.crypto.randomUUID(), now = Date.now } = {}) {
    let state = { version: 1, items: [], runs: [] }, error = null;
    try { const raw = storage.getItem(KEY); if (raw) { if (raw.length > 250000) throw new Error('Saved workspaces are too large.'); state = validate(JSON.parse(raw)); } }
    catch (_) { error = 'Saved workspaces could not be read. Their original record is preserved; workspace changes are paused.'; }
    function transact(change) {
      if (error) throw new Error(error);
      const next = copy(state), result = change(next);
      const raw = JSON.stringify(next); if (raw.length > 250000) throw new Error('Workspace storage is full. Remove old workspaces or run history first.');
      storage.setItem(KEY, raw); state = next; return copy(result ?? true);
    }
    const findRun = (state, runId) => { const value = state.runs.find(item => item.id === runId); if (!value) throw new Error('This workspace run no longer exists.'); return value; };
    return {
      snapshot: () => ({ ...copy(state), error }),
      save(inputName, values) {
        const title = name(inputName), refs = components(values);
        return transact(next => {
          if (next.items.some(item => item.name.toLocaleLowerCase() === title.toLocaleLowerCase())) throw new Error('A workspace with this name already exists. Choose a different name.');
          if (next.items.length >= LIMIT) throw new Error('Remove an old workspace before saving more than 20.');
          const workspaceId = id(); if (!text(workspaceId) || next.items.some(item => item.id === workspaceId)) throw new Error('Could not assign a workspace ID. Try again.');
          const item = { id: workspaceId, name: title, at: now(), components: refs }; next.items.push(item); return item;
        });
      },
      remove(workspaceId) { if (active.has(this)) throw new Error('Cancel the current resume before removing a workspace.'); return transact(next => { next.items = next.items.filter(item => item.id !== workspaceId); }); },
      clearHistory() { if (active.has(this)) throw new Error('Cancel the current resume before clearing history.'); return transact(next => { next.runs = []; }); },
      createRun(workspaceId, selectedKinds) {
        return transact(next => {
          const item = next.items.find(value => value.id === workspaceId); if (!item) throw new Error('This workspace no longer exists.');
          if (!Array.isArray(selectedKinds) || !selectedKinds.length || new Set(selectedKinds).size !== selectedKinds.length || selectedKinds.some(kind => !item.components.some(part => part.kind === kind))) throw new Error('Choose at least one available workspace step.');
          const runId = id(); if (!text(runId) || next.runs.some(item => item.id === runId)) throw new Error('Could not assign a run ID. Try again.');
          const run = { id: runId, workspaceId, name: item.name, at: now(), steps: item.components.map(component => ({ component, state: selectedKinds.includes(component.kind) ? 'pending' : 'skipped', message: '' })) };
          next.runs.push(run); next.runs = next.runs.slice(-LIMIT); return run;
        });
      },
      select(runId, kinds) {
        return transact(next => {
          const run = findRun(next, runId);
          if (!Array.isArray(kinds) || !kinds.length || new Set(kinds).size !== kinds.length || kinds.some(kind => !run.steps.some(step => step.component.kind === kind && !['completed', 'skipped', 'working'].includes(step.state)))) throw new Error('Select unfinished steps only. Completed and skipped steps cannot repeat.');
          for (const step of run.steps) if (kinds.includes(step.component.kind)) { step.state = 'pending'; step.message = ''; }
          return run;
        });
      },
      step(runId, kind, stateName, message = '') {
        if (!STATES.includes(stateName)) throw new Error('Invalid workspace result.');
        return transact(next => {
          const step = findRun(next, runId).steps.find(item => item.component.kind === kind);
          if (!step || ['completed', 'skipped'].includes(step.state)) throw new Error('This workspace step cannot run again.');
          step.state = stateName; step.message = String(message).slice(0, 2000); return step;
        });
      }
    };
  }
  async function executeRun(store, runId, kinds, { dispatch, signal, onChange = () => {} } = {}) {
    if (active.has(store)) throw new Error('A workspace is already resuming.');
    if (typeof dispatch !== 'function') throw new Error('Workspace actions are unavailable.');
    const run = store.snapshot().runs.find(item => item.id === runId);
    if (!run || !Array.isArray(kinds) || !kinds.length || new Set(kinds).size !== kinds.length || kinds.some(kind => !run.steps.some(step => step.component.kind === kind && step.state === 'pending'))) throw new Error('Review the unfinished workspace steps again.');
    const token = {}; active.set(store, token);
    try {
      for (const step of run.steps) {
        const kind = step.component.kind; if (!kinds.includes(kind)) continue;
        if (signal?.aborted) { store.step(runId, kind, 'cancelled', 'Cancelled before this step started.'); onChange(); continue; }
        store.step(runId, kind, 'working', 'Waiting for this step’s result.'); onChange();
        let result;
        try { result = await dispatch(copy(step.component)); }
        catch (error) { result = { ok: false, status: 'uncertain', message: error.message || 'This step did not return a verified result. Check it before retrying.' }; }
        const state = result?.status === 'awaiting-review' ? 'awaiting-review' : result?.ok && result?.verified === true ? 'completed' : result?.status === 'blocked' ? 'blocked' : result?.status === 'uncertain' || result?.ok ? 'uncertain' : signal?.aborted ? 'uncertain' : 'failed';
        store.step(runId, kind, state, result?.message || 'No verified result was returned.'); onChange();
      }
      return store.snapshot().runs.find(item => item.id === runId);
    } finally { if (active.get(store) === token) active.delete(store); }
  }
  return { KEY, KINDS, LIMIT, name, components, createStore, executeRun, isRunning: store => active.has(store) };
});
