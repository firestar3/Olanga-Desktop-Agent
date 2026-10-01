(function (root, factory) {
  const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; else root.OlangaCalendar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const text = value => String(value || '').replace(/\\[nN]/g, '\n').replace(/\\([,;\\])/g, '$1').slice(0, 1000);
  function date(value, parameters = '') {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
    if (!match) return null;
    const [, y, m, d, h = '00', minute = '00', s = '00', z] = match;
    const numbers = [+y, +m, +d, +h, +minute, +s];
    if (+m < 1 || +m > 12 || +d < 1 || +d > 31 || +h > 23 || +minute > 59 || +s > 59) return null;
    const normalized = new Date(Date.UTC(+y, +m - 1, +d, +h, +minute, +s));
    if (normalized.getUTCMonth() !== +m - 1 || normalized.getUTCDate() !== +d) return null;
    if (z) return normalized.getTime();
    const zone = /(?:^|;)TZID=([^;]+)/.exec(parameters)?.[1]?.replace(/^"|"$/g, '');
    if (!zone) { const local = new Date(+y, +m - 1, +d, +h, +minute, +s); return [local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds()].some((value, i) => value !== numbers[i]) ? null : local.getTime(); }
    try {
      const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      let candidate = normalized.getTime();
      const parts = value => Object.fromEntries(formatter.formatToParts(value).filter(part => part.type !== 'literal').map(part => [part.type, +part.value]));
      for (let i = 0; i < 3; i++) { const p = parts(candidate); candidate += normalized.getTime() - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second); }
      const p = parts(candidate); if ([p.year, p.month, p.day, p.hour, p.minute, p.second].some((value, i) => value !== numbers[i])) return null;
      return candidate;
    } catch (_) { return null; }
  }
  function parse(source, now = Date.now()) {
    if (typeof source !== 'string' || source.length > 1048576 || !source.includes('BEGIN:VCALENDAR')) throw new Error('Choose an iCalendar (.ics) file no larger than 1 MB.');
    const lines = source.replace(/\r?\n[ \t]/g, '').split(/\r?\n/), events = [];
    let current = null, skipped = 0, nested = 0;
    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') { current = {}; nested = 0; continue; }
      if (line === 'END:VEVENT') {
        if (!current) continue;
        const start = current.DTSTART && date(current.DTSTART.value, current.DTSTART.parameters);
        if (current.RRULE || current.RDATE || current.EXDATE || current.STATUS?.value === 'CANCELLED' || !Number.isFinite(start) || start < now - 86400000 || start > now + 90 * 86400000) { skipped++; current = null; continue; }
        const end = current.DTEND ? date(current.DTEND.value, current.DTEND.parameters) : start;
        if (!Number.isFinite(end) || end < start || events.length >= 500) { skipped++; current = null; continue; }
        events.push({ title: text(current.SUMMARY?.value) || 'Untitled event', start, end, allDay: !current.DTSTART.value.includes('T'), location: text(current.LOCATION?.value), description: text(current.DESCRIPTION?.value), uid: text(current.UID?.value) });
        current = null; continue;
      }
      if (!current) continue;
      if (line.startsWith('BEGIN:')) { nested++; continue; }
      if (line.startsWith('END:')) { nested = Math.max(0, nested - 1); continue; }
      if (nested) continue;
      const colon = line.indexOf(':'); if (colon < 0) continue;
      const [name, ...parameters] = line.slice(0, colon).split(';');
      if (['DTSTART', 'DTEND', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'UID', 'RRULE', 'RDATE', 'EXDATE', 'STATUS'].includes(name)) current[name] = { value: line.slice(colon + 1), parameters: parameters.join(';') };
    }
    events.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
    return { events, skipped, importedAt: now, recurrenceSupported: false };
  }
  return { parse, date };
});
