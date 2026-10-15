const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Bundles = require('../../shared/workspaces');
function fixture(initial) {
  const memory = new Map(initial ? [[Bundles.KEY, JSON.stringify(initial)]] : []), controls = [], fields = new Map(), close = [], messages = [], calls = [], all = [];
  const state = { layouts: [{ id: 'layout', name: 'Coursework windows' }], projects: [{ id: 'project', name: 'Coursework' }], companions: [{ id: 'tabs', name: 'Research tabs', kind: 'browser' }], routines: [{ id: 'routine', name: 'Focus' }], windowResult: { ok: true, verified: true, message: 'Windows restored.' } };
  function node(tag, text = '') {
    const value = { tag, textContent: text, value: '', children: [], hidden: false, checked: false, disabled: false, listeners: {}, attributes: {},
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      get firstElementChild() { return this.children[0]; },
      setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(type, action) { this.listeners[type] = action; }, focus() {},
    }; all.push(value); return value;
  }
  const section = node('section');
  const helpers = { section, node, field(parent, label) { const input = node('input'); fields.set(label, input); parent.append(input); return input; },
    button(label, action) { const value = node('button', label); value.click = action; controls.push(value); return value; },
    actions(parent, ...children) { parent.append(...children); }, detail(parent, value) { parent.append(node('p', value)); }, showMessage(value) { messages.push(value); } };
  const window = { OlangaWorkspaceBundles: Bundles, openOlangaWorkbench() {}, OlangaWorkbench: { addPage(id, label, build) { build(helpers); }, onClose(action) { close.push(action); }, async selectProject(id) { calls.push(`project:${id}`); return { ok: true, verified: true, message: 'Project selected.' }; } },
    electronAPI: {
      async workSessionList() { if (state.list) return state.list(); return { ok: true, sessions: state.layouts }; }, async projectList() { return state.projects; },
      async workSessionPreview(id) { calls.push(`preview:${id}`); if (state.preview) return state.preview(); return { ok: true, previewId: 'preview', steps: [{ appName: 'Editor', status: 'existing', message: 'Restore verified window.' }] }; },
      async workSessionRestore(id) { calls.push(`windows:${id}`); if (state.restore) return state.restore(); return state.windowResult; },
      async workSessionCancel() { calls.push('cancel-windows'); }, async companionCancel() { calls.push('cancel-companions'); }
    },
    OlangaCompanionSessions: { list: () => state.companions, async preview(id) { calls.push(`companion-preview:${id}`); return { id, targets: ['https://example.com'], message: 'Confirm in companion.' }; }, async restore(value) { calls.push(`companion:${value.id}`); return { ok: true, verified: true, message: 'Tabs verified.' }; } },
    OlangaWorkspaceRoutines: { list: () => state.routines, async review(id) { calls.push(`routine-review:${id}`); return { ok: true, status: 'awaiting-review', message: 'Routine still needs review.' }; } }
  };
  const context = vm.createContext({ window, document: { getElementById: () => null }, localStorage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) }, Date, JSON, console, AbortController, Promise, crypto: { randomUUID } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/workspaces.js'), 'utf8'), context);
  function contains(parent, target) { return parent === target || parent.children.some(child => contains(child, target)); }
  return { memory, fields, state, calls, close, messages, api: window.OlangaWorkspaces, controls: label => controls.filter(value => value.textContent === label && contains(section, value)), checks: () => all.filter(value => value.tag === 'input' && value.type === 'checkbox' && contains(section, value)) };
}
async function create(f, selections = ['include window layout Coursework windows', 'include project Coursework', 'include routine Focus']) {
  await f.api.save('Coursework'); for (const phrase of selections) assert.equal((await f.api.answerReview(phrase)).ok, true); return f.api.answerReview('save workspace');
}
test('opening named workspace tools never reads sources, starts services or dispatches actions', () => {
  const f = fixture(); assert.deepEqual(f.calls, []); assert.equal(f.api.hasReview(), false); assert.equal(f.api.list().length, 0);
});
test('voice names and exact component selection create a setup without typing or effects', async () => {
  const f = fixture(); await create(f); assert.equal(f.api.list()[0].name, 'Coursework'); assert.equal(f.api.list()[0].components.length, 3); assert.deepEqual(f.calls, []); assert.equal(f.api.hasReview(), false);
  await assert.rejects(f.api.save('x'.repeat(81)), /name/);
});
test('an unknown voice component and unrelated confirmation cannot save or execute a setup', async () => {
  const f = fixture(); await f.api.save('Coursework'); assert.equal((await f.api.answerReview('include project unknown')).ok, false); assert.equal((await f.api.answerReview('yes')).handled, false);
  await assert.rejects(f.api.answerReview('save workspace'), /at least one/); assert.equal(f.api.list().length, 0); assert.deepEqual(f.calls, []);
});
test('resume freshly previews components and waits for exact confirmation, preserving routine review', async () => {
  const f = fixture(); await create(f); await f.api.review('Coursework'); assert.equal(f.api.hasReview(), true); assert.deepEqual(f.calls, ['preview:layout']);
  const outcome = await f.api.answerReview('resume workspace'); assert.equal(outcome.status, 'awaiting-review');
  assert.deepEqual(f.calls, ['preview:layout', 'windows:preview', 'project:project', 'routine-review:routine']);
  assert.deepEqual(Array.from(f.api.snapshot().runs[0].steps, step => step.state), ['completed', 'completed', 'awaiting-review']);
  await f.controls('Review unfinished workspace steps')[0].click(); assert.deepEqual(f.checks().map(input => [input.checked, input.disabled]), [[false, true], [false, true], [false, false]]);
  await assert.rejects(f.api.answerReview('resume workspace'), /Select at least one/);
});
test('removed components are blocked after preview and cannot dispatch against a replacement', async () => {
  const f = fixture(); await create(f, ['include project Coursework']); await f.api.review('Coursework'); f.state.projects = [];
  const result = await f.api.answerReview('resume workspace'); assert.equal(result.status, 'partial'); assert.deepEqual(f.calls, []); assert.equal(f.api.snapshot().runs[0].steps[0].state, 'blocked');
});
test('failed and uncertain workspace effects are never automatically checked during recovery', async () => {
  const f = fixture(); await create(f, ['include window layout Coursework windows']); f.state.windowResult = { ok: false, message: 'Window disappeared.' };
  await f.api.review('Coursework'); await f.api.answerReview('resume workspace'); await f.controls('Review unfinished workspace steps')[0].click();
  assert.equal(f.checks()[0].checked, false); await assert.rejects(f.api.answerReview('resume workspace'), /Select at least one/); assert.equal(f.calls.filter(value => value.startsWith('windows:')).length, 1);
});
test('closing tools invalidates a late preview and exact spoken confirmation cannot revive it', async () => {
  const f = fixture(); await create(f, ['include window layout Coursework windows']); let release;
  f.state.preview = () => new Promise(resolve => { release = resolve; }); const reviewing = f.api.review('Coursework');
  for (let index = 0; index < 10 && !release; index++) await Promise.resolve(); assert.equal(typeof release, 'function');
  for (const cleanup of f.close) cleanup(); release({ ok: true, previewId: 'late', steps: [{ status: 'existing' }] }); await reviewing;
  assert.equal(f.api.hasReview(), false); assert.equal((await f.api.answerReview('resume workspace')).handled, false); assert.equal(f.calls.filter(value => value.startsWith('windows:')).length, 0);
});
test('cancelling an in-progress restore preserves its verified receipt and cancels remaining steps', async () => {
  const f = fixture(); await create(f, ['include window layout Coursework windows', 'include project Coursework']); await f.api.review('Coursework'); let release;
  f.state.restore = () => new Promise(resolve => { release = resolve; }); const running = f.api.answerReview('resume workspace');
  for (let index = 0; index < 10 && !release; index++) await Promise.resolve(); assert.equal(typeof release, 'function');
  await f.api.cancel(); release({ ok: true, verified: true, message: 'Restored before cancellation.' }); await running;
  assert.equal(f.calls.includes('project:project'), false); assert.deepEqual(Array.from(f.api.snapshot().runs[0].steps, step => step.state), ['completed', 'cancelled']);
});

test('window bundle completion uses the production per-window receipts and shows partial outcomes honestly', async () => {
  const f = fixture(); await create(f, ['include window layout Coursework windows']);
  f.state.windowResult = { ok: true, status: 'completed', receipts: [{ ok: true, verified: true, appName: 'Editor', message: 'Restored exact window.' }] };
  await f.api.review('Coursework'); let result = await f.api.answerReview('resume workspace'); assert.equal(result.run.steps[0].state, 'completed'); assert.match(result.run.steps[0].message, /Editor: Restored exact window/);
  f.state.windowResult = { ok: false, status: 'partial', receipts: [{ ok: true, verified: true, appName: 'Editor', message: 'Restored exact window.' }, { ok: false, appName: 'Browser', message: 'Window disappeared.' }] };
  await f.api.review('Coursework'); result = await f.api.answerReview('resume workspace'); assert.equal(result.run.steps[0].state, 'uncertain'); assert.match(result.run.steps[0].message, /Browser: Window disappeared/);
});

test('cancelling a delayed save validation prevents a late persistent workspace write', async () => {
  const f = fixture(); await f.api.save('Coursework'); await f.api.answerReview('include project Coursework'); let release;
  f.state.list = () => new Promise(resolve => { release = resolve; }); const saving = f.api.answerReview('save workspace');
  for (let index = 0; index < 10 && !release; index++) await Promise.resolve(); assert.equal(typeof release, 'function');
  await f.api.cancel(); release({ ok: true, sessions: f.state.layouts }); await assert.rejects(saving, /cancelled or replaced/); assert.equal(f.api.list().length, 0);
});

test('voice can adjust scoped resume steps but cannot reselect an uncertain action', async () => {
  const f = fixture(); await create(f, ['include window layout Coursework windows', 'include project Coursework']); await f.api.review('Coursework');
  assert.equal((await f.api.answerReview('skip step 2')).ok, true); let result = await f.api.answerReview('resume workspace'); assert.deepEqual(Array.from(result.run.steps, step => step.state), ['completed', 'skipped']);
  f.state.windowResult = { ok: true, verified: false, message: 'Result unknown.' }; await f.api.review('Coursework'); result = await f.api.answerReview('resume workspace'); assert.equal(result.run.steps[0].state, 'uncertain');
  await f.controls('Review unfinished workspace steps')[0].click(); assert.equal((await f.api.answerReview('include step 1')).ok, false); assert.equal(f.checks()[0].checked, false); assert.equal((await f.api.answerReview('include step 2')).ok, false);
});
