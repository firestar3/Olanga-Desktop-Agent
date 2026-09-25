const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQuickActions, getQuickAction, DEFAULT_QUICK_ACTIONS, LABEL_MAX_LENGTH, PROMPT_MAX_LENGTH } = require('../../shared/quick-actions');

test('quick actions always have five fixed slot identities with safe defaults', () => {
  for (const value of [undefined, null, {}, 'bad', [], [null, 3, false, [], {}]]) {
    const slots = normalizeQuickActions(value);
    assert.deepEqual(slots, DEFAULT_QUICK_ACTIONS);
    assert.equal(slots.length, 5);
  }
  const input = Array.from({ length: 8 }, () => ({ id: 'open-app', label: '  My action  ', prompt: '  Do this  ', command: 'evil' }));
  const result = normalizeQuickActions(input);
  assert.equal(result.length, 5);
  assert.deepEqual(result[0], { id: 'slot-1', label: 'My action', prompt: 'Do this' });
  assert.equal(result[4].id, 'slot-5');
  result[1].label = 'Changed';
  assert.notEqual(DEFAULT_QUICK_ACTIONS[1].label, 'Changed');
});

test('quick action text is bounded, preserves unicode, and empty values fall back', () => {
  const slots = normalizeQuickActions([
    { label: '🚀'.repeat(100), prompt: '🚀'.repeat(3000) },
    { label: ' \t \n ', prompt: '\u0000' },
    { label: 'Fix\n this\u0000 now', prompt: 'A\nB\u0007' }
  ]);
  assert.equal(Array.from(slots[0].label).length, LABEL_MAX_LENGTH);
  assert.equal(Array.from(slots[0].prompt).length, PROMPT_MAX_LENGTH);
  assert.equal(slots[1].label, DEFAULT_QUICK_ACTIONS[1].label);
  assert.equal(slots[1].prompt, DEFAULT_QUICK_ACTIONS[1].prompt);
  assert.equal(slots[2].label, 'Fix this now');
  assert.equal(slots[2].prompt, 'A\nB');
});

test('quick action lookup cannot execute arbitrary identifiers', () => {
  for (const id of [undefined, '__proto__', 'open-app', 'slot-0', 'slot-6', { id: 'slot-1' }]) assert.equal(getQuickAction([], id), null);
  assert.equal(getQuickAction([{ label: 'Saved action', prompt: 'Saved prompt' }], 'slot-1').prompt, 'Saved prompt');
});
