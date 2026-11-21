'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaTimerOverlay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizeSnapshot(value) {
    const enabled = value?.enabled === true;
    if (!enabled || !Array.isArray(value.timers)) return { enabled, timers: [], total: 0 };
    const seen = new Set();
    const timers = [];
    for (const item of value.timers) {
      if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id) ||
          typeof item.label !== 'string' || !item.label.trim() ||
          !Number.isFinite(item.endTime) || item.endTime <= 0 || item.endTime > 8640000000000000) continue;
      const paused = item.paused === true;
      if (paused && (!Number.isSafeInteger(item.remainingMs) || item.remainingMs < 0 || item.remainingMs > 31536000000)) continue;
      seen.add(item.id);
      timers.push({
        id: item.id, label: item.label.trim().slice(0, 120),
        kind: ['timer', 'reminder', 'alarm'].includes(item.kind) ? item.kind : 'timer',
        endTime: item.endTime, paused, ringing: !paused && item.ringing === true,
        ...(paused ? { remainingMs: item.remainingMs } : {})
      });
    }
    timers.sort((a, b) => Number(a.paused) - Number(b.paused) ||
      Number(b.ringing) - Number(a.ringing) || a.endTime - b.endTime || a.id.localeCompare(b.id));
    const total = Number.isSafeInteger(value.total) && value.total >= timers.length ? value.total : timers.length;
    return { enabled, timers: timers.slice(0, 5), total: timers.length ? total : 0 };
  }

  function remainingText(timer, now = Date.now()) {
    const milliseconds = timer.paused ? timer.remainingMs : timer.endTime - now;
    const seconds = timer.ringing ? 0 : Math.max(0, Math.ceil(milliseconds / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const parts = [minutes, seconds % 60];
    if (hours) parts.unshift(hours);
    return parts.map(part => String(part).padStart(2, '0')).join(':');
  }

  return Object.freeze({ normalizeSnapshot, remainingText });
});
