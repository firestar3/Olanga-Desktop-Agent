const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isTrustedMainFrame, validateStoreKey } = require('../../shared/ipc-policy');

test('privileged IPC accepts only the exact app document and main frame', () => {
  const entry = path.resolve('index.html');
  const frame = { url: pathToFileURL(entry).href };
  const webContents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents };
  const event = { sender: webContents, senderFrame: frame };
  assert.equal(isTrustedMainFrame(event, window, entry), true);
  assert.equal(isTrustedMainFrame({ ...event, sender: {} }, window, entry), false);
  assert.equal(isTrustedMainFrame({ ...event, senderFrame: { ...frame } }, window, entry), false);
  frame.url = 'https://example.com/';
  assert.equal(isTrustedMainFrame(event, window, entry), false);
  assert.equal(isTrustedMainFrame(event, null, entry), false);
});

test('secure store rejects arbitrary keys and prototype property names', () => {
  assert.equal(validateStoreKey('gemini_api_keys'), 'gemini_api_keys');
  for (const key of ['__proto__', 'constructor', 'arbitrary', null, {}]) {
    assert.throws(() => validateStoreKey(key), /Unknown/);
  }
});
