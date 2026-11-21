'use strict';

(() => {
  const api = window.olangaSideLight;
  const light = document.getElementById('light');
  const menu = document.getElementById('quickMenu');
  const actionList = document.getElementById('quickActions');
  const statusText = document.getElementById('statusText');
  const sportsCard = document.getElementById('sportsCard');
  const sportsContent = document.getElementById('sportsContent');
  const sportsRefresh = document.getElementById('refreshSports');
  const sportsHandle = document.getElementById('sportsHandle');
  const timerCard = document.getElementById('timerCard');
  const timerContent = document.getElementById('timerContent');
  const timerHandle = document.getElementById('timerHandle');
  const timerList = document.getElementById('overlayTimers');
  const timerHeading = document.getElementById('timerHeading');
  const showTimerCard = document.getElementById('showTimerCard');
  const showSportsCard = document.getElementById('showSportsCard');
  let timerMode = 'compact';
  let timerRowsKey = '';
  let displayedTimers = [];
  let countdownTimeout = null;
  const sportsGesture = createCardGesture(sportsHandle, {
    start: () => api?.startSportsDrag(), move: () => api?.moveSportsDrag(),
    end: () => api?.endSportsDrag(), cancel: () => api?.cancelSportsDrag(),
    toggle: () => api?.toggleSports(), step: direction => api?.setSportsCollapsed(direction > 0)
  });
  const timerGesture = createCardGesture(timerHandle, {
    start: () => api?.startTimerDrag(), move: () => api?.moveTimerDrag(),
    end: () => api?.endTimerDrag(), cancel: () => api?.cancelTimerDrag(),
    toggle: () => api?.toggleTimerMode(), step: direction => {
      const modes = ['expanded', 'compact', 'tucked'];
      api?.setTimerMode(modes[Math.max(0, Math.min(2, modes.indexOf(timerMode) + direction))]);
    }
  });
  const statusLabels = { idle: 'Ready', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', off: 'Off' };
  let wasOpen = false;
  let actionsKey = '';
  let pointerPending = false;

  function setGeometry(geometry) {
    if (!geometry?.orb || !geometry?.menu) return;
    const values = {
      '--orb-size': geometry.diameter, '--orb-left': geometry.orb.x, '--orb-top': geometry.orb.y,
      '--menu-left': geometry.menu.x, '--menu-top': geometry.menu.y,
      '--menu-width': geometry.menu.width, '--menu-height': geometry.menu.height
    };
    if (geometry.sports) Object.assign(values, {
      '--sports-left': geometry.sports.x, '--sports-top': geometry.sports.y,
      '--sports-width': geometry.sports.width, '--sports-height': geometry.sports.height
    });
    if (geometry.sportsHandle) Object.assign(values, {
      '--sports-handle-left': geometry.sportsHandle.x, '--sports-handle-top': geometry.sportsHandle.y,
      '--sports-handle-width': geometry.sportsHandle.width, '--sports-handle-height': geometry.sportsHandle.height
    });
    if (geometry.timers) Object.assign(values, {
      '--timers-left': geometry.timers.x, '--timers-top': geometry.timers.y,
      '--timers-width': geometry.timers.width, '--timers-height': geometry.timers.height
    });
    if (geometry.timerHandle) Object.assign(values, {
      '--timer-handle-left': geometry.timerHandle.x, '--timer-handle-top': geometry.timerHandle.y,
      '--timer-handle-width': geometry.timerHandle.width, '--timer-handle-height': geometry.timerHandle.height
    });
    for (const [name, value] of Object.entries(values)) {
      if (Number.isFinite(value)) document.documentElement.style.setProperty(name, `${value}px`);
    }
  }

  function showSports(snapshot) {
    const sports = snapshot.sports;
    const presentation = snapshot.sportsPresentation || {};
    const allowed = sports?.enabled === true && !!snapshot.geometry?.sports && !!snapshot.geometry?.sportsHandle && snapshot.visible !== false;
    sportsGesture.sync(allowed, presentation.dragging);
    sportsHandle.hidden = !allowed;
    sportsHandle.setAttribute('aria-expanded', String(!presentation.collapsed));
    sportsHandle.setAttribute('aria-label', presentation.collapsed ? 'Show scores' : 'Tuck scores away');
    document.body.classList.toggle('sports-dragging', allowed && presentation.dragging === true);
    const offset = Math.max(0, Number(presentation.offset) || 0);
    document.documentElement.style.setProperty('--sports-offset', `${offset}px`);
    const tucked = allowed && snapshot.geometry.sportsTucked === true;
    sportsCard.hidden = !allowed;
    sportsCard.classList.toggle('sports-tucked', tucked);
    sportsContent.hidden = tucked;
    sportsContent.inert = !allowed || presentation.collapsed === true || presentation.dragging === true;
    showTimerCard.hidden = snapshot.companion?.hasTimers !== true;
    if ((sportsContent.hidden || sportsContent.inert) && sportsContent.contains(document.activeElement) && allowed) sportsHandle.focus({ preventScroll: true });
    if (sportsCard.hidden) return;
    sportsCard.dataset.stale = String(sports.stale === true);
    sportsRefresh.setAttribute('aria-disabled', String(sports.refreshing === true));
    const game = sports.game;
    document.getElementById('sportsMatch').hidden = !game;
    const empty = document.getElementById('sportsEmpty');
    empty.hidden = !!game;
    const state = document.getElementById('sportsState');
    if (game) {
      const period = Number.isInteger(game.period) && game.period > 0 ? (game.period <= 4 ? `Q${game.period}` : game.period === 5 ? 'OT' : `${game.period - 4}OT`) : '';
      const liveDetail = [period, game.clock].filter(Boolean).join(' ');
      state.textContent = game.state === 'pre' ? 'Next game' : game.detail || (game.state === 'final' ? 'Final' : game.state === 'live' ? liveDetail || 'In progress' : 'Postponed');
      for (const [side, id] of [['away', 'Away'], ['home', 'Home']]) {
        const team = game[side];
        const label = document.getElementById('sports' + id);
        const teamText = team?.abbr || '—';
        if (label.textContent !== teamText) label.textContent = teamText;
        label.title = String(team?.name || '');
        const score = team?.score;
        const scoreText = (game.state === 'live' || game.state === 'final') && score !== null && score !== undefined ? String(score) : '—';
        const scoreLabel = document.getElementById('sports' + id + 'Score');
        if (scoreLabel.textContent !== scoreText) scoreLabel.textContent = scoreText;
      }
    } else {
      state.textContent = sports.refreshing ? 'Checking scores' : sports.error ? 'Unavailable' : 'No game scheduled';
      empty.textContent = sports.teamName || 'Your team';
    }
    const updated = document.getElementById('sportsUpdated');
    const checked = sports.updatedAt && new Date(sports.updatedAt);
    const timestamp = checked && Number.isFinite(checked.getTime()) ? checked.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
    const start = game?.startAt && new Date(game.startAt);
    if (sports.stale || sports.error) updated.textContent = timestamp ? `Updates delayed · ${timestamp}` : 'Unable to connect · retrying';
    else if (game?.state === 'pre' && start && Number.isFinite(start.getTime())) updated.textContent = start.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    else updated.textContent = timestamp ? `ESPN · updated ${timestamp}` : 'Connecting to ESPN';
    updated.title = sports.error ? `ESPN: ${sports.error}${timestamp ? '. Last successful check: ' + timestamp : ''}` : `ESPN${timestamp ? ' · last checked ' + timestamp : ''}. Scores may be delayed.`;
  }

  function refreshTimerReadings() {
    const now = Date.now();
    for (const { timer, row, time, status } of displayedTimers) {
      const text = window.OlangaTimerOverlay.remainingText(timer, now);
      const finished = !timer.paused && (timer.ringing || timer.endTime <= now);
      const detail = timer.paused ? 'Paused' : finished ? 'Finished' : timer.kind === 'alarm' ? 'Alarm' : timer.kind === 'reminder' ? 'Reminder' : '';
      if (time.textContent !== text) {
        time.textContent = text;
        time.title = text;
        time.classList.toggle('long-duration', text.length > 8);
      }
      if (status.textContent !== detail) status.textContent = detail;
      if (row.dataset.ringing !== String(finished)) row.dataset.ringing = String(finished);
    }
  }

  function stopTimerReadings() {
    clearTimeout(countdownTimeout);
    countdownTimeout = null;
  }

  function scheduleTimerReadings() {
    stopTimerReadings();
    if (timerCard.hidden || timerContent.hidden || !displayedTimers.some(({ timer }) => !timer.paused && !timer.ringing && timer.endTime > Date.now())) return;
    countdownTimeout = setTimeout(() => { refreshTimerReadings(); scheduleTimerReadings(); }, 1000);
  }

  function showTimers(snapshot) {
    const timers = snapshot.timers;
    const presentation = snapshot.timerPresentation || {};
    const allowed = timers?.enabled === true && Array.isArray(timers.timers) && timers.timers.length > 0 && !!snapshot.geometry?.timers && !!snapshot.geometry?.timerHandle && snapshot.visible !== false;
    const mode = ['expanded', 'compact', 'tucked'].includes(presentation.mode) ? presentation.mode : 'compact';
    timerMode = mode;
    timerGesture.sync(allowed, presentation.dragging);
    timerCard.hidden = !allowed;
    timerHandle.hidden = !allowed;
    const tucked = snapshot.geometry?.timerTucked === true || mode === 'tucked';
    timerContent.hidden = tucked;
    timerContent.inert = !allowed || tucked || presentation.dragging === true;
    timerCard.dataset.mode = mode;
    timerHandle.setAttribute('aria-expanded', String(!tucked));
    const nextLabel = mode === 'expanded' ? 'Show only the next timer' : mode === 'compact' ? 'Tuck timers away' : 'Expand timers';
    timerHandle.setAttribute('aria-label', nextLabel);
    document.body.classList.toggle('timer-dragging', allowed && presentation.dragging === true);
    if (timerContent.inert && timerContent.contains(document.activeElement) && allowed) timerHandle.focus({ preventScroll: true });
    showSportsCard.hidden = snapshot.companion?.hasSports !== true;
    if (!allowed) { stopTimerReadings(); return; }
    const records = timers.timers.slice(0, mode === 'expanded' ? 5 : 1);
    const total = Math.max(timers.timers.length, timers.total || 0);
    timerHeading.textContent = mode === 'expanded' ? `Timers · ${total}` : 'Next timer';
    timerHeading.title = total > 5 ? `Showing the next five. View all ${total} timers in Olanga` : `View ${total === 1 ? 'timer' : `all ${total} timers`} in Olanga`;
    timerHeading.setAttribute('aria-label', timerHeading.title);
    const key = JSON.stringify(records);
    if (timerRowsKey !== key) {
      timerRowsKey = key;
      displayedTimers = records.map(timer => {
        const row = document.createElement('li');
        row.className = 'overlay-timer';
        row.dataset.paused = String(timer.paused === true);
        const label = document.createElement('span');
        label.className = 'overlay-timer-label';
        label.textContent = timer.label;
        label.title = timer.label;
        const reading = document.createElement('div');
        reading.className = 'overlay-timer-reading';
        const time = document.createElement('span');
        time.className = 'overlay-timer-time';
        time.setAttribute('role', 'timer');
        time.setAttribute('aria-live', 'off');
        time.setAttribute('aria-label', timer.label);
        const status = document.createElement('span');
        status.className = 'overlay-timer-status';
        reading.append(time, status);
        row.append(label, reading);
        return { timer, row, time, status };
      });
      timerList.replaceChildren(...displayedTimers.map(({ row }) => row));
    }
    refreshTimerReadings();
    scheduleTimerReadings();
  }

  function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const focusedCard = sportsCard.contains(document.activeElement) ? 'sports' : timerCard.contains(document.activeElement) ? 'timers' : null;
    const state = Object.hasOwn(statusLabels, snapshot.state) ? snapshot.state : 'off';
    const open = snapshot.menuOpen === true && state !== 'off';
    document.body.dataset.state = state;
    document.body.classList.toggle('visuals-paused', snapshot.visible === false);
    document.body.classList.toggle('reduced-motion', snapshot.reducedMotion === true);
    light.hidden = state === 'off';
    light.classList.toggle('hovered', snapshot.hovered === true);
    light.setAttribute('aria-expanded', String(open));
    light.setAttribute('aria-label', open ? 'Close Olanga shortcuts' : `Open Olanga shortcuts. ${statusLabels[state]}`);
    menu.hidden = !open;
    statusText.textContent = statusLabels[state];
    setGeometry(snapshot.geometry);
    showSports(snapshot);
    showTimers(snapshot);
    if (focusedCard === 'sports' && sportsCard.hidden && !timerCard.hidden) {
      (showSportsCard.hidden || timerContent.inert ? timerHandle : showSportsCard).focus({ preventScroll: true });
    } else if (focusedCard === 'timers' && timerCard.hidden && !sportsCard.hidden) {
      (showTimerCard.hidden || sportsContent.inert ? sportsHandle : showTimerCard).focus({ preventScroll: true });
    }
    const actions = Array.isArray(snapshot.actions) ? snapshot.actions.slice(0, 5) : [];
    const key = JSON.stringify(actions);
    if (actionsKey !== key) {
      actionsKey = key;
      actionList.replaceChildren(...actions.map((action, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.title = String(action.label);
        button.setAttribute('aria-keyshortcuts', String(index + 1));
        const number = document.createElement('span');
        number.className = 'slot-number';
        number.textContent = String(index + 1);
        number.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.className = 'action-label';
        label.textContent = String(action.label);
        button.append(label, number);
        button.addEventListener('click', () => api?.runQuickAction(action.id));
        return button;
      }));
    }
    if (open && !wasOpen) actionList.querySelector('button')?.focus({ preventScroll: true });
    wasOpen = open;
  }

  light.addEventListener('click', () => api?.toggleMenu());
  document.getElementById('hideLight').addEventListener('click', () => api?.hideLight('5-seconds'));
  document.getElementById('hideLightHour').addEventListener('click', () => api?.hideLight('1-hour'));
  document.getElementById('openApp').addEventListener('click', () => api?.openApp());
  sportsRefresh.addEventListener('click', () => {
    if (sportsRefresh.getAttribute('aria-disabled') !== 'true') api?.refreshSports();
  });
  document.getElementById('sportsSettings').addEventListener('click', () => api?.openSportsSettings());
  showTimerCard.addEventListener('click', () => api?.selectCompanion('timers'));
  showSportsCard.addEventListener('click', () => api?.selectCompanion('sports'));
  document.getElementById('timerSettings').addEventListener('click', () => api?.openTimerSettings());
  timerHeading.addEventListener('click', () => api?.openTimers());

  function createCardGesture(handle, handlers) {
    let drag = null;
    let suppressClickUntil = 0;
    function releaseCapture(gesture) {
      if (gesture && handle.hasPointerCapture(gesture.id)) handle.releasePointerCapture(gesture.id);
    }
    function cancel(notify = true) {
      if (!drag) return;
      const gesture = drag;
      drag = null;
      suppressClickUntil = Date.now() + 1000;
      releaseCapture(gesture);
      if (notify) handlers.cancel();
    }
    function markMovement(event) {
      if (drag && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 4) drag.moved = true;
    }
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary || handle.hidden) return;
      cancel();
      suppressClickUntil = 0;
      try { handle.setPointerCapture(event.pointerId); } catch { return; }
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, acknowledged: false };
      handle.focus({ preventScroll: true });
      event.preventDefault();
      handlers.start();
    });
    handle.addEventListener('pointermove', markMovement);
    handle.addEventListener('pointerup', event => {
      if (!drag || event.pointerId !== drag.id) return;
      markMovement(event);
      const gesture = drag;
      drag = null;
      if (gesture.moved) suppressClickUntil = Date.now() + 1000;
      releaseCapture(gesture);
      handlers.end();
    });
    handle.addEventListener('click', event => {
      if (event.detail > 0 && Date.now() < suppressClickUntil) { event.preventDefault(); return; }
      handlers.toggle();
    });
    handle.addEventListener('pointercancel', () => cancel());
    handle.addEventListener('lostpointercapture', () => cancel());
    window.addEventListener('blur', () => cancel());
    handle.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation();
        cancel();
        handlers.step(event.key === 'ArrowDown' ? 1 : -1);
      }
    });
    return {
      cancel,
      active: () => !!drag,
      move: handlers.move,
      sync(allowed, dragging) {
        if (drag && (!allowed || (drag.acknowledged && !dragging))) cancel(false);
        if (drag && dragging) drag.acknowledged = true;
      }
    };
  }
  document.addEventListener('pointermove', () => {
    if (pointerPending) return;
    pointerPending = true;
    requestAnimationFrame(() => {
      pointerPending = false;
      const gesture = [sportsGesture, timerGesture].find(item => item.active());
      if (gesture) gesture.move(); else api?.refreshPointer();
    });
  });
  document.addEventListener('pointerleave', () => api?.refreshPointer());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (sportsGesture.active() || timerGesture.active())) {
      event.preventDefault(); event.stopPropagation(); sportsGesture.cancel(); timerGesture.cancel(); return;
    }
    if (event.key === 'Escape') { event.preventDefault(); api?.closeMenu(); return; }
    if (menu.hidden) return;
    if (/^[1-5]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && !event.repeat && !event.isComposing) {
      event.preventDefault();
      actionList.querySelectorAll('button')[Number(event.key) - 1]?.click();
      return;
    }
    const buttons = [...menu.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    if (event.key === 'Tab') next = (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
    if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
  });
  window.addEventListener('beforeunload', stopTimerReadings, { once: true });
  api?.onSnapshot(applySnapshot);
  api?.ready();
})();
