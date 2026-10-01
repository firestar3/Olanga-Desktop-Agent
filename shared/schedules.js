(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaSchedules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const KEY = 'olanga_schedules_v1';
  const LIMIT = 40;
  const copy = value => JSON.parse(JSON.stringify(value));
  const defaultZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  function validate(input) {
    if (!input || !['reminder', 'briefing'].includes(input.kind) || !['once', 'daily', 'weekly'].includes(input.repeat)) throw new Error('Choose a reminder or briefing and a supported repeat schedule.');
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title || title.length > 200 || /[\x00-\x1f]/.test(title)) throw new Error('Enter a title of 1–200 characters.');
    const item = { kind: input.kind, title, repeat: input.repeat, online: input.kind === 'briefing' && input.online === true };
    if (input.repeat === 'once') {
      if (!Number.isSafeInteger(input.onceAt) || input.onceAt <= 0 || input.onceAt > 8640000000000000) throw new Error('Choose a valid reminder date and time.');
      item.onceAt = input.onceAt;
    } else {
      if (typeof input.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error('Choose a time in 24-hour HH:MM format.');
      item.time = input.time;
      if (input.repeat === 'weekly') {
        if (!Array.isArray(input.days) || !input.days.length || input.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('Choose at least one weekday.');
        item.days = [...new Set(input.days)].sort((a, b) => a - b);
      }
    }
    return item;
  }
  // Date construction follows the device's calendar: DST gaps advance to the
  // next valid time, folds use the first occurrence, and calendar days are not
  // assumed to contain 24 hours. A given local date can deliver only once.
  function nextOccurrence(item, after) {
    if (item.repeat === 'once') return item.onceAt > after ? item.onceAt : null;
    const reference = new Date(after);
    if (!Number.isFinite(reference.getTime())) throw new Error('The system clock is invalid.');
    const [hour, minute] = item.time.split(':').map(Number);
    for (let offset = 0; offset <= 8; offset++) {
      const candidate = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() + offset, hour, minute, 0, 0);
      if (candidate.getTime() > after && (item.repeat === 'daily' || item.days.includes(candidate.getDay()))) return candidate.getTime();
    }
    throw new Error('Could not find the next scheduled occurrence.');
  }
  function createStore(storage, { now = Date.now, zone = defaultZone, id = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}` } = {}) {
    let state = { version: 1, items: [], deliveries: [] };
    let loadError = '';
    try {
      const raw = storage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved?.version !== 1 || !Array.isArray(saved.items) || saved.items.length > LIMIT || !Array.isArray(saved.deliveries)) throw new Error('Saved schedules could not be read.');
        const unique = new Set();
        state.items = saved.items.map(item => {
          const valid = validate(item);
          if (typeof item.id !== 'string' || !item.id || item.id.length > 100 || unique.has(item.id) || typeof item.enabled !== 'boolean' || item.nextAt !== null && (!Number.isSafeInteger(item.nextAt) || item.nextAt <= 0) || !Number.isSafeInteger(item.createdAt)) throw new Error('A saved schedule is invalid.');
          unique.add(item.id);
          return { ...valid, id: item.id, enabled: item.enabled, nextAt: item.nextAt, createdAt: item.createdAt, zone: String(item.zone || 'local').slice(0, 100), lastDeliveredAt: Number.isSafeInteger(item.lastDeliveredAt) ? item.lastDeliveredAt : null };
        });
        state.deliveries = saved.deliveries.slice(-60).filter(item => item && typeof item.id === 'string' && typeof item.title === 'string' && Number.isSafeInteger(item.deliveredAt)).map(item => ({ id: item.id.slice(0, 200), scheduleId: String(item.scheduleId || '').slice(0, 100), title: item.title.slice(0, 200), message: String(item.message || '').slice(0, 3000), deliveredAt: item.deliveredAt, scheduledAt: item.scheduledAt, status: ['pending', 'delivered', 'failed', 'interrupted'].includes(item.status) ? item.status : 'interrupted', missed: item.missed === true }));
        // A crash after consumption must never replay external/provider work.
        state.deliveries.forEach(item => { if (item.status === 'pending') item.status = 'interrupted'; });
      }
    } catch (error) { loadError = error.message; state = { version: 1, items: [], deliveries: [] }; }
    function commit(next) { storage.setItem(KEY, JSON.stringify(next)); state = next; }
    function transact(change) {
      if (loadError) throw new Error(`${loadError} Export or repair the saved schedule data before saving new schedules.`);
      const next = copy(state); const result = change(next); commit(next); return copy(result ?? true);
    }
    return {
      snapshot: () => ({ ...copy(state), error: loadError }),
      add(input) {
        const item = validate(input), clock = now();
        if (item.repeat === 'once' && item.onceAt <= clock) throw new Error('Choose a future date and time.');
        return transact(next => {
          if (next.items.length >= LIMIT) throw new Error(`Keep at most ${LIMIT} schedules.`);
          const scheduleId = id(); if (next.items.some(item => item.id === scheduleId)) throw new Error('Could not assign a unique schedule ID. Try again.');
          const saved = { ...item, id: scheduleId, enabled: true, createdAt: clock, zone: zone(), lastDeliveredAt: null, nextAt: nextOccurrence(item, clock) }; next.items.push(saved); return saved;
        });
      },
      enable(scheduleId, enabled) {
        if (typeof enabled !== 'boolean') throw new Error('Invalid enabled state.');
        return transact(next => {
          const item = next.items.find(item => item.id === scheduleId); if (!item) throw new Error('Schedule no longer exists.');
          if (!enabled) for (const delivery of next.deliveries) if (delivery.scheduleId === scheduleId && delivery.status === 'pending') { delivery.status = 'failed'; delivery.message = 'Disabled before delivery.'; }
          if (enabled === item.enabled) return item;
          item.enabled = enabled; item.zone = zone(); item.nextAt = enabled ? nextOccurrence(item, now()) : null;
          if (enabled && item.nextAt === null) throw new Error('This one-time reminder has passed. Create a new reminder.');
          return item;
        });
      },
      remove(scheduleId) { return transact(next => { next.items = next.items.filter(item => item.id !== scheduleId); }); },
      clearHistory() { return transact(next => { next.deliveries = []; }); },
      // Persist consumption BEFORE notification/provider work. A resume yields
      // at most one delivery per schedule, never each missed daily occurrence.
      takeDue() {
        const clock = now(); if (!Number.isSafeInteger(clock) || clock <= 0) throw new Error('The system clock is invalid.');
        if (loadError) throw new Error(loadError);
        const next = copy(state), due = []; let changed = false;
        for (const item of next.items) {
          if (!item.enabled) continue;
          if (item.repeat !== 'once' && item.zone !== zone()) { item.zone = zone(); item.nextAt = nextOccurrence(item, clock); changed = true; continue; }
          if (item.nextAt === null || item.nextAt > clock) continue;
          const scheduledAt = item.nextAt;
          item.lastDeliveredAt = clock; item.nextAt = nextOccurrence(item, clock); if (item.repeat === 'once') item.enabled = false;
          const delivery = { id: `${item.id}:${scheduledAt}`, scheduleId: item.id, title: item.title, message: '', scheduledAt, deliveredAt: clock, missed: clock - scheduledAt > 60000, status: 'pending' };
          next.deliveries.push(delivery); due.push({ ...copy(item), deliveryId: delivery.id, scheduledAt, missed: delivery.missed }); changed = true;
        }
        if (changed) { next.deliveries = next.deliveries.slice(-60); commit(next); }
        return due;
      },
      stillEnabled(scheduleId, deliveryId) { const item = state.items.find(item => item.id === scheduleId); return !!item && state.deliveries.some(delivery => delivery.id === deliveryId && delivery.status === 'pending') && (item.enabled || item.repeat === 'once'); },
      complete(deliveryId, status, message) {
        if (!['delivered', 'failed'].includes(status)) throw new Error('Invalid delivery outcome.');
        return transact(next => { const item = next.deliveries.find(item => item.id === deliveryId); if (item?.status === 'pending') { item.status = status; item.message = String(message || '').slice(0, 3000); } });
      }
    };
  }
  function createRunner(store, { localBriefing = () => 'Your scheduled briefing is ready.', onlineBriefing, notify = () => {} } = {}) {
    let active = null;
    return {
      tick() {
        if (active) return active;
        active = (async () => {
          const due = store.takeDue(), notices = []; let online = null;
          for (const item of due) {
            if (!store.stillEnabled(item.id, item.deliveryId)) { store.complete(item.deliveryId, 'failed', 'Removed or disabled before delivery.'); continue; }
            let message = item.title;
            try {
              if (item.kind === 'briefing') {
                // Missed briefings use current local data, avoiding a burst of
                // provider calls when the computer wakes or the app restarts.
                if (item.online && !item.missed && typeof onlineBriefing === 'function') {
                  if (!online) online = Promise.resolve().then(onlineBriefing);
                  try { message = await online; } catch (_) { message = `${await localBriefing()} Online additions were unavailable.`; }
                } else message = await localBriefing();
              }
              if (!store.stillEnabled(item.id, item.deliveryId)) { store.complete(item.deliveryId, 'failed', 'Removed or disabled before delivery.'); continue; }
              notices.push({ item, message: String(message).slice(0, 3000) });
            } catch (error) { store.complete(item.deliveryId, 'failed', error.message || 'Could not prepare this notification.'); }
          }
          const ready = notices.filter(({ item }) => store.stillEnabled(item.id, item.deliveryId));
          if (ready.length) {
            const title = ready.length === 1 ? ready[0].item.title : `${ready.length} Olanga reminders`;
            const body = ready.map(({ item, message }) => `${item.missed ? 'Missed while away: ' : ''}${message}`).join('\n').slice(0, 3000);
            try {
              await notify({ title, body });
              for (const { item, message } of ready) store.complete(item.deliveryId, 'delivered', message);
            } catch (error) { for (const { item } of ready) store.complete(item.deliveryId, 'failed', error.message || 'Notification could not be shown.'); }
          }
          return ready.length;
        })().finally(() => { active = null; });
        return active;
      }
    };
  }
  return { KEY, LIMIT, validate, nextOccurrence, createStore, createRunner };
});
