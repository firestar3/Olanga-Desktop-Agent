const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const resources = path.join(path.resolve(root, process.env.OLANGA_BUILD_DIR || 'dist'), 'win-unpacked/resources');
const archive = path.join(resources, 'app.asar');
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const files = ['main.js', 'preload.js', 'index.html', 'styles.css', 'desktop-workflows.css', 'status-indicator.html', 'status-indicator.js', 'status-indicator.css', 'status-indicator-preload.js'];
function addDirectory(folder) { for (const entry of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) { const file = folder + '/' + entry.name; if (entry.isDirectory()) addDirectory(file); else if (entry.isFile()) files.push(file); } }
for (const folder of ['js', 'shared', 'desktop', 'extensions']) addDirectory(folder);
files.push('docs/PHONE_REMOTE.md');
for (const file of files.filter(file => file.startsWith('extensions/'))) assert.equal(hash(fs.readFileSync(path.join(resources, file))), hash(fs.readFileSync(path.join(root, file))), 'Missing or stale installable companion file: ' + file);
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file));
  const packaged = asar.extractFile(archive, path.normalize(file));
  assert.equal(hash(packaged), hash(source), 'Missing or stale packaged file: ' + file);
}
for (const helper of fs.readdirSync(path.join(root, 'desktop')).filter(file => file.endsWith('.ps1'))) {
  assert.ok(fs.existsSync(path.join(resources, 'app.asar.unpacked/desktop', helper)), 'Native helper is not unpacked: ' + helper);
}
assert.equal(hash(fs.readFileSync(path.join(resources, 'vosk-model-v2.tar.gz'))), hash(fs.readFileSync(path.join(root, 'vosk-model-v2.tar.gz'))), 'Offline model is missing or stale');
const installedPackage = JSON.parse(asar.extractFile(archive, 'package.json').toString());
assert.equal(installedPackage.version, require('../package.json').version);
console.log('Verified ' + files.length + ' packaged source files, native helper, offline model and version ' + installedPackage.version + '.');
