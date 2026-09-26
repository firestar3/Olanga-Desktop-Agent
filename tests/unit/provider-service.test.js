const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderService, validateRequest, LIMITS } = require('../../desktop/provider-service');

const body = () => ({ contents: [{ role: 'user', parts: [{ text: 'A private test prompt.' }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 500, thinkingConfig: { thinkingLevel: 'LOW' } } });
const request = (extra = {}) => ({ requestId: 'test-request', model: 'gemini-3.5-flash', body: body(), ...extra });
const response = (text = 'Hello world', extra = {}) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], ...extra }), { status: 200, headers: { 'content-type': 'application/json' } });
function fixture(options = {}) {
  const calls = [], delays = [];
  const service = createProviderService({
    getCredentials: async () => ({ keys: ['saved-secret-key'], rotation: false }),
    sleep: async ms => { delays.push(ms); },
    ...options,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return options.fetchImpl ? options.fetchImpl(url, init, calls.length) : response(); }
  });
  return { service, calls, delays };
}

test('the main service reads saved credentials and uses only the fixed endpoint and header', async () => {
  const h = fixture({ fetchImpl: async () => response('', { candidates: [{ content: { parts: [{ text: 'private reasoning', thought: true }, { text: 'Hello ' }, { text: 'world' }] } }] }) });
  const result = await h.service.generate(request());
  assert.equal(result.text, 'Hello world');
  assert.equal(h.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent');
  assert.equal(h.calls[0].init.headers['x-goog-api-key'], 'saved-secret-key');
  assert.equal(h.calls[0].init.redirect, 'error');
  assert.ok(!JSON.stringify(result).includes('saved-secret-key'));
  assert.ok(!h.calls[0].url.includes('saved-secret-key'));
  h.service.dispose();
});

test('validation rejects credential/endpoint injection and unsupported request capabilities before reading keys', async () => {
  let reads = 0;
  const h = fixture({ getCredentials: () => { reads++; return { keys: [] }; } });
  for (const bad of [request({ apiKey: 'renderer-key' }), request({ url: 'https://other.example' }), request({ model: '../secret' }), request({ model: 'arbitrary-model' }), request({ body: { ...body(), tools: [{ functionDeclarations: [] }] } }), request({ body: { ...body(), contents: [{ parts: [{ file_data: { file_uri: 'https://private.example' } }] }] } }), request({ timeoutMs: 90001 }), request({ keyIndex: -1 })]) {
    const result = await h.service.generate(bad); assert.equal(result.ok, false); assert.equal(result.error.code, 'invalid-request');
  }
  assert.equal(reads, 0); assert.equal(h.calls.length, 0);
});

test('bounded audio, screenshots, JSON schemas and Google Search remain supported', () => {
  const values = body();
  values.system_instruction = { parts: [{ text: 'System instruction.' }] };
  values.contents[0].parts.push({ inline_data: { mime_type: 'audio/wav', data: 'YWJj' } }, { inline_data: { mime_type: 'image/png', data: 'YWJj' } });
  values.tools = [{ google_search: {} }];
  values.generationConfig.responseMimeType = 'application/json';
  values.generationConfig.responseSchema = { type: 'OBJECT', properties: { ready: { type: 'BOOLEAN' } } };
  assert.equal(JSON.parse(validateRequest(request({ body: values })).json).contents[0].parts.length, 3);
  for (const bad of [
    { ...values, contents: [{ parts: [{ text: 'x'.repeat(LIMITS.text + 1) }] }] },
    { ...values, contents: [{ parts: [{ inline_data: { mime_type: 'image/png', data: 'A'.repeat(8000001) } }] }] },
    { ...values, contents: [{ role: 'system', parts: [{ text: 'bad' }] }] },
    { ...values, generationConfig: { maxOutputTokens: 999999 } },
    { ...values, contents: [{ parts: [{ inline_data: { mime_type: 'application/pdf', data: 'YWJj' } }] }] }
  ]) assert.throws(() => validateRequest(request({ body: bad })));
});

test('429 rotates saved keys and preserves the exact body without replaying any actions', async () => {
  const h = fixture({ getCredentials: () => ({ keys: ['first-key', 'second-key'], rotation: true }), fetchImpl: async (_url, _init, call) => call === 1 ? new Response('quota', { status: 429 }) : response('Ready') });
  const result = await h.service.generate(request());
  assert.equal(result.text, 'Ready'); assert.equal(result.keyIndex, 1);
  assert.deepEqual(h.calls.map(call => call.init.headers['x-goog-api-key']), ['first-key', 'second-key']);
  assert.equal(h.calls[0].init.body, h.calls[1].init.body);
  assert.deepEqual(h.delays, []);
});

const quota = (quotaId, retryDelay) => new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for saved-secret-key', details: [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId }] },
  ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : [])
] } }), { status: 429, headers: { 'content-type': 'application/json' } });

test('429 stops retrying when Google reports a daily quota or a longer wait, and says when to try again', async () => {
  const minute = fixture({ fetchImpl: async () => quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '21.4s') });
  const waited = await minute.service.generate(request());
  assert.equal(waited.error.code, 'rate-limit');
  assert.match(waited.error.message, /about 22 seconds/);
  assert.equal(minute.calls.length, 1); assert.deepEqual(minute.delays, []);
  assert.deepEqual([minute.service.status().recent[0].rateLimit, minute.service.status().recent[0].retryMs], ['minute', 21400]);

  const daily = fixture({ fetchImpl: async () => quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '3600s') });
  const exhausted = await daily.service.generate(request());
  assert.match(exhausted.error.message, /daily limit/);
  assert.equal(daily.calls.length, 1);
  assert.ok(!/saved-secret|Quota exceeded/.test(JSON.stringify([exhausted, daily.service.status()])));

  const short = fixture({ fetchImpl: async () => quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '1.5s') });
  assert.equal((await short.service.generate(request())).error.status, 429);
  assert.equal(short.calls.length, 3); assert.deepEqual(short.delays, [1500, 2000]);

  const rotated = fixture({ getCredentials: () => ({ keys: ['first-key', 'second-key'], rotation: true }), fetchImpl: async (_url, _init, call) => call === 1 ? quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier') : response('Ready') });
  assert.equal((await rotated.service.generate(request())).keyIndex, 1);
});

test('a stalled 429 body cannot hold a request past its timeout', async () => {
  let cancelled = 0;
  const stalled = new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 429 });
  const h = fixture({ fetchImpl: async () => stalled });
  assert.equal((await h.service.generate(request({ timeoutMs: 30 }))).error.code, 'timeout');
  assert.equal(cancelled, 1); assert.equal(stalled.body.locked, false);
  assert.equal(h.service.status().active, 0);
});

test('503 uses bounded existing backoff, or returns immediately to the caller for model fallback', async () => {
  for (const allowFallback of [false, true]) {
    const h = fixture({ fetchImpl: async () => new Response('temporary', { status: 503 }) });
    const result = await h.service.generate(request({ allowFallback }));
    assert.equal(result.error.status, 503);
    assert.equal(h.calls.length, allowFallback ? 1 : 3);
    assert.deepEqual(h.delays, allowFallback ? [] : [1000, 2000]);
  }
});

test('authentication, 404 and network errors are generic and never echo provider bodies, keys or prompts', async () => {
  for (const status of [401, 403, 404, 500]) {
    const h = fixture({ fetchImpl: async () => new Response('PRIVATE saved-secret-key A private test prompt.', { status }) });
    const result = await h.service.generate(request());
    assert.equal(result.error.status, status); assert.equal(h.calls.length, 1);
    assert.ok(!/PRIVATE|saved-secret|private test/.test(JSON.stringify(result)));
    assert.ok(!/PRIVATE|saved-secret|private test/.test(JSON.stringify(h.service.status())));
  }
  const h = fixture({ fetchImpl: async () => { throw Object.assign(new Error('Fetch failed for saved-secret-key'), { code: 'authentication' }); } });
  assert.equal((await h.service.generate(request())).error.code, 'network');
  assert.ok(!JSON.stringify(h.service.status()).includes('saved-secret-key'));
});

test('missing or unreadable saved credentials fail before HTTP', async () => {
  for (const getCredentials of [() => ({ keys: [] }), () => { throw new Error('secret path and credential'); }]) {
    const h = fixture({ getCredentials });
    const result = await h.service.generate(request());
    assert.equal(result.ok, false); assert.match(result.error.code, /credential/);
    assert.ok(!result.error.message.includes('secret path'));
    assert.equal(h.calls.length, 0);
  }
});

test('abort settles a stalled HTTP call, releases concurrency and rejects late replies', async () => {
  let release, signal;
  const h = fixture({ fetchImpl: async (_url, init) => { signal = init.signal; return new Promise(resolve => { release = resolve; }); } });
  const pending = h.service.generate(request());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.service.cancel('test-request').cancelled, true);
  const result = await pending;
  assert.equal(result.error.name, 'AbortError'); assert.equal(signal.aborted, true); assert.equal(h.service.status().active, 0);
  release(response('Late result'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.service.status().totals.succeeded, 0);
});

test('cancellation while reading credentials never starts HTTP', async () => {
  let release;
  const h = fixture({ getCredentials: () => new Promise(resolve => { release = resolve; }) });
  const pending = h.service.generate(request());
  await new Promise(resolve => setImmediate(resolve));
  h.service.cancel('test-request'); assert.equal((await pending).error.name, 'AbortError');
  release({ keys: ['saved-secret-key'] }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 0);
});

test('cancelling backoff prevents another HTTP attempt', async () => {
  let sleeping;
  const reached = new Promise(resolve => { sleeping = resolve; });
  const h = fixture({ fetchImpl: async () => new Response('quota', { status: 429 }), sleep: async () => { sleeping(); return new Promise(() => {}); } });
  const pending = h.service.generate(request()); await reached;
  h.service.cancel('test-request'); assert.equal((await pending).error.name, 'AbortError');
  assert.equal(h.calls.length, 1);
});

test('service timeout bounds a non-cooperative fetch and duplicate/concurrent calls cannot queue silently', async () => {
  const h = fixture({ fetchImpl: () => new Promise(() => {}) });
  const pending = Array.from({ length: LIMITS.concurrency }, (_, index) => h.service.generate(request({ requestId: `request-${index}`, timeoutMs: 20 })));
  assert.equal((await h.service.generate(request({ requestId: 'request-0' }))).error.code, 'busy');
  assert.equal((await h.service.generate(request({ requestId: 'overflow' }))).error.code, 'busy');
  const results = await Promise.all(pending);
  assert.ok(results.every(result => result.error.code === 'timeout'));
  assert.equal(h.service.status().active, 0);
});

test('invalid/oversized, truncated and empty responses never produce successful text', async () => {
  for (const fetchImpl of [
    async () => new Response('not json'),
    async () => new Response('x'.repeat(LIMITS.responseBytes + 1)),
    async () => response('unfinished', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'unfinished' }] } }] }),
    async () => response('', { candidates: [] })
  ]) {
    const h = fixture({ fetchImpl });
    assert.equal((await h.service.generate(request())).ok, false);
  }
});

test('usage counts are bounded metadata with no prompts, output text or credentials', async () => {
  const h = fixture({ fetchImpl: async () => response('PRIVATE GENERATED TEXT', { usageMetadata: { promptTokenCount: 12, cachedContentTokenCount: 8, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 18 } }) });
  for (let index = 0; index < LIMITS.recent + 2; index++) await h.service.generate(request({ requestId: `usage-${index}` }));
  const status = h.service.status();
  assert.equal(status.recent.length, LIMITS.recent);
  assert.equal(status.totals.requests, LIMITS.recent + 2);
  assert.equal(status.totals.inputTokens, (LIMITS.recent + 2) * 12);
  assert.equal(status.totals.cachedTokens, (LIMITS.recent + 2) * 8);
  assert.equal(status.recent[0].cachedTokens, 8);
  assert.equal(status.totals.outputTokens, (LIMITS.recent + 2) * 4);
  assert.ok(!/private|saved-secret|GENERATED/i.test(JSON.stringify(status)));
  status.recent[0].model = 'mutated'; assert.notEqual(h.service.status().recent[0].model, 'mutated');
});

test('dispose aborts active requests and prevents new HTTP work', async () => {
  const h = fixture({ fetchImpl: () => new Promise(() => {}) });
  const pending = h.service.generate(request()); await new Promise(resolve => setImmediate(resolve));
  h.service.dispose(); assert.equal((await pending).error.name, 'AbortError');
  assert.equal((await h.service.generate(request())).error.code, 'unavailable');
});

test('provider rejects oversized headers while cancelling the unread HTTP body', async () => {
  let cancelled = 0;
  const http = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-length': String(LIMITS.responseBytes + 1) } });
  const h = fixture({ fetchImpl: async () => http });
  const result = await h.service.generate(request());
  assert.equal(result.error.code, 'invalid-response');
  assert.equal(cancelled, 1);
  assert.equal(http.body.locked, false);
});

test('provider cancels a response arriving after request cancellation', async () => {
  let release, cancelled = 0;
  const h = fixture({ fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const pending = h.service.generate(request());
  await new Promise(resolve => setImmediate(resolve));
  h.service.cancel('test-request');
  assert.equal((await pending).error.code, 'cancelled');
  const late = new Response(new ReadableStream({ cancel() { cancelled++; } }));
  release(late);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1);
  assert.equal(late.body.locked, false);
  assert.equal(h.service.status().totals.succeeded, 0);
});

test('provider releases response readers after both success and a stalled-body timeout', async () => {
  const complete = response('Complete');
  const success = fixture({ fetchImpl: async () => complete });
  assert.equal((await success.service.generate(request())).text, 'Complete');
  assert.equal(complete.body.locked, false);
  let cancelled = 0;
  const stalled = new Response(new ReadableStream({ cancel() { cancelled++; } }));
  const failure = fixture({ fetchImpl: async () => stalled });
  assert.equal((await failure.service.generate(request({ timeoutMs: 10 }))).error.code, 'timeout');
  assert.equal(cancelled, 1);
  assert.equal(stalled.body.locked, false);
});

// Server-sent events delivered in small byte slices so event boundaries,
// multi-byte characters and JSON bodies are split across reads.
function sse(events, { split = 7, hold = false } = {}) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return hold ? new Promise(() => {}) : controller.close();
      controller.enqueue(bytes.slice(offset, offset + split)); offset += split;
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const part = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text, ...extra }] } }] });

test('streamed replies deliver ordered text without thoughts and keep usage accounting', async () => {
  const events = [part('private plan', { thought: true }), part('Canberra is '), part('the capital — café. '), { candidates: [{ content: { parts: [{ text: 'Anything else?' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 9, totalTokenCount: 49 } }];
  const h = fixture({ fetchImpl: async () => sse(events) });
  const deltas = [];
  const result = await h.service.generate(request(), delta => deltas.push(delta));
  assert.deepEqual(deltas, ['Canberra is ', 'the capital — café. ', 'Anything else?']);
  assert.equal(result.text, 'Canberra is the capital — café. Anything else?');
  assert.equal(result.truncated, false);
  assert.equal(h.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse');
  assert.equal(h.service.status().totals.inputTokens, 40);
  assert.ok(!deltas.join('').includes('private plan'));
});

test('streams retry only before text arrives and report cancellation, errors, size and length stops', async () => {
  const retried = fixture({ getCredentials: () => ({ keys: ['first-key', 'second-key'], rotation: true }), fetchImpl: async (_url, _init, call) => call === 1 ? new Response('quota', { status: 429 }) : sse([part('Ready.')]) });
  const seen = [];
  assert.equal((await retried.service.generate(request(), delta => seen.push(delta))).keyIndex, 1);
  assert.deepEqual(seen, ['Ready.']);

  const held = fixture({ fetchImpl: async () => sse([part('First sentence. ')], { hold: true }) });
  const partial = [];
  const pending = held.service.generate(request(), delta => { partial.push(delta); held.service.cancel('test-request'); });
  const cancelled = await pending;
  assert.equal(cancelled.ok, false); assert.equal(cancelled.error.name, 'AbortError');
  assert.deepEqual(partial, ['First sentence. ']);
  assert.equal(held.service.status().active, 0);

  const failed = fixture({ fetchImpl: async () => sse([part('Partial. '), { error: { code: 503, message: 'overloaded' } }]) });
  assert.equal((await failed.service.generate(request(), () => {})).error.code, 'unavailable');
  const oversized = fixture({ fetchImpl: async () => sse([part('x'.repeat(LIMITS.responseBytes))], { split: 65536 }) });
  assert.equal((await oversized.service.generate(request(), () => {})).error.code, 'invalid-response');
  const empty = fixture({ fetchImpl: async () => sse([part('thinking', { thought: true })]) });
  assert.equal((await empty.service.generate(request(), () => {})).error.code, 'empty-response');
  const long = fixture({ fetchImpl: async () => sse([{ candidates: [{ content: { parts: [{ text: 'Cut off' }] }, finishReason: 'MAX_TOKENS' }] }]) });
  const truncated = await long.service.generate(request(), () => { throw new Error('Renderer closed'); });
  assert.equal(truncated.ok, true); assert.equal(truncated.truncated, true); assert.equal(truncated.text, 'Cut off');
});

function rendererBridge(api) {
  const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
  const context = { window: { electronAPI: api }, OlangaGemini: require('../../shared/gemini-request'), AbortController, DOMException, currentKeyIndex: 0, fetch: () => { throw new Error('Renderer HTTP must not run'); } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/assistant.js'), 'utf8'), context);
  return context;
}

test('renderer retains the request interface while main owns HTTP and credentials', async () => {
  const h = fixture(); const payloads = [];
  const context = rendererBridge({ providerGenerate: payload => { payloads.push(payload); return h.service.generate(JSON.parse(JSON.stringify(payload))); }, providerCancel: id => h.service.cancel(id) });
  assert.equal(await context.callGeminiGenerate('gemini-3.5-flash', body()), 'Hello world');
  assert.equal(h.calls.length, 1);
  assert.deepEqual(Object.keys(payloads[0]).sort(), ['allowFallback', 'body', 'keyIndex', 'model', 'requestId', 'timeoutMs']);
  assert.equal(Object.hasOwn(context, 'apiKey'), false, 'The request adapter does not require any renderer credential');
});

test('renderer abort cancels main HTTP and cannot return a late successful answer', async () => {
  const h = fixture({ fetchImpl: () => new Promise(() => {}) });
  const context = rendererBridge({ providerGenerate: payload => h.service.generate(JSON.parse(JSON.stringify(payload))), providerCancel: id => h.service.cancel(id) });
  const controller = new AbortController();
  const pending = context.callGeminiGenerate('gemini-3.5-flash', body(), { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.service.status().active, 0);
});

test('renderer preserves main failure statuses used by existing model fallback', async () => {
  const context = rendererBridge({ providerGenerate: async () => ({ ok: false, keyIndex: 1, error: { name: 'Error', status: 503, code: 'unavailable', message: 'Temporarily unavailable.' } }) });
  await assert.rejects(context.callGeminiGenerate('gemini-3.5-flash', body(), { allowFallback: true }), { status: 503, code: 'unavailable' });
  assert.equal(context.currentKeyIndex, 0, 'A response cannot select an index outside the current renderer key list.');
});

test('a disconnected cancellation bridge still settles the renderer immediately', async () => {
  const context = rendererBridge({ providerGenerate: () => new Promise(() => {}), providerCancel: () => { throw new Error('Bridge disconnected'); } });
  const controller = new AbortController();
  const pending = context.callGeminiGenerate('gemini-3.5-flash', body(), { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
});
