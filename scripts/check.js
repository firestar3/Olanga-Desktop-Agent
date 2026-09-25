const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const lock = require('../package-lock.json');
if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version) throw new Error('Package and lockfile versions differ');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== 'v' + pkg.version) throw new Error('Release tag must match package.json version');
const required = ['main.js', 'preload.js', 'index.html', 'styles.css', 'desktop-workflows.css', 'status-indicator.html', 'status-indicator.js', 'status-indicator.css', 'status-indicator-preload.js', 'desktop/automation.js', 'desktop/input-helper.ps1', 'desktop/status-overlay.js', 'shared/quick-actions.js', 'shared/action-plan.js', 'js/desktop-workflows.js', 'icon.png', 'vosk-model-v2.tar.gz'];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error('Missing application asset: ' + file);
}
for (const file of ['status-indicator.js', 'status-indicator.css', 'desktop-workflows.css', 'desktop/**/*']) {
  if (!pkg.build.files.includes(file)) throw new Error('Missing packaged asset: ' + file);
}
if (!pkg.build.asarUnpack.includes('desktop/*.ps1')) throw new Error('Native helper must be outside ASAR');
const modelHeader = Buffer.alloc(2);
const modelFile = fs.openSync(path.join(root, 'vosk-model-v2.tar.gz'), 'r');
fs.readSync(modelFile, modelHeader, 0, 2, 0);
fs.closeSync(modelFile);
if (modelHeader[0] !== 0x1f || modelHeader[1] !== 0x8b) throw new Error('Vosk model must be a gzip archive, not a Git LFS pointer');
let count = 0;
function checkDirectory(relative) {
  for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const file = path.join(relative, item.name);
    if (item.isDirectory()) checkDirectory(file);
    else if (item.name.endsWith('.js')) checkFile(file);
  }
}
function checkFile(file) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(file + ': ' + (result.stderr || result.error?.message));
  count++;
}
for (const file of ['main.js', 'preload.js', 'status-indicator.js', 'status-indicator-preload.js']) checkFile(file);
for (const dir of ['js', 'shared', 'desktop']) checkDirectory(dir);
console.log('Checked ' + count + ' JavaScript files, release version and installer assets.');
