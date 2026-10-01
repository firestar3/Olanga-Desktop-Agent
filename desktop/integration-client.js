'use strict';
const { randomUUID } = require('node:crypto');
const { isIP } = require('node:net');

const PROTOCOL = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL, '2025-03-26']);
function endpointURL(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter the HTTPS MCP endpoint.');
  let url; try { url = new URL(value); } catch (_) { throw new Error('Enter a valid HTTPS MCP endpoint.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search ||
      isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') ||
      /(?:^|\.)(?:localhost|local|internal|localdomain)$/.test(url.hostname)) throw new Error('Use a remote HTTPS hostname without credentials, a query string or fragment.');
  return url.toString();
}
function jsonCopy(value, limit = 32768) {
  let nodes = 0;
  function validate(item, depth) {
    if (++nodes > 2000 || depth > 12) throw new Error('Tool arguments are too complex.');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { item.forEach(child => validate(child, depth + 1)); return; }
    if (item && typeof item === 'object' && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsupported tool argument key.');
        validate(child, depth + 1);
      }
      return;
    }
    throw new Error('Tool arguments must contain JSON data only.');
  }
  validate(value, 0);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > limit) throw new Error('Tool arguments are too large.');
  return JSON.parse(serialized);
}
function createIntegrationClient({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 30000 } = {}) {
  let config = null, generation = 0, nextId = 0, initialized = null, initializing = null, closed = false;
  let catalog = new Map(), approvals = new Map();
  const requests = new Set();
  function redact(value) {
    const serialized = JSON.stringify(value);
    return JSON.parse(config?.token ? serialized.split(config.token).join('[redacted]') : serialized);
  }
  function cancelAll() { for (const request of requests) request.abort(); approvals.clear(); return { ok: true }; }
  function disconnect() {
    generation++; cancelAll(); config = null; initialized = null; initializing = null; catalog.clear();
    return { ok: true };
  }
  function configure({ url, bearerToken = '' } = {}) {
    if (closed) throw new Error('Integration client is closed.');
    const endpoint = endpointURL(url);
    if (typeof bearerToken !== 'string' || bearerToken.length > 8192 || /[^\x21-\x7e]/.test(bearerToken)) throw new Error('Invalid bearer token.');
    disconnect(); config = { endpoint, token: bearerToken };
    return { ok: true, endpoint };
  }
  function snapshot() {
    if (!config || closed) throw new Error('Configure an MCP server first.');
    return { ...config, generation };
  }
  function requireCurrent(connection) {
    if (connection.generation !== generation || !config || closed) throw new Error('The integration connection changed. Review the action again.');
  }
  async function readResponse(response, id) {
    if (!response.body?.getReader) throw new Error('The MCP server returned an empty response.');
    const type = response.headers.get('content-type')?.split(';')[0].trim();
    if (!['application/json', 'text/event-stream'].includes(type)) throw new Error('The MCP server returned an unsupported response type.');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let text = '', bytes = 0, eventCount = 0;
    function answer(message) {
      if (!message || message.jsonrpc !== '2.0' || Array.isArray(message)) throw new Error('Invalid MCP response.');
      if (message.id === id && !message.method) {
        if (message.error) throw new Error('The MCP server rejected this request.');
        if (!Object.hasOwn(message, 'result')) throw new Error('Invalid MCP response.');
        return { found: true, result: message.result };
      }
      // No sampling, elicitation, roots, or other server-initiated authority is
      // advertised. Notifications are data; a server request is unsupported.
      if (message.method && Object.hasOwn(message, 'id')) throw new Error('This server requires an unsupported client capability.');
      if (message.method && !Object.hasOwn(message, 'id')) return { found: false };
      throw new Error('The MCP response did not match this request.');
    }
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) { bytes += value.byteLength; if (bytes > 1048576) throw new Error('The MCP response exceeded its size limit.'); text += decoder.decode(value, { stream: true }); }
        if (done) text += decoder.decode();
        if (type === 'text/event-stream') {
          let match;
          while ((match = /\r?\n\r?\n/.exec(text))) {
            const event = text.slice(0, match.index); text = text.slice(match.index + match[0].length);
            if (++eventCount > 256) throw new Error('The MCP response exceeded its event limit.');
            const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
            if (data) { const parsed = answer(JSON.parse(data)); if (parsed.found) return parsed.result; }
          }
        }
        if (done) {
          if (type === 'application/json') return answer(JSON.parse(text)).result;
          throw new Error('The MCP stream ended before its result.');
        }
      }
    } finally { try { await reader.cancel(); } catch (_) {} }
  }
  async function post(connection, method, params, { notification = false, initialize = false } = {}) {
    requireCurrent(connection);
    const controller = new AbortController(); requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (connection.token) headers.Authorization = `Bearer ${connection.token}`;
    if (!initialize && initialized) {
      headers['MCP-Protocol-Version'] = initialized.protocolVersion;
      if (initialized.sessionId) headers['Mcp-Session-Id'] = initialized.sessionId;
    }
    const id = ++nextId;
    const message = { jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) };
    try {
      const response = await fetchImpl(connection.endpoint, { method: 'POST', headers, body: JSON.stringify(message),
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
      requireCurrent(connection);
      if (!response.ok) {
        if (response.status === 404) { initialized = null; catalog.clear(); approvals.clear(); }
        throw new Error(response.status === 401 || response.status === 403 ? 'The MCP server requires valid authorization.' : 'The MCP server did not accept the request.');
      }
      if (notification) { try { await response.body?.cancel(); } catch (_) {} return null; }
      const result = await readResponse(response, id);
      requireCurrent(connection);
      if (controller.signal.aborted) throw new Error('MCP request cancelled or timed out.');
      return { result, sessionId: initialize ? response.headers.get('mcp-session-id') : null };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('MCP request cancelled or timed out.');
      // Native network errors can contain URLs, credentials, or response data.
      const allowed = /^(?:The MCP |MCP |Invalid MCP |This server requires|The integration connection|The MCP stream)/;
      throw new Error(allowed.test(error?.message || '') ? error.message : 'The MCP request failed. Check the server address and connection.');
    } finally { clearTimeout(timeout); requests.delete(controller); }
  }
  async function initialize(connection) {
    if (initializing) return initializing;
    if (initialized) return;
    const pending = (async () => {
      const response = await post(connection, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Olanga', version: '1' } }, { initialize: true });
      if (!SUPPORTED_PROTOCOLS.has(response.result?.protocolVersion)) throw new Error('The MCP server selected an unsupported protocol version.');
      if (response.sessionId && (!/^[\x21-\x7e]{1,256}$/.test(response.sessionId))) throw new Error('Invalid MCP session identifier.');
      if (!response.result?.capabilities?.tools) throw new Error('The MCP server does not advertise tools.');
      initialized = { protocolVersion: response.result.protocolVersion, sessionId: response.sessionId };
      try { await post(connection, 'notifications/initialized', undefined, { notification: true }); }
      catch (error) { if (connection.generation === generation) initialized = null; throw error; }
    })();
    initializing = pending;
    try { await pending; } finally { if (initializing === pending) initializing = null; }
  }
  async function listTools() {
    const connection = snapshot(); await initialize(connection);
    const tools = [], seen = new Set(); let cursor;
    for (let page = 0; page < 5; page++) {
      const response = await post(connection, 'tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(response.result?.tools)) throw new Error('Invalid MCP tool list.');
      for (const tool of response.result.tools) {
        if (!tool || typeof tool.name !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name) || seen.has(tool.name) || tools.length >= 100 ||
            tool.inputSchema?.type !== 'object' || typeof tool.inputSchema !== 'object') throw new Error('Invalid MCP tool description.');
        seen.add(tool.name);
        tools.push({ name: tool.name, description: String(tool.description || '').slice(0, 4000), inputSchema: jsonCopy(tool.inputSchema), requiresApproval: true });
      }
      cursor = response.result.nextCursor;
      if (!cursor) break;
      if (typeof cursor !== 'string' || cursor.length > 1024 || page === 4) throw new Error('The MCP tool list exceeds the supported page limit.');
    }
    requireCurrent(connection); approvals.clear(); catalog = new Map(tools.map(tool => [tool.name, tool]));
    return redact({ tools, protocolVersion: initialized.protocolVersion });
  }
  function preview({ name, arguments: args = {} } = {}) {
    const connection = snapshot(), tool = catalog.get(name);
    if (!tool || !initialized) throw new Error('List tools and choose a supported tool first.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object.');
    const reviewed = jsonCopy(args), approvalId = randomUUID(), expiresAt = now() + 300000;
    if (approvals.size >= 20) approvals.clear();
    approvals.set(approvalId, { name, arguments: reviewed, expiresAt, generation: connection.generation });
    return redact({ approvalId, name, arguments: reviewed, description: tool.description, endpoint: connection.endpoint, expiresAt, requiresApproval: true });
  }
  async function callApproved({ approvalId } = {}) {
    const connection = snapshot(), approved = approvals.get(approvalId);
    approvals.delete(approvalId); // One use, even if the server response is lost.
    if (!approved || approved.expiresAt <= now() || approved.generation !== generation || !initialized) throw new Error('This tool review expired. Preview the action again.');
    try {
      const response = await post(connection, 'tools/call', { name: approved.name, arguments: approved.arguments });
      if (!response.result || !Array.isArray(response.result.content)) throw new Error('Invalid MCP tool result.');
      return redact({ ok: response.result.isError !== true, status: response.result.isError ? 'failed' : 'completed', name: approved.name, result: response.result });
    } catch (_) {
      // Delivery may already have happened. Never retry a side effect or label
      // a cancelled/lost response as proof that the tool did not run.
      return { ok: false, status: 'uncertain', name: approved.name, message: 'The tool result could not be confirmed. Check the connected service before reviewing another attempt.' };
    }
  }
  function dispose() { disconnect(); closed = true; }
  return { configure, listTools, preview, callApproved, cancelAll, disconnect, dispose };
}
module.exports = { createIntegrationClient, endpointURL };
