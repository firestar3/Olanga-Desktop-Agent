'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSportsService, NBA_TEAMS, normalizeSportsPreferences, normalizeEvent, parseEvents, chooseGame,
  dateKey, previousDateKey, nextInterval, readBoundedJson, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS } = require('../../desktop/sports-service');

const NOW = Date.parse('2026-10-28T23:30:00Z');
function event({ id = '401000001', state = 'in', name, start = '2026-10-28T23:00:00Z', home = 'GS', away = 'LAL', homeScore = '72', awayScore = '69', ...status } = {}) {
  return { id, date: start, competitions: [{ competitors: [
    { homeAway: 'home', team: { abbreviation: home, displayName: home === 'GS' ? 'Golden State Warriors' : home }, score: homeScore },
    { homeAway: 'away', team: { abbreviation: away, displayName: away === 'LAL' ? 'Los Angeles Lakers' : away }, score: awayScore }
  ] }], status: { type: { state, name: name || (state === 'in' ? 'STATUS_IN_PROGRESS' : state === 'post' ? 'STATUS_FINAL' : 'STATUS_SCHEDULED'), shortDetail: '8:02 - 3rd' }, period: 3, displayClock: '8:02', ...status } };
}
const response = payload => ({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify(payload) });
async function settle() { for (let i = 0; i < 35; i++) await Promise.resolve(); }
function fakeClock(start = NOW) {
  let time = start, id = 0;
  const jobs = new Map();
  return { now: () => time, jobs,
    setTimeoutImpl(fn, delay) { const key = ++id; jobs.set(key, { fn, at: time + delay }); return key; },
    clearTimeoutImpl(key) { jobs.delete(key); },
    async advance(ms) {
      const end = time + ms;
      while (true) {
        const next = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; jobs.delete(next[0]); next[1].fn(); await settle();
      }
      time = end; await settle();
    },
    jump(ms) { time += ms; },
    delays: () => [...jobs.values()].map(job => job.at - time).sort((a, b) => a - b)
  };
}
function fixture(t, fetcher = url => response({ events: url.includes('dates=20261028') ? [event()] : [] })) {
  const clock = fakeClock(), updates = [], requests = [];
  const service = createSportsService({ ...clock, onUpdate: snapshot => updates.push(snapshot), fetchImpl: async (url, options) => {
    requests.push({ url, options }); return fetcher(url, options, requests.length);
  } });
  t.after(() => service.dispose());
  return { clock, updates, requests, service, async start(team = 'gs') { service.configure({ enabled: true, team }); service.setActive(true); return service.refresh(); } };
}

test('all NBA teams are selectable; preferences are strictly normalized and cannot inject URLs', () => {
  assert.equal(NBA_TEAMS.length, 30); assert.equal(new Set(NBA_TEAMS.map(team => team.id)).size, 30);
  assert.deepEqual(normalizeSportsPreferences(), { enabled: false, team: 'gs', liveOnly: true });
  assert.deepEqual(normalizeSportsPreferences({ enabled: 'true', team: 'https://evil.test/' }), { enabled: false, team: 'gs', liveOnly: true });
  assert.deepEqual(normalizeSportsPreferences({ enabled: true, team: ' GSW ' }), { enabled: true, team: 'gs', liveOnly: true });
  assert.deepEqual(normalizeSportsPreferences({ enabled: true, team: 'NYK', liveOnly: false }), { enabled: true, team: 'ny', liveOnly: false });
  assert.equal(normalizeSportsPreferences({ liveOnly: 'false' }).liveOnly, true);
});

test('live, overtime and final scores preserve source status, without manufacturing a ticking clock', () => {
  const game = normalizeEvent(event());
  assert.equal(game.state, 'live'); assert.equal(game.home.score, 72); assert.equal(game.away.score, 69);
  assert.equal(game.clock, '8:02'); assert.equal(game.period, 3); assert.equal(game.detail, '8:02 - 3rd');
  assert.equal(normalizeEvent(event({ period: 5, displayClock: '0:45' })).period, 5);
  const final = normalizeEvent(event({ state: 'post', homeScore: { value: 120 }, awayScore: { displayValue: '115' } }));
  assert.equal(final.state, 'final'); assert.equal(final.home.score, 120); assert.equal(final.clock, '');
});

test('pregame and postponed games never display placeholder scores as actual results', () => {
  for (const values of [{ state: 'pre' }, { state: 'pre', name: 'STATUS_POSTPONED' }, { state: 'in', name: 'STATUS_DELAYED' }, { state: 'post', name: 'STATUS_CANCELED' }]) {
    const game = normalizeEvent(event({ ...values, homeScore: undefined, awayScore: 'bad' }));
    assert.equal(game.home.score, null); assert.equal(game.away.score, null); assert.equal(game.clock, '');
  }
});

test('invalid structure, missing scores and changed status cannot masquerade as an empty scoreboard', () => {
  for (const payload of [null, {}, { events: {} }, { events: [null] }, { events: Array(1001).fill(event()) }]) assert.throws(() => parseEvents(payload));
  assert.deepEqual(parseEvents({ events: [] }), []);
  for (const values of [{ homeScore: '' }, { homeScore: -1 }, { awayScore: 900 }, { awayScore: null }, { state: 'unexpected' }, { id: '../secret' }, { start: 'invalid' }]) assert.throws(() => normalizeEvent(event(values)));
  const duplicate = event(); duplicate.competitions[0].competitors[1].homeAway = 'home'; assert.throws(() => normalizeEvent(duplicate));
});

test('Eastern dates and previous days survive year boundaries and DST', () => {
  assert.equal(dateKey(Date.parse('2026-01-01T02:30:00Z')), '20251231');
  assert.equal(previousDateKey('20260101'), '20251231');
  assert.equal(previousDateKey('20260309'), '20260308');
  assert.equal(previousDateKey('20261102'), '20261101');
  assert.equal(previousDateKey('20240301'), '20240229');
});

test('game selection prefers live, tonight, recent west-coast final, then next game and last final', () => {
  const game = values => normalizeEvent(event(values));
  const previous = game({ id: '1', state: 'post', start: '2026-10-25T23:00:00Z' });
  const next = game({ id: '2', state: 'pre', start: '2026-10-30T23:00:00Z' });
  const tonight = game({ id: '3', state: 'pre', start: '2026-10-29T01:00:00Z' });
  const live = game({ id: '4' });
  assert.equal(chooseGame([previous, next, tonight, live], 'gs', NOW).id, '4');
  assert.equal(chooseGame([previous, next, tonight], 'gs', NOW).id, '3');
  assert.equal(chooseGame([previous, next], 'gs', NOW).id, '2');
  assert.equal(chooseGame([previous], 'gs', NOW).id, '1');
  const recent = game({ id: '5', state: 'post', start: '2026-10-29T02:00:00Z' });
  assert.equal(chooseGame([recent, next], 'gs', Date.parse('2026-10-29T06:00:00Z')).id, '5');
  assert.equal(chooseGame([next, live], 'bos', NOW), null);
  const oldLive = game({ id: '6', start: '2026-10-24T23:00:00Z' });
  assert.equal(chooseGame([oldLive, next], 'gs', NOW).id, '2');
});

test('polling interval changes at tip-off and after the game; future games do not poll rapidly', () => {
  assert.equal(nextInterval(normalizeEvent(event()), NOW), 15000);
  assert.equal(nextInterval(normalizeEvent(event({ state: 'pre', start: '2026-10-28T23:40:00Z' })), NOW), 15000);
  assert.equal(nextInterval(normalizeEvent(event({ state: 'post' })), NOW), 60000);
  assert.equal(nextInterval(normalizeEvent(event({ state: 'pre', start: '2026-11-01T23:00:00Z' })), NOW), 300000);
  assert.equal(nextInterval(null, NOW), 300000);
  const lateTipOff = normalizeEvent(event({ state: 'pre', start: '2026-10-29T04:01:00Z' }));
  const before = Date.parse('2026-10-29T03:43:00Z');
  assert.equal(nextInterval(lateTipOff, before), 180000, 'a next-day tip-off enters the 15-minute window before the ordinary five-minute poll');
  assert.equal(nextInterval(lateTipOff, before + 180000), 15000);
  assert.equal(nextInterval(normalizeEvent(event({ state: 'pre', start: '2026-10-28T23:45:01Z' })), NOW), 1000, 'the boundary is not rounded to a full minute');
});

test('live-only changes preserve scores, timestamps and the next poll without fetching again', async t => {
  const f = fixture(t); await f.start();
  const before = f.service.getSnapshot(), jobs = [...f.clock.jobs.keys()];
  assert.equal(before.liveOnly, true);
  f.service.configure({ enabled: true, team: 'gs', liveOnly: false });
  await settle();
  assert.deepEqual(f.service.getSnapshot(), { ...before, liveOnly: false });
  assert.equal(f.requests.length, 2); assert.deepEqual([...f.clock.jobs.keys()], jobs);
  f.service.configure({ enabled: true, team: 'gs', liveOnly: true });
  assert.deepEqual(f.service.getSnapshot(), before);
  await f.clock.advance(15000); assert.equal(f.requests.length, 4);
});

test('changing live-only during an in-flight request neither aborts nor duplicates it', async t => {
  const releases = [];
  const f = fixture(t, url => new Promise(resolve => releases.push(() => resolve(response({ events: url.includes('dates=20261028') ? [event()] : [] })))));
  f.service.configure({ enabled: true, team: 'gs' }); f.service.setActive(true); await settle();
  const pending = f.service.refresh();
  f.service.configure({ enabled: true, team: 'gs', liveOnly: false });
  assert.equal(f.service.getSnapshot().refreshing, true);
  assert.equal(f.requests.length, 2); assert.ok(f.requests.every(request => !request.options.signal.aborted));
  releases.forEach(release => release()); await pending;
  assert.equal(f.service.getSnapshot().liveOnly, false);
  assert.equal(f.service.getSnapshot().game.home.score, 72);
  assert.deepEqual(f.clock.delays(), [15000]);
});

test('an enabled live-only watch enters rapid polling before a future game without user interaction', async t => {
  const f = fixture(t, url => response({ events: url.includes('/schedule') ? [event({ state: 'pre', start: '2026-10-29T04:01:00Z' })] : [] }));
  f.clock.jump(Date.parse('2026-10-29T03:43:00Z') - NOW);
  await f.start();
  assert.equal(f.service.getSnapshot().liveOnly, true);
  assert.equal(f.service.getSnapshot().game.state, 'pre');
  assert.deepEqual(f.clock.delays(), [180000]);
  await f.clock.advance(180000);
  assert.deepEqual(f.clock.delays(), [15000]);
  const count = f.requests.length;
  await f.clock.advance(15000); assert.ok(f.requests.length > count);
});

test('disabled and hidden service does no network work and creates no timers', async t => {
  const f = fixture(t);
  await f.service.refresh(); assert.equal(f.requests.length, 0); assert.equal(f.clock.jobs.size, 0);
  f.service.configure({ enabled: true, team: 'gs' }); await settle(); assert.equal(f.requests.length, 0);
  f.service.configure({ enabled: false, team: 'gs' }); f.service.setActive(true); await settle(); assert.equal(f.requests.length, 0);
});

test('live polling automatically publishes new scores and uses bounded keyless credential-free requests', async t => {
  const f = fixture(t, (url, _options, count) => response({ events: url.includes('dates=20261028') ? [event({ homeScore: count > 2 ? '75' : '72' })] : [] }));
  await f.start(); assert.equal(f.service.getSnapshot().game.home.score, 72);
  assert.deepEqual(f.clock.delays(), [15000]);
  await f.clock.advance(15000); assert.equal(f.service.getSnapshot().game.home.score, 75);
  assert.equal(f.requests.length, 4); assert.deepEqual(f.clock.delays(), [15000]);
  for (const { url, options } of f.requests) {
    assert.equal(new URL(url).origin, 'https://site.api.espn.com'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.ok(options.signal); assert.equal(options.headers.Authorization, undefined);
  }
});

test('manual refresh is coalesced and throttled, without moving the next automatic refresh', async t => {
  const f = fixture(t); await f.start();
  await Promise.all([f.service.refresh(), f.service.refresh()]); assert.equal(f.requests.length, 2);
  assert.deepEqual(f.clock.delays(), [15000]);
  await f.clock.advance(5000); await f.service.refresh(); assert.equal(f.requests.length, 4);
  assert.deepEqual(f.clock.delays(), [15000]);
});

test('a failed yesterday feed cannot hide a verified live game from today', async t => {
  const f = fixture(t, url => {
    if (url.includes('dates=20261027')) throw new Error('old feed unavailable');
    return response({ events: [event()] });
  });
  await f.start(); assert.equal(f.service.getSnapshot().state, 'ready'); assert.equal(f.service.getSnapshot().game.home.score, 72);
  assert.equal(f.requests.length, 2); assert.deepEqual(f.clock.delays(), [15000]);
});

test('a partial scoreboard failure and empty schedule cannot clear a verified live game', async t => {
  let todayUnavailable = false;
  const f = fixture(t, url => {
    if (url.includes('dates=20261028')) {
      if (todayUnavailable) throw new Error('today unavailable');
      return response({ events: [event()] });
    }
    return response({ events: [] });
  });
  await f.start();
  const verified = f.service.getSnapshot();
  todayUnavailable = true;
  await f.clock.advance(15000);
  const failed = f.service.getSnapshot();
  assert.equal(failed.state, 'error');
  assert.equal(failed.stale, true);
  assert.deepEqual(failed.game, verified.game);
  assert.equal(failed.updatedAt, verified.updatedAt);
  assert.deepEqual(f.clock.delays(), [15000]);
  todayUnavailable = false;
  await f.clock.advance(15000);
  assert.equal(f.service.getSnapshot().state, 'ready');
  assert.equal(f.service.getSnapshot().stale, false);
});

test('an empty fallback cannot report no game when either scoreboard is unavailable', async t => {
  for (const unavailableDate of ['20261028', '20261027']) {
    const f = fixture(t, url => {
      if (url.includes('dates=' + unavailableDate)) throw new Error('partial outage');
      return response({ events: [] });
    });
    await f.start();
    const snapshot = f.service.getSnapshot();
    assert.equal(snapshot.state, 'error');
    assert.equal(snapshot.updatedAt, null);
    assert.equal(snapshot.game, null);
    assert.deepEqual(f.clock.delays(), [15000]);
  }
});

test('a fresh schedule with verified game data still recovers a partial scoreboard outage', async t => {
  for (const state of ['in', 'post']) {
    const f = fixture(t, url => {
      if (url.includes('dates=20261028')) throw new Error('today unavailable');
      return response({ events: url.includes('/schedule') ? [event({ state })] : [] });
    });
    await f.start();
    const snapshot = f.service.getSnapshot();
    assert.equal(snapshot.state, 'ready');
    assert.equal(snapshot.stale, false);
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.game.state, state === 'in' ? 'live' : 'final');
    assert.equal(snapshot.game.home.score, 72);
    assert.deepEqual(f.clock.delays(), [state === 'in' ? 15000 : 60000]);
  }
});

test('no current game loads and caches team schedule, with no-game distinct from feed failure', async t => {
  let schedules = 0;
  const f = fixture(t, url => {
    if (url.includes('/schedule')) { schedules++; return response({ events: [event({ state: 'pre', start: '2026-10-30T23:00:00Z' })] }); }
    return response({ events: [] });
  });
  await f.start(); assert.equal(f.service.getSnapshot().game.state, 'pre'); assert.equal(schedules, 1);
  await f.clock.advance(300000); assert.equal(schedules, 1);
  await f.clock.advance(600000); assert.equal(schedules, 2);
  const empty = fixture(t, () => response({ events: [] })); await empty.start();
  assert.equal(empty.service.getSnapshot().state, 'ready'); assert.equal(empty.service.getSnapshot().game, null);
  assert.equal(empty.service.getSnapshot().error, null); assert.ok(empty.service.getSnapshot().updatedAt);
});

test('network loss retains last verified score with stale status and exponential retries, then recovers', async t => {
  let offline = false;
  const f = fixture(t, url => { if (offline) throw new Error('offline'); return response({ events: url.includes('dates=20261028') ? [event()] : [] }); });
  await f.start(); const updated = f.service.getSnapshot().updatedAt; offline = true;
  await f.clock.advance(15000); let snapshot = f.service.getSnapshot();
  assert.equal(snapshot.state, 'error'); assert.equal(snapshot.stale, true); assert.equal(snapshot.game.home.score, 72); assert.equal(snapshot.updatedAt, updated);
  assert.deepEqual(f.clock.delays(), [15000]);
  await f.clock.advance(15000); assert.deepEqual(f.clock.delays(), [30000]);
  await f.clock.advance(30000); assert.deepEqual(f.clock.delays(), [60000]);
  await f.clock.advance(60000); assert.deepEqual(f.clock.delays(), [120000]);
  offline = false; await f.clock.advance(120000); snapshot = f.service.getSnapshot();
  assert.equal(snapshot.state, 'ready'); assert.equal(snapshot.stale, false); assert.equal(snapshot.error, null); assert.notEqual(snapshot.updatedAt, updated);
});

test('schedule fallback never reuses cached live scores or a pregame status through tip-off', async t => {
  let schedules = 0;
  const f = fixture(t, url => {
    if (url.includes('/schedule')) { schedules++; return response({ events: [event({ homeScore: schedules === 1 ? 72 : 75 })] }); }
    return response({ events: [] });
  });
  await f.start(); assert.equal(f.service.getSnapshot().game.home.score, 72);
  await f.clock.advance(15000); assert.equal(f.service.getSnapshot().game.home.score, 75); assert.equal(schedules, 2);
  let nearSchedules = 0;
  const near = fixture(t, url => {
    if (url.includes('/schedule')) { nearSchedules++; return response({ events: [event({ state: nearSchedules === 1 ? 'pre' : 'in', start: '2026-10-28T23:40:00Z' })] }); }
    return response({ events: [] });
  });
  await near.start(); await near.clock.advance(15000); assert.equal(nearSchedules, 2); assert.equal(near.service.getSnapshot().game.state, 'live');
});

test('resume after midnight queries the new Eastern day and aborts the previous schedule', async t => {
  const f = fixture(t); await f.start(); f.service.setActive(false);
  f.clock.jump(7 * 3600000); f.service.setActive(true); await f.service.refresh();
  const dates = f.requests.slice(2).filter(request => request.url.includes('scoreboard')).map(request => new URL(request.url).searchParams.get('dates'));
  assert.deepEqual(dates, ['20261029', '20261028']);
});

test('malformed update is disclosed and never clears a good score as if there were no game', async t => {
  let broken = false;
  const f = fixture(t, url => response(broken ? { changedSchema: [] } : { events: url.includes('dates=20261028') ? [event()] : [] }));
  await f.start(); broken = true; await f.clock.advance(15000);
  assert.equal(f.service.getSnapshot().stale, true); assert.match(f.service.getSnapshot().error, /unreadable/); assert.equal(f.service.getSnapshot().game.home.score, 72);
});

test('request timeout bounds uncooperative fetch, stops old inputs and retries automatically', async t => {
  const f = fixture(t, () => new Promise(() => {}));
  f.service.configure({ enabled: true, team: 'gs' }); f.service.setActive(true); const pending = f.service.refresh();
  await f.clock.advance(REQUEST_TIMEOUT_MS); await pending;
  assert.equal(f.service.getSnapshot().state, 'error'); assert.equal(f.service.getSnapshot().updatedAt, null);
  assert.ok(f.requests.every(request => request.options.signal.aborted)); assert.deepEqual(f.clock.delays(), [15000]);
});

test('hiding aborts requests, suppresses late completions, and resumes immediately', async t => {
  let releases = [], slow = true;
  const f = fixture(t, url => slow ? new Promise(resolve => releases.push(() => resolve(response({ events: url.includes('dates=20261028') ? [event()] : [] })))) : response({ events: url.includes('dates=20261028') ? [event({ homeScore: 80 })] : [] }));
  f.service.configure({ enabled: true, team: 'gs' }); f.service.setActive(true); await settle();
  f.service.setActive(false); await settle(); assert.ok(f.requests.every(request => request.options.signal.aborted)); assert.equal(f.clock.jobs.size, 0);
  for (const release of releases) release(); await settle(); assert.equal(f.service.getSnapshot().game, null);
  slow = false; f.service.setActive(true); await f.service.refresh(); assert.equal(f.service.getSnapshot().game.home.score, 80);
  assert.deepEqual(f.clock.delays(), [15000]);
});

test('team change drops old scores immediately and cannot publish an old in-flight result', async t => {
  let first = true, releases = [];
  const f = fixture(t, url => first ? new Promise(resolve => releases.push(() => resolve(response({ events: [event()] })))) : response({ events: url.includes('dates=20261028') ? [event({ home: 'BOS', away: 'NY', homeScore: 90, awayScore: 85 })] : [] }));
  f.service.configure({ enabled: true, team: 'gs' }); f.service.setActive(true); await settle();
  first = false; f.service.configure({ enabled: true, team: 'bos' }); await f.service.refresh();
  for (const release of releases) release(); await settle();
  const snapshot = f.service.getSnapshot(); assert.equal(snapshot.team, 'bos'); assert.equal(snapshot.teamName, 'Boston Celtics'); assert.equal(snapshot.game.home.abbr, 'BOS');
  assert.deepEqual(f.clock.delays(), [15000]);
});

test('disable and dispose cancel all timers and never schedule another fetch', async t => {
  const f = fixture(t); await f.start(); f.service.configure({ enabled: false, team: 'gs' });
  assert.equal(f.clock.jobs.size, 0); await f.clock.advance(3600000); assert.equal(f.requests.length, 2);
  f.service.configure({ enabled: true, team: 'gs' }); await f.service.refresh(); const count = f.requests.length;
  f.service.dispose(); assert.equal(f.clock.jobs.size, 0); f.service.setActive(true); f.service.configure({ enabled: true, team: 'bos' });
  await f.service.refresh(); await f.clock.advance(3600000); assert.equal(f.requests.length, count);
});

test('caller mutations and callback errors cannot corrupt service state or stop updates', async t => {
  const f = fixture(t); await f.start(); const copy = f.service.getSnapshot(); copy.game.home.score = 999;
  assert.equal(f.service.getSnapshot().game.home.score, 72);
  const clock = fakeClock(); const service = createSportsService({ ...clock, onUpdate() { throw new Error('view'); }, fetchImpl: async () => response({ events: [] }) });
  t.after(() => service.dispose()); service.configure({ enabled: true }); service.setActive(true); await service.refresh();
  assert.equal(service.getSnapshot().state, 'ready'); assert.deepEqual(clock.delays(), [300000]);
});

test('bounded response rejects oversized or malformed content and cancels streams', async () => {
  let cancelled = false;
  await assert.rejects(readBoundedJson({ headers: { get: () => String(MAX_RESPONSE_BYTES + 1) }, body: { async cancel() { cancelled = true; } } }));
  assert.equal(cancelled, true);
  await assert.rejects(readBoundedJson(response('x'.repeat(MAX_RESPONSE_BYTES + 1))));
  await assert.rejects(readBoundedJson({ text: async () => '<html>Unavailable</html>' }));
  cancelled = false; let released = false;
  await assert.rejects(readBoundedJson({ body: { getReader: () => ({ read: async () => ({ done: false, value: Buffer.alloc(MAX_RESPONSE_BYTES + 1) }), cancel: async () => { cancelled = true; }, releaseLock() { released = true; } }) } }));
  assert.equal(cancelled, true); assert.equal(released, true);
});
