'use strict';
const { normalizeSavedKeys } = require('../shared/gemini-keys');

// Provider requests and credentials stay in the main process. This service has
// no desktop tools: a retried generation can never replay an application action.
const MODELS = new Set(['gemini-3.5-flash', 'gemini-3.5-flash-lite']);
const LIMITS = Object.freeze({ requestBytes: 26000000, responseBytes: 2000000, text: 120000, inlineBytes: 24000000, concurrency: 4, timeoutMs: 90000, recent: 40 });
class ProviderServiceError extends Error {}
function fail(message, code = 'invalid-request', status = 0, name = 'Error') { return Object.assign(new ProviderServiceError(message), { code, status, name }); }
function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function fields(value, allowed) { if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('Invalid Gemini request.'); }
function integer(value, min, max) { return Number.isInteger(value) && value >= min && value <= max; }
function requestId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value); }
function validateRequest(input) {
  fields(input, ['requestId', 'model', 'body', 'timeoutMs', 'allowFallback', 'keyIndex']);
  if (!requestId(input.requestId) || !MODELS.has(input.model)) throw fail('Invalid Gemini request or unsupported model.');
  const timeoutMs = input.timeoutMs ?? 60000;
  if (!integer(timeoutMs, 1, LIMITS.timeoutMs) || (input.allowFallback !== undefined && typeof input.allowFallback !== 'boolean') || (input.keyIndex !== undefined && !integer(input.keyIndex, 0, 49))) throw fail('Invalid Gemini request options.');
  const body = input.body;
  fields(body, ['system_instruction', 'contents', 'generationConfig', 'tools']);
  let textLength = 0, inlineLength = 0, imageCount = 0, audioCount = 0;
  function parts(values, system = false) {
    if (!Array.isArray(values) || !values.length || values.length > 32) throw fail('Invalid Gemini message parts.');
    for (const part of values) {
      fields(part, ['text', 'inline_data']);
      if (typeof part.text === 'string' && part.inline_data === undefined) {
        textLength += part.text.length;
        if (textLength > LIMITS.text) throw fail('Gemini request text is too large.');
      } else if (!system && part.text === undefined && part.inline_data) {
        fields(part.inline_data, ['mime_type', 'data']);
        const { mime_type: mime, data } = part.inline_data;
        if (typeof data !== 'string' || !data.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw fail('Invalid inline Gemini media.');
        if (['image/png', 'image/jpeg'].includes(mime)) { if (++imageCount > 3 || data.length > 8000000) throw fail('Gemini screenshots exceed the request limit.'); }
        else if (mime === 'audio/wav') { if (++audioCount > 1 || data.length > LIMITS.inlineBytes) throw fail('Gemini audio exceeds the request limit.'); }
        else throw fail('Unsupported inline Gemini media.');
        inlineLength += data.length;
        if (inlineLength > LIMITS.inlineBytes) throw fail('Gemini media exceeds the request limit.');
      } else throw fail('Invalid Gemini message part.');
    }
  }
  if (body.system_instruction !== undefined) { fields(body.system_instruction, ['parts']); parts(body.system_instruction.parts, true); }
  if (!Array.isArray(body.contents) || !body.contents.length || body.contents.length > 32) throw fail('Invalid Gemini conversation.');
  for (const content of body.contents) {
    fields(content, ['role', 'parts']);
    if (content.role !== undefined && !['user', 'model'].includes(content.role)) throw fail('Invalid Gemini message role.');
    parts(content.parts);
  }
  if (body.generationConfig !== undefined) {
    const config = body.generationConfig;
    fields(config, ['temperature', 'topP', 'topK', 'maxOutputTokens', 'thinkingConfig', 'responseMimeType', 'responseSchema']);
    for (const name of ['temperature', 'topP']) if (config[name] !== undefined && (typeof config[name] !== 'number' || !Number.isFinite(config[name]) || config[name] < 0 || config[name] > 1)) throw fail('Invalid Gemini generation settings.');
    if ((config.topK !== undefined && !integer(config.topK, 1, 100)) || (config.maxOutputTokens !== undefined && !integer(config.maxOutputTokens, 1, 16384))) throw fail('Invalid Gemini generation settings.');
    if (config.thinkingConfig !== undefined) { fields(config.thinkingConfig, ['thinkingLevel']); if (!['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(config.thinkingConfig.thinkingLevel)) throw fail('Invalid Gemini thinking settings.'); }
    if (config.responseMimeType !== undefined && !['application/json', 'text/plain'].includes(config.responseMimeType)) throw fail('Invalid Gemini response type.');
    if (config.responseSchema !== undefined) {
      if (!plain(config.responseSchema) || config.responseMimeType !== 'application/json') throw fail('Invalid Gemini response schema.');
      let nodes = 0;
      const visit = (value, depth = 0) => {
        if (++nodes > 2000 || depth > 16) throw fail('Gemini response schema is too large.');
        if (Array.isArray(value)) value.forEach(item => visit(item, depth + 1));
        else if (plain(value)) for (const [key, item] of Object.entries(value)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) throw fail('Invalid Gemini response schema.'); visit(item, depth + 1); }
        else if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw fail('Invalid Gemini response schema.');
      };
      visit(config.responseSchema);
      if (JSON.stringify(config.responseSchema).length > 40000) throw fail('Gemini response schema is too large.');
    }
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length !== 1) throw fail('Unsupported Gemini tool.');
    fields(body.tools[0], ['google_search']); fields(body.tools[0].google_search, []);
  }
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json, 'utf8') > LIMITS.requestBytes) throw fail('Gemini request is too large.');
  // Snapshot once; callers cannot mutate an approved body during credential IO.
  return { requestId: input.requestId, model: input.model, json, timeoutMs, allowFallback: input.allowFallback === true, keyIndex: input.keyIndex };
}

function abortError() { return fail('Request cancelled.', 'cancelled', 0, 'AbortError'); }
function cancelBody(response) {
  try { void Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* Already closed/locked. */ }
}
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortError());
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
async function wait(ms, signal) {
  let timer;
  try { await abortable(new Promise(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}
async function readResponse(response, signal) {
  if (Number(response.headers?.get?.('content-length') || 0) > LIMITS.responseBytes) throw fail('Gemini response was too large.', 'invalid-response');
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > LIMITS.responseBytes) throw fail('Gemini response was too large.', 'invalid-response');
        chunks.push(Buffer.from(chunk.value));
      }
      text = Buffer.concat(chunks).toString('utf8');
    } finally {
      try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Already closed. */ }
      try { reader.releaseLock(); } catch { /* A non-cooperative reader may still have a pending read. */ }
    }
  } else {
    text = await abortable(response.text(), signal);
    if (Buffer.byteLength(text, 'utf8') > LIMITS.responseBytes) throw fail('Gemini response was too large.', 'invalid-response');
  }
  try { return JSON.parse(text); } catch { throw fail('Gemini returned an unreadable response.', 'invalid-response'); }
}
// Server-sent events from streamGenerateContent: each event carries a partial
// response. Thought parts are never forwarded, and the total size is bounded.
async function readEventStream(response, signal, onText) {
  const reader = response.body?.getReader?.();
  if (!reader) throw fail('Gemini returned an unreadable response.', 'invalid-response');
  const decoder = new TextDecoder();
  let buffer = '', size = 0, text = '', usage = null, finishReason = null;
  const handle = raw => {
    const payload = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!payload || payload === '[DONE]') return;
    let data;
    try { data = JSON.parse(payload); } catch { throw fail('Gemini returned an unreadable response.', 'invalid-response'); }
    if (data?.error) throw providerError(Number(data.error.code) || 500);
    if (data?.usageMetadata) usage = usageOf(data);
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    const parts = candidate?.content?.parts;
    const delta = Array.isArray(parts) ? parts.filter(part => part && !part.thought && typeof part.text === 'string').map(part => part.text).join('') : '';
    if (!delta) return;
    text += delta;
    try { onText(delta); } catch { /* A closed renderer cannot break the request. */ }
  };
  try {
    for (;;) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > LIMITS.responseBytes) throw fail('Gemini response was too large.', 'invalid-response');
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let boundary = /\r?\n\r?\n/.exec(buffer); boundary; boundary = /\r?\n\r?\n/.exec(buffer)) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        handle(raw);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handle(buffer);
  } finally {
    try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Already closed. */ }
    try { reader.releaseLock(); } catch { /* A non-cooperative reader may still have a pending read. */ }
  }
  return { text: text.trim(), usage: usage || usageOf(null), finishReason };
}
function usageOf(data) {
  const source = data?.usageMetadata;
  const count = name => integer(source?.[name], 0, 1000000000) ? source[name] : 0;
  return { inputTokens: count('promptTokenCount'), cachedTokens: count('cachedContentTokenCount'), outputTokens: count('candidatesTokenCount'), thoughtTokens: count('thoughtsTokenCount'), totalTokens: count('totalTokenCount') };
}
// A 429 body names the exhausted quota and how long it lasts. Only these two
// facts are read; the rest of the body is discarded.
async function rateLimitOf(response, signal) {
  const reading = new AbortController(), stop = () => reading.abort();
  const timer = setTimeout(stop, 1500);
  signal.addEventListener('abort', stop, { once: true });
  try {
    const data = await readResponse(response, reading.signal);
    const details = Array.isArray(data?.error?.details) ? data.error.details : [];
    const delay = /^(\d{1,6}(?:\.\d+)?)s$/.exec(details.find(detail => typeof detail?.retryDelay === 'string')?.retryDelay || '');
    const quotas = details.flatMap(detail => (Array.isArray(detail?.violations) ? detail.violations : [])).map(violation => String(violation?.quotaId || '')).join(' ');
    return { kind: /PerDay/i.test(quotas) ? 'daily' : /PerMinute/i.test(quotas) || delay ? 'minute' : 'unknown', retryMs: delay ? Math.ceil(Number(delay[1]) * 1000) : null };
  } catch { return { kind: 'unknown', retryMs: null }; }
  finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
}
function providerError(status, limit = null) {
  if (status === 429 && limit?.kind === 'daily') return fail("Google Gemini's daily limit for this key has been reached (429). It resets at midnight Pacific time; check usage and billing in Google AI Studio.", 'rate-limit', 429);
  if (status === 429 && limit?.retryMs) return fail(`Google Gemini's rate limit was reached (429). Try again in about ${Math.ceil(limit.retryMs / 1000)} seconds.`, 'rate-limit', 429);
  if (status === 429) return fail('Google Gemini quota or rate limit reached (429). Check your Google AI Studio usage and billing, or try again after the limit resets.', 'rate-limit', 429);
  if (status === 503) return fail('Google Gemini is temporarily unavailable (503). Please try again shortly.', 'unavailable', 503);
  if ([401, 403].includes(status)) return fail('Google Gemini rejected the saved credential. Check your key and its access in Settings.', 'authentication', status);
  if (status === 404) return fail('The requested Gemini model is unavailable.', 'model-unavailable', 404);
  return fail(`Google Gemini could not complete this request (HTTP ${integer(status, 100, 599) ? status : 500}).`, 'provider-error', integer(status, 100, 599) ? status : 500);
}

function createProviderService({ fetchImpl = globalThis.fetch, getCredentials, now = Date.now, sleep = wait } = {}) {
  if (typeof getCredentials !== 'function' || typeof fetchImpl !== 'function') throw new Error('Provider service needs credential and HTTP adapters.');
  const active = new Map(), recent = [];
  const totals = { requests: 0, attempts: 0, succeeded: 0, failed: 0, cancelled: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 };
  let disposed = false, configured = false, currentKeyIndex = 0;
  // With onText, the reply streams: partial text is delivered as it arrives and
  // the full text is still returned. Streams serve spoken answers only; they
  // never feed action dispatch, so a length stop is reported as truncated.
  async function generate(payload, onText) {
    const streaming = typeof onText === 'function';
    let request;
    try { request = validateRequest(payload); }
    catch (error) { return { ok: false, error: { message: error instanceof ProviderServiceError ? error.message : 'Invalid Gemini request.', code: 'invalid-request', status: 0, name: 'Error' } }; }
    if (disposed) return { ok: false, error: { message: 'Gemini service is closed.', code: 'unavailable', status: 0, name: 'Error' } };
    if (active.has(request.requestId) || active.size >= LIMITS.concurrency) return { ok: false, error: { message: 'Too many Gemini requests are running. Try again after they finish.', code: 'busy', status: 0, name: 'Error' } };
    const controller = new AbortController(), startedAt = now();
    const record = { controller, timedOut: false, attempts: 0, model: request.model, keyIndex: 0, usage: usageOf(null) };
    active.set(request.requestId, record); totals.requests++;
    const timer = setTimeout(() => { record.timedOut = true; controller.abort(); }, request.timeoutMs);
    let outcome = 'failed', status = 0, limit = null;
    try {
      let credentials;
      try { credentials = await abortable(Promise.resolve().then(getCredentials), controller.signal); }
      catch (error) { if (controller.signal.aborted) throw error; throw fail('Saved Gemini credentials could not be read. Save your key in Settings again.', 'credentials'); }
      const keys = normalizeSavedKeys(credentials?.keys);
      configured = keys.length > 0;
      if (!configured) throw fail('Add and securely save your Gemini API key in Settings first.', 'missing-credential');
      const rotation = credentials.rotation === true;
      record.keyIndex = (request.keyIndex ?? currentKeyIndex) % keys.length;
      let keysTried = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (controller.signal.aborted) throw abortError();
        record.attempts++; totals.attempts++;
        const fetching = Promise.resolve(fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${request.model}:${streaming ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys[record.keyIndex] }, body: request.json,
          signal: controller.signal, redirect: 'error'
        }));
        // Cancellation can settle the caller before an HTTP adapter resolves.
        // Dispose a late response instead of leaving its unread body connected.
        void fetching.then(response => { if (controller.signal.aborted) cancelBody(response); }, () => {});
        const response = await abortable(fetching, controller.signal);
        try {
          if (controller.signal.aborted) throw abortError();
          status = response.status;
          if (status === 429 || status === 503) {
            limit = status === 429 ? await rateLimitOf(response, controller.signal) : null;
            cancelBody(response);
            if (controller.signal.aborted) throw abortError();
            if (status === 503 && request.allowFallback) break;
            if (status === 429 && rotation && keysTried < keys.length - 1) { record.keyIndex = (record.keyIndex + 1) % keys.length; currentKeyIndex = record.keyIndex; keysTried++; continue; }
            if (attempt === 2) break;
            // Backoff cannot outlast a daily quota or one that frees up later.
            if (limit && (limit.kind === 'daily' || limit.retryMs > 6000)) break;
            await abortable(sleep(Math.min(6000, Math.max(1000 * 2 ** attempt, limit?.retryMs || 0)), controller.signal), controller.signal);
            keysTried = 0; continue;
          }
          if (!response.ok) throw providerError(status);
          if (streaming) {
            const streamed = await readEventStream(response, controller.signal, onText);
            if (controller.signal.aborted) throw abortError();
            record.usage = streamed.usage;
            for (const [name, value] of Object.entries(record.usage)) totals[name] += value;
            if (!streamed.text) throw fail('No response from Gemini.', 'empty-response');
            currentKeyIndex = record.keyIndex; outcome = 'succeeded';
            return { ok: true, text: streamed.text, keyIndex: record.keyIndex, usage: record.usage, truncated: streamed.finishReason === 'MAX_TOKENS' };
          }
          const data = await readResponse(response, controller.signal);
          if (controller.signal.aborted) throw abortError();
          record.usage = usageOf(data);
          for (const [name, value] of Object.entries(record.usage)) totals[name] += value;
          const candidate = data?.candidates?.[0];
          if (candidate?.finishReason === 'MAX_TOKENS') throw fail('The response was too long. Try a smaller task.', 'max-tokens');
          const parts = candidate?.content?.parts;
          const text = Array.isArray(parts) ? parts.filter(part => part && !part.thought && typeof part.text === 'string').map(part => part.text).join('').trim() : '';
          if (!text) throw fail('No response from Gemini.', 'empty-response');
          currentKeyIndex = record.keyIndex; outcome = 'succeeded';
          return { ok: true, text, keyIndex: record.keyIndex, usage: record.usage };
        } finally { cancelBody(response); }
      }
      throw providerError(status, status === 429 ? limit : null);
    } catch (error) {
      let safe;
      if (record.timedOut) safe = fail('Gemini took too long. Please try again.', 'timeout');
      else if (controller.signal.aborted) { safe = abortError(); outcome = 'cancelled'; }
      else if (error instanceof ProviderServiceError) safe = error;
      else safe = fail('Gemini could not connect. Check your connection and try again.', 'network');
      return { ok: false, keyIndex: record.keyIndex, error: { message: safe.message, code: safe.code, status: safe.status || 0, name: safe.name } };
    } finally {
      clearTimeout(timer); active.delete(request.requestId); totals[outcome]++;
      recent.push({ model: record.model, outcome, status: integer(status, 100, 599) ? status : 0, attempts: record.attempts, durationMs: Math.max(0, now() - startedAt), at: now(), ...record.usage, ...(outcome === 'failed' && status === 429 && limit ? { rateLimit: limit.kind, retryMs: limit.retryMs } : {}) });
      if (recent.length > LIMITS.recent) recent.splice(0, recent.length - LIMITS.recent);
    }
  }
  return {
    generate,
    cancel(id) { if (!requestId(id)) return { cancelled: false }; const record = active.get(id); if (record) record.controller.abort(); return { cancelled: !!record }; },
    status() { return { provider: 'gemini', configured, active: active.size, limits: { concurrency: LIMITS.concurrency, timeoutMs: LIMITS.timeoutMs }, totals: { ...totals }, recent: recent.map(item => ({ ...item })) }; },
    dispose() { disposed = true; for (const record of active.values()) record.controller.abort(); }
  };
}

module.exports = { createProviderService, validateRequest, MODELS, LIMITS };
