'use strict';

const NBA_TEAMS = Object.freeze([
  ['atl', 'Atlanta Hawks'], ['bos', 'Boston Celtics'], ['bkn', 'Brooklyn Nets'], ['cha', 'Charlotte Hornets'],
  ['chi', 'Chicago Bulls'], ['cle', 'Cleveland Cavaliers'], ['dal', 'Dallas Mavericks'], ['den', 'Denver Nuggets'],
  ['det', 'Detroit Pistons'], ['gs', 'Golden State Warriors'], ['hou', 'Houston Rockets'], ['ind', 'Indiana Pacers'],
  ['lac', 'LA Clippers'], ['lal', 'Los Angeles Lakers'], ['mem', 'Memphis Grizzlies'], ['mia', 'Miami Heat'],
  ['mil', 'Milwaukee Bucks'], ['min', 'Minnesota Timberwolves'], ['no', 'New Orleans Pelicans'], ['ny', 'New York Knicks'],
  ['okc', 'Oklahoma City Thunder'], ['orl', 'Orlando Magic'], ['phi', 'Philadelphia 76ers'], ['phx', 'Phoenix Suns'],
  ['por', 'Portland Trail Blazers'], ['sac', 'Sacramento Kings'], ['sa', 'San Antonio Spurs'], ['tor', 'Toronto Raptors'],
  ['utah', 'Utah Jazz'], ['wsh', 'Washington Wizards']
].map(([id, name]) => Object.freeze({ id, name })));
const TEAM_IDS = new Set(NBA_TEAMS.map(team => team.id));
const TEAM_ALIASES = Object.freeze({ gsw: 'gs', nop: 'no', nyk: 'ny', sas: 'sa', uta: 'utah', was: 'wsh', brk: 'bkn' });
const BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 6500;
const LIVE_INTERVAL_MS = 15000;
const GAME_INTERVAL_MS = 60000;
const IDLE_INTERVAL_MS = 300000;
const SCHEDULE_CACHE_MS = 15 * 60000;
const REFRESH_THROTTLE_MS = 5000;
const easternDate = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

function teamId(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return TEAM_ALIASES[id] || id;
}
function normalizeSportsPreferences(value) {
  const id = teamId(value?.team);
  return { enabled: value?.enabled === true, team: TEAM_IDS.has(id) ? id : 'gs', liveOnly: value?.liveOnly !== false };
}
function dateKey(timestamp) {
  const parts = Object.fromEntries(easternDate.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return parts.year + parts.month + parts.day;
}
function previousDateKey(key) {
  // Subtract a calendar day, not 24 hours from local time (DST has 23/25-hour days).
  return new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)) - 1)).toISOString().slice(0, 10).replaceAll('-', '');
}
function cleanText(value, limit = 100) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}
class SportsFeedError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function numericScore(value) {
  const raw = value && typeof value === 'object' ? value.value ?? value.displayValue : value;
  if ((typeof raw !== 'number' && typeof raw !== 'string') || String(raw).trim() === '') throw new SportsFeedError('invalid');
  const score = Number(raw);
  if (!Number.isInteger(score) || score < 0 || score > 400) throw new SportsFeedError('invalid');
  return score;
}
function normalizeEvent(event) {
  if (!event || typeof event !== 'object') throw new SportsFeedError('invalid');
  const competition = event.competitions?.[0];
  const status = competition?.status || event.status;
  const type = status?.type;
  const start = Date.parse(event.date || competition?.date);
  const id = typeof event.id === 'string' || typeof event.id === 'number' ? String(event.id) : '';
  if (!/^\d{1,24}$/.test(id) || !Number.isFinite(start) || !type || !Array.isArray(competition?.competitors)) throw new SportsFeedError('invalid');
  const name = String(type.name || '').toUpperCase();
  let state;
  if (/POSTPONED|CANCELLED|CANCELED|SUSPENDED|ABANDONED|DELAYED/.test(name)) state = 'postponed';
  else if (type.completed === true || type.state === 'post') state = 'final';
  else if (type.state === 'in') state = 'live';
  else if (type.state === 'pre') state = 'pre';
  else throw new SportsFeedError('invalid');
  const sides = {};
  for (const side of competition.competitors) {
    if (!['home', 'away'].includes(side?.homeAway) || sides[side.homeAway]) throw new SportsFeedError('invalid');
    const abbr = cleanText(side.team?.abbreviation, 8).toUpperCase();
    const name = cleanText(side.team?.displayName || side.team?.shortDisplayName || side.team?.name, 70);
    if (!abbr || !name) throw new SportsFeedError('invalid');
    sides[side.homeAway] = { abbr, name, score: state === 'live' || state === 'final' ? numericScore(side.score) : null };
  }
  if (!sides.home || !sides.away) throw new SportsFeedError('invalid');
  return { id, startAt: new Date(start).toISOString(), state,
    detail: cleanText(type.shortDetail || type.detail || type.description, 100),
    period: Number.isInteger(status.period) && status.period >= 0 && status.period <= 50 ? status.period : null,
    clock: state === 'live' ? cleanText(status.displayClock, 20) : '', ...sides };
}
function parseEvents(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.events) || payload.events.length > 1000) throw new SportsFeedError('invalid');
  return payload.events.map(normalizeEvent);
}
function includesTeam(game, team) { return teamId(game.home.abbr) === team || teamId(game.away.abbr) === team; }
function chooseGame(games, team, now) {
  const deduped = [...new Map(games.filter(game => includesTeam(game, team)).map(game => [game.id, game])).values()];
  const time = game => Date.parse(game.startAt);
  // Do not resurrect an abandoned stale "live" record from a season schedule.
  const live = deduped.filter(game => game.state === 'live' && Math.abs(now - time(game)) < 18 * 3600000).sort((a, b) => time(b) - time(a));
  if (live.length) return live[0];
  const today = dateKey(now);
  const todays = deduped.filter(game => game.state !== 'live' && dateKey(time(game)) === today).sort((a, b) => time(a) - time(b));
  if (todays.length) return todays.find(game => game.state === 'pre') || todays.at(-1);
  // A west-coast final remains useful after midnight until the next morning.
  const recent = deduped.filter(game => game.state === 'final' && now >= time(game) && now - time(game) < 10 * 3600000).sort((a, b) => time(b) - time(a));
  if (recent.length) return recent[0];
  const upcoming = deduped.filter(game => game.state === 'pre' && time(game) > now).sort((a, b) => time(a) - time(b));
  if (upcoming.length) return upcoming[0];
  return deduped.filter(game => game.state === 'final' && time(game) <= now).sort((a, b) => time(b) - time(a))[0] || null;
}
function nextInterval(game, now) {
  if (game?.state === 'live') return LIVE_INTERVAL_MS;
  const untilTipOff = game?.state === 'pre' ? Date.parse(game.startAt) - now : null;
  if (untilTipOff !== null && Math.abs(untilTipOff) <= 15 * 60000) return LIVE_INTERVAL_MS;
  const interval = game && dateKey(Date.parse(game.startAt)) === dateKey(now) ? GAME_INTERVAL_MS : IDLE_INTERVAL_MS;
  // Wake exactly when a scheduled game enters the near-tip-off window, even
  // across midnight, rather than sleeping past it on an off-day interval.
  return untilTipOff > 15 * 60000 ? Math.min(interval, untilTipOff - 15 * 60000) : interval;
}
async function readBoundedJson(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_RESPONSE_BYTES) { await response.body?.cancel?.(); throw new SportsFeedError('invalid'); }
  let text;
  if (!response.body?.getReader) {
    text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new SportsFeedError('invalid');
  } else {
    const reader = response.body.getReader(), chunks = []; let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new SportsFeedError('invalid'); }
        chunks.push(Buffer.from(chunk.value));
      }
      text = Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  }
  try { return JSON.parse(text); } catch (_) { throw new SportsFeedError('invalid'); }
}

function createSportsService({ fetchImpl = globalThis.fetch, onUpdate = () => {}, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  let preferences = normalizeSportsPreferences(), active = false, disposed = false;
  let timer = null, run = null, revision = 0, failures = 0, lastAttempt = -Infinity;
  const schedules = new Map();
  const initial = () => ({ ...preferences, teamName: NBA_TEAMS.find(team => team.id === preferences.team).name,
    state: 'idle', game: null, updatedAt: null, stale: false, error: null, refreshing: false, source: 'ESPN' });
  let snapshot = initial();
  const getSnapshot = () => structuredClone(snapshot);
  const enabled = () => !disposed && preferences.enabled && active;
  function publish(patch) {
    snapshot = { ...snapshot, ...patch };
    try { onUpdate(getSnapshot()); } catch (_) { /* A view failure must not stop the polling lifecycle. */ }
  }
  function cancel() {
    revision++;
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
    run?.controller.abort();
    run = null;
  }
  function schedule(delay) {
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
    if (!enabled()) return;
    timer = setTimeoutImpl(() => { timer = null; void refresh(true); }, delay);
    timer?.unref?.();
  }
  async function request(relative, signal) {
    const controller = new AbortController(); let timeout;
    const abort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
    let rejectAbort;
    const interrupted = new Promise((_, reject) => { rejectAbort = () => reject(new SportsFeedError('cancelled')); });
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    timeout = setTimeoutImpl(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout?.unref?.();
    try {
      if (controller.signal.aborted) throw new SportsFeedError('cancelled');
      return await Promise.race([interrupted, (async () => {
        const response = await fetchImpl(BASE_URL + relative, { signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) { await response.body?.cancel?.(); throw new SportsFeedError('unavailable'); }
        return parseEvents(await readBoundedJson(response));
      })()]);
    } finally {
      clearTimeoutImpl(timeout);
      signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', rejectAbort);
      controller.abort();
    }
  }
  async function getGames(team, signal) {
    const today = dateKey(now()), yesterday = previousDateKey(today);
    const boards = await Promise.allSettled([
      request('scoreboard?dates=' + today, signal),
      request('scoreboard?dates=' + yesterday, signal)
    ]);
    if (boards.every(result => result.status === 'rejected')) throw boards[0].reason;
    const completeBoards = boards.every(result => result.status === 'fulfilled');
    const games = [...(boards[1].value || []), ...(boards[0].value || [])];
    const selected = chooseGame(games, team, now());
    if (selected && (selected.state === 'live' || dateKey(Date.parse(selected.startAt)) === today || now() - Date.parse(selected.startAt) < 10 * 3600000)) return selected;
    const cached = schedules.get(team);
    let scheduleGames;
    const cachedGame = cached ? chooseGame(cached.games, team, now()) : null;
    // A schedule can itself report a live game. Never stamp cached live scores
    // with a fresh update time, or cache a pregame status through tip-off.
    const urgent = cachedGame && nextInterval(cachedGame, now()) === LIVE_INTERVAL_MS;
    if (cached && completeBoards && !urgent && now() - cached.at < SCHEDULE_CACHE_MS && now() >= cached.at) scheduleGames = cached.games;
    else {
      scheduleGames = await request('teams/' + team + '/schedule', signal);
      if (!signal.aborted) schedules.set(team, { at: now(), games: scheduleGames });
    }
    // The scoreboard wins over a cached schedule when both mention the game.
    const game = chooseGame([...scheduleGames, ...games], team, now());
    // An empty fallback cannot establish that no game exists when one day's
    // scoreboard failed. Retain the last verified score and retry the outage
    // instead of clearing a live card and sleeping for the off-day interval.
    if (!game && !completeBoards) throw boards.find(result => result.status === 'rejected').reason;
    return game;
  }
  function refresh(force = false) {
    if (!enabled()) return Promise.resolve(getSnapshot());
    if (run) return run.promise;
    if (!force && now() - lastAttempt >= 0 && now() - lastAttempt < REFRESH_THROTTLE_MS) return Promise.resolve(getSnapshot());
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
    const current = { controller: new AbortController(), revision, promise: null };
    const team = preferences.team;
    lastAttempt = now();
    run = current;
    publish({ refreshing: true, state: snapshot.updatedAt ? snapshot.state : 'loading' });
    current.promise = (async () => {
      try {
        const game = await getGames(team, current.controller.signal);
        if (!enabled() || revision !== current.revision || current.controller.signal.aborted) return getSnapshot();
        failures = 0;
        publish({ state: 'ready', game, updatedAt: new Date(now()).toISOString(), stale: false, error: null, refreshing: false });
        schedule(nextInterval(game, now()));
      } catch (error) {
        if (!enabled() || revision !== current.revision || current.controller.signal.aborted) return getSnapshot();
        failures++;
        publish({ state: 'error', stale: !!snapshot.updatedAt, refreshing: false,
          error: error?.code === 'invalid' ? 'The score feed returned an unreadable update. Retrying automatically.' : 'Scores are temporarily unavailable. Retrying automatically.' });
        schedule(Math.min(15000 * 2 ** Math.min(failures - 1, 3), 120000));
      } finally {
        current.controller.abort();
        if (run === current) run = null;
      }
      return getSnapshot();
    })();
    return current.promise;
  }
  function configure(value) {
    if (disposed) return;
    const next = normalizeSportsPreferences(value);
    if (preferences.enabled === next.enabled && preferences.team === next.team) {
      if (preferences.liveOnly === next.liveOnly) return;
      // Visibility is a presentation preference: keep scores, an in-flight
      // request and its cadence while the overlay changes what it displays.
      preferences = next;
      publish({ liveOnly: next.liveOnly });
      return;
    }
    const changedTeam = preferences.team !== next.team;
    cancel();
    preferences = next;
    failures = 0;
    if (changedTeam) snapshot = initial();
    publish({ ...preferences, refreshing: false, ...(!preferences.enabled ? { stale: !!snapshot.updatedAt } : {}) });
    if (enabled()) void refresh(true);
  }
  function setActive(value) {
    if (disposed || active === (value === true)) return;
    active = value === true;
    cancel();
    if (enabled()) void refresh(true);
    else publish({ refreshing: false, stale: !!snapshot.updatedAt });
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancel();
    schedules.clear();
  }
  return { configure, setActive, refresh: () => refresh(false), getSnapshot, dispose };
}

module.exports = { createSportsService, NBA_TEAMS, normalizeSportsPreferences, normalizeEvent, parseEvents, chooseGame, dateKey, previousDateKey, nextInterval, readBoundedJson,
  MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, LIVE_INTERVAL_MS, GAME_INTERVAL_MS, IDLE_INTERVAL_MS };
