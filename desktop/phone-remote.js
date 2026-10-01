const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const intents = require('../shared/fast-intents');

const ALLOWED = new Set(['OPEN_APP', 'VOLUME_SET', 'VOLUME_UP', 'VOLUME_DOWN', 'VOLUME_MUTE_ON', 'VOLUME_MUTE_OFF', 'SET_TIMER']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COOKIE = '__Host-OlangaRemote';
function privateAddress(value) {
  const address = String(value || '').replace(/^::ffff:/, '');
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || address === '127.0.0.1';
}
function listAddresses() {
  const rows = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) for (const item of addresses || []) {
    if (item.family === 'IPv4' && privateAddress(item.address)) rows.push({ name, address: item.address, localOnly: item.internal === true });
  }
  return rows.sort((a, b) => Number(a.localOnly) - Number(b.localOnly));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}
function parseCommand(text) {
  if (typeof text !== 'string' || text.length < 1 || text.length > 300 || /[\[\]\x00-\x1f]/.test(text)) throw new Error('Enter one supported app, volume, or timer command.');
  const actions = intents.parse(text.trim());
  if (!actions || actions.length !== 1 || !ALLOWED.has(/^\[([A-Z_]+)/.exec(actions[0].command)?.[1])) throw new Error('Phone control supports one app launch, volume change, or timer at a time.');
  return actions.map(({ command, message }) => ({ command, message }));
}
async function readPem(file, label) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error(`Choose an absolute ${label} path on this computer.`);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size < 30 || stat.size > 65536) throw new Error(`The ${label} file is invalid or too large.`);
  const value = await fs.readFile(file);
  if (value.length > 65536) throw new Error(`The ${label} file is too large.`);
  return value;
}
async function readIdentity(certPath, keyPath, host, now) {
  const [cert, key] = await Promise.all([readPem(certPath, 'certificate'), readPem(keyPath, 'private key')]);
  let certificate, privateKey;
  try { certificate = new crypto.X509Certificate(cert); privateKey = crypto.createPrivateKey(key); } catch (_) { throw new Error('Choose a PEM certificate and its unencrypted PEM private key.'); }
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) throw new Error('The HTTPS certificate is not currently valid.');
  if (certificate.publicKey.asymmetricKeyType === 'rsa' && certificate.publicKey.asymmetricKeyDetails.modulusLength < 2048) throw new Error('Use an RSA certificate of at least 2048 bits.');
  if (!certificate.checkIP(host)) throw new Error('The HTTPS certificate must contain the selected IP address in its Subject Alternative Name.');
  if (!certificate.publicKey.export({ type: 'spki', format: 'der' }).equals(crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }))) throw new Error('The certificate and private key do not match.');
  return { cert, key, fingerprint: certificate.fingerprint256, publicCertificate: certificate.raw };
}
function receiptOf(value) {
  const result = Array.isArray(value?.results) ? value.results[0] : value;
  return { ok: result?.ok === true, verified: result?.verified === true, message: String(result?.message || value?.spokenResponse || 'The request was sent, but a verified result was not returned.').slice(0, 2000) };
}
function createPhoneRemote({ execute, now = Date.now, actionTimeoutMs = 45000 } = {}) {
  if (typeof execute !== 'function') throw new Error('Phone remote needs an action executor.');
  let server = null, state = null, lifetime = null, busy = false, starting = false, generation = 0;
  const sockets = new Set(), executions = new Set(), commands = new Map();
  const snapshot = () => state ? { active: !!server, url: state.origin, host: state.host, port: state.port, pairingCode: state.pairCode, pairingExpiresAt: state.pairExpires, certificateFingerprint: state.fingerprint, expiresAt: state.expires, sessions: state.session && state.session.expires > now() ? 1 : 0, sessionExpiresAt: state.session?.expires || null, pairingLocked: state.failures >= 5 } : { active: false, sessions: 0 };
  async function stop() {
    generation++; clearTimeout(lifetime); lifetime = null;
    state = null; commands.clear(); busy = false;
    for (const controller of executions) controller.abort(); executions.clear();
    const previous = server; server = null;
    for (const socket of sockets) socket.destroy(); sockets.clear();
    if (previous) await new Promise(resolve => previous.close(() => resolve()));
    return snapshot();
  }
  async function start({ host, port = 0, certPath, keyPath } = {}) {
    if (starting) throw new Error('Phone remote is already starting.');
    if (!privateAddress(host) || !listAddresses().some(item => item.address === host)) throw new Error('Choose a private IPv4 address assigned to this computer. Public addresses and wildcard binds are not allowed.');
    if (!Number.isInteger(port) || port !== 0 && (port < 1024 || port > 65535)) throw new Error('Choose a port from 1024 to 65535, or 0 for an available port.');
    starting = true;
    try {
      await stop(); const run = generation;
      const identity = await readIdentity(certPath, keyPath, host, now());
      const files = await Promise.all(['phone-client.html', 'phone-client.js', 'phone-client.css'].map(file => fs.readFile(path.join(__dirname, file))));
      if (run !== generation) throw new Error('Phone remote startup was cancelled.');
      const created = https.createServer({ cert: identity.cert, key: identity.key, minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, (req, res) => handle(req, res, run, files, identity.publicCertificate).catch(() => { if (!res.headersSent) send(res, 500, { error: 'Phone request failed.' }); else res.destroy(); }));
      created.requestTimeout = 15000; created.headersTimeout = 10000; created.keepAliveTimeout = 5000; created.maxConnections = 12;
      created.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      created.on('tlsClientError', () => {});
      await new Promise((resolve, reject) => {
        const failed = error => { created.removeListener('listening', ready); reject(error); };
        const ready = () => { created.removeListener('error', failed); resolve(); };
        created.once('error', failed); created.once('listening', ready); created.listen({ host, port, exclusive: true });
      });
      if (run !== generation) { await new Promise(resolve => created.close(resolve)); throw new Error('Phone remote startup was cancelled.'); }
      const actualPort = created.address().port; server = created;
      state = { host, port: actualPort, origin: `https://${host}:${actualPort}`, pairCode: String(crypto.randomInt(100000, 1000000)), pairExpires: now() + 5 * 60000, expires: now() + 60 * 60000, fingerprint: identity.fingerprint, failures: 0, session: null };
      created.on('error', () => { stop().catch(() => {}); });
      lifetime = setTimeout(() => { stop().catch(() => {}); }, 60 * 60000); lifetime.unref?.();
      return snapshot();
    } finally { starting = false; }
  }
  function send(res, status, value, extra = {}) {
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'Permissions-Policy': 'camera=(), geolocation=()', ...extra });
    res.end(Buffer.isBuffer(value) ? value : JSON.stringify(value));
  }
  async function body(req) {
    if (req.headers['content-type'] !== 'application/json' || Number(req.headers['content-length'] || 0) > 4096) throw new Error('Invalid JSON request.');
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) throw new Error('Request is too large.'); chunks.push(chunk); }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid request.');
    return parsed;
  }
  function sessionFor(req) {
    const match = String(req.headers.cookie || '').match(/(?:^|;\s*)__Host-OlangaRemote=([a-f0-9]{64})(?:;|$)/);
    if (!state?.session || state.session.expires <= now() || !match || !safeEqual(match[1], state.session.token)) return null;
    return state.session;
  }
  async function handle(req, res, run, files, publicCertificate) {
    if (run !== generation || !state || now() >= state.expires) { send(res, 410, { error: 'Phone control expired. Start it again in Olanga.' }); return; }
    if (!privateAddress(req.socket.remoteAddress) || req.headers.host !== `${state.host}:${state.port}`) { send(res, 403, { error: 'This host is not allowed.' }); return; }
    if (req.headers.origin && req.headers.origin !== state.origin || req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) { send(res, 403, { error: 'Use the phone control page directly.' }); return; }
    const routes = { '/': [files[0], 'text/html; charset=utf-8'], '/phone-client.js': [files[1], 'text/javascript; charset=utf-8'], '/phone-client.css': [files[2], 'text/css; charset=utf-8'], '/certificate.cer': [publicCertificate, 'application/pkix-cert'] };
    if (req.method === 'GET' && routes[req.url]) { send(res, 200, routes[req.url][0], { 'Content-Type': routes[req.url][1] }); return; }
    if (!['GET', 'POST'].includes(req.method)) { send(res, 405, { error: 'Unsupported method.' }); return; }
    if (req.headers['x-olanga-client'] !== 'phone-v1' || req.method === 'POST' && req.headers.origin !== state.origin) { send(res, 403, { error: 'Use the phone control page directly.' }); return; }
    if (req.method === 'POST' && req.url === '/pair') {
      if (!state.pairCode || state.failures >= 5 || now() >= state.pairExpires) { send(res, 403, { error: 'Pairing is unavailable. Restart phone control in Olanga.' }); return; }
      let payload; try { payload = await body(req); } catch (_) { state.failures++; send(res, 400, { error: 'Enter the six-digit pairing code.' }); return; }
      // The state may have been revoked while a slow request body was arriving.
      if (run !== generation || !state) { send(res, 410, { error: 'Phone control stopped.' }); return; }
      if (!state.pairCode || state.failures >= 5 || now() >= state.pairExpires || !safeEqual(String(payload.code || ''), state.pairCode)) { state.failures++; send(res, 403, { error: 'Incorrect or expired pairing code.' }); return; }
      const session = { token: crypto.randomBytes(32).toString('hex'), csrf: crypto.randomBytes(32).toString('hex'), expires: Math.min(now() + 30 * 60000, state.expires), requests: [] };
      state.session = session; state.pairCode = null;
      send(res, 200, { paired: true, csrf: session.csrf, expiresAt: session.expires }, { 'Set-Cookie': `${COOKIE}=${session.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=1800` }); return;
    }
    const session = sessionFor(req);
    if (!session) { send(res, 401, { error: 'Pair this phone in Olanga again.' }); return; }
    if (req.method === 'GET' && req.url === '/session') { send(res, 200, { paired: true, csrf: session.csrf, expiresAt: session.expires }); return; }
    if (req.method !== 'POST' || !safeEqual(String(req.headers['x-olanga-csrf'] || ''), session.csrf)) { send(res, 403, { error: 'The session security token is missing.' }); return; }
    if (req.url === '/revoke') { state.session = null; for (const controller of executions) controller.abort(); send(res, 200, { paired: false }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` }); return; }
    if (req.url !== '/command') { send(res, 404, { error: 'Unknown request.' }); return; }
    let payload, actions;
    try { payload = await body(req); if (typeof payload.requestId !== 'string' || !UUID.test(payload.requestId)) throw new Error('Use a new request identifier.'); payload.requestId = payload.requestId.toLowerCase(); actions = parseCommand(payload.text); }
    catch (error) { send(res, 400, { error: error.message || 'Invalid command.' }); return; }
    if (run !== generation || !state || sessionFor(req) !== session) { send(res, 401, { error: 'This session was revoked.' }); return; }
    const previous = commands.get(payload.requestId);
    if (previous) {
      if (previous.command !== actions[0].command) { send(res, 409, { error: 'This request identifier belongs to a different command.' }); return; }
      send(res, 200, await previous.result); return;
    }
    session.requests = session.requests.filter(time => now() - time < 60000);
    if (session.requests.length >= 20 || commands.size >= 200) { send(res, 429, { error: 'Phone command limit reached. Wait a minute, or pair a fresh session for more commands.' }); return; }
    if (busy) { send(res, 409, { error: 'Olanga is finishing another phone command. Wait for its result.' }); return; }
    session.requests.push(now()); busy = true;
    const controller = new AbortController(); executions.add(controller);
    let deadline;
    const timedOut = new Promise(resolve => {
      deadline = setTimeout(() => { controller.abort(); resolve({ ok: false, verified: false, message: 'The command timed out. It may already have been sent; check Olanga before starting another request.' }); }, Math.max(100, Math.min(120000, actionTimeoutMs)));
      controller.signal.addEventListener('abort', () => { resolve({ ok: false, verified: false, message: 'Phone control stopped or the command timed out. Check Olanga for any completed action.' }); }, { once: true });
    });
    const execution = Promise.resolve().then(() => {
      if (controller.signal.aborted || run !== generation) throw new Error('Phone request cancelled.');
      return execute({ requestId: payload.requestId, text: payload.text.trim(), command: actions[0].command, actions, signal: controller.signal });
    }).then(receiptOf, () => ({ ok: false, verified: false, message: 'Olanga could not complete this command. Check the desktop app for details.' })).finally(() => { if (run === generation) busy = false; });
    // An executor that ignores cancellation must finish before another command
    // can begin. Timing out the HTTP result is not evidence that it stopped.
    const result = Promise.race([execution, timedOut]).finally(() => { clearTimeout(deadline); executions.delete(controller); });
    commands.set(payload.requestId, { command: actions[0].command, result });
    send(res, 200, await result);
  }
  return { start, stop, status: snapshot, addresses: listAddresses };
}
module.exports = { createPhoneRemote, privateAddress, parseCommand, listAddresses };
