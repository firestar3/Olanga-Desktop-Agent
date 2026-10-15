const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const schedules = require('../../shared/schedules');

function fixture() {
  const fields = new Map(), buttons = [], all = [], intervals = [], activeIntervals = new Set(), notifications = [], providers = [], storage = new Map();
  let clock = new Date(2026, 8, 29, 8, 0).getTime();
  const node = (tag, text) => {
    const value = { tag, textContent: text || '', children: [], value: '', checked: false, hidden: false, attributes: {}, listeners: {}, append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); if (this.tag === 'select' && !this.value) this.value = child.value; } }, replaceChildren(...children) { this.children = []; this.append(...children); }, setAttribute(key, val) { this.attributes[key] = val; }, addEventListener(event, fn) { this.listeners[event] = fn; } };
    all.push(value); return value;
  };
  const section = node('section');
  const button = (label, action) => { const value = node('button', label); value.click = action; buttons.push(value); return value; };
  const field = (parent, label, type) => { const wrapper = node('label', label), input = node('input'); input.type = type; wrapper.append(input); parent.append(wrapper); fields.set(label, input); return input; };
  const context = vm.createContext({
    console, Date, setInterval: callback => { intervals.push(callback); const id = intervals.length; activeIntervals.add(id); return id; }, clearInterval(id) { activeIntervals.delete(id); },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    OlangaSchedules: { ...schedules, createStore: source => schedules.createStore(source, { now: () => clock, zone: () => 'test' }) },
    OlangaBriefing: { compose: () => 'Your checklist is clear.' },
    buildDailyBriefing: async () => { providers.push('online'); return { message: 'Online briefing' }; },
    document: { hidden: false, createTextNode: text => node('#text', text), addEventListener() {} },
    window: { addEventListener() {}, electronAPI: { notify: value => notifications.push(value) }, OlangaWorkbench: { addPage(id, label, build) { assert.equal(id, 'schedules'); build({ section, node, button, field, actions: (parent, ...items) => parent.append(...items), detail: (parent, text) => parent.append(node('p', text)), showMessage() {} }); } } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/schedules.js'), 'utf8'), context);
  const control = label => all.find(item => item.attributes['aria-label'] === label);
  return { context, fields, buttons, intervals, activeIntervals, notifications, providers, control, clock: () => clock, setTime: value => { clock = value; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('opening schedule tools performs no provider, notification, or schedule creation', async () => {
  const f = fixture(); await tick(); assert.equal(f.context.window.OlangaScheduleStore.snapshot().items.length, 0);
  assert.deepEqual(f.notifications, []); assert.deepEqual(f.providers, []); assert.equal(f.intervals.length, 0);
  assert.equal(f.fields.get('Date and time').parentElement.hidden, false); assert.equal(f.fields.get('Time').parentElement.hidden, true);
});

test('a user-created local briefing notifies once and its controls disable future work', async () => {
  const f = fixture(); await tick(); f.fields.get('Reminder or briefing title').value = 'Morning';
  f.control('Type').value = 'briefing'; f.control('Type').listeners.change(); f.control('Repeat').value = 'daily'; f.control('Repeat').listeners.change();
  assert.equal(f.fields.get('Date and time').parentElement.hidden, true); assert.equal(f.fields.get('Time').parentElement.hidden, false);
  f.buttons.find(item => item.textContent === 'Save schedule').click();
  assert.equal(f.activeIntervals.size, 1);
  const item = f.context.window.OlangaScheduleStore.snapshot().items[0]; assert.equal(item.online, false);
  f.setTime(new Date(2026, 8, 29, 9, 0).getTime()); await f.intervals[0]();
  assert.equal(f.notifications.length, 1); assert.equal(f.notifications[0].body, 'Your checklist is clear.'); assert.equal(f.providers.length, 0);
  f.buttons.filter(item => item.textContent === 'Disable').at(-1).click(); f.setTime(new Date(2026, 8, 30, 9, 0).getTime()); await f.intervals[0]();
  assert.equal(f.notifications.length, 1);
  assert.equal(f.activeIntervals.size, 0);
});

test('imported past schedules remain disabled across polling and explicit enable rejects expired one-time reminders', async () => {
  const f = fixture(); await tick(); const adapter = f.context.window.OlangaSchedulesAdapter;
  await adapter.suspend(); adapter.replacePaused([{ kind: 'reminder', title: 'Imported past', repeat: 'once', onceAt: f.clock() - 60000, online: false }, { kind: 'briefing', title: 'Imported daily', repeat: 'daily', time: '09:00', online: true }]); adapter.resumePolling();
  assert.equal(f.activeIntervals.size, 0); assert.equal(f.context.window.OlangaScheduleStore.snapshot().items.every(item => !item.enabled && item.nextAt === null), true);
  f.setTime(new Date(2026, 8, 30, 9, 0).getTime()); for (const poll of f.intervals) await poll();
  assert.deepEqual(f.notifications, []); assert.deepEqual(f.providers, []);
  const items = f.context.window.OlangaScheduleStore.snapshot().items;
  assert.throws(() => f.context.window.OlangaScheduleStore.enable(items[0].id, true), /passed/);
  f.context.window.OlangaScheduleStore.enable(items[1].id, true); assert.equal(f.activeIntervals.size, 1); assert.equal(f.context.window.OlangaScheduleStore.snapshot().items[1].enabled, true);
});
