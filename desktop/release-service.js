const RELEASES_URL = 'https://github.com/firestar3/Olanga-Desktop-Agent/releases';
const LATEST_API_URL = 'https://api.github.com/repos/firestar3/Olanga-Desktop-Agent/releases/latest';
const MAX_RESPONSE_BYTES = 256 * 1024;
function cancelBody(response) {
  try { void Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* Already closed/locked. */ }
}

function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split('.') || [];
  if (prerelease.some(part => /^\d+$/.test(part) && /^0\d/.test(part))) return null;
  return { version: value.replace(/^v/, ''), parts: match.slice(1, 4), prerelease };
}

function compareNumeric(left, right) { return left.length === right.length ? (left === right ? 0 : left < right ? -1 : 1) : left.length < right.length ? -1 : 1; }
function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue), right = parseVersion(rightValue);
  if (!left || !right) throw new Error('A valid semantic version is required.');
  for (let index = 0; index < 3; index++) {
    const difference = compareNumeric(left.parts[index], right.parts[index]);
    if (difference) return difference;
  }
  if (!left.prerelease.length || !right.prerelease.length) return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const a = left.prerelease[index], b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    if (a === b) continue;
    const numericA = /^\d+$/.test(a), numericB = /^\d+$/.test(b);
    if (numericA && numericB) return compareNumeric(a, b);
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function validateRelease(payload) {
  const parsed = parseVersion(payload?.tag_name);
  if (!parsed || parsed.prerelease.length || payload.draft !== false || payload.prerelease !== false || !Array.isArray(payload.assets) || payload.assets.length > 1000) throw new Error('invalid-release');
  let url, pathname;
  try { url = new URL(payload.html_url); pathname = decodeURIComponent(url.pathname); } catch { throw new Error('invalid-release'); }
  const prefix = '/firestar3/Olanga-Desktop-Agent/releases/tag/';
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || pathname.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase() || pathname.slice(prefix.length) !== payload.tag_name) throw new Error('invalid-release');
  const hasAsset = name => payload.assets.some(asset => asset && asset.name === name && asset.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0);
  return {
    version: parsed.version,
    url: RELEASES_URL + '/tag/' + encodeURIComponent(payload.tag_name),
    installerAvailable: hasAsset(`Olanga-Setup-${parsed.version}.exe`),
    checksumsAvailable: hasAsset('SHA256SUMS'),
  };
}

async function readBoundedJson(response, signal) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('response-too-large');
  const contentType = response.headers?.get?.('content-type');
  if (contentType && !/^application\/(?:[\w.-]+\+)?json\b/i.test(contentType)) throw new Error('invalid-response');
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const cancelReader = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancelReader, { once: true });
    const decoder = new TextDecoder();
    let count = 0;
    text = '';
    try {
      for (;;) {
        if (signal.aborted) throw new Error('timeout');
        const { done, value } = await reader.read();
        if (done) break;
        count += value.byteLength;
        if (count > MAX_RESPONSE_BYTES) throw new Error('response-too-large');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) { reader.cancel().catch(() => {}); throw error; }
    finally { signal.removeEventListener('abort', cancelReader); reader.releaseLock(); }
  } else {
    text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('response-too-large');
  }
  if (signal.aborted) throw new Error('timeout');
  try { return JSON.parse(text); } catch { throw new Error('invalid-response'); }
}

function createReleaseService({ getInstalledVersion = () => require('../package.json').version, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000, cacheTtlMs = 15 * 60 * 1000, failureCacheTtlMs = 60 * 1000 } = {}) {
  let cached = null;
  let pending = null;
  const base = installedVersion => ({ installedVersion, url: RELEASES_URL, channel: 'stable', automaticUpdatesEnabled: false, downloaded: false, assetVerification: 'not-performed', signingVerified: false });
  async function checkOnce() {
    const installedVersion = String(getInstalledVersion());
    if (!parseVersion(installedVersion)) return { ...base(installedVersion), ok: false, status: 'invalid-installed-version', message: 'Olanga could not compare this build version. Open GitHub Releases to check manually.' };
    const abort = new AbortController();
    let timer;
    try {
      const result = await Promise.race([
        (async () => {
          const response = await fetchImpl(LATEST_API_URL, { method: 'GET', redirect: 'error', signal: abort.signal, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Olanga-Desktop-Agent' } });
          try {
            if (abort.signal.aborted) throw new Error('timeout');
            if (response.status === 404) return { ...base(installedVersion), ok: true, status: 'no-release', message: 'No stable Olanga release is published on GitHub yet.' };
            if (response.status === 403 || response.status === 429) throw new Error('rate-limited');
            if (!response.ok) throw new Error('server-unavailable');
            const release = validateRelease(await readBoundedJson(response, abort.signal));
            const difference = compareVersions(release.version, installedVersion);
            const message = difference > 0 ? `Olanga ${release.version} is available. Open the release page to review it and update manually.` : difference === 0 ? `Olanga ${installedVersion} matches the latest stable release.` : `Installed Olanga ${installedVersion} is newer than the latest stable release (${release.version}).`;
            return { ...base(installedVersion), ...release, ok: true, status: difference > 0 ? 'update-available' : difference === 0 ? 'up-to-date' : 'ahead', updateAvailable: difference > 0, message: message + (difference > 0 && !release.installerAvailable ? ' A Windows installer is not listed in that release yet.' : '') };
          } finally { cancelBody(response); }
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('timeout')); }, timeoutMs); }),
      ]);
      return result;
    } catch (error) {
      const status = abort.signal.aborted || error.message === 'timeout' ? 'timeout' : error.message === 'rate-limited' ? 'rate-limited' : ['invalid-release', 'invalid-response', 'response-too-large'].includes(error.message) ? 'invalid-response' : 'unavailable';
      const message = status === 'timeout' ? 'The update check timed out. You can open GitHub Releases or try again later.' : status === 'rate-limited' ? 'GitHub is limiting update checks. Try again later or open the release page.' : status === 'invalid-response' ? 'GitHub returned release data that Olanga could not validate. Open the release page to check manually.' : 'Olanga could not reach GitHub Releases. Local app controls are still available.';
      return { ...base(installedVersion), ok: false, status, message };
    } finally { clearTimeout(timer); abort.abort(); }
  }
  return {
    async check() {
      if (cached && now() < cached.expiresAt) return { ...cached.result, cached: true };
      if (pending) return { ...await pending, cached: true };
      pending = checkOnce().then(result => {
        const final = { ...result, checkedAt: new Date(now()).toISOString(), cached: false };
        cached = { result: final, expiresAt: now() + (result.ok ? cacheTtlMs : failureCacheTtlMs) };
        return final;
      });
      try { return { ...await pending }; } finally { pending = null; }
    },
  };
}

module.exports = { createReleaseService, compareVersions, parseVersion, validateRelease, RELEASES_URL, LATEST_API_URL };
