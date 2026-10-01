'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { verifyInstallerSignature, validateSigningReport, configuredPublisher, normalizeThumbprint } = require('../desktop/signing-policy');
async function main() {
  const version = require('../package.json').version;
  const root = path.resolve(__dirname, '..');
  const dist = path.resolve(root, process.env.OLANGA_BUILD_DIR || 'dist');
  if (!dist.toLowerCase().startsWith((root + path.sep).toLowerCase())) throw new Error('The signing output directory must be inside this workspace.');
  const installers = fs.readdirSync(dist).filter(name => /^Olanga-Setup-.+\.exe$/.test(name));
  if (installers.length !== 1 || installers[0] !== `Olanga-Setup-${version}.exe`) throw new Error('Expected exactly one version-matched installer.');
  const pin = normalizeThumbprint(process.env.OLANGA_SIGNING_PUBLISHER_THUMBPRINT || null);
  if (configuredPublisher() !== pin) throw new Error('Packaged publisher policy differs from the configured release policy. Run prepare-signing before building.');
  const [installer, application] = await Promise.all([verifyInstallerSignature(path.join(dist, installers[0])), verifyInstallerSignature(path.join(dist, 'win-unpacked/Olanga.exe'))]);
  const report = validateSigningReport({ expectedSigned: process.env.OLANGA_SIGNING_EXPECTED === 'true', expectedThumbprint: pin, installer, application });
  fs.writeFileSync(path.join(dist, 'SIGNING-REPORT.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Verified release signing policy: ${report.signing}${report.publisherPinned ? ', exact publisher certificate matched' : ''}.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
