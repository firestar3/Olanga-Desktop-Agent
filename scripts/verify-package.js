const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const resources = path.join(root, 'dist/win-unpacked/resources');
const archive = path.join(resources, 'app.asar');
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const files = ['main.js', 'preload.js', 'index.html', 'styles.css', 'desktop-workflows.css', 'status-indicator.html', 'status-indicator.js', 'status-indicator.css', 'status-indicator-preload.js'];
for (const folder of ['js', 'shared', 'desktop']) {
  for (const file of fs.readdirSync(path.join(root, folder))) {
    if (fs.statSync(path.join(root, folder, file)).isFile()) files.push(folder + '/' + file);
  }
}
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file));
  const packaged = asar.extractFile(archive, file);
  assert.equal(hash(packaged), hash(source), 'Missing or stale packaged file: ' + file);
}
assert.ok(fs.existsSync(path.join(resources, 'app.asar.unpacked/desktop/input-helper.ps1')), 'Native helper is not unpacked');
assert.equal(hash(fs.readFileSync(path.join(resources, 'vosk-model-v2.tar.gz'))), hash(fs.readFileSync(path.join(root, 'vosk-model-v2.tar.gz'))), 'Offline model is missing or stale');
const installedPackage = JSON.parse(asar.extractFile(archive, 'package.json').toString());
assert.equal(installedPackage.version, require('../package.json').version);
console.log('Verified ' + files.length + ' packaged source files, native helper, offline model and version ' + installedPackage.version + '.');
