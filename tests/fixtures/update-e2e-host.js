// Packaged ONLY by update-e2e-builder.cjs. The normal release excludes tests/.
// Real production main/preload/renderer/manual updater and real NSIS installation;
// fixture release responses stream local installer bytes through the normal
// download, SHA-256 verification, installer, and usable-restart path.
const { app, BrowserWindow, ipcMain, session, net, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const installation = path.dirname(app.getPath('exe'));
const root = path.dirname(installation);
assert.equal(path.basename(app.getPath('exe')), 'OlangaUpdateFixture.exe');
assert.match(path.basename(root), /^olanga-update-e2e-[a-zA-Z0-9]+$/);
assert.equal(fs.realpathSync(path.dirname(root)).toLowerCase(), fs.realpathSync(app.getPath('temp')).toLowerCase());
const config = JSON.parse(fs.readFileSync(path.join(root, 'e2e-config.json'), 'utf8'));
assert.equal(config.fixture, 'olanga-update-e2e-v1');
assert.equal(path.resolve(config.installation).toLowerCase(), installation.toLowerCase());
assert.equal(config.targetVersion, '1.6.0');
const assetPath = path.join(root, 'assets', 'Olanga-Setup-1.6.0.exe');
const profile = path.join(root, 'profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.disableHardwareAcceleration();
const originalSetName = app.setName.bind(app);
app.setName = () => originalSetName('olanga-update-e2e-fixture');
const originalAppId = app.setAppUserModelId.bind(app);
app.setAppUserModelId = () => originalAppId('com.aarav.olanga.update-e2e-fixture');
app.getLoginItemSettings = () => ({ openAtLogin: false });
app.setLoginItemSettings = () => { throw new Error('Login settings disabled in updater fixture.'); };
globalShortcut.register = () => true;
const reportPath = path.join(root, 'journey.json');
const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : {
  passed: false, checks: [], calls: [], requests: [], forbidden: [], rendererErrors: [], versions: [],
  coverage: { realNsis: true, isolatedWindowsIdentity: true, realProductionUpdater: true,
    realProductionRenderer: true, fixtureTransport: true, liveGitHub: false, productionUserProfile: false,
    codeSigned: false, microphone: false, providers: false },
};
report.versions.push(app.getVersion());
let main, finished = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const writeReport = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
function fail(error) { if (finished) return; finished = true; report.error = error.stack || String(error); writeReport(); app.exit(1); }
process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
const timeout = setTimeout(() => fail(new Error('Updater fixture renderer exceeded its bounded deadline.')), 180000);
const assetSize = fs.statSync(assetPath).size;
const assetHash = crypto.createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex');
const filename = path.basename(assetPath), checksums = `${assetHash}  ${filename}\n`;
const releaseBase = 'https://github.com/firestar3/Olanga-Desktop-Agent/releases';
const downloadBase = releaseBase + '/download/v1.6.0/';
const metadata = { tag_name: 'v1.6.0', draft: false, prerelease: false, html_url: releaseBase + '/tag/v1.6.0', assets: [
  { name: filename, state: 'uploaded', size: assetSize, browser_download_url: downloadBase + filename, digest: 'sha256:' + assetHash },
  { name: 'SHA256SUMS', state: 'uploaded', size: Buffer.byteLength(checksums), browser_download_url: downloadBase + 'SHA256SUMS' },
] };
async function fixtureFetch(url, options = {}) {
  const requested = String(url); report.requests.push(requested); writeReport();
  if (requested === 'https://api.github.com/repos/firestar3/Olanga-Desktop-Agent/releases/latest') return new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } });
  if (requested === downloadBase + 'SHA256SUMS') return new Response(checksums, { headers: { 'content-length': String(Buffer.byteLength(checksums)) } });
  if (requested === downloadBase + filename) {
    const stream = fs.createReadStream(assetPath, { highWaterMark: 64 * 1024 });
    options.signal?.addEventListener('abort', () => stream.destroy(new Error('cancelled')), { once: true });
    return new Response(Readable.toWeb(stream), { headers: { 'content-length': String(assetSize) } });
  }
  report.forbidden.push('network:' + requested); throw new Error('External network is disabled in updater fixture.');
}
net.fetch = fixtureFetch;
globalThis.fetch = fixtureFetch;
const updater = require('../../desktop/manual-updater');
updater.createElectronUpdateFetch = () => fixtureFetch;
const unsafe = new Set(['provider-generate', 'provider-generate-stream', 'nvidia-tts-config', 'nvidia-tts-synthesize', 'open-app', 'arrange-app', 'close-app', 'play-spotify', 'reload-spotify', 'media-control', 'desktop-capture', 'desktop-run', 'desktop-undo', 'execute-command', 'fetch-news-bundle', 'open-external', 'set-open-at-login']);
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, (event, ...args) => {
  if (unsafe.has(channel)) { report.forbidden.push(channel); throw new Error('External action disabled in updater fixture.'); }
  if (['check-release', 'update-download', 'update-install', 'update-renderer-ready'].includes(channel)) { report.calls.push(channel); writeReport(); }
  return callback(event, ...args);
});
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, _file, error) => report.rendererErrors.push(error.message));
  contents.on('render-process-gone', (_event, details) => report.rendererErrors.push('Renderer stopped: ' + details.reason));
});
app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => { report.forbidden.push('permission:' + permission); callback(false); });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (detail, callback) => { report.forbidden.push('browser-network:' + new URL(detail.url).origin); callback({ cancel: true }); });
});
require('../../main');
async function evaluate(fn, ...args) { return main.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true); }
async function waitFor(predicate, message, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (await predicate()) return; await pause(75); }
  throw new Error(message);
}
async function click(selector) {
  await evaluate(selector => { const node = document.querySelector(selector); if (!node || !node.getClientRects().length || node.disabled) throw new Error('Missing usable control: ' + selector); node.scrollIntoView({ block: 'nearest' }); node.focus(); node.click(); }, selector);
}
function check(name, condition) { report.checks.push({ name, passed: !!condition }); writeReport(); assert.ok(condition, name); }
async function openUpdates() { await click('#workspaceOpen'); await click('[data-workspace-tab="3"]'); }
app.whenReady().then(async () => {
  await waitFor(() => { main = BrowserWindow.getAllWindows().find(win => /[\\/]index\.html$/.test(win.webContents.getURL())); return main && !main.webContents.isLoading(); }, 'Main renderer did not load.');
  await waitFor(() => evaluate(() => window.OlangaAppInitialized === true && !!window.OlangaWorkspace), 'Production initialization did not finish.');
  main.setContentSize(1050, 760);
  if (app.getVersion() === '1.5.2') {
    check('First launch performs no automatic update check or download', report.requests.length === 0);
    await click('#startLocalBtn');
    await click('[data-screen="settingsScreen"]');
    await evaluate(() => { const city = document.getElementById('cityInput'); city.value = 'Fixture City'; city.dispatchEvent(new Event('input', { bubbles: true })); const accent = document.getElementById('appearanceAccentSelect'); accent.value = 'blue'; accent.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => evaluate(() => document.getElementById('preferencesSaveStatus').dataset.state === 'saved'), 'Fixture preference save did not complete.');
    await click('[data-screen="mainScreen"]'); await openUpdates();
    await click('#checkRelease');
    await waitFor(() => evaluate(() => !document.getElementById('downloadUpdate').hidden), 'Checked release did not offer download.');
    check('Check offers manual download and has not started the installer', report.calls.filter(value => value === 'update-download').length === 0 && !report.calls.includes('update-install'));
    await click('#downloadUpdate');
    await waitFor(() => evaluate(() => !document.getElementById('installUpdate').hidden && !document.getElementById('installUpdate').disabled), 'Downloaded installer did not verify.', 90000);
    const state = await evaluate(() => window.electronAPI.getUpdateState());
    check('Real installer bytes passed SHA-256 verification before install', state.phase === 'ready' && state.assetVerification === 'sha256-verified');
    check('Download has not installed without the separate action', !report.calls.includes('update-install'));
    report.baselineComplete = true; report.expectedAssetHash = assetHash; writeReport();
    await click('#installUpdate');
  } else {
    check('Supervisor reopened the requested version', app.getVersion() === '1.6.0');
    await waitFor(() => main.isVisible() && !main.isMinimized(), 'Restarted window did not become visible.');
    check('Restarted main window is visible and initialized', main.isVisible() && !main.isMinimized());
    await waitFor(async () => { const state = await evaluate(() => window.electronAPI.getUpdateState()); return state.installationResult?.ok === true; }, 'Updater did not confirm usable restart.', 60000);
    await click('[data-screen="settingsScreen"]');
    check('The NSIS update preserves local preferences', await evaluate(() => document.getElementById('cityInput').value === 'Fixture City' && document.documentElement.dataset.accent === 'blue'));
    await click('[data-screen="mainScreen"]'); await openUpdates();
    check('Apps shows a completed usable restart', await evaluate(() => /installed and ready/.test(document.getElementById('releaseStatus').textContent)));
    check('Update remains manual after restart', report.requests.filter(url => url.includes('/releases/latest')).length === 1 && report.calls.filter(channel => channel === 'update-install').length === 1);
    check('No provider, microphone or unrelated external action occurred', report.forbidden.length === 0 && report.rendererErrors.length === 0);
    fs.writeFileSync(path.join(root, 'reopened.png'), (await main.webContents.capturePage()).toPNG());
    report.passed = true; report.finishedAt = new Date().toISOString(); finished = true; clearTimeout(timeout); writeReport(); app.quit();
  }
}).catch(fail);
