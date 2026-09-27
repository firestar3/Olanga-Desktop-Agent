const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createReleaseService, RELEASES_URL, LATEST_API_URL } = require('../../desktop/release-service');
const { createManualUpdater, createElectronUpdateFetch, parseChecksum, isTrustedDownloadUrl } = require('../../desktop/manual-updater');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let index = 0; index < 200 && !predicate(); index++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(predicate(), 'Expected operation to reach the awaited state');
}
function fixture(version = '1.4.1') {
  const installer = Buffer.from('safe mock installer bytes; this fixture is never executed');
  const name = `Olanga-Setup-${version}.exe`;
  const checksums = Buffer.from(`${sha(installer)}  ${name}\n`);
  const asset = (filename, bytes) => ({ name: filename, state: 'uploaded', size: bytes.length, digest: 'sha256:' + sha(bytes), browser_download_url: `${RELEASES_URL}/download/v${version}/${filename}` });
  return {
    installer, checksums,
    payload: { tag_name: 'v' + version, html_url: RELEASES_URL + '/tag/v' + version, draft: false, prerelease: false, assets: [asset(name, installer), asset('SHA256SUMS', checksums)] },
  };
}
function response(bytes, headers = {}) { return new Response(bytes, { headers: { 'content-length': String(bytes.length), ...headers } }); }
function harness(t, options = {}) {
  const data = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'olanga-updater-test-'));
  const calls = [], launches = [], states = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url, request });
    const override = options.fetchOverride ? await options.fetchOverride(url, request, data) : undefined;
    if (override !== undefined) return override;
    if (url === LATEST_API_URL) return new Response(JSON.stringify(data.payload), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/SHA256SUMS')) return response(data.checksums);
    if (url.endsWith('.exe')) return response(data.installer);
    throw new Error('Unexpected URL in mock: ' + url);
  };
  const releaseService = createReleaseService({ getInstalledVersion: () => '1.4.0', fetchImpl });
  const updater = createManualUpdater({
    releaseService, updatesDir: directory, fetchImpl, getInstalledVersion: () => '1.4.0',
    launchInstaller: async (file, version) => { launches.push({ file, version }); return options.launchInstaller?.(file, version); },
    onState: state => { states.push(state); options.onState?.(state); },
    ...options.updaterOptions,
  });
  t.after(async () => {
    await updater.dispose();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('olanga-updater-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { updater, data, directory, calls, launches, states };
}
function downloadedFile(directory) {
  const child = fs.readdirSync(directory).find(item => item.startsWith('update-'));
  return child ? path.join(directory, child, 'Olanga-Setup-1.4.1.exe') : null;
}

test('manual updater performs no startup, state-read, premature download, or quit installation', async t => {
  const h = harness(t);
  assert.equal(h.updater.getState().phase, 'idle');
  await h.updater.download(); await h.updater.install(); await flush();
  assert.equal(h.calls.length, 0); assert.equal(h.launches.length, 0);
  await h.updater.check();
  assert.equal(h.calls.length, 1);
  assert.equal(h.updater.getState().canDownload, true);
  assert.equal(h.updater.getState().automaticUpdatesEnabled, false);
  assert.equal(h.updater.getState().downloaded, false);
  await h.updater.check();
  assert.equal(h.calls.length, 2, 'Explicit checks refresh immediately');
  await h.updater.dispose();
  assert.equal(h.launches.length, 0);
});

test('download verifies both checksum assets, reports progress and waits for explicit installation', async t => {
  const h = harness(t);
  await h.updater.check();
  const result = await h.updater.download('https://attacker.example/ignored.exe');
  assert.equal(result.phase, 'ready');
  assert.equal(result.progress, 100); assert.equal(result.bytesReceived, h.data.installer.length);
  assert.equal(result.assetVerification, 'sha256-verified');
  assert.equal(result.signingVerified, false); assert.equal(result.canInstall, true);
  assert.equal(h.launches.length, 0);
  assert.deepEqual(fs.readFileSync(downloadedFile(h.directory)), h.data.installer);
  assert.equal(JSON.stringify(result).includes(h.directory), false, 'Renderer receives no executable path');
  assert.ok(h.states.some(state => state.phase === 'verifying'));
  assert.ok(h.calls.every(call => call.request.headers.Authorization === undefined));
  assert.ok(h.calls.slice(1).every(call => call.request.redirect === 'manual' && call.request.credentials === 'omit'));
  await h.updater.install('C:\\attacker.exe');
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0].file, downloadedFile(h.directory));
  assert.equal(h.launches[0].version, '1.4.1');
  assert.equal(h.updater.getState().phase, 'installing');
  await h.updater.install();
  assert.equal(h.launches.length, 1);
});

test('published SHA256SUMS supports releases without optional GitHub digests without claiming a signature', async t => {
  const h = harness(t);
  h.data.payload.assets.forEach(asset => delete asset.digest);
  await h.updater.check();
  const result = await h.updater.download();
  assert.equal(result.phase, 'ready'); assert.equal(result.signingVerified, false);
  assert.equal(result.assetVerification, 'sha256-verified');
});

test('source builds can download but cannot run an installer', async t => {
  const h = harness(t, { updaterOptions: { canInstall: false } });
  await h.updater.check(); await h.updater.download();
  assert.equal(h.updater.getState().canInstall, false);
  assert.equal(h.updater.getState().installationSupported, false);
  await h.updater.install(); assert.equal(h.launches.length, 0);
});

test('the next explicit download removes abandoned updater files but preserves unrelated directories', async t => {
  const h = harness(t);
  const abandoned = path.join(h.directory, 'update-1.4.1-aB3dE5');
  const unrelated = path.join(h.directory, 'update-1.4.1-cD5eF7');
  fs.mkdirSync(abandoned); fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(abandoned, 'Olanga-Setup-1.4.1.exe.part'), 'partial old file');
  fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'unrelated data');
  await h.updater.check(); assert.equal(fs.existsSync(abandoned), true, 'Checking metadata does not delete files');
  await h.updater.download();
  assert.equal(fs.existsSync(abandoned), false);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'unrelated data');
  assert.equal(h.updater.getState().phase, 'ready');
});

test('ready installer survives an unchanged explicit recheck without being downloaded twice', async t => {
  const h = harness(t);
  await h.updater.check(); await h.updater.download();
  const file = downloadedFile(h.directory);
  const result = await h.updater.check();
  assert.equal(result.phase, 'ready'); assert.equal(result.canInstall, true);
  assert.equal(downloadedFile(h.directory), file);
  assert.equal(h.calls.length, 4);
});

test('a changed release invalidates and removes a previously ready installer', async t => {
  const h = harness(t);
  await h.updater.check(); await h.updater.download();
  h.data.payload = fixture('1.4.2').payload;
  const result = await h.updater.check();
  assert.equal(result.version, '1.4.2'); assert.equal(result.canInstall, false);
  assert.equal(result.downloaded, false); assert.deepEqual(fs.readdirSync(h.directory), []);
});

test('an offline recheck preserves the already verified installer and reports the check failure', async t => {
  let offline = false;
  const h = harness(t, { fetchOverride: url => {
    if (offline && url === LATEST_API_URL) throw new Error('offline');
  } });
  await h.updater.check(); await h.updater.download();
  const file = downloadedFile(h.directory);
  offline = true;
  const result = await h.updater.check();
  assert.equal(result.ok, false); assert.equal(result.phase, 'ready');
  assert.equal(result.canInstall, true); assert.equal(fs.existsSync(file), true);
  assert.match(result.message, /still ready/);
  await h.updater.install(); assert.equal(h.launches.length, 1);
});

test('duplicate downloads share one operation and cancelling removes partial files', async t => {
  let body, releaseBody;
  const h = harness(t, { fetchOverride: (url, request, data) => {
    if (url.endsWith('.exe')) {
      body = new ReadableStream({ start(controller) { controller.enqueue(data.installer.subarray(0, 8)); }, cancel() { releaseBody = true; } });
      return new Response(body);
    }
  } });
  await h.updater.check();
  const first = h.updater.download(), second = h.updater.download();
  assert.equal(first, second);
  await until(() => h.updater.getState().bytesReceived === 8);
  assert.equal(h.updater.getState().canCancel, true);
  const checksDuringDownload = h.calls.length;
  await h.updater.check(); assert.equal(h.calls.length, checksDuringDownload);
  await h.updater.cancel();
  assert.equal((await first).phase, 'cancelled');
  assert.equal(releaseBody, true);
  assert.deepEqual(fs.readdirSync(h.directory), []);
  assert.equal(h.updater.getState().canDownload, true);
  assert.equal(h.updater.getState().canCancel, false);
  assert.equal(h.launches.length, 0);
});

test('late fetch responses after cancellation are closed and cannot overwrite a subsequent retry', async t => {
  let late, cancelled = false, firstInstaller = true;
  const h = harness(t, { fetchOverride: url => {
    if (url.endsWith('.exe') && firstInstaller) {
      firstInstaller = false;
      return new Promise(resolve => { late = resolve; });
    }
  } });
  await h.updater.check(); const pending = h.updater.download();
  await until(() => !!late);
  await h.updater.cancel(); assert.equal((await pending).phase, 'cancelled');
  assert.equal((await h.updater.download()).phase, 'ready');
  late(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await flush(); await flush();
  assert.equal(cancelled, true); assert.equal(h.updater.getState().phase, 'ready');
});

test('stalled request and response bodies time out and discard the partial update', async t => {
  for (const mode of ['request', 'body']) {
    const h = harness(t, { updaterOptions: { idleTimeoutMs: 15, timeoutMs: 100 }, fetchOverride: url => {
      if (url.endsWith('.exe')) return mode === 'request' ? new Promise(() => {}) : new Response(new ReadableStream({}));
    } });
    await h.updater.check(); const result = await h.updater.download();
    assert.equal(result.phase, 'error'); assert.match(result.message, /timed out/);
    assert.deepEqual(fs.readdirSync(h.directory), []);
  }
});

test('every redirect is HTTPS and restricted to GitHub release asset storage', async t => {
  const original = `${RELEASES_URL}/download/v1.4.1/Olanga-Setup-1.4.1.exe`;
  for (const bad of ['http://release-assets.githubusercontent.com/github-production-release-asset/1/x', 'https://attacker.example/file', 'https://release-assets.githubusercontent.com.attacker.example/github-production-release-asset/1/x', 'https://user@release-assets.githubusercontent.com/github-production-release-asset/1/x', 'https://github.com/other/repo/releases/download/v1.4.1/a.exe', 'https://release-assets.githubusercontent.com/unrelated']) assert.equal(isTrustedDownloadUrl(bad, original), false, bad);
  const trusted = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/fixture?signature=mock';
  const h = harness(t, { fetchOverride: (url, _request, data) => {
    if (url.endsWith('.exe')) return new Response(null, { status: 302, headers: { location: trusted } });
    if (url === trusted) return response(data.installer);
  } });
  await h.updater.check(); assert.equal((await h.updater.download()).phase, 'ready');
  assert.ok(h.calls.some(call => call.url === trusted));
});

test('untrusted and endless redirects never download or execute their destinations', async t => {
  for (const destination of ['https://attacker.example/file.exe', `${RELEASES_URL}/download/v1.4.1/Olanga-Setup-1.4.1.exe`]) {
    const h = harness(t, { fetchOverride: url => url.endsWith('.exe') ? new Response(null, { status: 302, headers: { location: destination } }) : undefined });
    await h.updater.check(); assert.equal((await h.updater.download()).phase, 'error');
    assert.ok(h.calls.length <= 8); assert.ok(h.calls.every(call => !call.url.includes('attacker')));
    assert.deepEqual(fs.readdirSync(h.directory), []); assert.equal(h.launches.length, 0);
  }
});

test('truncated, oversized and tampered installer bytes are discarded before installation', async t => {
  for (const corruption of ['short', 'long', 'modified', 'declared-length']) {
    const h = harness(t, { fetchOverride: (url, _request, data) => {
      if (!url.endsWith('.exe')) return undefined;
      if (corruption === 'short') return new Response(data.installer.subarray(0, 10));
      if (corruption === 'long') return new Response(Buffer.concat([data.installer, Buffer.from('extra')]));
      if (corruption === 'modified') return new Response(Buffer.alloc(data.installer.length, 9));
      return response(data.installer, { 'content-length': '999999999999' });
    } });
    await h.updater.check(); const result = await h.updater.download();
    assert.equal(result.phase, 'error', corruption); assert.equal(result.canInstall, false);
    assert.deepEqual(fs.readdirSync(h.directory), []); await h.updater.install();
    assert.equal(h.launches.length, 0);
  }
});

test('checksum manifest tampering and disagreement with GitHub digest reject the installer', async t => {
  for (const tamperDigest of [false, true]) {
    const h = harness(t);
    h.data.checksums = Buffer.from(`${'0'.repeat(64)}  Olanga-Setup-1.4.1.exe\n`);
    if (tamperDigest) h.data.payload.assets[1].digest = 'sha256:' + sha(h.data.checksums);
    await h.updater.check(); const result = await h.updater.download();
    assert.equal(result.phase, 'error'); assert.match(result.message, /checksum/);
    assert.equal(h.calls.some(call => call.url.endsWith('.exe')), false);
  }
});

test('checksum manifest requires one exact filename and rejects ambiguous or malformed entries', () => {
  const hash = 'a'.repeat(64), name = 'Olanga-Setup-1.4.1.exe';
  assert.equal(parseChecksum(`\uFEFF${hash}  ${name}\r\n`, name), hash);
  assert.equal(parseChecksum(`${hash} *${name}\n`, name), hash);
  for (const text of [`${hash}  ../${name}\n`, `${hash}  ${name}\n${hash}  ${name}\n`, 'bad data', `${hash}  Other.exe`]) assert.throws(() => parseChecksum(text, name), /invalid-checksums/);
});

test('install rechecks the saved bytes and refuses missing or tampered installers', async t => {
  for (const change of ['replace', 'remove']) {
    const h = harness(t);
    await h.updater.check(); await h.updater.download();
    const filename = downloadedFile(h.directory);
    if (change === 'replace') fs.writeFileSync(filename, Buffer.alloc(h.data.installer.length, 1));
    else fs.unlinkSync(filename);
    const result = await h.updater.install();
    assert.equal(result.phase, 'error'); assert.equal(result.canInstall, false);
    assert.match(result.message, /changed or is missing/); assert.equal(h.launches.length, 0);
    assert.deepEqual(fs.readdirSync(h.directory), []);
  }
});

test('installer launch failure keeps the verified update available for an explicit retry', async t => {
  let fail = true;
  const h = harness(t, { launchInstaller: async () => { if (fail) throw new Error('mock spawn failure'); } });
  await h.updater.check(); await h.updater.download();
  const failed = await h.updater.install();
  assert.equal(failed.phase, 'ready'); assert.equal(failed.canInstall, true); assert.equal(failed.ok, false);
  fail = false;
  await h.updater.install(); assert.equal(h.launches.length, 2);
});

test('rapid install clicks cannot launch two installer processes', async t => {
  let finish;
  const h = harness(t, { launchInstaller: () => new Promise(resolve => { finish = resolve; }) });
  await h.updater.check(); await h.updater.download();
  const first = h.updater.install(), second = h.updater.install();
  await until(() => h.launches.length === 1);
  finish(); await Promise.all([first, second]);
  assert.equal(h.launches.length, 1);
});

test('UI observer errors never interrupt an otherwise valid download', async t => {
  const h = harness(t, { onState: () => { throw new Error('renderer closed'); } });
  await h.updater.check(); assert.equal((await h.updater.download()).phase, 'ready');
});

function nativeTransport(onEnd) {
  const requests = [];
  const net = {
    fetch: async () => { throw new Error('net.fetch must not handle manual redirects'); },
    request(options) {
      const request = new EventEmitter();
      request.options = options; request.abortCount = 0;
      request.abort = () => { request.abortCount++; queueMicrotask(() => request.emit('abort')); };
      request.followRedirect = () => { throw new Error('Native request must not follow an unvalidated URL'); };
      request.end = () => {
        // Real Electron36 Writable behavior: close can precede HTTP headers.
        request.emit('finish'); request.emit('close');
        setImmediate(() => onEnd(request));
      };
      requests.push(request);
      return request;
    },
  };
  return { net, requests, fetch: createElectronUpdateFetch(net) };
}
function nativeBody(chunks) {
  const body = chunks ? Readable.from(chunks) : new Readable({ read() {} });
  body.statusCode = 200; body.headers = { 'content-type': 'application/octet-stream' };
  return body;
}

test('Electron adapter surfaces manual redirects after early Writable close without following the target', async () => {
  const location = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/fixture?temporary=mock';
  const h = nativeTransport(request => {
    request.emit('redirect', 302, 'GET', location, {});
    if (!request.abortCount) request.emit('error', new Error('Redirect was cancelled'));
  });
  const result = await h.fetch('https://github.com/source', { redirect: 'manual' });
  assert.equal(result.status, 302); assert.equal(result.headers.get('location'), location);
  assert.equal(h.requests[0].abortCount, 1);
  assert.equal(h.requests[0].options.credentials, 'omit');
  assert.equal(h.requests[0].options.redirect, 'manual');
});

test('Electron adapter streams native response bytes after early request close', async () => {
  const chunks = [Buffer.from('first'), Buffer.from('second')];
  const h = nativeTransport(request => {
    const body = nativeBody(chunks); body.headers['content-length'] = '11';
    request.emit('response', body);
  });
  const result = await h.fetch('https://github.com/source', { redirect: 'manual' });
  assert.equal(result.status, 200); assert.equal(result.headers.get('content-length'), '11');
  assert.equal(await result.text(), 'firstsecond');
  assert.equal(h.requests[0].abortCount, 0);
});

test('Electron adapter keeps abort connected after headers and closes an interrupted response', async () => {
  const abort = new AbortController();
  let body;
  const h = nativeTransport(request => { body = nativeBody(); request.emit('response', body); });
  const result = await h.fetch('https://github.com/source', { redirect: 'manual', signal: abort.signal });
  const read = result.body.getReader().read();
  abort.abort();
  await assert.rejects(read, /cancelled/);
  assert.equal(body.destroyed, true); assert.ok(h.requests[0].abortCount >= 1);
});

test('cancelling an Electron response body aborts its native request', async () => {
  let body;
  const h = nativeTransport(request => { body = nativeBody(); request.emit('response', body); });
  const result = await h.fetch('https://github.com/source', { redirect: 'manual' });
  await result.body.cancel(); await flush();
  assert.equal(body.destroyed, true); assert.ok(h.requests[0].abortCount >= 1);
});

test('Electron native errors before and after headers reject cleanly', async () => {
  const failed = nativeTransport(request => request.emit('error', new Error('mock offline')));
  await assert.rejects(failed.fetch('https://github.com/source', { redirect: 'manual' }), /mock offline/);
  let body;
  const h = nativeTransport(request => { body = nativeBody(); request.emit('response', body); });
  const result = await h.fetch('https://github.com/source', { redirect: 'manual' });
  const pending = result.body.getReader().read();
  body.destroy(new Error('mock connection closed'));
  await assert.rejects(pending, /mock connection closed/);
});

test('Electron malformed response setup fails without an unhandled stream error', async () => {
  let body;
  const h = nativeTransport(request => {
    body = new EventEmitter(); body.headers = {}; body.statusCode = 200;
    body.destroy = error => { body.destroyed = true; queueMicrotask(() => body.emit('error', error)); };
    request.emit('response', body);
  });
  await assert.rejects(h.fetch('https://github.com/source', { redirect: 'manual' }), /streamReadable|Readable/);
  await flush(); assert.equal(body.destroyed, true);
});

test('Electron adapter delegates nonmanual metadata fetches and skips already aborted downloads', async () => {
  let delegated = 0, requested = 0;
  const fetch = createElectronUpdateFetch({
    fetch: async (url, options) => { delegated++; assert.equal(options.redirect, 'error'); return new Response('metadata'); },
    request: () => { requested++; throw new Error('Should not request'); },
  });
  assert.equal(await (await fetch(LATEST_API_URL, { redirect: 'error' })).text(), 'metadata');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(fetch('https://github.com/source', { redirect: 'manual', signal: abort.signal }), /cancelled/);
  assert.equal(delegated, 1); assert.equal(requested, 0);
});
