/* Composes the spoken daily briefing from local records and optional
   headlines/weather. Pure text only: it reads data and never acts. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaBriefing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_ITEMS = 3;
  function greeting(hour) {
    if (hour >= 5 && hour < 12) return 'Good morning';
    if (hour >= 12 && hour < 17) return 'Good afternoon';
    if (hour >= 17 && hour < 22) return 'Good evening';
    return 'Hello';
  }
  function list(items) {
    if (items.length <= 1) return items.join('');
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
  }
  function remaining(ms) {
    const minutes = Math.max(1, Math.round(ms / 60000));
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    return `${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} minute${rest === 1 ? '' : 's'}` : ''}`;
  }
  const clock = time => new Date(time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
  // Google News titles end with " - Publisher" and may start with a label such
  // as "Exclusive |"; spoken headlines drop both.
  function headline(title) {
    return clean(title).replace(/\s+[-–—|]\s+[^-–—|]{2,60}$/, '')
      .replace(/^(?:exclusive|opinion|analysis|live|breaking|watch|video|update)\s*[|:]\s*/i, '')
      .replace(/[.!?…]+$/, '').trim();
  }
  function describeTimer(timer, now) {
    const label = clean(timer.label) || 'Timer';
    if (timer.kind === 'alarm') return ['alarm', 'wake up'].includes(label.toLowerCase()) ? `your alarm at ${clock(timer.endTime)}` : `a reminder at ${clock(timer.endTime)} to ${label}`;
    if (timer.kind === 'reminder') return `a reminder in ${remaining(timer.endTime - now)} to ${label}`;
    return `${label.toLowerCase() === 'timer' ? 'a timer' : `the ${label} timer`} with ${remaining(timer.endTime - now)} left`;
  }
  function compose({ now = new Date(), timers = [], tasks = [], headlines = [], weather = '' } = {}) {
    const time = now.getTime();
    const sentences = [`${greeting(now.getHours())}, Boss. It's ${clock(time)} on ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.`];
    const forecast = clean(weather);
    if (forecast) sentences.push(/[.!?]$/.test(forecast) ? forecast : `${forecast}.`);
    const open = tasks.filter(task => task && !task.completed && clean(task.text));
    if (open.length) {
      const names = open.slice(0, MAX_ITEMS).map(task => clean(task.text));
      sentences.push(`You have ${open.length} open task${open.length === 1 ? '' : 's'}: ${list(names)}${open.length > MAX_ITEMS ? `, plus ${open.length - MAX_ITEMS} more` : ''}.`);
    } else sentences.push('Your checklist is clear.');
    const valid = timers.filter(timer => timer && Number.isFinite(timer.endTime));
    const ringing = valid.filter(timer => timer.ringing);
    if (ringing.length) sentences.push(`${list(ringing.map(timer => clean(timer.label) || 'A timer'))} ${ringing.length === 1 ? 'is' : 'are'} ringing now.`);
    const upcoming = valid.filter(timer => !timer.ringing && timer.endTime > time).sort((a, b) => a.endTime - b.endTime);
    if (upcoming.length) {
      const items = upcoming.slice(0, MAX_ITEMS).map(timer => describeTimer(timer, time));
      const text = `Coming up: ${list(items)}${upcoming.length > MAX_ITEMS ? `, plus ${upcoming.length - MAX_ITEMS} more` : ''}.`;
      sentences.push(text.charAt(0).toUpperCase() + text.slice(1));
    }
    const titles = [...new Set(headlines.map(headline).filter(Boolean))].slice(0, MAX_ITEMS);
    if (titles.length) sentences.push(`In the news: ${titles.join('. ')}.`);
    return sentences.join(' ');
  }
  return { compose, greeting, headline };
});
