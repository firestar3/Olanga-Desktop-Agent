const http = require('node:http');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const OPERATIONS = Object.freeze({
  browser: ['browser.listTabs', 'browser.focusTab', 'browser.resumeTabs', 'browser.readSelection'],
  vscode: ['vscode.listDocuments', 'vscode.resumeDocuments', 'vscode.previewEdit', 'vscode.listTasks', 'vscode.runTask'],
});
const token = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = message => ({ ok: false, verified: false, message });
function webUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Choose a valid web page URL.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP and HTTPS pages without embedded credentials are supported.');
  return url.href;
}
function validateRequest(kind, operation, payload = {}) {
  if (!OPERATIONS[kind]?.includes(operation) || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('This companion operation is not supported.');
  if (JSON.stringify(payload).length > 150000) throw new Error('This companion request is too large.');
  if (operation === 'browser.focusTab' || operation === 'browser.readSelection') {
    if (!Number.isInteger(payload.tabId) || payload.tabId < 0) throw new Error('Choose a shared browser tab.');
    return { tabId: payload.tabId, url: webUrl(payload.url) };
  }
  if (operation === 'browser.resumeTabs') {
    if (!Array.isArray(payload.tabs) || !payload.tabs.length || payload.tabs.length > 30) throw new Error('Choose between 1 and 30 saved tabs.');
    return { tabs: payload.tabs.map(item => ({ url: webUrl(item.url), title: typeof item.title === 'string' ? item.title.slice(0, 200) : '' })) };
  }
  if (operation === 'vscode.resumeDocuments') {
    if (!Array.isArray(payload.uris) || !payload.uris.length || payload.uris.length > 20 || payload.uris.some(uri => typeof uri !== 'string' || uri.length > 4096 || !uri.startsWith('file:///'))) throw new Error('Choose previously shared local documents.');
    return { uris: [...new Set(payload.uris)] };
  }
  if (operation === 'vscode.previewEdit') {
    if (typeof payload.documentId !== 'string' || payload.documentId.length > 100 || !Number.isInteger(payload.version) || payload.version < 1 || typeof payload.text !== 'string' || payload.text.length > 100000) throw new Error('Use a shared selection, its current document version, and bounded replacement text.');
    return { documentId: payload.documentId, version: payload.version, text: payload.text };
  }
  if (operation === 'vscode.runTask') {
    if (typeof payload.taskId !== 'string' || !payload.taskId || payload.taskId.length > 100) throw new Error('Choose a task shared by VS Code.');
    return { taskId: payload.taskId };
  }
  return {};
}

function createCompanionBridge({ onState = () => {}, now = Date.now, requestTimeoutMs = 120000 } = {}) {
  let server = null, starting = null, endpoint = null, disposed = false, pairing = null;
  const connections = new Map(), commands = new Map(), inbox = [];
  function snapshot() {
    return { ok: true, running: !!server, connections: [...connections.values()].map(client => ({ id: client.id, kind: client.kind, name: client.name, connected: now() - client.lastSeen < 15000, lastSeen: client.lastSeen, capabilities: [...OPERATIONS[client.kind]] })), inbox: JSON.parse(JSON.stringify(inbox)), pending: [...commands.values()].map(command => ({ id: command.id, connectionId: command.connectionId, operation: command.operation, state: command.state })) };
  }
  const notify = () => { try { onState(snapshot()); } catch {} };
  function finish(command, result) { if (!commands.has(command.id)) return; commands.delete(command.id); clearTimeout(command.timer); const client = connections.get(command.connectionId); if (client && command.state === 'dispatched') { client.cancelled.push(command.id); if (client.cancelled.length > 20) client.cancelled.shift(); } command.resolve(result); notify(); }
  function cancelAll() { for (const command of [...commands.values()]) finish(command, fail(command.state === 'dispatched' ? 'Request cancelled. An action already dispatched by the companion may have happened; inspect its receipt before retrying.' : 'Request cancelled before the companion started it.')); return { ok: true }; }
  function disconnect(id) {
    connections.delete(id);
    for (const command of [...commands.values()]) if (command.connectionId === id) finish(command, fail(command.state === 'dispatched' ? 'Companion disconnected. A dispatched action may already have happened.' : 'Companion disconnected before the action started.'));
    for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].connectionId === id) inbox.splice(i, 1);
    notify(); return { ok: true };
  }
  function reply(response, status, data, origin) {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (origin) { headers['Access-Control-Allow-Origin'] = origin; headers.Vary = 'Origin'; }
    response.writeHead(status, headers); response.end(JSON.stringify(data));
  }
  async function body(request) {
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new Error('JSON is required.');
    let text = ''; request.setEncoding('utf8');
    for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 1000000) throw new Error('Request too large.'); }
    const data = JSON.parse(text || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid JSON object.');
    return data;
  }
  async function handle(request, response) {
    const origin = request.headers.origin;
    const browserOrigin = typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    const nativeOrigin = !origin && request.headers['x-olanga-client'] === 'vscode';
    if (disposed || !endpoint || request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== new URL(endpoint).host || (!browserOrigin && !nativeOrigin)) return reply(response, 403, fail('Only explicitly paired local companions are accepted.'));
    if (request.method === 'OPTIONS') {
      if (!browserOrigin) return reply(response, 403, fail('Unsupported origin.'));
      response.writeHead(204, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '30', Vary: 'Origin' }); response.end(); return;
    }
    if (request.method !== 'POST' || !['/pair', '/poll', '/authorize', '/result', '/publish', '/disconnect'].includes(request.url)) return reply(response, 404, fail('Unknown companion route.'), origin);
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || '')?.[1];
    let client;
    if (request.url === '/pair') {
      if (!pairing || pairing.expiresAt < now() || pairing.attempts++ > 20 || !equal(bearer, pairing.code) || (pairing.kind === 'browser' ? !browserOrigin : !nativeOrigin)) return reply(response, 403, fail('The pairing code is invalid or expired.'), origin);
    } else {
      client = [...connections.values()].find(item => equal(bearer, item.token) && item.origin === (origin || 'vscode'));
      if (!client) return reply(response, 403, fail('The companion is not paired.'), origin);
    }
    try {
      const data = await body(request);
      if (request.url === '/pair') {
        if (disposed || !pairing || pairing.expiresAt < now() || !equal(bearer, pairing.code)) return reply(response, 403, fail('This pairing code was already used or expired.'), origin);
        if (connections.size >= 5) throw new Error('Disconnect an existing companion before pairing another.');
        client = { id: randomUUID(), token: token(), origin: origin || 'vscode', kind: pairing.kind, name: typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 80) : pairing.kind === 'browser' ? 'Browser companion' : 'VS Code companion', lastSeen: now(), cancelled: [] };
        pairing = null; connections.set(client.id, client); notify();
        return reply(response, 200, { ok: true, connectionId: client.id, token: client.token, capabilities: OPERATIONS[client.kind] }, origin);
      }
      if (disposed || connections.get(client.id) !== client) return reply(response, 403, fail('The companion was disconnected.'), origin);
      client.lastSeen = now();
      if (request.url === '/poll') {
        const busy = data.busy === true || [...commands.values()].some(item => item.connectionId === client.id && item.state === 'dispatched');
        const command = !busy && [...commands.values()].find(item => item.connectionId === client.id && item.state === 'queued');
        if (command) { command.state = 'dispatched'; notify(); }
        return reply(response, 200, { ok: true, cancelled: client.cancelled.splice(0), command: command ? { id: command.id, operation: command.operation, payload: command.payload, expiresAt: command.expiresAt } : null }, origin);
      }
      if (request.url === '/authorize') {
        const command = commands.get(data.id);
        if (!command || command.connectionId !== client.id || command.state !== 'dispatched' || command.expiresAt <= now()) throw new Error('The request expired or was cancelled. Nothing else should be changed.');
        return reply(response, 200, { ok: true }, origin);
      }
      if (request.url === '/result') {
        const command = commands.get(data.id);
        if (!command || command.connectionId !== client.id || command.state !== 'dispatched' || typeof data.result?.ok !== 'boolean' || typeof data.result?.message !== 'string') throw new Error('No matching dispatched request exists.');
        finish(command, { ...data.result, connectionId: client.id, requestId: command.id });
        return reply(response, 200, { ok: true }, origin);
      }
      if (request.url === '/publish') {
        if (!['selection', 'tabs', 'documents', 'diagnostics', 'tasks'].includes(data.kind) || typeof data.title !== 'string' || data.title.length > 200 || (data.text !== undefined && (typeof data.text !== 'string' || data.text.length > 100000))) throw new Error('The shared content is invalid or too large.');
        const item = { id: randomUUID(), connectionId: client.id, companionKind: client.kind, at: now(), kind: data.kind, title: data.title, ...(typeof data.text === 'string' ? { text: data.text } : {}), ...(data.url ? { url: client.kind === 'browser' ? webUrl(data.url) : String(data.url).slice(0, 4096) } : {}), ...(Number.isInteger(data.version) ? { version: data.version } : {}), ...(typeof data.documentId === 'string' ? { documentId: data.documentId.slice(0, 100) } : {}), ...(Array.isArray(data.items) ? { items: JSON.parse(JSON.stringify(data.items.slice(0, 200))) } : {}) };
        inbox.push(item); while (inbox.length > 30) inbox.shift(); notify();
        return reply(response, 200, { ok: true, id: item.id }, origin);
      }
      disconnect(client.id); return reply(response, 200, { ok: true }, origin);
    } catch (error) { if (!response.headersSent) reply(response, 400, fail(error.message), origin); }
  }
  async function start() {
    if (server) return;
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      const listener = http.createServer((req, res) => handle(req, res).catch(() => { if (!res.headersSent) reply(res, 500, fail('Companion request failed.')); }));
      listener.requestTimeout = 10000; listener.headersTimeout = 10000; listener.maxHeadersCount = 30; listener.maxConnections = 12;
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        if (disposed) { listener.close(); reject(new Error('Olanga is closing.')); return; }
        server = listener; endpoint = `http://127.0.0.1:${listener.address().port}`; resolve();
      });
    }).finally(() => { starting = null; });
    return starting;
  }
  return {
    async startPairing(kind) {
      if (disposed) return fail('The companion bridge is closed.');
      if (!OPERATIONS[kind]) return fail('Choose a browser or VS Code companion.');
      try { await start(); pairing = { kind, code: token(), expiresAt: now() + 300000, attempts: 0 }; return { ok: true, endpoint, kind, code: pairing.code, expiresAt: pairing.expiresAt }; } catch (error) { return fail(error.message); }
    },
    list: snapshot,
    disconnect,
    cancelAll,
    forget(id) { const at = inbox.findIndex(item => item.id === id); if (at >= 0) inbox.splice(at, 1); notify(); return { ok: true }; },
    request({ connectionId, operation, payload } = {}) {
      const client = connections.get(connectionId);
      if (!client || now() - client.lastSeen > 15000) return Promise.resolve(fail('Open and reconnect the companion before sending a request.'));
      if (commands.size >= 10) return Promise.resolve(fail('Wait for a pending companion request to finish.'));
      try { payload = validateRequest(client.kind, operation, payload); } catch (error) { return Promise.resolve(fail(error.message)); }
      return new Promise(resolve => {
        const duration = operation === 'vscode.runTask' ? Math.max(requestTimeoutMs, 360000) : requestTimeoutMs;
        const command = { id: randomUUID(), connectionId, operation, payload, state: 'queued', expiresAt: now() + duration, resolve };
        command.timer = setTimeout(() => finish(command, fail(command.state === 'dispatched' ? 'The companion did not finish in time. A dispatched action may already have happened; inspect the companion before retrying.' : 'The companion did not receive this request before it expired.')), duration);
        commands.set(command.id, command); notify();
      });
    },
    dispose() { disposed = true; pairing = null; for (const id of [...connections.keys()]) disconnect(id); server?.close(); server?.closeAllConnections(); server = null; endpoint = null; },
  };
}
module.exports = { createCompanionBridge, validateRequest, webUrl };
