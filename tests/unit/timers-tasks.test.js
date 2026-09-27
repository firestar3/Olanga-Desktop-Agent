const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../js/timers-tasks.js'), 'utf8');

function harness(store = new Map(), start = 100000) {
  let now = start, nextInterval = 0, alarms = 0;
  const intervals = new Map();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    Date: Clock, setTimeout, clearTimeout, console: { log() {}, error() {} }, window: {},
    activeTimers: [], activeTasks: [], alarmIntervalId: null, timersContainer: null,
    document: { getElementById() { return null; } },
    localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    setInterval(fn, delay) { const id = ++nextInterval; intervals.set(id, { fn, delay }); return id; },
    clearInterval(id) { intervals.delete(id); }
  });
  vm.runInContext(source, context);
  context.playAlarmSound = () => { alarms++; };
  return { context, store, intervals, get alarms() { return alarms; },
    advance(ms) { now += ms; for (const [id, interval] of [...intervals]) if (intervals.has(id)) interval.fn(); }
  };
}

test('timer deadlines survive restart, ring when due, and stay dismissed after another restart', () => {
  const first = harness();
  assert.equal(first.context.createTimer(60, 'Tea').ok, true);
  const persisted = JSON.parse(first.store.get('olanga_timers'));
  assert.deepEqual(Object.keys(persisted[0]).sort(), ['endTime', 'id', 'label']);
  const restarted = harness(first.store, 120000);
  restarted.context.loadTimers();
  assert.equal(restarted.context.activeTimers[0].endTime, 160000);
  restarted.advance(39000);
  assert.equal(restarted.alarms, 0);
  restarted.advance(1000);
  assert.equal(restarted.alarms, 1);
  assert.equal(restarted.context.activeTimers[0].ringing, true);
  assert.equal(restarted.context.cancelTimerByLabel('tea').ok, true);
  assert.equal(restarted.intervals.size, 0);
  const final = harness(first.store, 200000);
  final.context.loadTimers();
  assert.equal(final.context.activeTimers.length, 0);
  assert.equal(final.alarms, 0);
});

test('overdue timers ring on reopening with one shared alarm and no duplicate intervals', () => {
  const first = harness();
  first.context.createTimer(1, 'Tea');
  first.context.createTimer(2, 'Laundry');
  first.context.createTimer(60, 'Work');
  const reopened = harness(first.store, 110000);
  reopened.context.loadTimers();
  assert.equal(reopened.context.activeTimers.filter(timer => timer.ringing).length, 2);
  assert.equal(reopened.alarms, 1);
  assert.deepEqual([...reopened.intervals.values()].map(item => item.delay).sort(), [1000, 2000]);
  reopened.context.loadTimers();
  assert.equal(reopened.intervals.size, 2);
  reopened.context.clearAllTimers();
  assert.equal(reopened.intervals.size, 0);
  assert.equal(first.store.get('olanga_timers'), '[]');
});

test('invalid timer storage cannot break startup or discard valid neighboring timers', () => {
  for (const raw of ['{', '{}', 'null', '[null, 4, {}]']) {
    const app = harness(new Map([['olanga_timers', raw]]));
    assert.doesNotThrow(() => app.context.loadTimers());
    assert.equal(app.context.activeTimers.length, 0);
    assert.equal(app.store.get('olanga_timers'), raw, 'Loading must not overwrite damaged storage');
  }
  const app = harness(new Map([['olanga_timers', JSON.stringify([
    { id: 'ok', endTime: 130000, label: 'Work' }, { id: 'ok', endTime: 130000, label: 'Duplicate' },
    { id: 'bad', endTime: 'tomorrow', label: 'Bad' }, { id: 'blank', endTime: 130000, label: '' }
  ])]]));
  app.context.loadTimers();
  assert.equal(app.context.activeTimers.length, 1);
  assert.equal(app.context.activeTimers[0].label, 'Work');
});

test('invalid durations create no timers and failed persistence preserves a working timer with an honest receipt', () => {
  const app = harness();
  for (const seconds of [0, -5, NaN, Infinity, '60', 1e20, null]) assert.equal(app.context.createTimer(seconds).ok, false);
  assert.equal(app.context.activeTimers.length, 0);
  app.context.localStorage.setItem = () => { throw new Error('Storage full'); };
  const result = app.context.createTimer(1, 'Tea');
  assert.equal(result.ok, true);
  assert.match(result.message, /could not be saved/);
  app.advance(1000);
  assert.equal(app.alarms, 1);
  assert.equal(app.context.cancelTimerByLabel('Tea').ok, false);
  assert.equal(app.context.activeTimers.length, 0);
  assert.equal(app.context.cancelTimerByLabel('Missing').ok, false);
});

test('manual duration parsing preserves whole and compound units and handles decimals without multiplying the wrong digit', () => {
  const { context } = harness();
  for (const [input, seconds] of [['60', 60], ['1h30m', 5400], ['2m30s', 150], ['1.5h', 5400], ['2.5 minutes', 150], ['1 hour, 30 minutes and 5 seconds', 5405], ['0.5', 0.5]]) {
    assert.equal(context.parseTimerInput(input), seconds, input);
  }
  for (const input of ['-5m', '1h30', '5 bananas', '1m later', '1.5.2h', '1h and', '1h,', '', null]) {
    assert.equal(context.parseTimerInput(input), 0, String(input));
  }
});

test('checklist operations prefer exact names, retain unique partial names, and never guess between matches', () => {
  const { context } = harness();
  context.addTask('Buy milk for work');
  context.addTask('Buy milk');
  context.addTask('Call Alex');
  assert.equal(context.completeTask('buy milk').ok, true);
  assert.equal(context.activeTasks[0].completed, false);
  assert.equal(context.activeTasks[1].completed, true);
  assert.equal(context.setTaskDue('Alex', 'Friday').ok, true);
  assert.equal(context.activeTasks[2].dueDate, 'Friday');
  for (const mutate of [value => context.removeTask(value), value => context.completeTask(value), value => context.setTaskDue(value, 'Monday')]) {
    const before = JSON.stringify(context.activeTasks);
    assert.match(mutate('Buy').message, /More than one/);
    assert.equal(mutate('').ok, false);
    assert.equal(mutate('Missing').ok, false);
    assert.equal(JSON.stringify(context.activeTasks), before);
  }
  assert.equal(context.removeTask('work').ok, true);
  assert.equal(context.activeTasks.length, 2);
});

test('duplicate task names require a stable ID and completion can be reversed after reload', () => {
  const first = harness();
  first.context.addTask('Read', 'Friday');
  first.context.addTask('Read');
  assert.equal(first.context.completeTask('Read').ok, false);
  const id = first.context.activeTasks[1].id;
  assert.equal(first.context.completeTask(id).ok, true);
  const second = harness(first.store);
  second.context.loadTasks();
  assert.equal(second.context.activeTasks[1].completed, true);
  assert.equal(second.context.completeTask(id, false).ok, true);
  assert.equal(second.context.activeTasks[1].completed, false);
  assert.equal(second.context.removeTask(id).ok, true);
  assert.equal(second.context.activeTasks.length, 1);
  assert.equal(second.context.activeTasks[0].dueDate, 'Friday');
});

test('checklist loads survive corrupt data and preserve valid entries without rewriting storage', () => {
  for (const raw of ['null', '{}', '{', '[null, 7, {}]']) {
    const app = harness(new Map([['olanga_tasks', raw]]));
    assert.doesNotThrow(() => app.context.loadTasks());
    assert.equal(app.context.activeTasks.length, 0);
    assert.equal(app.store.get('olanga_tasks'), raw);
  }
  const app = harness(new Map([['olanga_tasks', JSON.stringify([
    { id: 'a', text: 'Read', completed: true, dueDate: 'Friday' }, null,
    { id: 'b', text: 'Call', completed: 'false', dueDate: {} }, { id: 'a', text: 'Duplicate' }
  ])]]));
  app.context.loadTasks();
  assert.equal(app.context.activeTasks.length, 2);
  assert.equal(app.context.activeTasks[0].completed, true);
  assert.equal(app.context.activeTasks[1].completed, false);
  assert.equal(app.context.activeTasks[1].dueDate, null);
});

test('storage errors cannot crash timer/checklist initialization and failed checklist changes roll back', () => {
  const { context } = harness();
  context.localStorage.getItem = context.localStorage.setItem = () => { throw new Error('Storage unavailable'); };
  assert.doesNotThrow(() => { context.loadTimers(); context.loadTasks(); });
  const result = context.addTask('Read');
  assert.equal(result.ok, false);
  assert.match(result.message, /could not be saved.*Nothing was changed/);
  assert.equal(context.activeTasks.length, 0);
});

test('duplicate timer names require selection and never cancel several timers implicitly', () => {
  const app = harness();
  app.context.createTimer(60, 'Tea'); app.context.createTimer(120, 'Tea');
  const before = app.store.get('olanga_timers');
  const result = app.context.cancelTimerByLabel('tea');
  assert.equal(result.ok, false); assert.equal(result.clarification, true);
  assert.equal(app.context.activeTimers.length, 2);
  assert.equal(app.store.get('olanga_timers'), before);
  assert.equal(app.context.cancelTimer(app.context.activeTimers[1].id).ok, true);
  assert.equal(app.context.activeTimers[0].endTime, 160000);
});

test('same-tick records retain distinct identities even with repeated random output and after reload', () => {
  const app = harness(); vm.runInContext('Math.random = () => 0;', app.context);
  app.context.addTask('One'); app.context.addTask('Two');
  app.context.createTimer(60, 'One'); app.context.createTimer(120, 'Two');
  assert.equal(new Set([...app.context.activeTasks, ...app.context.activeTimers].map(item => item.id)).size, 4);
  const next = harness(app.store); vm.runInContext('Math.random = () => 0;', next.context);
  next.context.loadTasks(); next.context.loadTimers(); next.context.addTask('Three'); next.context.createTimer(180, 'Three');
  assert.equal(new Set(next.context.activeTasks.map(item => item.id)).size, 3);
  assert.equal(new Set(next.context.activeTimers.map(item => item.id)).size, 3);
});

test('every checklist mutation preserves memory and durable records after a save failure', () => {
  const app = harness();
  app.context.addTask('Read', 'Friday');
  const id = app.context.activeTasks[0].id, before = JSON.stringify(app.context.activeTasks), stored = app.store.get('olanga_tasks');
  app.context.localStorage.setItem = () => { throw new Error('Storage full'); };
  for (const change of [() => app.context.addTask('New'), () => app.context.removeTask(id), () => app.context.clearAllTasks(), () => app.context.setTaskDue(id, 'Monday'), () => app.context.completeTask(id), () => app.context.toggleTaskComplete(id)]) {
    const result = change(); assert.equal(result.ok, false); assert.match(result.message, /Nothing was changed/);
    assert.equal(JSON.stringify(app.context.activeTasks), before); assert.equal(app.store.get('olanga_tasks'), stored);
  }
});

const sixAm = new Date(2020, 8, 26, 6, 0, 0).getTime();
const hours = value => value * 3600000;
// Values created inside the vm context have their own prototypes.
const plain = value => JSON.parse(JSON.stringify(value));

test('alarm times resolve to the next matching moment without guessing a past time', () => {
  const { context } = harness(new Map(), sixAm);
  for (const [spec, offset] of [['7:00 AM', hours(1)], ['5:00 AM', hours(23)], ['7:00', hours(1)], ['5:00', hours(11)], ['12:00', hours(6)], ['12:00 AM', hours(18)], ['7:00 AM tomorrow', hours(25)], ['5:30 pm', hours(11.5)]]) {
    assert.equal(context.nextAlarmTime(spec, sixAm), sixAm + offset, spec);
  }
  for (const spec of ['13:00', '0:30 AM', '7', '7:60 PM', 'tomorrow', '', null]) assert.equal(context.nextAlarmTime(spec, sixAm), null, String(spec));
});

test('reminders and alarms persist their kind while plain timers keep the original stored shape', () => {
  const first = harness(new Map(), sixAm);
  assert.match(first.context.createReminder(600, 'call mom').message, /remind you in 10 minutes: call mom/);
  assert.match(first.context.createAlarm('7:00 AM', 'Alarm').message, /Alarm set for 7:00 AM today/);
  assert.match(first.context.createAlarm('5:00 AM', 'take vitamins').message, /remind you at 5:00 AM tomorrow: take vitamins/);
  first.context.createTimer(60, 'Tea');
  const stored = JSON.parse(first.store.get('olanga_timers'));
  assert.deepEqual(stored.map(item => item.kind ?? 'timer'), ['reminder', 'alarm', 'alarm', 'timer']);
  assert.deepEqual(Object.keys(stored[3]).sort(), ['endTime', 'id', 'label']);
  const reopened = harness(first.store, sixAm + 1000);
  reopened.context.loadTimers();
  assert.deepEqual(plain(reopened.context.activeTimers.map(timer => [timer.kind, timer.endTime - sixAm])), [['reminder', 600000], ['alarm', hours(1)], ['alarm', hours(23)], ['timer', 60000]]);
  for (const [seconds, text] of [[0, 'x'], [86401, 'x'], [1.5, 'x'], ['60', 'x'], [60, ''], [60, 'x'.repeat(121)]]) assert.equal(first.context.createReminder(seconds, text).ok, false);
  assert.equal(first.context.createAlarm('25:00', 'Alarm').ok, false);
});

test('a due reminder speaks once while idle, then rings, and notifies outside the window', async () => {
  const app = harness(new Map(), sixAm);
  const spoken = [], notices = [];
  let finishSpeech;
  Object.assign(app.context, { State: { IDLE: 'idle' }, currentState: 'idle', isTtsMuted: false, speakResponse: text => { spoken.push(text); return new Promise(resolve => { finishSpeech = resolve; }); } });
  app.context.window.electronAPI = { notify: notice => notices.push(notice) };
  app.context.createReminder(60, 'call mom');
  app.advance(60000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(spoken, ['Reminder: call mom.']);
  assert.deepEqual(plain(notices), [{ title: 'Reminder', body: 'call mom' }]);
  assert.equal(app.alarms, 0, 'The alarm waits until the reminder has been spoken');
  finishSpeech(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.alarms, 1);
  app.context.currentState = 'thinking';
  app.context.createAlarm('7:00 AM', 'Alarm');
  app.advance(hours(1));
  assert.equal(spoken.length, 1, 'A busy assistant is never interrupted by a spoken alarm');
  assert.deepEqual(plain(notices.at(-1)), { title: 'Alarm', body: "It's 7:00 AM." });
});

test('restored reminders ring without speaking and a dismissed reminder never starts its alarm late', async () => {
  const first = harness(new Map(), sixAm);
  first.context.createReminder(60, 'stretch');
  const reopened = harness(first.store, sixAm + hours(1));
  const spoken = [], notices = [];
  Object.assign(reopened.context, { State: { IDLE: 'idle' }, currentState: 'idle', speakResponse: text => { spoken.push(text); } });
  reopened.context.window.electronAPI = { notify: notice => notices.push(notice) };
  reopened.context.loadTimers();
  assert.deepEqual(spoken, []);
  assert.equal(reopened.alarms, 1);
  assert.match(notices[0].body, /stretch \(due while Olanga was closed\)/);
  const live = harness(new Map(), sixAm);
  let finishSpeech;
  Object.assign(live.context, { State: { IDLE: 'idle' }, currentState: 'idle', speakResponse: () => new Promise(resolve => { finishSpeech = resolve; }) });
  live.context.createReminder(1, 'stretch');
  live.advance(1000);
  assert.equal(live.context.stopTimers().ok, true);
  finishSpeech(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(live.alarms, 0);
});

test('stopping alarms dismisses only ringing records, cancels a single record, and asks when unclear', () => {
  const app = harness(new Map(), sixAm);
  assert.match(app.context.stopTimers().message, /no active timers/);
  app.context.createTimer(60, 'Tea');
  assert.match(app.context.stopTimers().message, /Tea cancelled/);
  app.context.createTimer(1, 'Tea'); app.context.createAlarm('7:00 AM', 'Alarm'); app.context.createReminder(600, 'call mom');
  app.advance(1000);
  const dismissed = app.context.stopTimers();
  assert.equal(dismissed.ok, true); assert.match(dismissed.message, /Tea timer dismissed/);
  assert.deepEqual(plain(app.context.activeTimers.map(timer => timer.label)), ['Alarm', 'call mom']);
  const unclear = app.context.stopTimers();
  assert.equal(unclear.clarification, true); assert.match(unclear.message, /Alarm at 7:00 AM; call mom with/);
  assert.equal(app.context.activeTimers.length, 2);
  const match = app.context.findTimerForChange('the call mom one');
  assert.equal(match.timer.label, 'call mom');
  assert.equal(app.context.cancelTimerByLabel(match.timer.id).ok, true);
  assert.deepEqual(plain(app.context.activeTimers.map(timer => timer.label)), ['Alarm']);
  assert.equal(app.context.findTimerForChange('laundry').ok, false);
});

test('alarm contexts are released on completion, resume rejection, and audio setup failure', async () => {
  for (const mode of ['end', 'resume-failure', 'setup-failure']) {
    let closed = 0, disconnected = 0, oscillator;
    const app = harness();
    vm.runInContext(source.slice(source.indexOf('function playAlarmSound()'), source.indexOf('function playAlarmSoundLoop()')), app.context);
    app.context.window.AudioContext = class {
      state = mode === 'resume-failure' ? 'suspended' : 'running';
      currentTime = 0;
      resume() { return Promise.reject(new Error('Device unavailable')); }
      createOscillator() {
        oscillator = { frequency: { setValueAtTime() {} }, connect() {}, disconnect() { disconnected++; }, start() {}, stop() {} };
        return oscillator;
      }
      createGain() {
        if (mode === 'setup-failure') throw new Error('Device unavailable');
        return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() { disconnected++; } };
      }
      close() { closed++; this.state = 'closed'; return Promise.resolve(); }
    };
    app.context.playAlarmSound();
    if (mode === 'end') { oscillator.onended(); oscillator.onended(); }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, 1, mode);
    assert.equal(disconnected, mode === 'setup-failure' ? 1 : 2, mode);
  }
});

test('a hung audio resume cannot accumulate contexts and dismissal closes pending audio', () => {
  let created = 0, closed = 0, watchdog;
  const app = harness();
  vm.runInContext(source.slice(source.indexOf('function playAlarmSound()'), source.indexOf('function playAlarmSoundLoop()')), app.context);
  app.context.setTimeout = fn => { watchdog = fn; return 1; };
  app.context.clearTimeout = () => {};
  app.context.window.AudioContext = class {
    state = 'suspended'; currentTime = 0;
    constructor() { created++; }
    resume() { return new Promise(() => {}); }
    createOscillator() { return { frequency: { setValueAtTime() {} }, connect() {}, disconnect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    close() { closed++; this.state = 'closed'; return Promise.resolve(); }
  };
  app.context.createTimer(1, 'Tea');
  for (let i = 0; i < 6; i++) app.advance(2000);
  assert.equal(created, 1);
  watchdog();
  assert.equal(closed, 1);
  app.advance(2000);
  assert.equal(created, 2);
  app.context.cancelTimerByLabel('Tea');
  assert.equal(closed, 2);
  assert.equal(app.intervals.size, 0);
});
