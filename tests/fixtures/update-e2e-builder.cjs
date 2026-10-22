// Deliberately separate Windows identity: this installer must never replace a
// user's Olanga, shortcuts, auto-start entry, or normal NSIS registry keys.
const path = require('node:path');
const packageMetadata = require('../../package.json');
const production = packageMetadata.build;
const version = process.env.OLANGA_UPDATE_FIXTURE_VERSION || packageMetadata.version;
if (!['1.5.2', '1.6.0', packageMetadata.version].includes(version)) throw new Error('Unknown updater fixture version.');
module.exports = {
  ...production, extends: null,
  // Test-only payloads need no expensive recompression; NSIS install/restart is real.
  compression: 'store',
  appId: 'com.aarav.olanga.update-e2e-fixture',
  productName: 'Olanga Update E2E Fixture',
  executableName: 'OlangaUpdateFixture',
  electronVersion: process.env.OLANGA_UPDATE_FIXTURE_ELECTRON || packageMetadata.devDependencies.electron,
  electronDist: process.env.OLANGA_UPDATE_FIXTURE_ELECTRON_DIST || undefined,
  extraMetadata: { name: 'olanga-update-e2e-fixture', version, main: 'tests/fixtures/update-e2e-host.js' },
  directories: { output: path.join('build', 'qa', `update-fixture-${version}`) },
  files: [...production.files, 'tests/fixtures/update-e2e-host.js'],
  nsis: { ...production.nsis, guid: 'd2e33a92-193e-46ee-87bc-0d079f2471a2',
    oneClick: false, perMachine: false, allowElevation: false,
    createDesktopShortcut: false, createStartMenuShortcut: false,
    shortcutName: 'Olanga Update E2E Fixture', uninstallDisplayName: 'Olanga Update E2E Fixture',
    runAfterFinish: false, deleteAppDataOnUninstall: false,
  },
};
