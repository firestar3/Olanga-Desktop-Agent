const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createPhoneDispatch } = require('../../desktop/phone-dispatch');
function fixture() {
  const sent = []; let current, destroyed = false;
  const window = { isDestroyed: () => destroyed, webContents: { send: (...args) => sent.push(args) } }; current = window;
  const dispatch = createPhoneDispatch({ getWindow: () => current });
  return { dispatch, sent, window, replace: () => { current = { ...window }; }, destroy: () => { destroyed = true; } };
}
const payload = (controller = new AbortController()) => ({ requestId: randomUUID(), text: 'open Spotify', command: '[OPEN_APP: Spotify]', signal: controller.signal });
const result = { ok: true, verified: true, message: 'Spotify is open.' };

test('phone handoff must be claimed once before a validated receipt can settle it', async () => {
  const { dispatch, sent } = fixture(), input = payload(); const pending = dispatch.execute(input);
  assert.deepEqual(sent[0], ['phone-command', { requestId: input.requestId, text: input.text, command: input.command }]);
  assert.equal(dispatch.complete({ requestId: input.requestId, result }), false);
  assert.equal(dispatch.claim(input.requestId), true); assert.equal(dispatch.claim(input.requestId), false);
  for (const invalid of [{ ...result, verified: 'yes' }, { ...result, ok: 1 }, { ...result, message: '' }, { ...result, message: 'x'.repeat(2001) }]) assert.equal(dispatch.complete({ requestId: input.requestId, result: invalid }), false);
  assert.equal(dispatch.complete({ requestId: input.requestId, result }), true); assert.deepEqual(await pending, result);
  assert.equal(dispatch.complete({ requestId: input.requestId, result }), false);
});

test('duplicate handoffs cannot resend either a pending or completed request identifier', async () => {
  const { dispatch, sent } = fixture(), input = payload(); const pending = dispatch.execute(input);
  assert.equal((await dispatch.execute(input)).ok, false); assert.equal(sent.length, 1);
  dispatch.claim(input.requestId); dispatch.complete({ requestId: input.requestId, result }); await pending;
  assert.equal((await dispatch.execute(input)).ok, false); assert.equal(sent.length, 1);
});

test('abort before claim prevents execution and abort after claim ignores late success', async () => {
  for (const claimed of [false, true]) {
    const { dispatch, sent } = fixture(), controller = new AbortController(), input = payload(controller); const pending = dispatch.execute(input);
    if (claimed) dispatch.claim(input.requestId); controller.abort();
    assert.equal((await pending).ok, false); assert.equal(dispatch.claim(input.requestId), false);
    assert.equal(dispatch.complete({ requestId: input.requestId, result }), false); assert.deepEqual(sent.at(-1), ['phone-command-cancel', input.requestId]);
  }
});

test('changed or destroyed renderer cannot claim or complete an old handoff', async () => {
  for (const stage of ['claim', 'complete']) for (const change of ['replace', 'destroy']) {
    const f = fixture(), input = payload(); const pending = f.dispatch.execute(input);
    if (stage === 'complete') f.dispatch.claim(input.requestId); f[change]();
    assert.equal(stage === 'claim' ? f.dispatch.claim(input.requestId) : f.dispatch.complete({ requestId: input.requestId, result }), false);
    assert.equal((await pending).ok, false);
  }
});

test('invalid commands, unavailable windows and cancelled input do not reach renderer', async () => {
  const f = fixture();
  for (const input of [null, { ...payload(), text: 'open Spotify', command: '[OPEN_APP: powershell]' }, { ...payload(), text: 'open Spotify and set volume to 30' }, { ...payload(), requestId: 'invalid' }]) assert.equal((await f.dispatch.execute(input)).ok, false);
  const aborted = new AbortController(); aborted.abort(); assert.equal((await f.dispatch.execute(payload(aborted))).ok, false);
  f.destroy(); assert.equal((await f.dispatch.execute(payload())).ok, false); assert.equal(f.sent.length, 0);
});

test('renderer send failure and cancellation settle without hanging or accepting late receipts', async () => {
  const f = fixture(); f.window.webContents.send = () => { throw new Error('IPC closed'); };
  assert.equal((await f.dispatch.execute(payload())).ok, false);
  const second = fixture(), input = payload(); const pending = second.dispatch.execute(input); second.dispatch.claim(input.requestId); second.dispatch.cancelAll();
  assert.equal((await pending).ok, false); assert.equal(second.dispatch.complete({ requestId: input.requestId, result }), false);
});
