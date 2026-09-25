(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaGemini = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const REASONING_MODEL = 'gemini-3.5-flash';
  const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
  const RESPONSE_MODEL = 'gemini-3.5-flash-lite';
  function buildRequest(messages, options = {}) {
    if (!Array.isArray(messages) || !messages.length || messages.length > 32) throw new Error('Invalid Gemini conversation.');
    const system = [], contents = [];
    let textLength = 0, images = 0;
    for (const message of messages) {
      if (!message || !['system', 'user', 'assistant'].includes(message.role)) throw new Error('Invalid Gemini message role.');
      const parts = (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content);
      if (!Array.isArray(parts) || !parts.length || parts.length > 8) throw new Error('Invalid Gemini message content.');
      const converted = parts.map(part => {
        if (part?.type === 'text' && typeof part.text === 'string') {
          textLength += part.text.length;
          if (textLength > 120000) throw new Error('Gemini request is too large.');
          return { text: part.text };
        }
        const match = message.role === 'user' && typeof part?.image_url?.url === 'string'
          && /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(part.image_url.url);
        if (part?.type !== 'image_url' || !match || ++images > 3 || match[2].length > 8000000) throw new Error('Only bounded inline screenshots are supported.');
        return { inline_data: { mime_type: match[1], data: match[2] } };
      });
      if (message.role === 'system') system.push(...converted);
      else contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: converted });
    }
    if (!contents.length) throw new Error('Gemini needs a user message.');
    const maxOutputTokens = options.maxTokens ?? 6000, temperature = options.temperature ?? 0.2;
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16384 || !Number.isFinite(temperature) || temperature < 0 || temperature > 1) throw new Error('Invalid Gemini generation settings.');
    return {
      ...(system.length ? { system_instruction: { parts: system } } : {}), contents,
      generationConfig: { temperature, maxOutputTokens, thinkingConfig: { thinkingLevel: 'LOW' },
        ...(options.schema ? { responseMimeType: 'application/json', responseSchema: options.schema } : {}) }
    };
  }
  return { REASONING_MODEL, FALLBACK_MODEL, RESPONSE_MODEL, buildRequest };
});
