(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaProductivity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const KEY = 'olanga_productivity_v1';
  const STATES = new Set(['working', 'completed', 'failed', 'cancelled', 'awaiting-input', 'interrupted', 'unverified']);
  const STEP_STATES = new Set(['pending', 'working', 'completed', 'failed', 'cancelled', 'uncertain', 'skipped', 'unverified']);
  const MAX_HISTORY = 40;
  const MAX_FACTS = 50;
  const TIMING_PHASES = ['acknowledgment', 'transcription', 'planning', 'execution', 'first-audio', 'speech', 'total'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const name = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 100 && !/[\[\]\r\n\x00-\x1f]/.test(value) ? value.trim() : '';
  // Memories are statements the user explicitly asked Olanga to keep. They are
  // context for answers, never instructions or permission to act.
  const factText = value => typeof value === 'string' && value.trim().length >= 2 && value.trim().length <= 300 && !/[\[\]\x00-\x1f]/.test(value) ? value.trim().replace(/\s+/g, ' ') : '';
  const FACT_STOP_WORDS = new Set(['the', 'that', 'this', 'my', 'is', 'are', 'was', 'and', 'about', 'your', 'for', 'our']);
  let idSequence = 0;
  const id = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}-${++idSequence}`;
  function completedState(steps) {
    if (steps.some(step => step.state === 'failed')) return 'failed';
    if (steps.some(step => step.state === 'cancelled')) return 'cancelled';
    if (steps.some(step => ['pending', 'working', 'uncertain'].includes(step.state))) return 'interrupted';
    return steps.some(step => step.state === 'unverified') ? 'unverified' : 'completed';
  }

  function defaults() {
    return { version: 1, memoryEnabled: false, saveActivity: false, diagnostics: false, speechInput: 'cloud', factsEnabled: true, aliases: [], playlists: [], facts: [], routines: [], activity: [], runs: [], timings: [] };
  }
  function sanitize(raw) {
    const result = defaults();
    if (!raw || typeof raw !== 'object' || raw.version !== 1) return result;
    for (const key of ['memoryEnabled', 'saveActivity', 'diagnostics']) result[key] = raw[key] === true;
    result.factsEnabled = raw.factsEnabled !== false;
    const factIds = new Set(), factTexts = new Set();
    for (const item of Array.isArray(raw.facts) ? raw.facts.slice(0, MAX_FACTS) : []) {
      const text = factText(item?.text);
      if (!text || !name(item?.id) || factIds.has(item.id) || factTexts.has(text.toLowerCase()) || !Number.isFinite(item.at)) continue;
      factIds.add(item.id); factTexts.add(text.toLowerCase());
      result.facts.push({ id: item.id, text, at: item.at });
    }
    result.speechInput = ['offline', 'offline-general'].includes(raw.speechInput) ? raw.speechInput : 'cloud';
    for (const key of ['aliases', 'playlists']) {
      const seen = new Set();
      for (const item of Array.isArray(raw[key]) ? raw[key].slice(0, 50) : []) {
        const alias = name(item?.alias), target = name(item?.target);
        if (!alias || !target || seen.has(alias.toLowerCase())) continue;
        seen.add(alias.toLowerCase());
        result[key].push({ alias, target });
      }
    }
    const routineIds = new Set();
    for (const item of Array.isArray(raw.routines) ? raw.routines.slice(0, 30) : []) {
      if (!name(item?.id) || routineIds.has(item.id) || !name(item.name) || !Array.isArray(item.lines) || !item.lines.length || item.lines.length > 12 || item.lines.some(line => typeof line !== 'string' || !line.trim() || line.length > 500 || /[\r\n]/.test(line))) continue;
      routineIds.add(item.id);
      result.routines.push({ id: item.id, name: item.name.trim(), lines: item.lines.map(line => line.trim()) });
    }
    if (result.saveActivity) {
      for (const entry of Array.isArray(raw.activity) ? raw.activity.slice(-MAX_HISTORY) : []) {
        if (!name(entry?.id) || !Number.isFinite(entry.at) || !STATES.has(entry.state)) continue;
        result.activity.push({ id: entry.id, at: entry.at, state: ['working', 'awaiting-input'].includes(entry.state) ? 'interrupted' : entry.state,
          steps: (Array.isArray(entry.steps) ? entry.steps : []).slice(0, 16).filter(step => /^[A-Z_]{1,40}$/.test(step?.operation) && STEP_STATES.has(step.state)).map(step => ({ operation: step.operation, state: step.state === 'working' ? 'uncertain' : step.state })) });
      }
    }
    const runs = Array.isArray(raw.runs) ? raw.runs.slice(-10) : [];
    const runIdCounts = new Map();
    for (const run of runs) if (name(run?.id)) runIdCounts.set(run.id, (runIdCounts.get(run.id) || 0) + 1);
    for (const run of runs) {
      if (!name(run?.id) || !name(run.name) || !Number.isFinite(run.at) || !STATES.has(run.state) || !Array.isArray(run.steps) || !run.steps.length || run.steps.length > 12) continue;
      // Ambiguous IDs could display one proposal but dispatch another via find(id).
      if (runIdCounts.get(run.id) !== 1) continue;
      if (run.steps.some(step => typeof step?.command !== 'string' || !/^\[[A-Z_]+(?:: [^\[\]\r\n]+)?\]$/.test(step.command) || step.command.length > 1000 || !STEP_STATES.has(step.state))) continue;
      result.runs.push({ id: run.id, name: run.name, at: run.at, state: run.state === 'working' ? 'interrupted' : run.state,
        steps: run.steps.map(step => ({ command: step.command, state: step.state === 'working' ? 'uncertain' : step.state })) });
    }
    if (result.diagnostics) result.timings = (Array.isArray(raw.timings) ? raw.timings : []).slice(-200).filter(item => TIMING_PHASES.includes(item?.phase) && Number.isFinite(item.ms) && item.ms >= 0 && item.ms <= 3600000 && ['ok', 'error', 'cancelled'].includes(item.outcome)).map(item => ({ phase: item.phase, ms: item.ms, outcome: item.outcome }));
    return result;
  }

  function createStore(storage) {
    let state;
    try { state = sanitize(JSON.parse(storage.getItem(KEY) || 'null')); } catch (_) { state = defaults(); }
    const listeners = new Set();
    // A view failure must not turn a committed write into an apparent storage
    // failure, nor prevent other views from receiving the committed state.
    function notify() { for (const listener of [...listeners]) { try { listener(); } catch (_) {} } }
    function freshId() {
      let candidate;
      do { candidate = id(); } while (['routines', 'runs', 'activity', 'facts'].some(key => state[key].some(item => item.id === candidate)));
      return candidate;
    }
    function save(required = false) {
      try {
        const activity = state.saveActivity ? state.activity.map(entry => ({ id: entry.id, at: entry.at, state: entry.state, steps: entry.steps.map(step => ({ operation: step.operation, state: step.state })) })) : [];
        storage.setItem(KEY, JSON.stringify({ ...state, activity, timings: state.diagnostics ? state.timings : [] }));
      } catch (_) {
        if (required) throw new Error('Olanga could not save this change. Free some storage and try again.');
        notify();
        return false;
      }
      notify();
      return true;
    }
    function edit(fn) {
      const previous = state, draft = clone(state);
      fn(draft);
      state = draft;
      try { save(true); } catch (error) { state = previous; notify(); throw error; }
    }
    function options() {
      return state.memoryEnabled ? { aliases: clone(state.aliases), playlists: clone(state.playlists) } : {};
    }
    return {
      snapshot: () => clone(state), options,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      preference(key, value) {
        if (!['memoryEnabled', 'saveActivity', 'diagnostics', 'speechInput', 'factsEnabled'].includes(key)) throw new Error('Unknown preference.');
        if (key === 'speechInput' ? !['cloud', 'offline', 'offline-general'].includes(value) : typeof value !== 'boolean') throw new Error('Invalid preference.');
        edit(data => { data[key] = value; if (key === 'diagnostics' && !value) data.timings = []; });
      },
      remember(kind, alias, target, previous) {
        if (!['aliases', 'playlists'].includes(kind) || !name(alias) || !name(target)) throw new Error('Use names of 1–100 characters without command markers or line breaks.');
        edit(data => {
          const index = data[kind].findIndex(item => item.alias.toLowerCase() === alias.trim().toLowerCase());
          if (previous) {
            const oldIndex = ['aliases', 'playlists'].includes(previous.kind) ? data[previous.kind].findIndex(item => item.alias === previous.alias) : -1;
            if (oldIndex < 0) throw new Error('This saved name was removed. Open a current saved name to edit.');
            if (index >= 0 && (kind !== previous.kind || index !== oldIndex)) throw new Error('Another saved name already uses that name. Choose a different name.');
            data[previous.kind].splice(oldIndex, 1);
          }
          const item = { alias: alias.trim(), target: target.trim() };
          if (!previous && index >= 0) data[kind][index] = item;
          else { if (data[kind].length >= 50) throw new Error('Remove a saved name before adding another.'); data[kind].push(item); }
        });
      },
      forget(kind, alias) { if (!['aliases', 'playlists'].includes(kind)) return; edit(data => { data[kind] = data[kind].filter(item => item.alias !== alias); }); },
      clearMemory() { edit(data => { data.aliases = []; data.playlists = []; data.memoryEnabled = false; }); },
      rememberFact(text) {
        const clean = factText(text);
        if (!clean) throw new Error('Tell me what to remember in 2–300 characters, without brackets or line breaks.');
        let record;
        edit(data => {
          record = data.facts.find(item => item.text.toLowerCase() === clean.toLowerCase());
          if (record) return;
          if (data.facts.length >= MAX_FACTS) throw new Error('Your memory list is full. Delete a memory in Workspace before adding another.');
          record = { id: freshId(), text: clean, at: Date.now() };
          data.facts.push(record);
        });
        return clone(record);
      },
      // Exact wording first, then a unique phrase, then all meaningful words.
      findFacts(query) {
        const target = String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (!target) return [];
        const exact = state.facts.filter(item => item.text.toLowerCase() === target);
        if (exact.length) return clone(exact);
        const phrase = state.facts.filter(item => item.text.toLowerCase().includes(target));
        if (phrase.length) return clone(phrase);
        const words = target.split(' ').filter(word => word.length > 2 && !FACT_STOP_WORDS.has(word));
        return words.length ? clone(state.facts.filter(item => words.every(word => item.text.toLowerCase().includes(word)))) : [];
      },
      deleteFact(factId) {
        let removed = null;
        edit(data => { removed = data.facts.find(item => item.id === factId) || null; data.facts = data.facts.filter(item => item.id !== factId); });
        return removed ? clone(removed) : null;
      },
      clearFacts() { const count = state.facts.length; edit(data => { data.facts = []; }); return count; },
      memoryContext() { return state.factsEnabled ? state.facts.map(item => item.text) : []; },
      saveRoutine(routine, parse) {
        if (!routine || !Array.isArray(routine.lines) || routine.lines.some(line => typeof line !== 'string')) throw new Error('Give the routine a name and supported commands.');
        const lines = routine.lines.map(line => line.trim()).filter(Boolean);
        if (!name(routine.name) || !lines.length || lines.length > 12 || lines.some(line => line.length > 500 || /[\r\n]/.test(line))) throw new Error('Give the routine a name and up to 12 short commands, one per line.');
        const actions = lines.flatMap(line => { const parsed = parse(line, options()); if (!Array.isArray(parsed) || !parsed.length) throw new Error(`This command needs interpretation and cannot be saved as a routine: ${line}`); return parsed; });
        if (actions.length > 12) throw new Error('A routine can contain at most 12 actions.');
        if (routine.id && !state.routines.some(item => item.id === routine.id)) throw new Error('This routine was removed. Start a new routine instead.');
        const record = { id: routine.id || freshId(), name: routine.name.trim(), lines };
        edit(data => { const index = data.routines.findIndex(item => item.id === record.id); if (index >= 0) data.routines[index] = record; else { if (data.routines.length >= 30) throw new Error('Remove a routine before adding another.'); data.routines.push(record); } });
        return clone(record);
      },
      deleteRoutine(routineId) { edit(data => { data.routines = data.routines.filter(item => item.id !== routineId); }); },
      createRun(routine, actions, selected) {
        if (!name(routine?.name) || !Array.isArray(actions) || !actions.length || actions.length > 12 || actions.some(action => typeof action?.command !== 'string' || action.command.length > 1000 || !/^\[[A-Z_]+(?:: [^\[\]\r\n]+)?\]$/.test(action.command))) throw new Error('Invalid routine steps.');
        if (selected === undefined) selected = actions.map((_, index) => index);
        if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(index => !Number.isInteger(index) || !actions[index])) throw new Error('Select at least one valid step.');
        const run = { id: freshId(), name: routine.name, at: Date.now(), state: 'awaiting-input', steps: actions.map((action, index) => ({ command: action.command, state: selected.includes(index) ? 'pending' : 'skipped' })) };
        edit(data => { data.runs = [...data.runs, run].slice(-10); });
        return clone(run);
      },
      selectRunSteps(runId, selected) {
        edit(data => {
          const run = data.runs.find(item => item.id === runId);
          if (!run || !Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(index => !Number.isInteger(index) || !run.steps[index] || ['completed', 'skipped', 'working'].includes(run.steps[index].state))) throw new Error('Review the unfinished steps again.');
          run.steps.forEach((step, index) => { if (!['completed', 'skipped'].includes(step.state) && !selected.includes(index)) step.state = 'skipped'; });
        });
      },
      transitionRun(runId, index, status) {
        if (!STEP_STATES.has(status)) throw new Error('Invalid step state.');
        edit(data => { const run = data.runs.find(item => item.id === runId); const step = run?.steps[index]; if (!step || step.state === 'completed' || step.state === 'skipped') throw new Error('This step cannot run again.'); step.state = status; run.state = 'working'; });
      },
      finishRun(runId, status) {
        if (!STATES.has(status)) return;
        let finished;
        try {
          edit(data => {
            const run = data.runs.find(item => item.id === runId);
            if (!run) return;
            run.state = finished = status === 'completed' ? completedState(run.steps) : status;
            for (const step of run.steps) if (step.state === 'working') step.state = 'uncertain';
          });
        } catch (error) {
          // The durable dispatch boundary still permits safe recovery on restart.
          // Mirror that uncertainty locally; no executor remains active after this.
          const run = state.runs.find(item => item.id === runId);
          if (run) {
            run.state = 'interrupted';
            for (const step of run.steps) if (step.state === 'working') step.state = 'uncertain';
          }
          notify();
          throw error;
        }
        return finished;
      },
      deleteRun(runId) { edit(data => { data.runs = data.runs.filter(item => item.id !== runId); }); },
      begin() { const entry = { id: freshId(), at: Date.now(), state: 'working', steps: [] }; state.activity = [...state.activity, entry].slice(-MAX_HISTORY); save(); return entry.id; },
      plan(entryId, operations) {
        const entry = state.activity.find(item => item.id === entryId);
        if (!entry || entry.state !== 'working' || entry.steps.length || !Array.isArray(operations) || operations.length > 16 || operations.some(operation => !/^[A-Z_]{1,40}$/.test(operation))) return;
        entry.steps = operations.map(operation => ({ operation, state: 'pending' })); save();
      },
      step(entryId, operation) {
        const entry = state.activity.find(item => item.id === entryId);
        if (!entry || entry.state !== 'working' || !/^[A-Z_]{1,40}$/.test(operation)) return null;
        const pending = entry.steps.findIndex(step => step.operation === operation && step.state === 'pending');
        if (pending >= 0) { entry.steps[pending].state = 'working'; save(); return pending; }
        if (entry.steps.length >= 16) return null;
        entry.steps.push({ operation, state: 'working' }); save(); return entry.steps.length - 1;
      },
      receipt(entryId, index, outcome, details) {
        const entry = state.activity.find(item => item.id === entryId), step = entry?.steps[index];
        if (!entry || entry.state !== 'working' || !step || step.state !== 'working') return;
        // A cancelled dispatch may already have affected the external app.
        step.state = outcome === 'cancelled' ? 'uncertain' : ['completed', 'unverified', 'uncertain'].includes(outcome) ? outcome : 'failed';
        if (typeof details === 'string') step.details = details.slice(0, 600);
        save();
      },
      finish(entryId, status) {
        const entry = state.activity.find(item => item.id === entryId);
        if (!entry || !['working', 'awaiting-input'].includes(entry.state) || !STATES.has(status)) return;
        entry.state = status === 'completed' ? completedState(entry.steps) : status;
        for (const step of entry.steps) {
          if (step.state === 'working') step.state = 'uncertain';
          else if (step.state === 'pending') step.state = 'skipped';
        }
        save();
      },
      clearActivity(entryId) { edit(data => { data.activity = entryId ? data.activity.filter(item => item.id !== entryId) : []; }); },
      timing(phase, ms, outcome = 'ok') {
        if (!state.diagnostics || !TIMING_PHASES.includes(phase) || !Number.isFinite(ms)) return;
        state.timings = [...state.timings, { phase, ms: Math.max(0, Math.min(3600000, ms)), outcome: ['ok', 'error', 'cancelled'].includes(outcome) ? outcome : 'error' }].slice(-200); save();
      },
      clearTimings() { edit(data => { data.timings = []; }); }
    };
  }
  // Presentation only: the reviewed command remains the authoritative dispatch
  // value. Preserve its arguments and never turn these labels back into actions.
  function formatCommand(command) {
    const match = /^\[([A-Z_]+)(?::\s*([^\[\]\r\n]+))?\]$/.exec(String(command));
    if (!match) return 'Unavailable command';
    const operation = match[1], argument = (match[2] || '').trim();
    const quoted = value => `“${value}”`;
    const names = {
      OPEN_APP: 'Open app', CLOSE_APP: 'Request app close', CANCEL_TIMER: 'Cancel timer',
      REMOVE_TASK: 'Remove task', COMPLETE_TASK: 'Complete task', UNCOMPLETE_TASK: 'Reopen task',
      SPOTIFY_SONG: 'Play Spotify song', SPOTIFY_ALBUM: 'Play Spotify album',
      SPOTIFY_PLAYLIST: 'Play public Spotify playlist', SPOTIFY_LIBRARY: 'Play private Spotify playlist', SPOTIFY_ARTIST: 'Play Spotify artist',
      SPOTIFY_LIKED: 'Play your Spotify Liked Songs', SPOTIFY_RELOAD: 'Restart Spotify and resume playback',
      MEDIA_PLAY_PAUSE: 'Toggle play / pause', MEDIA_PLAY: 'Resume playback', MEDIA_PAUSE: 'Pause playback',
      MEDIA_STATUS: 'Check current playback', MEDIA_NEXT: 'Skip to next track', MEDIA_PREV: 'Go to previous track',
      VOLUME_UP: 'Turn system volume up', VOLUME_DOWN: 'Turn system volume down', VOLUME_STATUS: 'Check system volume',
      VOLUME_MUTE: 'Toggle system mute', VOLUME_MUTE_ON: 'Mute system audio', VOLUME_MUTE_OFF: 'Unmute system audio',
      MUTE_MIC: 'Mute microphone', UNMUTE_MIC: 'Unmute microphone', MUTE_TTS: 'Mute Olanga’s voice', UNMUTE_TTS: 'Unmute Olanga’s voice',
      CLEAR_ALL_TIMERS: 'Clear all timers', TIMER_STATUS: 'Check timers', CLEAR_ALL_TASKS: 'Clear all checklist tasks', TASK_STATUS: 'Check checklist',
      TIME_STATUS: 'Say the time', DATE_STATUS: 'Say the date', HELP: 'Describe what Olanga can do', DISMISS: 'Dismiss the request',
      STOP_TIMER: 'Stop the ringing alarm or timer', REMEMBER: 'Remember', FORGET: 'Forget a memory', MEMORY_STATUS: 'List memories',
      CLEAR_MEMORIES: 'Delete all memories', DAILY_BRIEFING: 'Daily briefing'
    };
    if (operation === 'VOLUME_SET') return `Set system volume to ${argument}%`;
    const pair = /^([^,]+),\s*(.+)$/.exec(argument);
    const units = value => {
      let seconds = Number(value);
      const parts = [];
      for (const [size, label] of [[3600, 'hour'], [60, 'minute'], [1, 'second']]) {
        const amount = Math.floor(seconds / size); seconds %= size;
        if (amount) parts.push(`${amount} ${label}${amount === 1 ? '' : 's'}`);
      }
      return parts.join(' ') || '0 seconds';
    };
    if (operation === 'SET_TIMER' && pair && /^\d+$/.test(pair[1])) return `Start timer: ${units(pair[1])} · ${quoted(pair[2].trim())}`;
    if (operation === 'SET_REMINDER' && pair && /^\d+$/.test(pair[1])) return `Reminder in ${units(pair[1])}: ${quoted(pair[2].trim())}`;
    if (operation === 'SET_ALARM' && pair) return `${['alarm', 'wake up'].includes(pair[2].trim().toLowerCase()) ? 'Alarm' : 'Reminder'} at ${pair[1].trim()}: ${quoted(pair[2].trim())}`;
    if (operation === 'ARRANGE_APP' && pair) {
      const app = quoted(pair[1].trim()), layout = pair[2].trim().toLowerCase();
      if (layout === 'maximize') return `Maximize ${app}`;
      if (['left', 'right'].includes(layout)) return `Move ${app} to the ${layout} half`;
    }
    if (operation === 'SET_TASK_DUE' && pair) return `Set due date for ${quoted(pair[1].trim())} to ${quoted(pair[2].trim())}`;
    if (operation === 'ADD_TASK') return pair ? `Add task: ${quoted(pair[1].trim())} · due ${quoted(pair[2].trim())}` : `Add task: ${quoted(argument)}`;
    const label = names[operation] || operation.replaceAll('_', ' ').toLowerCase().replace(/^./, character => character.toUpperCase());
    return argument ? `${label}: ${quoted(argument)}` : label;
  }
  function statistics(timings) {
    return [...new Set(timings.map(item => item.phase))].map(phase => {
      const samples = timings.filter(item => item.phase === phase), values = samples.map(item => item.ms).sort((a, b) => a - b);
      return { phase, count: samples.length, median: values[Math.floor((values.length - 1) / 2)], p95: values[Math.ceil(values.length * .95) - 1], failures: samples.filter(item => item.outcome !== 'ok').length };
    });
  }
  const running = new WeakMap();
  async function executeRun(store, runId, indices, { signal, dispatch, validate = () => {} }) {
    const run = store.snapshot().runs.find(item => item.id === runId);
    if (!run || !Array.isArray(indices) || !indices.length || new Set(indices).size !== indices.length || indices.some(index => !Number.isInteger(index) || !run.steps[index] || ['completed', 'skipped', 'working'].includes(run.steps[index].state))) throw new Error('Review the unfinished steps before running them.');
    const active = running.get(store) || new Set(); running.set(store, active);
    if (active.size) throw new Error('A routine is already running. Cancel it before starting another.');
    const selected = [...indices].sort((a, b) => a - b);
    for (const index of selected) validate(run.steps[index].command);
    active.add(runId);
    let state = 'completed'; const messages = [];
    const assertActive = () => { if (signal?.aborted) throw Object.assign(new Error('Routine cancelled.'), { name: 'AbortError' }); };
    try {
      for (const index of selected) {
        assertActive();
        store.transitionRun(run.id, index, 'working');
        const result = await dispatch(run.steps[index].command);
        assertActive();
        const ok = Array.isArray(result?.results) && result.results.length > 0 && result.results.every(receipt => receipt.ok === true);
        const verified = ok && result.results.every(receipt => receipt.verified !== false);
        store.transitionRun(run.id, index, ok ? verified ? 'completed' : 'unverified' : 'failed');
        messages.push(result?.spokenResponse || 'The step returned no confirmed result.');
        if (!ok) { state = 'failed'; messages.push('The remaining steps did not run. Review them in Workspace.'); break; }
      }
    } catch (error) {
      state = signal?.aborted || error.name === 'AbortError' ? 'cancelled' : 'failed';
      if (state !== 'cancelled') messages.push(`The routine stopped. ${error.message}`);
    } finally {
      try { state = store.finishRun(run.id, state) || 'failed'; } catch (error) { state = 'failed'; messages.push(error.message); }
      active.delete(runId);
    }
    return { state, messages };
  }
  return { createStore, sanitize, defaults, statistics, formatCommand, executeRun, isRunning: store => !!running.get(store)?.size, KEY, MAX_FACTS };
});
