const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePlan, supportedWindow, HOTKEYS, REGION_HOTKEYS, describeStep } = require('../../shared/action-plan');

const windowA = { handle: '100', processId: 123, processName: 'notepad', title: 'Notes' };
const windowB = { handle: '200', processId: 456, processName: 'idea64', title: 'Editor' };
const capture = { captureId: 'capture-1', foreground: windowA, windows: [windowA, windowB] };
const makePlan = steps => ({ captureId: capture.captureId, summary: 'Edit the selected document', scope: { mode: 'window', handle: windowA.handle }, steps });

test('validates a bounded plan into an immutable independent copy', () => {
  const input = makePlan([{ type: 'hotkey', keys: ['CTRL', 'A'] }, { type: 'type', text: 'Hello world' }, { type: 'click', x: 0.4, y: 0.3 }]);
  const result = validatePlan(input, capture);
  input.steps[0].keys[0] = 'WIN';
  input.steps[1].text = 'Changed';
  assert.deepEqual(result.steps[0].keys, ['CTRL', 'A']);
  assert.equal(result.steps[1].text, 'Hello world');
  assert.equal(result.steps[2].button, 'left');
  assert.ok(Object.isFrozen(result.steps) && Object.isFrozen(result.steps[0].keys) && Object.isFrozen(result.scope));
});

test('rejects command actions, unknown fields and unexpected action objects', () => {
  for (const step of [{ type: 'exec', command: 'calc' }, { type: 'type', text: 'hello', shell: true }, null, []]) assert.throws(() => validatePlan(makePlan([step]), capture));
  assert.throws(() => validatePlan({ ...makePlan([{ type: 'wait', ms: 200 }]), command: 'calc' }, capture));
});

test('requires the matching captured screen and an observed scope', () => {
  assert.throws(() => validatePlan({ ...makePlan([{ type: 'wait', ms: 200 }]), captureId: 'another' }, capture), /expired/);
  assert.throws(() => validatePlan({ ...makePlan([{ type: 'wait', ms: 200 }]), scope: { mode: 'window', handle: '999' } }, capture), /supported observed/);
});

test('rejects invalid coordinates, counts, delays, and oversized plans', () => {
  for (const x of [NaN, Infinity, -0.1, 1.1, '0.5']) assert.throws(() => validatePlan(makePlan([{ type: 'click', x, y: 0.5 }]), capture));
  for (const count of [0, 3, 1.5]) assert.throws(() => validatePlan(makePlan([{ type: 'click', x: 0.5, y: 0.5, count }]), capture));
  assert.throws(() => validatePlan(makePlan(Array(13).fill({ type: 'wait', ms: 100 })), capture), /1–12/);
  assert.throws(() => validatePlan(makePlan(Array(5).fill({ type: 'wait', ms: 2000 })), capture), /8 seconds/);
  assert.throws(() => validatePlan(makePlan([{ type: 'wait', ms: 2001 }]), capture));
  assert.throws(() => validatePlan(makePlan([{ type: 'scroll', amount: 0 }]), capture));
});

test('enforces total typed text budget without rejecting code for an editor', () => {
  assert.throws(() => validatePlan(makePlan([{ type: 'type', text: 'a'.repeat(1500) }, { type: 'type', text: 'b'.repeat(501) }]), capture), /2,000/);
  const code = 'function hello() {\n  return "hello";\n}';
  assert.equal(validatePlan(makePlan([{ type: 'type', text: code }]), capture).steps[0].text, code);
  assert.throws(() => validatePlan(makePlan([{ type: 'type', text: 'hidden\u0000data' }]), capture));
});

test('permits only explicit keyboard combinations and reserves Escape for stopping', () => {
  for (const keys of [['WIN', 'R'], ['CTRL', 'ALT', 'DELETE'], ['ALT', 'F4'], ['ESC'], ['ESCAPE'], ['CTRL', 'C', 'ENTER'], ['ctrl', 'A']]) assert.throws(() => validatePlan(makePlan([{ type: 'hotkey', keys }]), capture), /shortcut/);
  for (const keys of HOTKEYS) assert.doesNotThrow(() => validatePlan(makePlan([{ type: 'hotkey', keys: [...keys] }]), capture));
});

test('known terminal and privileged targets are unavailable', () => {
  for (const processName of ['cmd', 'PowerShell', 'pwsh.exe', 'WindowsTerminal', 'conhost', 'regedit']) assert.equal(supportedWindow({ ...windowA, processName }), false);
  assert.equal(supportedWindow({ ...windowA, title: 'Run' }), false);
  assert.equal(supportedWindow(windowB), true);
});

test('a new target needs a separate scope and approved plan', () => {
  assert.throws(() => validatePlan(makePlan([{ type: 'focus', handle: windowB.handle }]), capture), /new capture/);
  assert.doesNotThrow(() => validatePlan(makePlan([{ type: 'focus', handle: windowA.handle }]), capture));
  const hiddenTargetPlan = { ...makePlan([{ type: 'type', text: 'Unseen edit' }]), scope: { mode: 'window', handle: windowB.handle } };
  assert.throws(() => validatePlan(hiddenTargetPlan, capture), /focus-only/);
  assert.doesNotThrow(() => validatePlan({ ...hiddenTargetPlan, steps: [{ type: 'focus', handle: windowB.handle }] }, capture));
});

test('region restricts coordinates and shortcuts; a model cannot expand it through steps', () => {
  const plan = makePlan([{ type: 'click', x: 0.4, y: 0.4 }]);
  plan.scope = { mode: 'region', handle: '100', region: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 } };
  assert.doesNotThrow(() => validatePlan(plan, capture));
  assert.throws(() => validatePlan({ ...plan, steps: [{ type: 'click', x: 0.1, y: 0.4 }] }, capture), /outside/);
  assert.throws(() => validatePlan({ ...plan, steps: [{ type: 'click', x: 0.4, y: 0.4, button: 'right' }] }, capture), /Context menus/);
  for (const keys of [['TAB'], ['CTRL', 'L'], ['F6'], ['CTRL', 'S']]) assert.throws(() => validatePlan({ ...plan, steps: [{ type: 'hotkey', keys }] }, capture), /leave/);
  for (const keys of REGION_HOTKEYS) assert.doesNotThrow(() => validatePlan({ ...plan, steps: [{ type: 'hotkey', keys: [...keys] }] }, capture));
  assert.throws(() => validatePlan({ ...plan, scope: { ...plan.scope, region: { x: 0.9, y: 0.2, width: 0.5, height: 0.5 } } }, capture), /region/);
});

test('review text contains the exact typed text and window identity', () => {
  assert.equal(describeStep({ type: 'type', text: 'Line 1\nLine 2' }), 'Type exactly: "Line 1\\nLine 2"');
  assert.match(describeStep({ type: 'focus', handle: '100' }, capture.windows), /Notes \(notepad, window 100\)/);
});
