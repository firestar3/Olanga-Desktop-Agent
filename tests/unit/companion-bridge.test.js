const test = require('node:test');
const assert = require('node:assert/strict');
const { createCompanionBridge, validateRequest } = require('../../desktop/companion-bridge');
const origin = 'chrome-extension://' + 'a'.repeat(32);
async function fixture(t, options = {}) {
  const bridge = createCompanionBridge(options); t.after(() => bridge.dispose());
  const ticket = await bridge.startPairing('browser'); assert.equal(ticket.ok, true, ticket.message);
  async function post(route, secret, data = {}, from = origin) {
    const response = await fetch(ticket.endpoint + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, ...(from ? { Origin: from } : { 'X-Olanga-Client': 'vscode' }) }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json(), cors: response.headers.get('access-control-allow-origin') };
  }
  const pair = () => post('/pair', ticket.code, { name: 'Test companion' });
  return { bridge, ticket, post, pair };
}
test('bridge remains inactive until explicit pairing and never exposes credentials in snapshots', async t => {
  const bridge = createCompanionBridge(); t.after(() => bridge.dispose());
  assert.equal(bridge.list().running, false);
  const ticket = await bridge.startPairing('vscode');
  assert.equal(ticket.ok, true); assert.equal(JSON.stringify(bridge.list()).includes(ticket.code), false);
});
test('ordinary websites cannot pair even with a code; browser token binds to exact extension origin', async t => {
  const { post, ticket, pair } = await fixture(t);
  assert.equal((await post('/pair', ticket.code, {}, 'https://untrusted.example')).status, 403);
  const paired = await pair(); assert.equal(paired.status, 200); assert.equal(paired.cors, origin);
  assert.equal((await post('/poll', paired.data.token, {}, 'chrome-extension://' + 'b'.repeat(32))).status, 403);
  assert.equal((await post('/poll', paired.data.token, {}, null)).status, 403);
  assert.equal((await pair()).status, 403);
});
test('paired client receives only its validated command and matching result completes the receipt', async t => {
  const { bridge, post, pair } = await fixture(t); const paired = (await pair()).data;
  const promise = bridge.request({ connectionId: paired.connectionId, operation: 'browser.focusTab', payload: { tabId: 7, url: 'https://example.com/' } });
  const poll = (await post('/poll', paired.token)).data;
  assert.equal(poll.command.operation, 'browser.focusTab');
  assert.equal((await post('/authorize', paired.token, { id: poll.command.id })).data.ok, true);
  assert.equal((await post('/result', paired.token, { id: 'wrong', result: { ok: true, message: 'Wrong' } })).status, 400);
  await post('/result', paired.token, { id: poll.command.id, result: { ok: true, verified: true, message: 'Selected tab active.' } });
  assert.equal((await promise).verified, true);
  assert.equal((await post('/result', paired.token, { id: poll.command.id, result: { ok: true, message: 'Replay' } })).status, 400);
});
test('navigation cancellation invalidates late approvals but preserves the connection', async t => {
  const { bridge, post, pair } = await fixture(t); const paired = (await pair()).data;
  const promise = bridge.request({ connectionId: paired.connectionId, operation: 'browser.listTabs' });
  const command = (await post('/poll', paired.token)).data.command;
  bridge.cancelAll(); assert.equal((await promise).ok, false);
  assert.equal((await post('/authorize', paired.token, { id: command.id })).status, 400);
  const polled = (await post('/poll', paired.token)).data;
  assert.ok(polled.cancelled.includes(command.id)); assert.equal(bridge.list().connections.length, 1);
});
test('busy extension heartbeats do not dispatch another command', async t => {
  const { bridge, post, pair } = await fixture(t); const paired = (await pair()).data;
  const promise = bridge.request({ connectionId: paired.connectionId, operation: 'browser.listTabs' });
  assert.equal((await post('/poll', paired.token, { busy: true })).data.command, null);
  bridge.cancelAll(); await promise;
});
test('expired pairing, timed-out requests, and disposal report explicit failures', async t => {
  let clock = 0; const { bridge, pair } = await fixture(t, { now: () => clock, requestTimeoutMs: 20 });
  clock = 300001; assert.equal((await pair()).status, 403);
  const second = await bridge.startPairing('vscode');
  const response = await fetch(second.endpoint + '/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Olanga-Client': 'vscode', Authorization: `Bearer ${second.code}` }, body: '{}' });
  const paired = await response.json();
  const result = await bridge.request({ connectionId: paired.connectionId, operation: 'vscode.listTasks' });
  assert.equal(result.ok, false); assert.match(result.message, /expired/);
  bridge.dispose(); assert.equal((await bridge.startPairing('browser')).ok, false);
});
test('shared Unicode text stays intact, snapshots are independent, and disconnect clears its inbox', async t => {
  const { bridge, post, pair } = await fixture(t); const paired = (await pair()).data;
  await post('/publish', paired.token, { kind: 'selection', title: '選択した文章', text: '🌟 café — 日本語', url: 'https://example.com' });
  const snapshot = bridge.list(); assert.equal(snapshot.inbox[0].text, '🌟 café — 日本語');
  assert.equal(JSON.stringify(snapshot).includes(paired.token), false);
  snapshot.inbox[0].text = 'Changed externally'; assert.notEqual(bridge.list().inbox[0].text, snapshot.inbox[0].text);
  bridge.disconnect(paired.connectionId); assert.equal(bridge.list().inbox.length, 0);
});
test('operation validation cannot carry executable URLs, shell commands, arbitrary document schemes or forged cross-kind actions', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/test', 'https://user:pass@example.com/']) assert.throws(() => validateRequest('browser', 'browser.focusTab', { tabId: 1, url }));
  assert.throws(() => validateRequest('browser', 'vscode.runTask', { taskId: 'task' }));
  assert.throws(() => validateRequest('vscode', 'vscode.runTask', { command: 'powershell.exe' }));
  assert.throws(() => validateRequest('vscode', 'vscode.resumeDocuments', { uris: ['vscode://extension.command'] }));
});
test('disposing during asynchronous server startup closes the listener and rejects pairing', async () => {
  const bridge = createCompanionBridge(); const pairing = bridge.startPairing('browser'); bridge.dispose();
  assert.equal((await pairing).ok, false); assert.equal(bridge.list().running, false);
});
