const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');
const { createReleaseService, compareVersions, parseVersion, RELEASES_URL, LATEST_API_URL } = require('../../desktop/release-service');

function release(version = '1.4.0') {
  return {
    tag_name: 'v' + version, html_url: RELEASES_URL + '/tag/v' + version,
    draft: false, prerelease: false,
    assets: [
      { name: `Olanga-Setup-${version}.exe`, state: 'uploaded', size: 1234 },
      { name: 'SHA256SUMS', state: 'uploaded', size: 100 },
    ],
  };
}
function reply(value, status = 200, headers = {}) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } }); }
function service(fetchImpl, options = {}) { return createReleaseService({ getInstalledVersion: () => '1.3.1', fetchImpl, ...options }); }

test('semantic comparison handles multi-digit versions, prereleases and build metadata', () => {
  for (const [higher, lower] of [['1.10.0', '1.9.99'], ['2.0.0', '1.999.0'], ['1.0.0', '1.0.0-rc.2'], ['1.0.0-rc.10', '1.0.0-rc.2'], ['1.0.0-beta', '1.0.0-1'], ['1.0.0-beta.1', '1.0.0-beta'], ['999999999999999999999.0.0', '999999999999999999998.0.0']]) {
    assert.equal(compareVersions(higher, lower), 1, higher);
    assert.equal(compareVersions(lower, higher), -1, lower);
  }
  assert.equal(compareVersions('v1.3.1+build.7', '1.3.1+build.99'), 0);
  for (const value of ['1.2', '01.2.3', '1.2.3-beta.01', 'v1.2.3/extra', '1.2.3 ', 'latest', null]) assert.equal(parseVersion(value), null, String(value));
});

test('manual check reads only the fixed public metadata endpoint and links to its validated release', async () => {
  const calls = [];
  const result = await service(async (url, options) => { calls.push({ url, options }); return reply(release()); }).check();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, LATEST_API_URL);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.body, undefined);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.version, '1.4.0');
  assert.equal(result.url, RELEASES_URL + '/tag/v1.4.0');
  assert.equal(result.installerAvailable, true);
  assert.equal(result.checksumsAvailable, true);
  assert.equal(result.assetVerification, 'not-performed');
  assert.equal(result.signingVerified, false);
  assert.equal(result.downloaded, false);
  assert.equal(result.automaticUpdatesEnabled, false);
  const canonicalCase = await service(async () => reply({ ...release(), html_url: 'https://github.com/FireStar3/Olanga-Desktop-Agent/releases/tag/v1.4.0' })).check();
  assert.equal(canonicalCase.ok, true);
  assert.equal(canonicalCase.url, RELEASES_URL + '/tag/v1.4.0');
});

test('the same or older release cannot be reported as an available update', async () => {
  for (const [version, status] of [['1.3.1', 'up-to-date'], ['1.3.0', 'ahead']]) {
    const result = await service(async () => reply(release(version))).check();
    assert.equal(result.status, status);
    assert.equal(result.updateAvailable, false);
  }
});

test('release and asset metadata cannot claim signature or checksum verification', async () => {
  const payload = release();
  payload.assets = [{ name: 'SHA256SUMS', state: 'new', size: 0 }, { name: 'Olanga-Setup-0.1.0.exe', state: 'uploaded', size: 100 }];
  const result = await service(async () => reply(payload)).check();
  assert.equal(result.installerAvailable, false);
  assert.equal(result.checksumsAvailable, false);
  assert.match(result.message, /installer is not listed/);
  assert.equal(result.assetVerification, 'not-performed');
});

test('untrusted URLs, malformed versions, drafts and prereleases are rejected', async () => {
  const invalid = [
    { html_url: 'https://attacker.example/v1.4.0' },
    { html_url: 'https://github.com/firestar3/OtherRepo/releases/tag/v1.4.0' },
    { html_url: RELEASES_URL + '/tag/v1.4.0?redirect=elsewhere' },
    { html_url: 'https://username@github.com/firestar3/Olanga-Desktop-Agent/releases/tag/v1.4.0' },
    { html_url: RELEASES_URL + '/tag/v1.5.0' },
    { tag_name: 'nightly' }, { draft: true }, { prerelease: true }, { assets: {} },
    { tag_name: 'v1.4.0-beta.1', html_url: RELEASES_URL + '/tag/v1.4.0-beta.1' },
  ];
  for (const changes of invalid) {
    const result = await service(async () => reply({ ...release(), ...changes })).check();
    assert.equal(result.ok, false, JSON.stringify(changes));
    assert.equal(result.status, 'invalid-response');
    assert.equal(result.url, RELEASES_URL);
    assert.equal(result.updateAvailable, undefined);
  }
});

test('manual clicks reuse cached checks and coalesce in-flight requests', async () => {
  let now = 1000, calls = 0, finish;
  const checker = service(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, { now: () => now, cacheTtlMs: 100 });
  const first = checker.check();
  const second = checker.check();
  assert.equal(calls, 1);
  finish(reply(release()));
  assert.equal((await first).cached, false);
  assert.equal((await second).cached, true);
  const cached = await checker.check();
  assert.equal(cached.cached, true);
  cached.message = 'Changed by caller';
  assert.notEqual((await checker.check()).message, cached.message);
  now += 101;
  const expired = checker.check();
  assert.equal(calls, 2);
  finish(reply(release()));
  await expired;
});

test('network and rate-limit failures are cached briefly without claiming up-to-date', async () => {
  let calls = 0, now = 1000;
  const checker = service(async () => { calls++; return reply({ message: 'Rate limited' }, 429); }, { now: () => now, failureCacheTtlMs: 100 });
  const failure = await checker.check();
  assert.equal(failure.ok, false);
  assert.equal(failure.status, 'rate-limited');
  assert.equal(failure.updateAvailable, undefined);
  await checker.check(); assert.equal(calls, 1);
  now += 101; await checker.check(); assert.equal(calls, 2);
  const offline = await service(async () => { throw new Error('offline'); }).check();
  assert.equal(offline.status, 'unavailable');
  assert.match(offline.message, /Local app controls/);
});

test('an absent stable release and an invalid installed version remain distinct', async () => {
  const absent = await service(async () => reply({}, 404)).check();
  assert.equal(absent.status, 'no-release');
  assert.equal(absent.updateAvailable, undefined);
  let calls = 0;
  const invalid = await service(async () => { calls++; return reply(release()); }, { getInstalledVersion: () => 'dev' }).check();
  assert.equal(invalid.status, 'invalid-installed-version');
  assert.equal(calls, 0);
});

test('stalled requests and response bodies are bounded and aborted', async () => {
  let signal;
  const stalled = await service((_url, options) => { signal = options.signal; return new Promise(() => {}); }, { timeoutMs: 10 }).check();
  assert.equal(stalled.status, 'timeout');
  assert.equal(signal.aborted, true);
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const stalledBody = await service(async () => new Response(body, { headers: { 'content-type': 'application/json' } }), { timeoutMs: 10 }).check();
  assert.equal(stalledBody.status, 'timeout');
  assert.equal(cancelled, true);
});

test('oversized, non-JSON and malformed response bodies are rejected', async () => {
  for (const response of [
    reply(release(), 200, { 'content-length': String(300000) }),
    new Response('x'.repeat(300000), { headers: { 'content-type': 'application/json' } }),
    new Response('<html>not JSON</html>', { headers: { 'content-type': 'text/html' } }),
    new Response('{ broken', { headers: { 'content-type': 'application/json' } }),
  ]) {
    const result = await service(async () => response).check();
    assert.equal(result.status, 'invalid-response');
    assert.equal(result.ok, false);
  }
});

test('release status and header failures cancel unread bodies instead of leaving downloads active', async () => {
  for (const [status, headers, expected] of [
    [404, {}, 'no-release'], [429, {}, 'rate-limited'], [503, {}, 'unavailable'],
    [200, { 'content-length': '300000' }, 'invalid-response'],
    [200, { 'content-type': 'text/html' }, 'invalid-response'],
  ]) {
    let cancelled = 0;
    const http = new Response(new ReadableStream({ cancel() { cancelled++; } }), { status, headers });
    const result = await service(async () => http).check();
    assert.equal(result.status, expected);
    assert.equal(cancelled, 1, `HTTP ${status} must release its unread body`);
    assert.equal(http.body.locked, false);
  }
});

test('a release response arriving after timeout is cancelled and cannot replace the cached failure', async () => {
  let releaseFetch, cancelled = 0;
  const checker = service(() => new Promise(resolve => { releaseFetch = resolve; }), { timeoutMs: 10 });
  assert.equal((await checker.check()).status, 'timeout');
  const http = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } });
  releaseFetch(http);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1);
  assert.equal((await checker.check()).status, 'timeout');
});

test('release workflow publishes installer, checksums and honest signing metadata without replacing assets', () => {
  const workflow = yaml.load(fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8'));
  const steps = workflow.jobs.windows.steps;
  const build = steps.find(step => step.name === 'Build the installer');
  assert.ok(build.env.WIN_CSC_LINK && build.env.WIN_CSC_KEY_PASSWORD);
  assert.match(build.run, /forceCodeSigning=true/);
  assert.match(build.run, /signExecutable=false/);
  const upload = steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  for (const artifact of ['Olanga-Setup-*.exe', 'SHA256SUMS', 'RELEASE-METADATA.json']) assert.ok(upload.with.path.includes(artifact), artifact);
  const publish = steps.find(step => step.name === 'Attach installer and verification files to the release');
  assert.doesNotMatch(publish.run, /--clobber/);
  assert.match(publish.if, /refs\/tags\//);
});

test('workflow checksum step hashes actual unsigned fixture bytes and rejects a required missing signature', { skip: process.platform !== 'win32' }, () => {
  const workflow = yaml.load(fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8'));
  const metadataStep = workflow.jobs.windows.steps.find(step => step.name === 'Verify signing status and create release checksums').run;
  const tempRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'olanga-release-test-'));
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Node launched by PowerShell 7 can inherit its module path. Windows
  // PowerShell 5 must load its own built-in Security/Utility modules instead.
  const nativeEnvironment = { ...process.env, PSModulePath: path.join(path.dirname(powershell), 'Modules') };
  try {
    fs.mkdirSync(path.join(directory, 'dist/win-unpacked'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), '{"version":"9.8.7"}');
    const installer = path.join(directory, 'dist/Olanga-Setup-9.8.7.exe');
    const runScripts = Buffer.from(JSON.stringify(workflow.jobs.windows.steps.filter(step => step.run).map(step => step.run))).toString('base64');
    const parseWorkflow = `$runScripts = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${runScripts}')) | ConvertFrom-Json\nforeach ($runScript in $runScripts) { $tokens = $null; $parseErrors = $null; $null = [System.Management.Automation.Language.Parser]::ParseInput($runScript, [ref]$tokens, [ref]$parseErrors); if ($parseErrors.Count) { throw ($parseErrors.Message -join '; ') } }`;
    const buildFixture = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n${parseWorkflow}\nAdd-Type -TypeDefinition 'public class ReleaseFixture { public static void Main() {} }' -OutputAssembly '${installer.replace(/'/g, "''")}' -OutputType ConsoleApplication\nCopy-Item -LiteralPath '${installer.replace(/'/g, "''")}' -Destination 'dist/win-unpacked/Olanga.exe'\n$env:OLANGA_SIGNING_EXPECTED = 'false'\n$env:GITHUB_SHA = 'test-fixture'\n${metadataStep}`;
    const scriptPath = path.join(directory, 'verify-fixture.ps1');
    fs.writeFileSync(scriptPath, buildFixture);
    execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { cwd: directory, env: nativeEnvironment, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const expected = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
    assert.equal(fs.readFileSync(path.join(directory, 'dist/SHA256SUMS'), 'utf8'), `${expected}  Olanga-Setup-9.8.7.exe\n`);
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'dist/RELEASE-METADATA.json'), 'utf8'));
    assert.equal(metadata.sha256, expected);
    assert.equal(metadata.signing, 'unsigned');
    assert.equal(metadata.installerAuthenticodeStatus, 'NotSigned');
    assert.equal(metadata.appAuthenticodeStatus, 'NotSigned');
    assert.equal(metadata.automaticUpdatesEnabled, false);
    assert.equal(metadata.rollbackValidated, false);
    assert.match(fs.readFileSync(path.join(directory, 'dist/RELEASE-NOTES.md'), 'utf8'), /installer is unsigned/);
    fs.writeFileSync(scriptPath, `$ErrorActionPreference = 'Stop'\n$env:OLANGA_SIGNING_EXPECTED = 'true'\n${metadataStep}`);
    assert.throws(() => execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { cwd: directory, env: nativeEnvironment, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), error => /does not have a valid Authenticode signature/.test(String(error.stderr)));
  } finally {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(tempRoot + path.sep) && path.basename(resolved).startsWith('olanga-release-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
