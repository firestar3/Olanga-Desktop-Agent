const test = require('node:test');
const assert = require('node:assert/strict');
const { createEndpoint, createPreRoll } = require('../../shared/voice-endpoint');
const samples = (ms, amplitude = 0, rate = 16000) => new Float32Array(ms * rate / 1000).fill(amplitude);

test('endpoint follows captured samples without animation frames or wall-clock timers', () => {
  const endpoint = createEndpoint({ sampleRate: 16000 });
  assert.equal(endpoint.process(samples(200, .1), { recording: true }).speech, true);
  assert.equal(endpoint.process(samples(1490), { recording: true }).stop, false);
  assert.equal(endpoint.process(samples(10), { recording: true }).stop, true);
  endpoint.reset();
  assert.equal(endpoint.process(samples(3990), { recording: true }).cancel, false);
  assert.equal(endpoint.process(samples(10), { recording: true }).cancel, true);
});
test('noise adaptation cannot suppress a previously audible voice or shorten a continued phrase', () => {
  const endpoint = createEndpoint({ sampleRate: 16000 });
  for (let i = 0; i < 300; i++) endpoint.process(samples(20, .01));
  assert.equal(endpoint.process(samples(200, .07), { recording: true }).speech, true);
  assert.equal(endpoint.process(samples(800, .005), { recording: true }).stop, false);
  endpoint.process(samples(150, .04), { recording: true });
  assert.equal(endpoint.process(samples(1400), { recording: true }).stop, false);
  assert.equal(endpoint.process(samples(100), { recording: true }).stop, true);
});
test('brief noise does not become speech and explicit follow-up keeps the longer start window', () => {
  const endpoint = createEndpoint({ sampleRate: 48000 });
  assert.equal(endpoint.process(samples(10, .9, 48000), { recording: true }).speech, false);
  assert.equal(endpoint.process(samples(4000, 0, 48000), { recording: true, waitMs: 12000 }).cancel, false);
  assert.equal(endpoint.process(samples(8000, 0, 48000), { recording: true, waitMs: 12000 }).cancel, true);
});
test('pre-roll is bounded, copied, and only returns audio after a known wake boundary once consumed', () => {
  const ring = createPreRoll(16000, 750), first = samples(500, .1);
  ring.push(first, 8000); first.fill(0);
  ring.push(samples(500, .2), 16000);
  const tail = ring.after(12000);
  assert.equal(tail.reduce((sum, chunk) => sum + chunk.length, 0), 4000);
  assert.ok(tail[0][0] > .19);
  assert.equal(ring.after(0).reduce((sum, chunk) => sum + chunk.length, 0), 12000);
  assert.deepEqual(ring.after(null), []);
  ring.clear(); assert.deepEqual(ring.after(0), []);
});
