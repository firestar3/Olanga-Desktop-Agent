const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { RELEASES_URL, MAX_INSTALLER_BYTES, MAX_CHECKSUM_BYTES, compareVersions, parseVersion } = require('./release-service');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DOWNLOAD_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

function createElectronUpdateFetch(net) {
  return (url, options = {}) => {
    if (options.redirect !== 'manual') return net.fetch(url, options);
    // Electron 36's net.fetch rejects manual redirects as "Redirect was
    // cancelled". net.request exposes the redirect before Chromium follows it,
    // allowing the updater to validate Location and issue each approved hop.
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) { reject(new Error('cancelled')); return; }
      let settled = false, incoming = null;
      const request = net.request({ url, method: 'GET', headers: options.headers,
        redirect: 'manual', credentials: 'omit', useSessionCookies: false,
        bypassCustomProtocolHandlers: true, cache: 'no-store' });
      const abort = () => request.abort();
      const cleanup = () => options.signal?.removeEventListener('abort', abort);
      const fail = error => {
        cleanup();
        if (!settled) { settled = true; reject(error); }
        if (incoming && !incoming.destroyed) incoming.destroy(error);
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      request.on('redirect', (status, _method, location) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(new Response(null, { status, headers: { location } }));
        request.abort();
      });
      request.on('response', response => {
        incoming = response;
        if (settled || options.signal?.aborted) { response.on('error', () => {}); request.abort(); return; }
        response.on('error', fail);
        response.on('end', cleanup);
        response.on('aborted', () => { if (!response.destroyed) response.destroy(new Error('cancelled')); });
        response.on('close', () => { cleanup(); if (!response.readableEnded) request.abort(); });
        try {
          // Preserve backpressure instead of collecting a whole installer in
          // memory. Cancelling the web reader also destroys the native stream.
          const body = Readable.toWeb(response, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } });
          const headers = new Headers();
          for (const name of ['content-length', 'content-type', 'location']) {
            const value = response.headers[name];
            if (value != null) headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
          }
          const result = new Response([204, 205, 304].includes(response.statusCode) ? null : body, { status: response.statusCode, headers });
          settled = true;
          resolve(result);
        } catch (error) { fail(error); request.abort(); }
      });
      request.on('error', fail);
      request.on('abort', () => fail(new Error('cancelled')));
      // ClientRequest is a Writable: Electron 36 can emit close immediately
      // after end(), before HTTP response/redirect events. Response lifecycle,
      // error and abort events determine completion instead.
      try { request.end(); } catch (error) { fail(error); request.abort(); }
    });
  };
}

function cancelBody(response) {
  try { void Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* Already locked or closed. */ }
}

function abortable(promise, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (handler, value) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      handler(value);
    };
    const abort = () => finish(reject, new Error(signal.reason === 'timeout' ? 'timeout' : 'cancelled'));
    if (signal.aborted) { void Promise.resolve(promise).catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    if (timeoutMs) timer = setTimeout(() => finish(reject, new Error('timeout')), timeoutMs);
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function isTrustedDownloadUrl(value, originalUrl) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return false;
    if (url.hostname === 'github.com') return url.href === originalUrl;
    return DOWNLOAD_HOSTS.has(url.hostname) && url.pathname.startsWith('/github-production-release-asset/');
  } catch { return false; }
}

async function fetchAsset(fetchImpl, asset, signal, idleTimeoutMs) {
  let url = asset.url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!isTrustedDownloadUrl(url, asset.url)) throw new Error('untrusted-download');
    // Validate every Location ourselves; fetch must not follow an untrusted hop.
    const request = Promise.resolve().then(() => fetchImpl(url, {
      method: 'GET', redirect: 'manual', signal, credentials: 'omit',
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Olanga-Desktop-Agent' },
      bypassCustomProtocolHandlers: true,
    }));
    request.then(response => { if (signal.aborted) cancelBody(response); }, () => {});
    const response = await abortable(request, signal, idleTimeoutMs);
    if (signal.aborted) { cancelBody(response); throw new Error('cancelled'); }
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers?.get?.('location');
      cancelBody(response);
      if (!location || redirects === 5) throw new Error('untrusted-download');
      try { url = new URL(location, url).href; } catch { throw new Error('untrusted-download'); }
      continue;
    }
    if (!response.ok || response.status !== 200) { cancelBody(response); throw new Error('download-unavailable'); }
    const lengthHeader = response.headers?.get?.('content-length');
    if (lengthHeader != null && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) !== asset.size)) {
      cancelBody(response);
      throw new Error('download-size');
    }
    return response;
  }
  throw new Error('untrusted-download');
}

async function readAsset(response, asset, signal, idleTimeoutMs, onChunk) {
  if (!response.body?.getReader) { cancelBody(response); throw new Error('invalid-download'); }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let received = 0;
  const hash = crypto.createHash('sha256');
  try {
    for (;;) {
      if (signal.aborted) throw new Error(signal.reason === 'timeout' ? 'timeout' : 'cancelled');
      const { done, value } = await abortable(reader.read(), signal, idleTimeoutMs);
      if (signal.aborted) throw new Error(signal.reason === 'timeout' ? 'timeout' : 'cancelled');
      if (done) break;
      received += value.byteLength;
      if (received > asset.size) throw new Error('download-size');
      hash.update(value);
      await onChunk(value, received);
    }
    if (received !== asset.size) throw new Error('download-size');
    const digest = hash.digest('hex');
    if (asset.sha256 && digest !== asset.sha256) throw new Error('checksum-mismatch');
    return digest;
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

function parseChecksum(text, installerName) {
  const matches = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-f\d]{64}) [ *](.+)$/i.exec(line);
    if (!match) throw new Error('invalid-checksums');
    if (match[2] === installerName) matches.push(match[1].toLowerCase());
  }
  if (matches.length !== 1) throw new Error('invalid-checksums');
  return matches[0];
}

function createManualUpdater({
  releaseService,
  updatesDir,
  getInstalledVersion = () => require('../package.json').version,
  fetchImpl = globalThis.fetch,
  launchInstaller,
  onState = () => {},
  canInstall: installationSupported = true,
  timeoutMs = 15 * 60 * 1000,
  idleTimeoutMs = 30 * 1000,
} = {}) {
  if (!releaseService || !path.isAbsolute(updatesDir || '')) throw new Error('Manual updater requires a release service and absolute updates directory.');
  const root = path.resolve(updatesDir);
  let candidate = null, ready = null, active = null, disposed = false;
  let state = {
    ok: true, phase: 'idle', status: 'not-checked', installedVersion: String(getInstalledVersion()),
    message: 'Check for a newer version when you are ready.', url: RELEASES_URL,
    channel: 'stable', automaticUpdatesEnabled: false, downloaded: false,
    assetVerification: 'not-performed', signingVerified: false,
    bytesReceived: 0, totalBytes: 0, progress: 0,
  };

  function getState() {
    return {
      ...state,
      canDownload: !!candidate && !disposed && !['checking', 'downloading', 'verifying', 'installing', 'ready'].includes(state.phase),
      canInstall: !!ready && installationSupported && typeof launchInstaller === 'function' && !disposed && state.phase === 'ready',
      canCancel: active?.kind === 'download' && ['downloading', 'verifying'].includes(state.phase) || false,
      installationSupported: !!installationSupported,
    };
  }
  function publish(changes) {
    state = { ...state, ...changes };
    const snapshot = getState();
    if (!disposed) { try { onState(snapshot); } catch { /* UI observers cannot interrupt a file operation. */ } }
    return snapshot;
  }
  async function removeOwnedDirectory(directory) {
    if (!directory) return;
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('update-')) throw new Error('invalid-update-path');
    // Only this instance's mkdtemp directory is removed, never the updates root.
    await fs.promises.rm(resolved, { recursive: true, force: true }).catch(() => {});
  }
  async function cleanAbandonedDownloads() {
    // This is called only by an explicit Download. A previous session may have
    // closed after downloading; its unremembered files should not accumulate.
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const match = /^update-(.+)-[a-z\d]{6}$/i.exec(entry.name);
      if (!entry.isDirectory() || !match || !parseVersion(match[1])) continue;
      const directory = path.join(root, entry.name);
      if (ready?.directory === directory) continue;
      const names = await fs.promises.readdir(directory).catch(() => null);
      const expected = `Olanga-Setup-${match[1]}.exe`;
      if (names && names.every(name => name === expected || name === expected + '.part')) await removeOwnedDirectory(directory);
    }
  }
  function run(kind, work) {
    if (disposed) return Promise.resolve(getState());
    if (active) return active.kind === kind ? active.promise : Promise.resolve(getState());
    const operation = { kind, controller: new AbortController(), promise: null };
    active = operation;
    operation.promise = Promise.resolve().then(() => work(operation)).finally(() => {
      if (active === operation) active = null;
    });
    return operation.promise;
  }
  function sameCandidate(left, right) { return !!left && !!right && JSON.stringify(left) === JSON.stringify(right); }
  function validCandidate(value) {
    if (!value || compareVersions(value.version, String(getInstalledVersion())) <= 0) return false;
    for (const [asset, expectedName, maximum] of [[value.installer, `Olanga-Setup-${value.version}.exe`, MAX_INSTALLER_BYTES], [value.checksums, 'SHA256SUMS', MAX_CHECKSUM_BYTES]]) {
      if (!asset || asset.name !== expectedName || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maximum) return false;
      // The release service already validated the tag. Defend this boundary too.
      const expectedSuffix = `/${encodeURIComponent(expectedName)}`;
      const prefix = RELEASES_URL + '/download/';
      if (typeof asset.url !== 'string' || !asset.url.startsWith(prefix) || !asset.url.endsWith(expectedSuffix)) return false;
      const tag = decodeURIComponent(asset.url.slice(prefix.length, -expectedSuffix.length));
      if (tag !== value.version && tag !== 'v' + value.version) return false;
      if (asset.url !== `${prefix}${encodeURIComponent(tag)}${expectedSuffix}` || (asset.sha256 != null && !/^[a-f\d]{64}$/i.test(asset.sha256))) return false;
    }
    return true;
  }

  function check({ force = true } = {}) {
    if (state.phase === 'installing') return Promise.resolve(getState());
    return run('check', async () => {
      const oldCandidate = candidate;
      publish({ phase: 'checking', message: 'Checking GitHub for the latest stable release…' });
      try {
        const result = await releaseService.check({ force });
        if (disposed) return getState();
        // A failed metadata recheck must not discard an already verified file.
        // Installation will still rehash it, and the failed check stays visible.
        if (!result.ok && ready && oldCandidate) {
          candidate = oldCandidate;
          return publish({ ...result, phase: 'ready', version: ready.version, updateAvailable: true,
            downloaded: true, assetVerification: 'sha256-verified',
            message: `${result.message} The verified Olanga ${ready.version} download is still ready to install.` });
        }
        const proposed = result.ok && result.updateAvailable ? releaseService.getDownloadCandidate() : null;
        candidate = proposed && validCandidate(proposed) ? proposed : null;
        const keepReady = ready && sameCandidate(oldCandidate, candidate);
        if (ready && !keepReady) { await removeOwnedDirectory(ready.directory); ready = null; }
        return publish({
          ...result, phase: keepReady ? 'ready' : result.ok ? 'available' : 'error',
          downloaded: !!keepReady, assetVerification: keepReady ? 'sha256-verified' : 'not-performed',
          signingVerified: false, bytesReceived: keepReady ? candidate.installer.size : 0,
          totalBytes: candidate?.installer.size || 0, progress: keepReady ? 100 : 0,
          ...(keepReady ? { message: `Olanga ${candidate.version} is downloaded and its SHA-256 checksum is verified. Install & restart when you are ready.` } : {}),
        });
      } catch {
        candidate = null;
        if (ready) { await removeOwnedDirectory(ready.directory); ready = null; }
        return publish({ ok: false, phase: 'error', downloaded: false, assetVerification: 'not-performed', message: 'Olanga could not validate the update. Check again or open GitHub Releases.' });
      }
    });
  }

  function download() {
    if (!candidate || state.phase === 'ready' || state.phase === 'installing') return Promise.resolve(getState());
    return run('download', async operation => {
      const release = structuredClone(candidate);
      const signal = operation.controller.signal;
      let directory = null, handle = null;
      const timer = setTimeout(() => operation.controller.abort('timeout'), timeoutMs);
      publish({ ok: true, phase: 'downloading', message: `Downloading Olanga ${release.version}…`, downloaded: false, assetVerification: 'not-performed', bytesReceived: 0, totalBytes: release.installer.size, progress: 0 });
      try {
        if (!validCandidate(release)) throw new Error('untrusted-download');
        const checksumResponse = await fetchAsset(fetchImpl, release.checksums, signal, idleTimeoutMs);
        const checksumChunks = [];
        await readAsset(checksumResponse, release.checksums, signal, idleTimeoutMs, chunk => checksumChunks.push(Buffer.from(chunk)));
        const expectedHash = parseChecksum(Buffer.concat(checksumChunks).toString('utf8'), release.installer.name);
        if (release.installer.sha256 && expectedHash !== release.installer.sha256) throw new Error('checksum-mismatch');
        if (signal.aborted) throw new Error('cancelled');
        await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
        await cleanAbandonedDownloads();
        if (signal.aborted) throw new Error('cancelled');
        directory = await fs.promises.mkdtemp(path.join(root, `update-${release.version}-`));
        const filePath = path.join(directory, release.installer.name);
        const partialPath = filePath + '.part';
        handle = await fs.promises.open(partialPath, 'wx', 0o600);
        const response = await fetchAsset(fetchImpl, release.installer, signal, idleTimeoutMs);
        let lastProgressAt = 0;
        const actualHash = await readAsset(response, release.installer, signal, idleTimeoutMs, async (chunk, received) => {
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
            if (!bytesWritten) throw new Error('download-write');
            offset += bytesWritten;
          }
          const now = Date.now();
          if (now - lastProgressAt >= 100 || received === release.installer.size) {
            lastProgressAt = now;
            publish({ bytesReceived: received, progress: Math.floor(received * 100 / release.installer.size) });
          }
        });
        publish({ phase: 'verifying', message: 'Verifying the downloaded installer…' });
        if (actualHash !== expectedHash) throw new Error('checksum-mismatch');
        await handle.sync();
        await handle.close(); handle = null;
        if (signal.aborted) throw new Error('cancelled');
        await fs.promises.rename(partialPath, filePath);
        if (signal.aborted) throw new Error('cancelled');
        ready = { directory, filePath, hash: expectedHash, size: release.installer.size, version: release.version };
        directory = null;
        return publish({ ok: true, phase: 'ready', downloaded: true, assetVerification: 'sha256-verified', progress: 100, bytesReceived: release.installer.size, message: `Olanga ${release.version} is downloaded and its SHA-256 checksum is verified. Install & restart when you are ready.` });
      } catch (error) {
        const cancelled = signal.aborted && signal.reason !== 'timeout';
        const code = signal.reason === 'timeout' ? 'timeout' : error.message;
        const message = cancelled ? 'Download cancelled. You can download the update again when you are ready.'
          : code === 'checksum-mismatch' ? 'The installer did not match its published SHA-256 checksum. It was discarded; check again before retrying.'
            : code === 'timeout' ? 'The update download timed out. Try again when the connection is stable.'
              : ['invalid-checksums', 'untrusted-download', 'invalid-download', 'download-size'].includes(code) ? 'The update files could not be validated. Nothing was installed. Check again or open GitHub Releases.'
                : 'Olanga could not download the update. Check your connection and free disk space, then try again.';
        return publish({ ok: false, phase: cancelled ? 'cancelled' : 'error', downloaded: false, assetVerification: 'not-performed', message });
      } finally {
        clearTimeout(timer);
        operation.controller.abort();
        if (handle) await handle.close().catch(() => {});
        await removeOwnedDirectory(directory);
      }
    });
  }

  async function verifyReadyFile(file) {
    if (path.dirname(file.directory) !== root || path.dirname(file.filePath) !== file.directory || path.basename(file.filePath) !== `Olanga-Setup-${file.version}.exe`) throw new Error('invalid-update-path');
    const stat = await fs.promises.lstat(file.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) throw new Error('checksum-mismatch');
    const [realRoot, realDirectory, realFile] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(file.directory), fs.promises.realpath(file.filePath)]);
    if (path.dirname(realDirectory) !== realRoot || path.dirname(realFile) !== realDirectory) throw new Error('invalid-update-path');
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    for await (const chunk of fs.createReadStream(file.filePath)) {
      bytes += chunk.length;
      if (bytes > file.size || disposed) throw new Error('checksum-mismatch');
      hash.update(chunk);
    }
    if (bytes !== file.size || hash.digest('hex') !== file.hash) throw new Error('checksum-mismatch');
  }

  function install() {
    if (!ready || !installationSupported || state.phase !== 'ready' || typeof launchInstaller !== 'function') return Promise.resolve(getState());
    return run('install', async () => {
      const file = ready;
      publish({ phase: 'verifying', message: 'Rechecking the installer before updating…' });
      try { await verifyReadyFile(file); }
      catch {
        ready = null;
        await removeOwnedDirectory(file.directory);
        return publish({ ok: false, phase: 'error', downloaded: false, assetVerification: 'not-performed', message: 'The saved installer changed or is missing. Download the update again before installing.' });
      }
      if (disposed) return getState();
      publish({ phase: 'installing', message: `Installing Olanga ${file.version}. Olanga will close and restart…` });
      try {
        // Only this callback can launch an executable. Both the path and hash
        // are main-process state, never values received over renderer IPC.
        await launchInstaller(file.filePath, file.version);
        return getState();
      } catch {
        return publish({ ok: false, phase: 'ready', message: 'The installer could not start. Olanga is still open; you can try Install & restart again.' });
      }
    });
  }

  function cancel() {
    if (active?.kind === 'download') active.controller.abort('cancelled');
    return active?.kind === 'download' ? active.promise : Promise.resolve(getState());
  }
  async function dispose() {
    disposed = true;
    if (active?.kind === 'download') active.controller.abort('cancelled');
    if (active) await active.promise.catch(() => {});
  }
  return { check, getState, download, cancel, install, dispose };
}

module.exports = { createManualUpdater, createElectronUpdateFetch, parseChecksum, isTrustedDownloadUrl };
