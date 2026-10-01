'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
function normalizeThumbprint(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Invalid expected publisher thumbprint.');
  const normalized = value.replace(/[\s:]/g, '').toUpperCase();
  if (!/^[A-F0-9]{40}$/.test(normalized)) throw new Error('Expected publisher thumbprint must contain exactly 40 hexadecimal characters.');
  return normalized;
}
function configuredPublisher() {
  const config = require('./trusted-publisher.json');
  if (config.schema !== 1 || typeof config.required !== 'boolean') throw new Error('Invalid packaged publisher policy.');
  const thumbprint = normalizeThumbprint(config.thumbprint);
  if (config.required !== !!thumbprint) throw new Error('Incomplete packaged publisher policy.');
  return thumbprint;
}
function validateInstallerSignature(signature, expected) {
  const thumbprint = normalizeThumbprint(expected);
  if (!thumbprint) return false;
  if (signature?.status !== 'Valid' || normalizeThumbprint(signature.thumbprint) !== thumbprint) throw new Error('publisher-mismatch');
  return true;
}
function validateSigningReport({ expectedSigned, expectedThumbprint = null, installer, application }) {
  const pin = normalizeThumbprint(expectedThumbprint);
  if (typeof expectedSigned !== 'boolean' || (pin && !expectedSigned)) throw new Error('Publisher pin requires a signed build.');
  if (expectedSigned) {
    if (installer?.status !== 'Valid' || application?.status !== 'Valid') throw new Error('Signing was required, but the installer or application signature is not valid.');
    const installerThumbprint = normalizeThumbprint(installer.thumbprint), applicationThumbprint = normalizeThumbprint(application.thumbprint);
    if (!installerThumbprint || !applicationThumbprint || installerThumbprint !== applicationThumbprint) throw new Error('Installer and application must be signed by the same publisher certificate.');
    if (pin && installerThumbprint !== pin) throw new Error('The signing certificate does not match the expected publisher thumbprint.');
    return { signing: 'signed', installerAuthenticodeStatus: 'Valid', appAuthenticodeStatus: 'Valid', signerThumbprint: installerThumbprint, expectedPublisherThumbprint: pin, publisherPinned: !!pin };
  }
  if (installer?.status !== 'NotSigned' || application?.status !== 'NotSigned') throw new Error('An explicitly unsigned build has an unexpected signature status.');
  return { signing: 'unsigned', installerAuthenticodeStatus: 'NotSigned', appAuthenticodeStatus: 'NotSigned', signerThumbprint: null, expectedPublisherThumbprint: null, publisherPinned: false };
}
function verifyInstallerSignature(filePath, { spawnImpl = spawn, platform = process.platform, timeoutMs = 20000 } = {}) {
  if (platform !== 'win32' || typeof filePath !== 'string' || !path.isAbsolute(filePath)) return Promise.reject(new Error('Windows signature verification is unavailable.'));
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let child, output = '', settled = false, timer;
    function finish(error, value) {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { try { child?.kill(); } catch (_) {} reject(error); } else resolve(value);
    }
    try {
      const helper = path.join(__dirname, 'signature-helper.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      child = spawnImpl(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Path', filePath], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PSModulePath: path.join(path.dirname(executable), 'Modules') } });
      timer = setTimeout(() => finish(new Error('Windows signature verification timed out.')), timeoutMs);
      child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 65536) finish(new Error('Invalid Windows signature report.')); });
      child.stdout.on('error', () => finish(new Error('Windows signature verification failed.')));
      child.stderr.on('error', () => finish(new Error('Windows signature verification failed.'))); child.stderr.resume();
      child.once('error', () => finish(new Error('Windows signature verification failed.')));
      child.once('close', code => {
        if (code !== 0) { finish(new Error('Windows signature verification failed.')); return; }
        try { const result = JSON.parse(output.replace(/^\uFEFF/, '').trim()); if (typeof result.status !== 'string') throw new Error(); finish(null, { status: result.status, thumbprint: normalizeThumbprint(result.thumbprint) }); }
        catch (_) { finish(new Error('Invalid Windows signature report.')); }
      });
    } catch (_) { finish(new Error('Windows signature verification failed.')); }
  });
}
module.exports = { normalizeThumbprint, configuredPublisher, validateInstallerSignature, validateSigningReport, verifyInstallerSignature };
