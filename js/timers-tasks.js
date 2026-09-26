/* ============================================
   OLANGA — TIMERS AND TASKS / CHECKLIST
   ============================================ */

// ============================================
// TIMER MANAGEMENT SUBSYSTEM
// ============================================

const TIMERS_STORAGE_KEY = 'olanga_timers';
// Reminders and alarms are timers with a spoken ring. Plain timers keep the
// original stored shape, so older versions still read them.
const TIMER_KINDS = new Set(['timer', 'reminder', 'alarm']);
const TIMER_NOT_SAVED = ' It could not be saved and will be lost if Olanga closes.';
let stopAlarmPlayback = null;
let localRecordSequence = 0;

function describeDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600), minutes = Math.floor((totalSeconds % 3600) / 60), seconds = totalSeconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (seconds || !parts.length) parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
  return parts.join(' ');
}

function formatClock(time) {
  return new Date(time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function isPlainAlarm(timer) {
  return timer.kind === 'alarm' && ['alarm', 'wake up'].includes(timer.label.toLowerCase());
}

// Accepts "h:mm", "h:mm AM|PM" and an optional " tomorrow". Without AM/PM the
// sooner of the two matching times is chosen, never a time in the past.
function nextAlarmTime(spec, now = Date.now()) {
  const match = /^(1[0-2]|[1-9]):([0-5]\d)(?: (AM|PM))?( tomorrow)?$/i.exec(String(spec || '').trim());
  if (!match) return null;
  const hour = Number(match[1]) % 12, minute = Number(match[2]);
  const hours = match[3] ? [hour + (match[3].toUpperCase() === 'PM' ? 12 : 0)] : [hour, hour + 12];
  const today = new Date(now), candidates = [];
  for (const offset of match[4] ? [1] : [0, 1]) {
    for (const value of hours) {
      const time = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, value, minute, 0, 0).getTime();
      if (time > now) candidates.push(time);
    }
  }
  return candidates.length ? Math.min(...candidates) : null;
}

function nextLocalRecordId(records) {
  let id;
  do { id = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}-${++localRecordSequence}`; } while (records.some(record => record.id === id));
  return id;
}

function stopTimerAlarm() {
  if (alarmIntervalId !== null) clearInterval(alarmIntervalId);
  alarmIntervalId = null;
  if (stopAlarmPlayback) stopAlarmPlayback();
}

function saveTimers() {
  try {
    localStorage.setItem(TIMERS_STORAGE_KEY, JSON.stringify(activeTimers.map(({ id, endTime, label, kind }) => (kind && kind !== 'timer' ? { id, endTime, label, kind } : { id, endTime, label }))));
    return true;
  } catch (error) {
    console.error('Failed to save timers:', error);
    return false;
  }
}

function startTimerCountdown(timerObj) {
  if (timerObj.endTime <= Date.now()) {
    // Only a restored record can already be due: every new duration is positive.
    ringTimer(timerObj, true);
    return;
  }
  timerObj.intervalId = setInterval(() => {
    if (timerObj.endTime <= Date.now()) {
      clearInterval(timerObj.intervalId);
      timerObj.intervalId = null;
      ringTimer(timerObj);
    } else {
      updateTimerDisplay(timerObj);
    }
  }, 1000);
}

function loadTimers() {
  // Repeated initialization must not create duplicate countdowns or alarms.
  activeTimers.forEach(timer => { if (timer.intervalId !== null) clearInterval(timer.intervalId); });
  stopTimerAlarm();
  activeTimers = [];
  try {
    const stored = JSON.parse(localStorage.getItem(TIMERS_STORAGE_KEY) || '[]');
    const seen = new Set();
    if (Array.isArray(stored)) {
      for (const timer of stored) {
        if (!timer || typeof timer.id !== 'string' || !timer.id || seen.has(timer.id) ||
            !Number.isFinite(timer.endTime) || timer.endTime <= 0 || timer.endTime > 8640000000000000 ||
            typeof timer.label !== 'string' || !timer.label.trim()) continue;
        seen.add(timer.id);
        activeTimers.push({ id: timer.id, endTime: timer.endTime, label: timer.label, kind: TIMER_KINDS.has(timer.kind) ? timer.kind : 'timer', intervalId: null, ringing: false });
      }
    }
  } catch (error) {
    console.error('Failed to load timers:', error);
  }
  renderTimers();
  activeTimers.forEach(startTimerCountdown);
}

function createTimer(durationSeconds, label = 'Timer') {
  const endTime = Date.now() + durationSeconds * 1000;
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
      !Number.isFinite(endTime) || endTime > 8640000000000000) {
    return { ok: false, message: 'The timer needs a valid duration greater than zero.' };
  }
  label = typeof label === 'string' && label.trim() ? label.trim() : 'Timer';
  const { saved } = addTimerRecord(endTime, label || 'Timer', 'timer');
  const duration = durationSeconds % 60 === 0 ? `${durationSeconds / 60} minutes` : `${durationSeconds} seconds`;
  return { ok: true, message: `${label} set for ${duration}.${saved ? '' : TIMER_NOT_SAVED}` };
}

function addTimerRecord(endTime, label, kind) {
  const timerObj = { id: nextLocalRecordId(activeTimers), endTime, label, kind, intervalId: null, ringing: false };
  activeTimers.push(timerObj);
  const saved = saveTimers();
  renderTimers();
  startTimerCountdown(timerObj);
  return { timerObj, saved };
}

function createReminder(durationSeconds, text) {
  if (typeof durationSeconds !== 'number' || !Number.isInteger(durationSeconds) || durationSeconds <= 0 || durationSeconds > 86400) {
    return { ok: false, message: 'Reminders can be set from one second to 24 hours ahead.' };
  }
  const label = typeof text === 'string' ? text.trim() : '';
  if (!label || label.length > 120) return { ok: false, message: 'Tell me what the reminder is for, in a short phrase.' };
  const { saved } = addTimerRecord(Date.now() + durationSeconds * 1000, label, 'reminder');
  return { ok: true, message: `I'll remind you in ${describeDuration(durationSeconds)}: ${label}.${saved ? '' : TIMER_NOT_SAVED}` };
}

function createAlarm(spec, label = 'Alarm') {
  const endTime = nextAlarmTime(spec);
  if (!endTime) return { ok: false, message: 'Tell me a time such as 7:30 AM, up to one day ahead.' };
  const text = typeof label === 'string' && label.trim() ? label.trim().slice(0, 120) : 'Alarm';
  const { timerObj, saved } = addTimerRecord(endTime, text, 'alarm');
  const when = `${formatClock(endTime)} ${new Date(endTime).toDateString() === new Date().toDateString() ? 'today' : 'tomorrow'}`;
  return { ok: true, message: `${isPlainAlarm(timerObj) ? `Alarm set for ${when}.` : `I'll remind you at ${when}: ${text}.`}${saved ? '' : TIMER_NOT_SAVED}` };
}

function describeTimerRing(timer, overdue) {
  const clock = formatClock(timer.endTime);
  const ring = timer.kind === 'timer'
    ? { title: 'Timer finished', body: `${timer.label} is done.`, speech: null }
    : isPlainAlarm(timer)
      ? { title: 'Alarm', body: `It's ${clock}.`, speech: `It's ${clock}. Your alarm is going off.` }
      : { title: 'Reminder', body: timer.label, speech: `Reminder: ${timer.label}.` };
  if (overdue) return { title: ring.title, body: `${isPlainAlarm(timer) ? `Alarm for ${clock}` : timer.label} (due while Olanga was closed)`, speech: null };
  return ring;
}

// Speak only while the assistant is idle; the alarm sound follows the words so
// neither masks the other. Busy, muted or restored reminders keep the original
// alarm sound without speaking over another conversation.
function announceTimer(timerObj, text) {
  if (typeof speakResponse !== 'function' || typeof State === 'undefined' || typeof currentState === 'undefined' ||
      currentState !== State.IDLE || (typeof isTtsMuted !== 'undefined' && isTtsMuted)) return false;
  let speech;
  try { speech = Promise.resolve(speakResponse(text)); } catch (_) { speech = Promise.resolve(); }
  speech.catch(() => {}).finally(() => {
    if (timerObj.ringing && activeTimers.includes(timerObj)) playAlarmSoundLoop();
  });
  return true;
}

function ringTimer(timerObj, overdue = false) {
  if (timerObj.ringing) return;
  timerObj.ringing = true;
  const ring = describeTimerRing(timerObj, overdue);
  try { window.electronAPI?.notify?.({ title: ring.title, body: ring.body }); } catch (_) {}
  if (!ring.speech || !announceTimer(timerObj, ring.speech)) playAlarmSoundLoop();

  const card = document.getElementById(`timer-card-${timerObj.id}`);
  if (card) {
    card.classList.add('ringing');
    const timeEl = card.querySelector('.timer-time');
    if (timeEl) timeEl.textContent = '00:00';
  }
}

function cancelTimer(id) {
  const timerIndex = activeTimers.findIndex(t => t.id === id);
  if (timerIndex !== -1) {
    const timer = activeTimers[timerIndex];
    if (timer.intervalId) {
      clearInterval(timer.intervalId);
    }
    activeTimers.splice(timerIndex, 1);
    const saved = saveTimers();

    // Check if we can stop the alarm sound loop
    const stillRinging = activeTimers.some(t => t.ringing);
    if (!stillRinging) stopTimerAlarm();

    renderTimers();
    return { ok: saved, message: `${timer.label} cancelled.${saved ? '' : ' The change could not be saved; this timer may return when Olanga reopens.'}` };
  }
  return { ok: false, message: 'That timer is no longer active.' };
}

function cancelTimerByLabel(label) {
  if (typeof label !== 'string' || !label.trim()) return { ok: false, message: 'Please specify the timer name.' };
  // A clarified follow-up passes the selected record's ID.
  const byId = activeTimers.find(timer => timer.id === label.trim());
  if (byId) return cancelTimer(byId.id);
  const lowercaseLabel = label.toLowerCase().trim();
  const matched = activeTimers.filter(t => t.label.toLowerCase().trim() === lowercaseLabel);
  if (matched.length > 1) return { ok: false, clarification: true, message: `More than one timer is named "${label.trim()}". Select the timer to dismiss, or explicitly ask to clear all timers.` };
  if (matched.length === 1) return cancelTimer(matched[0].id);
  return { ok: false, message: `No active timer named "${label.trim()}" was found.` };
}

function timerNoun(timer) {
  if (timer.kind === 'timer') return timer.label.toLowerCase() === 'timer' ? 'Timer' : `${timer.label} timer`;
  return isPlainAlarm(timer) ? 'Alarm' : 'Reminder';
}

function describeActiveTimer(timer) {
  if (timer.kind === 'alarm') return `${timer.label} at ${formatClock(timer.endTime)}`;
  return `${timer.label} with ${formatTime(Math.max(0, timer.endTime - Date.now()))} left`;
}

// "Stop the alarm" dismisses whatever is ringing. Otherwise it cancels the only
// active record, and asks rather than guessing when several are running.
function stopTimers() {
  const ringing = activeTimers.filter(timer => timer.ringing);
  if (ringing.length) {
    const results = ringing.map(timer => cancelTimer(timer.id));
    const saved = results.every(result => result.ok);
    return { ok: saved, message: `${ringing.length === 1 ? `${timerNoun(ringing[0])} dismissed.` : `Dismissed ${ringing.length} alarms and timers.`}${saved ? '' : ' The change could not be saved; it may return when Olanga reopens.'}` };
  }
  if (!activeTimers.length) return { ok: false, message: 'You have no active timers, alarms or reminders.' };
  if (activeTimers.length === 1) return cancelTimer(activeTimers[0].id);
  return { ok: false, clarification: true, message: `Which one should I cancel? ${activeTimers.map(describeActiveTimer).join('; ')}.` };
}

function findTimerForChange(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, message: 'Please specify the timer name.' };
  const byId = activeTimers.find(timer => timer.id === text.trim());
  if (byId) return { timer: byId };
  const target = text.trim().toLowerCase().replace(/^(?:the|my)\s+/, '').replace(/\s+(?:one|timer|alarm|reminder)$/, '').trim();
  const exact = activeTimers.filter(timer => timer.label.toLowerCase().trim() === target);
  const matches = exact.length ? exact : activeTimers.filter(timer => target && timer.label.toLowerCase().includes(target));
  if (matches.length === 1) return { timer: matches[0] };
  if (matches.length > 1) return { ok: false, clarification: true, message: `More than one timer matches "${text.trim()}".` };
  return { ok: false, message: `No active timer matching "${text.trim()}" was found.` };
}

function clearAllTimers() {
  activeTimers.forEach(t => {
    if (t.intervalId) clearInterval(t.intervalId);
  });
  activeTimers = [];
  const saved = saveTimers();
  stopTimerAlarm();
  renderTimers();
  return { ok: saved, message: `All timers cleared.${saved ? '' : ' The change could not be saved; timers may return when Olanga reopens.'}` };
}

function renderTimers() {
  if (!timersContainer) return;
  timersContainer.innerHTML = '';

  if (activeTimers.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'timers-empty';
    emptyEl.textContent = 'No active timers';
    timersContainer.appendChild(emptyEl);
    return;
  }

  activeTimers.forEach(timer => {
    const card = document.createElement('div');
    card.className = `timer-card ${timer.ringing ? 'ringing' : ''}`;
    card.id = `timer-card-${timer.id}`;
    card.dataset.kind = timer.kind || 'timer';

    const remainingMs = timer.endTime - Date.now();
    const formatted = formatTime(remainingMs > 0 ? remainingMs : 0);
    const when = timer.kind === 'alarm' ? `<span class="timer-when">${escapeHTML(formatClock(timer.endTime))}</span>` : '';

    card.innerHTML = `
      <div class="timer-info">
        <span class="timer-label">${escapeHTML(timer.label)}</span>${when}
        <span class="timer-time">${formatted}</span>
      </div>
      <button class="timer-btn-close" title="Dismiss Timer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    `;

    const closeBtn = card.querySelector('.timer-btn-close');
    closeBtn.addEventListener('click', () => {
      cancelTimer(timer.id);
    });

    timersContainer.appendChild(card);
  });
}

function updateTimerDisplay(timerObj) {
  const card = document.getElementById(`timer-card-${timerObj.id}`);
  if (!card) return;

  const timeEl = card.querySelector('.timer-time');
  if (!timeEl) return;

  const remainingMs = timerObj.endTime - Date.now();
  timeEl.textContent = formatTime(remainingMs > 0 ? remainingMs : 0);
}

function formatTime(ms) {
  const totalSecs = Math.ceil(ms / 1000);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  let result = '';
  if (hrs > 0) {
    result += (hrs < 10 ? '0' + hrs : hrs) + ':';
  }
  result += (mins < 10 ? '0' + mins : mins) + ':';
  result += (secs < 10 ? '0' + secs : secs);
  return result;
}

function parseTimerInput(input) {
  if (typeof input !== 'string') return 0;
  const cleaned = input.toLowerCase().trim();
  if (/^\d+(?:\.\d+)?$/.test(cleaned)) return Number.isFinite(Number(cleaned)) ? Number(cleaned) : 0;
  const token = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gy;
  let position = 0, seconds = 0;
  while (position < cleaned.length) {
    token.lastIndex = position;
    const match = token.exec(cleaned);
    if (!match) return 0;
    seconds += Number(match[1]) * (/^h/.test(match[2]) ? 3600 : /^m/.test(match[2]) ? 60 : 1);
    position = token.lastIndex;
    const separator = /^\s*(?:,\s*)?(?:and\s+)?/.exec(cleaned.slice(position))[0];
    position += separator.length;
    if (position === cleaned.length && /,|and/.test(separator)) return 0;
  }
  return Number.isFinite(seconds) ? seconds : 0;
}

function playAlarmSound() {
  // A suspended audio device may never finish starting. Keep at most one pulse
  // alive, and release it on dismissal or timeout before attempting another.
  if (stopAlarmPlayback) return;
  let ctx, osc, gain;
  let watchdog;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(watchdog);
    if (stopAlarmPlayback === release) stopAlarmPlayback = null;
    try { osc?.disconnect(); } catch (_) {}
    try { gain?.disconnect(); } catch (_) {}
    try { if (ctx && ctx.state !== 'closed') Promise.resolve(ctx.close()).catch(() => {}); } catch (_) {}
  };
  stopAlarmPlayback = release;
  watchdog = setTimeout(release, 5000);
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') {
      Promise.resolve(ctx.resume()).catch(error => {
        release();
        console.error('Failed to resume alarm sound:', error);
      });
    }
    osc = ctx.createOscillator();
    gain = ctx.createGain();
    osc.onended = release;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);

    gain.gain.setValueAtTime(0.5, ctx.currentTime);
    const now = ctx.currentTime;

    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);

    gain.gain.setValueAtTime(0.5, now + 0.3);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.45);

    gain.gain.setValueAtTime(0.5, now + 0.6);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.75);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 1.0);
  } catch (err) {
    release();
    console.error('Failed to play alarm sound:', err);
  }
}

function playAlarmSoundLoop() {
  if (alarmIntervalId) return;

  playAlarmSound();

  alarmIntervalId = setInterval(() => {
    const stillRinging = activeTimers.some(t => t.ringing);
    if (stillRinging) {
      // Beeps would keep end-of-speech detection from finishing a spoken
      // "stop", so they pause while the user's voice is being recorded.
      const listening = typeof State !== 'undefined' && typeof currentState !== 'undefined' && currentState === State.LISTENING;
      if (!listening) playAlarmSound();
    } else {
      stopTimerAlarm();
    }
  }, 2000);
}

// ============================================
// TASK / CHECKLIST MANAGEMENT SUBSYSTEM
// ============================================

function saveTasks() {
  try {
    localStorage.setItem('olanga_tasks', JSON.stringify(activeTasks));
    return true;
  } catch (error) {
    console.error('Failed to save tasks:', error);
    return false;
  }
}

function loadTasks() {
  try {
    const stored = JSON.parse(localStorage.getItem('olanga_tasks') || '[]');
    const seen = new Set();
    activeTasks = Array.isArray(stored) ? stored.filter(task => {
      if (!task || typeof task.id !== 'string' || !task.id || seen.has(task.id) || typeof task.text !== 'string' || !task.text.trim()) return false;
      seen.add(task.id);
      return true;
    }).map(task => ({ id: task.id, text: task.text, completed: task.completed === true, dueDate: typeof task.dueDate === 'string' ? task.dueDate : null })) : [];
  } catch (error) {
    console.error('Failed to load tasks:', error);
    activeTasks = [];
  }
}

function finishTaskChange(message, previous) {
  const saved = saveTasks();
  if (!saved) activeTasks = previous;
  renderTasks();
  const failure = 'The checklist change could not be saved. Nothing was changed.';
  const container = document.getElementById('tasksContainer');
  if (container) {
    let notice = document.getElementById('tasksSaveStatus');
    if (!notice) { notice = document.createElement('p'); notice.id = 'tasksSaveStatus'; notice.setAttribute('role', 'status'); container.appendChild(notice); }
    notice.textContent = saved ? '' : failure;
    notice.hidden = saved;
  }
  return { ok: saved, message: saved ? message : failure };
}

function findTaskForChange(idOrText) {
  if (typeof idOrText !== 'string' || !idOrText.trim()) return { ok: false, message: 'Please specify the task name.' };
  const target = idOrText.trim().toLowerCase();
  const byId = activeTasks.find(task => task.id === idOrText);
  if (byId) return { task: byId };
  const exact = activeTasks.filter(task => task.text.toLowerCase().trim() === target);
  const matches = exact.length ? exact : activeTasks.filter(task => task.text.toLowerCase().includes(target));
  if (matches.length === 1) return { task: matches[0] };
  if (matches.length > 1) return { ok: false, clarification: true, message: `More than one task matches "${idOrText.trim()}". Which full task name do you mean? You can also select it in the checklist.` };
  return { ok: false, message: `No task matching "${idOrText.trim()}" was found.` };
}

function addTask(text, dueDate = null) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, message: 'The task needs a name.' };
  const id = nextLocalRecordId(activeTasks);
  const previous = activeTasks.map(task => ({ ...task }));

  activeTasks.push({
    id,
    text: text.trim(),
    completed: false,
    dueDate: typeof dueDate === 'string' && dueDate.trim() ? dueDate.trim() : null
  });

  return finishTaskChange(`Added "${text.trim()}" to your checklist.${typeof dueDate === 'string' && dueDate.trim() ? ` Due ${dueDate.trim()}.` : ''}`, previous);
}

function removeTask(idOrText) {
  const match = findTaskForChange(idOrText);
  if (!match.task) return match;
  const previous = activeTasks.map(task => ({ ...task }));
  activeTasks.splice(activeTasks.indexOf(match.task), 1);
  return finishTaskChange(`Removed "${match.task.text}" from your checklist.`, previous);
}

function clearAllTasks() {
  const previous = activeTasks;
  activeTasks = [];
  return finishTaskChange('Your checklist is clear.', previous);
}

function setTaskDue(idOrText, dueDate) {
  const match = findTaskForChange(idOrText);
  if (!match.task) return match;
  const previous = activeTasks.map(task => ({ ...task }));
  match.task.dueDate = typeof dueDate === 'string' && dueDate.trim() ? dueDate.trim() : null;
  return finishTaskChange(match.task.dueDate ? `"${match.task.text}" is due ${match.task.dueDate}.` : `Cleared the due date for "${match.task.text}".`, previous);
}

function toggleTaskComplete(id) {
  const task = activeTasks.find(t => t.id === id);
  if (task) return completeTask(id, !task.completed);
}

function completeTask(idOrText, markDone = true) {
  const match = findTaskForChange(idOrText);
  if (!match.task) return match;
  const previous = activeTasks.map(task => ({ ...task }));
  match.task.completed = !!markDone;
  return finishTaskChange(`Marked "${match.task.text}" ${markDone ? 'complete' : 'incomplete'}.`, previous);
}

function renderTasks() {
  const listContainer = document.getElementById('tasksList');
  if (!listContainer) return;
  listContainer.innerHTML = '';

  if (activeTasks.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'tasks-empty';
    emptyEl.textContent = 'Checklist is empty';
    listContainer.appendChild(emptyEl);
    return;
  }

  activeTasks.forEach(task => {
    const item = document.createElement('div');
    item.className = 'task-item';
    item.id = `task-item-${task.id}`;

    item.innerHTML = `
      <input type="checkbox" class="task-checkbox" ${task.completed ? 'checked' : ''} />
      <div class="task-content">
        <span class="task-text ${task.completed ? 'completed' : ''}">${escapeHTML(task.text)}</span>
        ${task.dueDate ? `<span class="task-due">📅 ${escapeHTML(task.dueDate)}</span>` : ''}
      </div>
      <button class="task-delete-btn" title="Delete Task">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    `;

    const cb = item.querySelector('.task-checkbox');
    cb.addEventListener('change', () => {
      toggleTaskComplete(task.id);
    });

    const delBtn = item.querySelector('.task-delete-btn');
    delBtn.addEventListener('click', () => {
      removeTask(task.id);
    });

    listContainer.appendChild(item);
  });
}
