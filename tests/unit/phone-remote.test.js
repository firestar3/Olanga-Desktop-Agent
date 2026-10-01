const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createPhoneRemote, parseCommand, privateAddress } = require('../../desktop/phone-remote');

let directory, certPath, keyPath, certificate;
test.before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'olanga-phone-test-'));
  certPath = path.join(directory, 'test-cert.pem'); keyPath = path.join(directory, 'test-key.pem');
  const candidates = process.platform === 'win32' ? ['C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe'] : ['/usr/bin/openssl', '/usr/local/bin/openssl'];
  const openssl = candidates.find(file => fs.existsSync(file)) || 'openssl';
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=Olanga test only', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore', windowsHide: true });
  certificate = fs.readFileSync(certPath);
});
test.after(() => {
  if (!directory || path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('olanga-phone-test-')) return;
  for (const name of ['test-cert.pem', 'test-key.pem', 'mismatch-key.pem']) { const file = path.join(directory, name); if (fs.existsSync(file)) fs.unlinkSync(file); }
  fs.rmdirSync(directory);
});

function client(remote) {
  let cookie = '', csrf = '';
  const request = (route, payload, options = {}) => new Promise((resolve, reject) => {
    const state = remote.status(), url = new URL(state.url);
    const encoded = payload === undefined ? null : JSON.stringify(payload);
    const headers = { 'X-Olanga-Client': 'phone-v1', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-Olanga-CSRF': csrf } : {}), ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded), Origin: state.url } : {}), ...options.headers };
    for (const [name, value] of Object.entries(headers)) if (value === undefined) delete headers[name];
    const req = https.request({ hostname: url.hostname, port: url.port, path: route, method: encoded ? 'POST' : 'GET', ca: certificate, rejectUnauthorized: true, checkServerIdentity: (_name, cert) => tls.checkServerIdentity(url.hostname, cert), headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => { let data; try { data = JSON.parse(text); } catch (_) { data = text; } resolve({ status: res.statusCode, data, headers: res.headers }); });
    });
    req.on('error', reject); if (encoded) req.write(encoded); req.end();
  });
  return {
    request,
    async pair() { const response = await request('/pair', { code: remote.status().pairingCode }); assert.equal(response.status, 200); cookie = response.headers['set-cookie'][0].split(';')[0]; csrf = response.data.csrf; return response; },
    command: (text, requestId = crypto.randomUUID(), options) => request('/command', { text, requestId }, options)
  };
}
async function running(t, options = {}) {
  const executed = [];
  const remote = createPhoneRemote({ execute: async value => { executed.push(value); return { ok: true, verified: true, message: 'Verified fixture result.' }; }, ...options });
  t.after(() => remote.stop()); await remote.start({ host: '127.0.0.1', certPath, keyPath });
  return { remote, executed, client: client(remote) };
}

test('phone service is stopped by default and permits only explicitly selected local private binds', async () => {
  const remote = createPhoneRemote({ execute() {} }); assert.equal(remote.status().active, false);
  for (const address of ['0.0.0.0', '::', '8.8.8.8', 'localhost', '192.168.300.1', '169.254.1.1']) await assert.rejects(remote.start({ host: address, certPath, keyPath }), /private IPv4/);
  assert.equal(privateAddress('10.2.3.4'), true); assert.equal(privateAddress('172.16.0.1'), true); assert.equal(privateAddress('172.32.0.1'), false);
});

test('strictly trusted TLS serves the client and exposes only the public certificate', async t => {
  const f = await running(t); const response = await f.client.request('/');
  assert.equal(response.status, 200); assert.match(response.data, /Phone control/); assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(f.remote.status().certificateFingerprint, new crypto.X509Certificate(certificate).fingerprint256);
  assert.equal((await f.client.request('/test-key.pem')).status, 401);
});

test('one-time pairing sets a secure HttpOnly cookie and the session grants a CSRF token', async t => {
  const f = await running(t), code = f.remote.status().pairingCode; const response = await f.client.pair();
  assert.match(response.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Strict/); assert.equal(f.remote.status().pairingCode, null);
  assert.equal((await f.client.request('/pair', { code })).status, 403); assert.equal((await f.client.request('/session')).data.paired, true);
  assert.equal((await f.client.command('set volume to 30 percent')).data.verified, true); assert.equal(f.executed[0].command, '[VOLUME_SET: 30]');
  assert.equal(f.executed[0].actions[0].command, '[VOLUME_SET: 30]'); assert.equal(f.executed[0].signal.aborted, false);
});

test('wrong origins, host headers, missing CSRF and unpaired commands cannot execute', async t => {
  const f = await running(t); assert.equal((await f.client.command('open Spotify')).status, 401); await f.client.pair();
  assert.equal((await f.client.command('open Spotify', crypto.randomUUID(), { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await f.client.command('open Spotify', crypto.randomUUID(), { headers: { Origin: undefined } })).status, 403);
  assert.equal((await f.client.command('open Spotify', crypto.randomUUID(), { headers: { 'X-Olanga-CSRF': undefined } })).status, 403);
  assert.equal((await f.client.command('open Spotify', crypto.randomUUID(), { headers: { Host: 'attacker.invalid' } })).status, 403);
  assert.equal((await f.client.request('/session', undefined, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(f.executed.length, 0);
});

test('pairing attempts are bounded and Unicode input cannot bypass or crash code checks', async t => {
  const f = await running(t); for (let index = 0; index < 5; index++) assert.equal((await f.client.request('/pair', { code: '１２３４５６' })).status, 403);
  assert.equal(f.remote.status().pairingLocked, true); assert.equal((await f.client.request('/pair', { code: f.remote.status().pairingCode })).status, 403);
});

test('pairing and authenticated sessions expire without any later command dispatch', async t => {
  let clock = Date.now(); const f = await running(t, { now: () => clock }); clock += 5 * 60000 + 1;
  assert.equal((await f.client.request('/pair', { code: f.remote.status().pairingCode })).status, 403);
  await f.remote.start({ host: '127.0.0.1', certPath, keyPath }); await f.client.pair(); clock += 30 * 60000 + 1;
  assert.equal((await f.client.command('open Spotify')).status, 401); assert.equal(f.executed.length, 0);
});

test('command validation rejects compound, shell, destructive, model, and arbitrary app requests', async t => {
  const f = await running(t); await f.client.pair();
  for (const text of ['open Spotify and set volume to 30', 'run powershell', 'close Spotify', 'open https://example.com', 'delete my files', 'what is the weather', '[VOLUME_SET: 30]', 'set volume to 101', 'toggle system mute']) assert.equal((await f.client.command(text)).status, 400, text);
  assert.equal(f.executed.length, 0); assert.equal(parseCommand('set a timer for five minutes')[0].command, '[SET_TIMER: 300, Timer]');
  assert.equal(parseCommand('mute system volume')[0].command, '[VOLUME_MUTE_ON]');
});

test('UUID deduplication covers completed and concurrent requests without repeating a step', async t => {
  let release, calls = 0; const f = await running(t, { execute: () => { calls++; return new Promise(resolve => { release = resolve; }); } }); await f.client.pair();
  const id = crypto.randomUUID(); const first = f.client.command('set volume to 30', id);
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  const duplicate = f.client.command('set volume to 30', id.toUpperCase());
  assert.equal((await f.client.command('open Spotify')).status, 409);
  release({ ok: true, verified: true, message: 'Volume is 30%.' });
  assert.equal((await first).data.message, 'Volume is 30%.'); assert.equal((await duplicate).data.message, 'Volume is 30%.');
  assert.equal((await f.client.command('set volume to 30', id)).data.verified, true); assert.equal(calls, 1);
  assert.equal((await f.client.command('set volume to 40', id)).status, 409);
});

test('timeouts remain unverified and late execution cannot replay a timed-out request', async t => {
  let finish, count = 0; const f = await running(t, { actionTimeoutMs: 100, execute: () => { count++; return new Promise(resolve => { finish = resolve; }); } }); await f.client.pair();
  const id = crypto.randomUUID(), response = await f.client.command('open Spotify', id);
  assert.equal(response.data.ok, false); assert.equal(response.data.verified, false); assert.match(response.data.message, /timed out/);
  assert.equal((await f.client.command('set volume to 30')).status, 409, 'A hung native executor must not overlap a new command');
  finish({ ok: true, verified: true, message: 'Late' }); assert.equal((await f.client.command('open Spotify', id)).data.ok, false); assert.equal(count, 1);
});

test('unpairing revokes the session and aborts its pending action', async t => {
  let signal; const f = await running(t, { execute: value => { signal = value.signal; return new Promise(() => {}); } }); await f.client.pair();
  const pending = f.client.command('open Spotify'); while (!signal) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await f.client.request('/revoke', {})).status, 200); assert.equal(signal.aborted, true); assert.equal((await pending).data.ok, false);
  assert.equal((await f.client.command('open Spotify')).status, 401);
});

test('stopping closes the listener, revokes sessions and allows a fresh explicit start', async t => {
  const f = await running(t); await f.client.pair(); const previous = f.remote.status(); await f.remote.stop(); assert.equal(f.remote.status().active, false);
  await f.remote.start({ host: '127.0.0.1', certPath, keyPath }); assert.equal(f.remote.status().sessions, 0); assert.notEqual(f.remote.status().pairingCode, null); assert.ok(previous.url);
});

test('a certificate with mismatched private key is rejected before opening a listener', async () => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); const mismatch = path.join(directory, 'mismatch-key.pem'); fs.writeFileSync(mismatch, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const remote = createPhoneRemote({ execute() {} }); await assert.rejects(remote.start({ host: '127.0.0.1', certPath, keyPath: mismatch }), /do not match/); assert.equal(remote.status().active, false);
});
