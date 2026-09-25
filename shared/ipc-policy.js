const { pathToFileURL } = require('url');

function isTrustedMainFrame(event, window, entryPath) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents) return false;
  const frame = event.senderFrame;
  return !!frame && frame === window.webContents.mainFrame && frame.url === pathToFileURL(entryPath).href;
}

const STORE_KEYS = new Set(['gemini_api_keys', 'nvidia_api_key', 'app_preferences']);
function validateStoreKey(key) {
  if (typeof key !== 'string' || !STORE_KEYS.has(key)) throw new Error('Unknown secure store key');
  return key;
}

module.exports = { isTrustedMainFrame, validateStoreKey };
