/* Small in-app companions reuse existing score updates and Windows media state. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    const start = () => { root.OlangaCompanionCards = api.mount(root, root.document); };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const clean = (value, limit = 160) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : '';
  function normalizeMedia(value) {
    if (value?.status === 'Closed' || value?.reason === 'no-session' || value?.reason === 'inactive') {
      return { available: false, title: 'Nothing playing on Spotify', artist: 'Start a track in Spotify to use these controls.', status: 'Closed' };
    }
    const knownStatus = ['Playing', 'Paused', 'Stopped', 'Opened', 'Changing'].includes(value?.status);
    if (value?.ok === true && value.verified === true && (clean(value.title) || knownStatus)) {
      return { available: true, title: clean(value.title) || 'Current track', artist: clean(value.artist), status: knownStatus ? value.status : 'Unknown' };
    }
    return { available: false, title: 'Spotify unavailable', artist: 'Olanga will check again shortly.', status: 'Unavailable' };
  }
  function sportsVisible(snapshot) {
    return snapshot?.enabled === true && (snapshot.liveOnly === false || snapshot.game?.state === 'live');
  }

  // This observer never sends a playback command. Main owns its separate
  // read-only helper so a background lookup cannot hold up voice actions.
  function createMediaMonitor({ read, onChange, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let active = false, disposed = false, pending = null, timer = null, revision = 0, actionPending = false, resync = false;
    let media = normalizeMedia({ status: 'Closed' });
    const publish = value => { try { onChange(value); } catch (_) { /* A view failure must not leave an unhandled polling promise. */ } };
    function clear() { if (timer !== null) clearTimer(timer); timer = null; }
    function schedule(delay) {
      clear();
      if (!active || disposed || actionPending) return;
      timer = setTimer(() => { timer = null; poll(); }, delay);
    }
    function poll() {
      if (!active || disposed || actionPending || pending) return pending;
      const current = revision;
      resync = false;
      pending = Promise.resolve().then(read).then(value => {
        if (!active || disposed || current !== revision) return;
        media = normalizeMedia(value);
        publish(media);
      }, () => {
        if (!active || disposed || current !== revision) return;
        media = normalizeMedia(null);
        publish(media);
      }).finally(() => {
        pending = null;
        schedule(resync ? 0 : media.status === 'Playing' ? 5000 : 10000);
      });
      return pending;
    }
    return {
      setActive(value) {
        const next = value === true;
        if (disposed || active === next) return;
        active = next; revision++; clear();
        if (active) { resync = true; poll(); }
      },
      setActionPending(value) {
        if (disposed || actionPending === (value === true)) return;
        actionPending = value === true; revision++; clear();
        if (!actionPending) { resync = true; poll(); }
      },
      dispose() { disposed = true; active = false; revision++; clear(); }
    };
  }

  function mount(window, document) {
    const rail = document.getElementById('companionRail');
    const api = window.electronAPI;
    if (!rail || !api) return Object.freeze({ dispose() {} });
    rail.innerHTML = `
      <div id="companionCardsContent" class="companion-cards-content">
      <section class="companion-card companion-sports" id="companionSportsCard" aria-label="NBA scores" hidden>
        <header class="companion-heading"><span>NBA <span id="companionSportsState"></span></span><button id="companionSportsSettings" class="companion-icon-button" type="button" aria-label="Open live score settings" title="Live score settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16M9 4v6M15 14v6"/></svg></button></header>
        <div class="companion-scoreboard" aria-live="polite" aria-atomic="true"><div><span id="companionSportsAway"></span><strong id="companionSportsAwayScore"></strong></div><div><span id="companionSportsHome"></span><strong id="companionSportsHomeScore"></strong></div></div>
        <p id="companionSportsEmpty" hidden></p><p class="companion-meta" id="companionSportsUpdated"></p>
      </section>
      <section class="companion-card companion-music" id="companionMusicCard" aria-label="Spotify controls">
        <header class="companion-heading"><span>Spotify</span><span id="companionMusicStatus"></span></header>
        <p id="companionTrackTitle" class="companion-track-title">Nothing playing on Spotify</p><p id="companionTrackArtist" class="companion-track-artist">Start a track in Spotify to use these controls.</p>
        <div class="companion-playback"><button id="companionMediaPrevious" type="button" aria-label="Previous track" title="Previous track" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14M18 5 8 12l10 7Z"/></svg></button><button id="companionMediaToggle" type="button" aria-label="Play" title="Play" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path id="companionPlayGlyph" d="m8 5 11 7-11 7Z"/></svg></button><button id="companionMediaNext" type="button" aria-label="Next track" title="Next track" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14M6 5l10 7-10 7Z"/></svg></button></div>
        <p class="companion-meta companion-message" id="companionMusicMessage" role="status" hidden></p>
      </section></div>`;
    const node = id => document.getElementById(id);
    const text = (id, value) => { const target = node(id); if (target.textContent !== value) target.textContent = value; };
    let sports = null, sportsRevision = 0, active = false, disposed = false, actionBusy = false;
    let media = normalizeMedia({ status: 'Closed' });
    const buttons = ['Previous', 'Toggle', 'Next'].map(name => node('companionMedia' + name));
    function renderMusic() {
      text('companionTrackTitle', media.title);
      text('companionTrackArtist', media.artist || 'Artist not reported');
      node('companionTrackTitle').title = media.title;
      node('companionTrackArtist').title = media.artist;
      const labels = { Playing: 'Playing', Paused: 'Paused', Stopped: 'Stopped', Opened: 'Ready', Changing: 'Updating…', Unknown: 'Status unavailable' };
      text('companionMusicStatus', actionBusy ? 'Updating…' : media.available ? labels[media.status] || 'Status unavailable' : '');
      const controllable = active && !actionBusy && media.available && ['Playing', 'Paused', 'Stopped', 'Opened'].includes(media.status) && typeof api.mediaControl === 'function';
      buttons.forEach(button => { button.disabled = !controllable; });
      const label = media.status === 'Playing' ? 'Pause' : 'Play';
      node('companionMediaToggle').setAttribute('aria-label', label);
      node('companionMediaToggle').title = label;
      node('companionPlayGlyph').setAttribute('d', media.status === 'Playing' ? 'M8 5v14M16 5v14' : 'm8 5 11 7-11 7Z');
    }
    function renderSports() {
      const card = node('companionSportsCard');
      card.hidden = !sportsVisible(sports);
      if (card.hidden) return;
      card.dataset.stale = String(sports.stale === true || !!sports.error);
      const game = sports.game;
      const rows = card.querySelector('.companion-scoreboard');
      rows.hidden = !game; node('companionSportsEmpty').hidden = !!game;
      if (game) {
        const period = Number.isInteger(game.period) && game.period > 0 ? (game.period <= 4 ? `Q${game.period}` : game.period === 5 ? 'OT' : `${game.period - 4}OT`) : '';
        const status = game.state === 'pre' ? 'Next game' : clean(game.detail, 60) || (game.state === 'live' ? [period, clean(game.clock, 20)].filter(Boolean).join(' ') || 'In progress' : game.state === 'final' ? 'Final' : 'Postponed');
        text('companionSportsState', status);
        for (const [side, suffix] of [['away', 'Away'], ['home', 'Home']]) {
          text('companionSports' + suffix, clean(game[side]?.abbr, 12) || '—');
          node('companionSports' + suffix).title = clean(game[side]?.name, 80);
          const score = game[side]?.score;
          text('companionSports' + suffix + 'Score', ['live', 'final'].includes(game.state) && Number.isFinite(Number(score)) && score !== null && score !== undefined ? String(score) : '—');
        }
      } else {
        text('companionSportsState', sports.error ? 'Unavailable' : sports.refreshing ? 'Checking scores' : 'No game scheduled');
        text('companionSportsEmpty', clean(sports.teamName, 80) || 'Your team');
      }
      const checked = new Date(sports.updatedAt || NaN), valid = Number.isFinite(checked.getTime());
      const checkedText = valid ? checked.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
      const start = new Date(game?.startAt || NaN);
      let caption;
      if (sports.stale || sports.error) caption = checkedText ? `Updates delayed · ${checkedText}` : 'Unable to connect · retrying';
      else if (game?.state === 'pre' && Number.isFinite(start.getTime())) caption = start.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      else caption = checkedText ? `ESPN · checked ${checkedText}` : 'Connecting to ESPN';
      text('companionSportsUpdated', caption);
      node('companionSportsUpdated').title = clean(sports.error, 180) || 'ESPN scores may lag the broadcast.';
    }
    const monitor = createMediaMonitor({
      read: () => typeof api.getMediaSnapshot === 'function' ? api.getMediaSnapshot() : Promise.resolve({ status: 'Closed' }),
      onChange: value => { media = value; renderMusic(); }
    });
    function ready() {
      return document.getElementById('mainScreen')?.classList.contains('hidden') === false &&
        document.querySelector('.floating-icons')?.classList.contains('visible') === true &&
        document.getElementById('setupScreen')?.classList.contains('hidden') !== false &&
        document.getElementById('wakeWordCaptureScreen')?.classList.contains('hidden') !== false &&
        !document.getElementById('settingsScreen')?.classList.contains('settings-before-setup');
    }
    function syncVisibility() {
      if (disposed) return;
      const show = ready();
      rail.hidden = !show;
      document.body.classList.toggle('companion-rail-visible', show);
      active = show && (window.OlangaVisibility?.isVisible?.() ?? !document.hidden);
      monitor.setActive(active);
      renderMusic();
    }
    async function command(action) {
      if (!active || actionBusy || !media.available || typeof api.mediaControl !== 'function') return;
      actionBusy = true; monitor.setActionPending(true); renderMusic();
      const message = node('companionMusicMessage'); message.hidden = true;
      try {
        const receipt = await api.mediaControl(action, true);
        if (disposed) return;
        if (receipt?.ok === true && receipt.verified === true) {
          if (clean(receipt.title)) media = normalizeMedia(receipt);
        } else { text('companionMusicMessage', clean(receipt?.message, 160) || 'Spotify did not confirm that change.'); message.hidden = false; }
      } catch (_) {
        if (!disposed) { text('companionMusicMessage', 'Spotify controls are temporarily unavailable. Try again.'); message.hidden = false; }
      } finally {
        actionBusy = false;
        if (!disposed) { renderMusic(); monitor.setActionPending(false); }
      }
    }
    for (const [name, action] of [['Previous', 'PREV'], ['Toggle', 'PLAY_PAUSE'], ['Next', 'NEXT']]) node('companionMedia' + name).addEventListener('click', () => { void command(action); });
    node('companionSportsSettings').addEventListener('click', () => {
      if (!window.OlangaSettingsNavigation?.open('user', { focus: false })) return;
      window.requestAnimationFrame(() => {
        node('sportsSettingsHeading')?.closest('section')?.scrollIntoView({ block: 'center', behavior: 'auto' });
        node('sportsTeamSelect')?.focus({ preventScroll: true });
      });
    });
    const unsubscribeSports = api.onSportsSnapshot?.(value => { sportsRevision++; sports = value; renderSports(); });
    const requestedAt = sportsRevision;
    Promise.resolve().then(() => api.getSportsSnapshot?.()).then(value => {
      if (disposed || requestedAt !== sportsRevision) return;
      sports = value; renderSports();
    }).catch(() => {});
    const observer = new window.MutationObserver(syncVisibility);
    for (const target of [document.querySelector('.floating-icons'), node('mainScreen'), node('setupScreen'), node('wakeWordCaptureScreen'), node('settingsScreen')]) {
      if (target) observer.observe(target, { attributes: true, attributeFilter: ['class'] });
    }
    const unsubscribeVisibility = window.OlangaVisibility?.subscribe(syncVisibility);
    document.addEventListener('visibilitychange', syncVisibility);
    syncVisibility();
    function dispose() {
      if (disposed) return;
      disposed = true; monitor.dispose(); observer.disconnect(); unsubscribeSports?.(); unsubscribeVisibility?.();
      document.removeEventListener('visibilitychange', syncVisibility);
      document.body.classList.remove('companion-rail-visible'); rail.hidden = true;
    }
    window.addEventListener('beforeunload', dispose, { once: true });
    return Object.freeze({ dispose });
  }
  return { normalizeMedia, sportsVisible, createMediaMonitor, mount };
});
