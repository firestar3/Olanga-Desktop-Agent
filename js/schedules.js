/* Explicit schedules run only while Olanga is open. No system scheduler or automatic speech. */
(function () {
  if (!window.OlangaWorkbench || typeof OlangaSchedules === 'undefined') return;
  let store = OlangaSchedules.createStore(localStorage);
  const localBriefing = () => typeof OlangaBriefing !== 'undefined' ? OlangaBriefing.compose({ now: new Date(), tasks: typeof activeTasks !== 'undefined' ? activeTasks : [], timers: typeof activeTimers !== 'undefined' ? activeTimers : [], headlines: [], weather: '' }) : 'Open Olanga to view your tasks and timers.';
  const runnerOptions = {
    localBriefing,
    onlineBriefing: async () => {
      if (typeof buildDailyBriefing !== 'function') return localBriefing();
      return (await buildDailyBriefing()).message;
    },
    notify: payload => window.electronAPI?.notify?.(payload)
  };
  let runner = OlangaSchedules.createRunner(store, runnerOptions);
  let restoreSuspended = false, pendingTick = null;
  let render = () => {}, lastError = '';
  let interval = null;
  let disposed = false;
  function syncSchedulePolling() {
    const state = store.snapshot();
    const needed = !disposed && !restoreSuspended && !state.error && state.items.some(item => item.enabled && item.nextAt !== null);
    if (needed && interval === null) interval = setInterval(tick, 5000);
    else if (!needed && interval !== null) { clearInterval(interval); interval = null; }
  }
  // Calendar imports and the schedules page share this store. Start and stop
  // delivery checks whenever either changes it; empty/disabled schedules sleep.
  function wrapMutations() { for (const name of ['add', 'enable', 'remove']) {
    const mutate = store[name];
    store[name] = (...args) => { const result = mutate(...args); syncSchedulePolling(); return result; };
  }
  }
  wrapMutations();
  async function tick() {
    if (restoreSuspended) return;
    try { pendingTick = runner.tick(); if (await pendingTick) render(); lastError = ''; }
    catch (error) { if (lastError !== error.message) { lastError = error.message; console.warn('[Olanga] Schedule delivery stopped:', error.message); } }
    finally { pendingTick = null; syncSchedulePolling(); }
  }
  window.OlangaScheduleStore = store;
  window.OlangaSchedulesAdapter = {
    original: () => localStorage.getItem(OlangaSchedules.KEY),
    portable() { const state = store.snapshot(); if (state.error) throw new Error('Recover saved schedules before exporting them.'); return state.items.map(item => { const { kind, title, repeat, online, onceAt, time, days } = item; return { kind, title, repeat, online, ...(repeat === 'once' ? { onceAt } : { time }), ...(repeat === 'weekly' ? { days } : {}) }; }); },
    async suspend() { restoreSuspended = true; syncSchedulePolling(); if (pendingTick) await pendingTick; },
    resumePolling() { restoreSuspended = false; syncSchedulePolling(); },
    reload() { store = OlangaSchedules.createStore(localStorage); runner = OlangaSchedules.createRunner(store, runnerOptions); wrapMutations(); window.OlangaScheduleStore = store; render(); syncSchedulePolling(); },
    replacePaused(items) {
      const now = Date.now(), zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
      const saved = { version: 1, items: items.map((item, index) => ({ ...item, id: 'import-' + now + '-' + index, enabled: false, nextAt: null, createdAt: now, zone, lastDeliveredAt: null })), deliveries: [] };
      const raw = JSON.stringify(saved); localStorage.setItem(OlangaSchedules.KEY, raw); if (localStorage.getItem(OlangaSchedules.KEY) !== raw) throw new Error('Imported schedules could not be verified.'); this.reload();
    },
    rollback(raw) { if (raw === null) localStorage.removeItem(OlangaSchedules.KEY); else localStorage.setItem(OlangaSchedules.KEY, raw); if (localStorage.getItem(OlangaSchedules.KEY) !== raw) throw new Error('Schedule recovery could not be verified.'); this.reload(); }
  };
  window.OlangaWorkbench.addPage('schedules', 'Schedules', ({ section, node, button, field, actions, detail, showMessage }) => {
    detail(section, 'Create reminders or a daily briefing. Notifications work while Olanga is open, including in the tray. Missed occurrences are grouped once when you return; they never replay every missed day.');
    detail(section, 'Repeating schedules follow your computer’s local time. During a daylight-saving gap the time advances to the next valid time; a repeated hour runs once. Changing time zones schedules the next occurrence in the new zone.');
    const title = field(section, 'Reminder or briefing title', 'text', 'Prepare for coursework'); title.maxLength = 200;
    function select(label, options) { const wrapper = node('label', label), input = node('select'); input.setAttribute('aria-label', label); for (const [value, text] of options) { const option = node('option', text); option.value = value; input.append(option); } wrapper.append(input); section.append(wrapper); return input; }
    const kind = select('Type', [['reminder', 'Reminder'], ['briefing', 'Briefing']]);
    const repeat = select('Repeat', [['once', 'Once'], ['daily', 'Daily'], ['weekly', 'Weekly']]);
    const once = field(section, 'Date and time', 'datetime-local'), time = field(section, 'Time', 'time'); time.value = '09:00';
    const weekdays = node('fieldset'), legend = node('legend', 'Days of the week'); weekdays.append(legend);
    const checks = [];
    for (const [day, name] of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].entries()) { const label = node('label', undefined, 'workspace-check'), input = node('input'); input.type = 'checkbox'; input.value = String(day); input.checked = day > 0 && day < 6; label.append(input, document.createTextNode(name)); weekdays.append(label); checks.push(input); }
    section.append(weekdays);
    const onlineLabel = node('label', undefined, 'workspace-check'), online = node('input'); online.type = 'checkbox'; onlineLabel.append(online, document.createTextNode('Include online weather and news in this briefing (uses your saved providers and location when it runs)')); section.append(onlineLabel);
    detail(section, 'Briefings use local tasks and timers by default. Missed briefings always use current local data. Notifications stay silent and do not interrupt an active conversation.');
    function updateFields() { once.parentElement.hidden = repeat.value !== 'once'; time.parentElement.hidden = repeat.value === 'once'; weekdays.hidden = repeat.value !== 'weekly'; onlineLabel.hidden = kind.value !== 'briefing'; if (kind.value !== 'briefing') online.checked = false; }
    repeat.addEventListener('change', updateFields); kind.addEventListener('change', updateFields); updateFields();
    const list = node('div'), history = node('div');
    const date = timestamp => new Date(timestamp).toLocaleString();
    render = () => {
      list.replaceChildren(); history.replaceChildren(); const state = store.snapshot();
      if (state.error) { detail(list, `Schedules are paused: ${state.error}`); return; }
      for (const item of state.items) {
        const row = node('div', undefined, 'workspace-item'), content = node('div'); content.append(node('strong', item.title));
        detail(content, `${item.kind === 'briefing' ? 'Briefing' : 'Reminder'} · ${item.repeat} · ${item.enabled && item.nextAt ? `Next: ${date(item.nextAt)}` : 'Disabled'}${item.online ? ' · Online additions enabled' : ''}`);
        actions(content, button(item.enabled ? 'Disable' : 'Enable', () => { store.enable(item.id, !item.enabled); render(); }), button('Remove', () => { store.remove(item.id); render(); })); row.append(content); list.append(row);
      }
      if (!state.items.length) detail(list, 'No schedules saved.');
      for (const item of state.deliveries.slice().reverse()) { const row = node('div', undefined, 'workspace-item'), content = node('div'); content.append(node('strong', item.title)); detail(content, `${date(item.deliveredAt)} · ${item.status === 'delivered' ? 'Notification requested' : item.status}${item.missed ? ' · Missed while away' : ''}`); if (item.message) detail(content, item.message); row.append(content); history.append(row); }
    };
    actions(section, button('Save schedule', () => {
      store.add({ title: title.value, kind: kind.value, repeat: repeat.value, onceAt: new Date(once.value).getTime(), time: time.value, days: checks.filter(input => input.checked).map(input => Number(input.value)), online: online.checked }); title.value = ''; render(); showMessage('Schedule saved on this computer. Keep Olanga open or in the tray to receive it.');
    }, true), button('Refresh schedules', render));
    section.append(node('h3', 'Saved schedules'), list, node('h3', 'Recent notifications')); actions(section, button('Clear notification history', () => { store.clearHistory(); render(); })); section.append(history); render();
  });
  window.addEventListener('focus', tick);
  const unsubscribeClock = window.electronAPI?.onAppClockChanged?.(tick);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.addEventListener('beforeunload', () => { disposed = true; clearInterval(interval); interval = null; unsubscribeClock?.(); }, { once: true });
  tick();
})();
