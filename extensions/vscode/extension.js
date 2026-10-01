const vscode = require('vscode');
const http = require('node:http');
const { createVscodeAdapter, endpoint } = require('./core');
function activate(context) {
  let connection = null, timer = null, polling = false, running = false, activeCommandId = null;
  const adapter = createVscodeAdapter(vscode, { knownDocuments: context.globalState.get('olanga.sharedDocuments', []), rememberDocuments: items => context.globalState.update('olanga.sharedDocuments', items) });
  function send(route, data = {}, secret = connection?.token, base = connection?.endpoint) {
    return new Promise((resolve, reject) => {
      if (!base || !secret) return reject(new Error('Connect the Olanga companion first.'));
      const body = JSON.stringify(data);
      const request = http.request(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${secret}`, 'X-Olanga-Client': 'vscode' }, timeout: 10000 }, response => {
        response.setEncoding('utf8'); let text = '';
        response.on('data', chunk => { text += chunk; if (text.length > 250000) { response.destroy(); reject(new Error('Companion response was too large.')); } });
        response.on('error', reject);
        response.on('end', () => { try { const result = JSON.parse(text); if (response.statusCode !== 200 || !result.ok) throw new Error(result.message || 'Companion request failed.'); resolve(result); } catch (error) { reject(error); } });
      });
      request.on('error', reject); request.on('timeout', () => request.destroy(new Error('Companion connection timed out.'))); request.end(body);
    });
  }
  function stop() { clearInterval(timer); timer = null; connection = null; adapter.cancelAll(); }
  function sendFor(session, route, data) {
    if (!session || connection !== session) return Promise.reject(new Error('The companion connection changed. Start this request again.'));
    return send(route, data, session.token, session.endpoint);
  }
  async function publish(result, session = connection) {
    await sendFor(session, '/publish', { kind: result.kind, title: result.title, text: result.text, url: result.url, version: result.version, documentId: result.documentId, items: result.items });
    vscode.window.showInformationMessage(result.message);
  }
  async function receive(command) {
    running = true; activeCommandId = command.id; const session = connection; let result;
    try {
      if (Date.now() >= command.expiresAt) throw new Error('This companion request expired.');
      result = await adapter.run(command.operation, command.payload, { authorize: () => sendFor(session, '/authorize', { id: command.id }) });
      if (result.kind) await publish(result, session);
    } catch (error) { result = { ok: false, verified: false, message: error.message }; }
    try { await sendFor(session, '/result', { id: command.id, result }); } catch (error) { vscode.window.showWarningMessage(error.message); }
    running = false; activeCommandId = null;
  }
  async function poll() {
    if (!connection || polling) return; polling = true;
    try { const result = await send('/poll', { busy: running }); if (result.cancelled?.includes(activeCommandId)) adapter.cancelAll(); if (result.command && !running) void receive(result.command); }
    catch (error) { stop(); vscode.window.showWarningMessage(error.message); }
    finally { polling = false; }
  }
  function register(name, fn) { context.subscriptions.push(vscode.commands.registerCommand(name, async () => { try { return await fn(); } catch (error) { vscode.window.showErrorMessage(error.message); } })); }
  register('olanga.connect', async () => {
    if (connection) throw new Error('Disconnect the current companion before pairing again.');
    const raw = await vscode.window.showInputBox({ title: 'Olanga local endpoint', prompt: 'Paste the local endpoint shown in Olanga Workbench.', ignoreFocusOut: true }); if (!raw) return;
    const base = endpoint(raw.trim());
    const code = await vscode.window.showInputBox({ title: 'Olanga one-time pairing code', prompt: 'Paste the code shown in Olanga. It expires after five minutes.', password: true, ignoreFocusOut: true }); if (!code) return;
    if (!/^[A-Za-z0-9_-]{43}$/.test(code.trim())) throw new Error('Paste the complete one-time code from Olanga.');
    const paired = await send('/pair', { name: 'VS Code companion' }, code.trim(), base);
    connection = { endpoint: base, token: paired.token }; timer = setInterval(poll, 1000); await poll();
    vscode.window.showInformationMessage('Olanga companion connected. No document contents have been shared.');
  });
  register('olanga.disconnect', async () => { if (connection) { try { await send('/disconnect'); } catch {} } stop(); vscode.window.showInformationMessage('Olanga companion disconnected.'); });
  register('olanga.shareSelection', async () => { const session = connection; if (!session) throw new Error('Connect the Olanga companion first.'); await publish(await adapter.captureSelection(), session); });
  register('olanga.shareDocuments', async () => { const session = connection; if (!session) throw new Error('Connect the Olanga companion first.'); await publish(await adapter.listDocuments(), session); });
  register('olanga.shareTasks', async () => { const session = connection; if (!session) throw new Error('Connect the Olanga companion first.'); await publish(await adapter.listTasks(), session); });
  context.subscriptions.push({ dispose() { stop(); adapter.dispose(); } });
}
module.exports = { activate };
