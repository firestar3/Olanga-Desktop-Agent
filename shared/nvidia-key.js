(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaNvidiaKey = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizeNvidiaKey(value) {
    if (typeof value !== 'string') throw new Error('Enter your NVIDIA API key in Settings.');
    let key = value.trim();
    const unquote = text => /^(["']).*\1$/.test(text) ? text.slice(1, -1).trim() : text;
    key = unquote(unquote(key).replace(/^Bearer\s+/i, '')).trim();
    if (!key) return '';
    if (key.startsWith('AIza')) throw new Error('That looks like a Google key. Use a NVIDIA hosted API key from build.nvidia.com.');
    if (key.length > 4096 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(key)) {
      throw new Error('Paste only the NVIDIA API key, without a command, spaces or line breaks.');
    }
    return key;
  }
  return { normalizeNvidiaKey };
});
