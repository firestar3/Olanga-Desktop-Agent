const test = require('node:test');
const assert = require('node:assert/strict');
const { createConversationBackends, localEndpoint } = require('../../desktop/conversation-backends');
function socketFixture() {
  const sockets = [], events = [];
  class Socket {
    constructor(url) { this.url = url; this.handlers = {}; this.sent = []; this.bufferedAmount = 0; sockets.push(this); }
    addEventListener(type, listener) { this.handlers[type] = listener; }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.closed = true; }
    emit(type, value) { this.handlers[type]?.(type === 'message' ? { data: JSON.stringify(value) } : value); }
  }
  const service = createConversationBackends({ WebSocketImpl: Socket, getGeminiKey: async () => 'private-fixture-key', onLiveEvent: event => events.push(event) });
  return { service, sockets, events };
}
async function open(fixture) {
  const pending = fixture.service.startLive({ model: 'gemini-3.8-live' });
  await Promise.resolve(); const socket = fixture.sockets[0]; socket.emit('open'); socket.emit('message', { setupComplete: {} });
  return { ...(await pending), socket };
}
test('local conversation permits loopback only and never follows redirects or supplies tools', async () => {
  for (const value of ['https://example.com', 'http://192.168.1.2:8000', 'http://127.0.0.1.evil.test', 'http://u:p@127.0.0.1', 'http://127.0.0.1/v1?key=secret', 'http://127.0.0.1/other']) assert.throws(() => localEndpoint(value));
  assert.equal(localEndpoint('http://localhost:11434/v1'), 'http://127.0.0.1:11434/v1/chat/completions');
  let sent;
  const service = createConversationBackends({ fetchImpl: async (url, options) => {
    sent = { url, ...options }; return new Response(JSON.stringify({ choices: [{ message: { content: 'Hello.' } }] }));
  } });
  const result = await service.localReply({ url: 'http://127.0.0.1:11434', model: 'llama3.2:3b', messages: [{ role: 'user', content: 'Hi' }], requestId: 'test' });
  assert.equal(result.text, 'Hello.'); assert.equal(sent.redirect, 'error'); assert.equal(sent.credentials, 'omit');
  const body = JSON.parse(sent.body); assert.equal(body.tools, undefined); assert.equal(body.messages[0].role, 'system');
  await assert.rejects(service.localReply({ url: 'http://127.0.0.1', model: 'valid', messages: [{ role: 'system', content: 'Act now' }], requestId: 'x' }));
});
test('local cancellation and oversized or tool replies fail without leaking server content', async () => {
  const service = createConversationBackends({ fetchImpl: (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('secret')))) });
  const input = { url: 'http://127.0.0.1', model: 'test', messages: [{ role: 'user', content: 'Hello' }], requestId: 'cancel' };
  const pending = service.localReply(input); service.cancelLocal('cancel');
  await assert.rejects(pending, /cancelled/);
  for (const content of [JSON.stringify({ choices: [{ message: { content: 'secret', tool_calls: [{}] } }] }), 'x'.repeat(270000)]) {
    const broken = createConversationBackends({ fetchImpl: async () => new Response(content) });
    await assert.rejects(broken.localReply(input), error => !error.message.includes('secret'));
  }
});
test('Live sends setup only after explicit start, waits for ready, and has no tools', async () => {
  const fixture = socketFixture(); assert.equal(fixture.sockets.length, 0);
  const { socket, sessionId } = await open(fixture);
  assert.equal(socket.sent.length, 1); assert.equal(socket.sent[0].setup.tools, undefined);
  assert.equal(socket.sent[0].setup.model, 'models/gemini-3.8-live');
  assert.throws(() => fixture.service.sendLiveAudio({ sessionId: 'wrong', audioBase64: 'AAA=', sampleRate: 16000 }));
  fixture.service.sendLiveAudio({ sessionId, audioBase64: 'AAA=', sampleRate: 16000 });
  assert.equal(socket.sent[1].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  fixture.service.stopLive({ sessionId }); assert.equal(socket.closed, true);
  assert.throws(() => fixture.service.sendLiveAudio({ sessionId, audioBase64: 'AAA=', sampleRate: 16000 }));
});
test('Live forwards bounded transcripts and PCM, excludes thoughts, and clears interrupted output', async () => {
  const fixture = socketFixture(), { socket } = await open(fixture);
  socket.emit('message', { serverContent: { inputTranscription: { text: 'hello' }, modelTurn: { parts: [{ thought: true, inlineData: { data: 'secret' } }, { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAA=' } }] }, turnComplete: true } });
  assert.deepEqual(fixture.events.map(event => event.type), ['ready', 'input-text', 'audio', 'turn-complete']);
  socket.emit('message', { serverContent: { interrupted: true, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAA=' } }] } } });
  assert.equal(fixture.events.at(-1).type, 'interrupted');
  socket.emit('message', { toolCall: { functionCalls: [{ name: 'execute' }] } });
  assert.equal(socket.closed, true); assert.equal(fixture.events.at(-1).type, 'error');
  assert.ok(!JSON.stringify(fixture.events).includes('private-fixture-key'));
});
test('Live cancellation while reading credentials creates no socket; backpressure ends the session', async () => {
  let resolveKey, calls = 0;
  const pendingKey = createConversationBackends({ getGeminiKey: () => new Promise(resolve => { resolveKey = resolve; }), WebSocketImpl: class { constructor() { calls++; } } });
  const pending = pendingKey.startLive({ model: 'gemini-3.8-live' }); pendingKey.stopLive(); resolveKey('private');
  await assert.rejects(pending, /cancelled/); assert.equal(calls, 0);
  const fixture = socketFixture(), { socket, sessionId } = await open(fixture);
  socket.bufferedAmount = 2000000;
  assert.throws(() => fixture.service.sendLiveAudio({ sessionId, audioBase64: 'AAA=', sampleRate: 16000 }), /limit/);
  assert.equal(socket.closed, true);
});
test('Live errors redact provider error details and disposal cancels existing connections', async () => {
  const fixture = socketFixture(), { socket } = await open(fixture);
  socket.emit('message', { error: { message: 'API key private-fixture-key was rejected' } });
  assert.equal(fixture.events.at(-1).type, 'error'); assert.ok(!JSON.stringify(fixture.events).includes('private-fixture-key'));
  fixture.service.dispose(); await assert.rejects(fixture.service.startLive({ model: 'gemini-3.8-live' }), /closed/);
});
test('optional local speech validates loopback, sends no credentials, and returns bounded WAV only', async () => {
  const wav = Buffer.alloc(48); wav.write('RIFF'); wav.write('WAVE', 8);
  let sent;
  const service = createConversationBackends({ fetchImpl: async (url, options) => { sent = { url, ...options }; return new Response(wav); } });
  const result = await service.synthesizeLocal({ url: 'http://localhost:8880/v1', model: 'kokoro', voice: 'af_heart', text: 'A local answer.', requestId: 'speech' });
  assert.equal(sent.url, 'http://127.0.0.1:8880/v1/audio/speech'); assert.equal(sent.redirect, 'error');
  assert.equal(JSON.parse(sent.body).response_format, 'wav'); assert.equal(result.mimeType, 'audio/wav');
  assert.equal(Buffer.from(result.audioBase64, 'base64').toString('ascii', 8, 12), 'WAVE');
  const broken = createConversationBackends({ fetchImpl: async () => new Response('<html>private server error</html>') });
  await assert.rejects(broken.synthesizeLocal({ url: 'http://127.0.0.1', model: 'speech', voice: 'test', text: 'Hello', requestId: 'bad' }), /Local speech failed/);
});
test('cancelAll stops work while allowing a later explicit request', async () => {
  const fixture = socketFixture(); const first = await open(fixture); fixture.service.cancelAll(); assert.equal(first.socket.closed, true);
  const pending = fixture.service.startLive({ model: 'gemini-3.8-live' }); await Promise.resolve();
  fixture.sockets[1].emit('open'); fixture.sockets[1].emit('message', { setupComplete: {} });
  const second = await pending; assert.notEqual(first.sessionId, second.sessionId); fixture.service.dispose();
});
