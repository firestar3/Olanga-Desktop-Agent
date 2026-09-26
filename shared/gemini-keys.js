(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaGeminiKeys = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_KEYS = 50;
  const MAX_KEY_LENGTH = 512;

  // Tolerate old saved lists, but preserve one canonical order everywhere a
  // numeric key index is used: settings, the main process and provider retries.
  function normalizeSavedKeys(value) {
    const source = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    const keys = [], seen = new Set();
    for (const item of source) {
      if (typeof item !== 'string' || item.length > MAX_KEY_LENGTH || /[\r\n\x00]/.test(item)) continue;
      const key = item.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      if (keys.length === MAX_KEYS) break;
    }
    return keys;
  }

  function validateCandidateKeys(value) {
    if (!Array.isArray(value) || value.length > MAX_KEYS) throw new Error('Save no more than 50 Gemini API keys.');
    const keys = normalizeSavedKeys(value);
    if (keys.length !== value.length || value.some((key, index) => key !== keys[index])) {
      throw new Error('Use different Gemini API keys, each no longer than 512 characters, without surrounding spaces or line breaks.');
    }
    return keys;
  }

  return { normalizeSavedKeys, validateCandidateKeys, MAX_KEYS, MAX_KEY_LENGTH };
});
