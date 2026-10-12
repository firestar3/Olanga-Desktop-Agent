const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = file => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');

test('the renderer bridge has no Terminal or freeform command execution surface', async () => {
  let api;
  const calls = [];
  vm.runInNewContext(source('preload.js'), {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'electronAPI'); api = value; } },
        ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); } },
      };
    },
  });
  assert.ok(api);
  for (const name of ['executeCommand', 'createTerminalSession', 'executeTerminalSessionCommand', 'closeTerminalSession']) assert.equal(Object.hasOwn(api, name), false);
  await api.openApp('Spotify');
  await api.mediaControl('SET_VOLUME', true, 75);
  await api.companionRequest({ action: 'editor.runTask', id: 'existing-task-id' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['open-app', 'Spotify'], ['media-control', 'SET_VOLUME', true, 75],
    ['companion-request', { action: 'editor.runTask', id: 'existing-task-id' }],
  ]);
});

test('the main process registers no Terminal session or freeform command IPC handlers', () => {
  const main = source('main.js');
  const channels = [...main.matchAll(/trustedMainIpc\.handle\(['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.equal(channels.includes('execute-command'), false);
  assert.equal(channels.some(channel => channel.startsWith('terminal-session-')), false);
  for (const retained of ['open-app', 'close-app', 'arrange-app', 'media-control', 'secure-store-get', 'secure-store-set', 'update-install']) assert.ok(channels.includes(retained), `${retained} must remain available`);
  assert.doesNotMatch(main, /function (?:createTerminalSession|drainTerminalSession)\b/);
});
