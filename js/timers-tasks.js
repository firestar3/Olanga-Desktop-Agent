/* ============================================
   OLANGA — TIMERS AND TASKS / CHECKLIST
   ============================================ */

// ============================================
// TIMER MANAGEMENT SUBSYSTEM
// ============================================

function createTimer(durationSeconds, label = 'Timer') {
  const id = Date.now() + Math.random().toString(36).substr(2, 9);
  const durationMs = durationSeconds * 1000;
  const endTime = Date.now() + durationMs;

  const timerObj = {
    id,
    endTime,
    label: label || 'Timer',
    intervalId: null,
    ringing: false
  };

  activeTimers.push(timerObj);

  // Render the new timer immediately
  renderTimers();

  // Start the countdown interval
  timerObj.intervalId = setInterval(() => {
    const remainingMs = timerObj.endTime - Date.now();
    if (remainingMs <= 0) {
      clearInterval(timerObj.intervalId);
      timerObj.intervalId = null;
      ringTimer(timerObj);
    } else {
      updateTimerDisplay(timerObj);
    }
  }, 1000);
}

function ringTimer(timerObj) {
  timerObj.ringing = true;
  playAlarmSoundLoop();

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

    // Check if we can stop the alarm sound loop
    const stillRinging = activeTimers.some(t => t.ringing);
    if (!stillRinging && alarmIntervalId) {
      clearInterval(alarmIntervalId);
      alarmIntervalId = null;
    }

    renderTimers();
  }
}

function cancelTimerByLabel(label) {
  const lowercaseLabel = label.toLowerCase().trim();
  const matched = activeTimers.filter(t => t.label.toLowerCase().trim() === lowercaseLabel);
  if (matched.length > 0) {
    matched.forEach(t => cancelTimer(t.id));
  }
}

function clearAllTimers() {
  activeTimers.forEach(t => {
    if (t.intervalId) clearInterval(t.intervalId);
  });
  activeTimers = [];
  if (alarmIntervalId) {
    clearInterval(alarmIntervalId);
    alarmIntervalId = null;
  }
  renderTimers();
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

    const remainingMs = timer.endTime - Date.now();
    const formatted = formatTime(remainingMs > 0 ? remainingMs : 0);

    card.innerHTML = `
      <div class="timer-info">
        <span class="timer-label">${escapeHTML(timer.label)}</span>
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
  const cleaned = input.toLowerCase().trim();

  // Try matching patterns like "1h30m", "3m", "10s", "1h", "2m30s"
  const hMatch = cleaned.match(/(\d+)\s*h/);
  const mMatch = cleaned.match(/(\d+)\s*m/);
  const sMatch = cleaned.match(/(\d+)\s*s/);

  if (hMatch || mMatch || sMatch) {
    const hours = hMatch ? parseInt(hMatch[1]) : 0;
    const minutes = mMatch ? parseInt(mMatch[1]) : 0;
    const seconds = sMatch ? parseInt(sMatch[1]) : 0;
    return hours * 3600 + minutes * 60 + seconds;
  }

  // Plain number = seconds
  const num = parseInt(cleaned);
  if (!isNaN(num) && num > 0) {
    return num;
  }

  return 0;
}

function playAlarmSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

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
    console.error('Failed to play alarm sound:', err);
  }
}

function playAlarmSoundLoop() {
  if (alarmIntervalId) return;

  playAlarmSound();

  alarmIntervalId = setInterval(() => {
    const stillRinging = activeTimers.some(t => t.ringing);
    if (stillRinging) {
      playAlarmSound();
    } else {
      clearInterval(alarmIntervalId);
      alarmIntervalId = null;
    }
  }, 2000);
}

// ============================================
// TASK / CHECKLIST MANAGEMENT SUBSYSTEM
// ============================================

function saveTasks() {
  localStorage.setItem('olanga_tasks', JSON.stringify(activeTasks));
}

function loadTasks() {
  const stored = localStorage.getItem('olanga_tasks');
  if (stored) {
    try {
      activeTasks = JSON.parse(stored);
    } catch (e) {
      console.error('Failed to parse tasks', e);
      activeTasks = [];
    }
  }
}

function addTask(text, dueDate = null) {
  if (!text.trim()) return;
  const id = Date.now() + Math.random().toString(36).substr(2, 9);

  activeTasks.push({
    id,
    text: text.trim(),
    completed: false,
    dueDate: dueDate ? dueDate.trim() : null
  });

  saveTasks();
  renderTasks();
}

function removeTask(idOrText) {
  const lowercaseVal = idOrText.toLowerCase().trim();

  let index = activeTasks.findIndex(t => t.id === idOrText);
  if (index === -1) {
    index = activeTasks.findIndex(t => t.text.toLowerCase().includes(lowercaseVal));
  }

  if (index !== -1) {
    activeTasks.splice(index, 1);
    saveTasks();
    renderTasks();
  }
}

function clearAllTasks() {
  activeTasks = [];
  saveTasks();
  renderTasks();
}

function setTaskDue(idOrText, dueDate) {
  const lowercaseVal = idOrText.toLowerCase().trim();

  let task = activeTasks.find(t => t.id === idOrText);
  if (!task) {
    task = activeTasks.find(t => t.text.toLowerCase().includes(lowercaseVal));
  }

  if (task) {
    task.dueDate = dueDate ? dueDate.trim() : null;
    saveTasks();
    renderTasks();
  }
}

function toggleTaskComplete(id) {
  const task = activeTasks.find(t => t.id === id);
  if (task) {
    task.completed = !task.completed;
    saveTasks();
    renderTasks();
  }
}

function completeTask(idOrText, markDone = true) {
  const lowercaseVal = idOrText.toLowerCase().trim();

  let task = activeTasks.find(t => t.id === idOrText);
  if (!task) {
    task = activeTasks.find(t => t.text.toLowerCase().includes(lowercaseVal));
  }

  if (task) {
    task.completed = markDone;
    saveTasks();
    renderTasks();
    console.log(`[Olanga] ✅ Task "${task.text}" marked as ${markDone ? 'complete' : 'incomplete'}`);
  } else {
    console.warn(`[Olanga] ⚠️ Could not find task matching: "${idOrText}"`);
  }
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
      const idx = activeTasks.findIndex(t => t.id === task.id);
      if (idx !== -1) {
        activeTasks.splice(idx, 1);
        saveTasks();
        renderTasks();
      }
    });

    listContainer.appendChild(item);
  });
}
