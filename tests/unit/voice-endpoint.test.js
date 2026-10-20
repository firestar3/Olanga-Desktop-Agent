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

test('pre-roll preserves exact chronology through wraparound, oversized packets and partial wake boundaries', () => {
  const ring = createPreRoll(16000, 25), capacity = 400;
  let captured = [], end = 0, seed = 23;
  for (let packet = 0; packet < 250; packet++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const length = seed % 700 + 1, chunk = Float32Array.from({ length }, (_, index) => end + index);
    end += length;
    captured = captured.concat([...chunk]).slice(-capacity);
    ring.push(chunk, end);
    chunk.fill(-1);
    for (const frame of [0, end - capacity, end - 237, end - 1, end, end + 1]) {
      const actual = ring.after(frame).flatMap(samples => [...samples]);
      const expected = frame >= end ? [] : captured.slice(Math.max(0, frame - (end - captured.length)));
      assert.deepEqual(actual, expected, `packet ${packet}, boundary ${frame}`);
    }
    const copy = ring.after(0); copy[0]?.fill(-2);
    assert.deepEqual(ring.after(0).flatMap(samples => [...samples]), captured);
    assert.equal(ring.endFrame, end);
  }
});

test('pre-roll clears discontinuous audio and supports an explicitly disabled buffer', () => {
  const ring = createPreRoll(16000, 25);
  ring.push(new Float32Array(100).fill(1), 100);
  ring.push(new Float32Array(100).fill(2), 250);
  assert.deepEqual(ring.after(0).flatMap(samples => [...samples]), Array(100).fill(2));
  ring.clear();
  ring.push(new Float32Array(50).fill(3), 300);
  assert.deepEqual(ring.after(0).flatMap(samples => [...samples]), Array(50).fill(3));
  for (const boundary of [undefined, null, NaN, Infinity]) assert.deepEqual(ring.after(boundary), []);
  const disabled = createPreRoll(16000, 0);
  disabled.push(new Float32Array(200).fill(1), 200);
  assert.deepEqual(disabled.after(0), []); assert.equal(disabled.endFrame, 200);
});

test('steady wake pre-roll reuses one sample allocation until audio is requested', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  let allocations = 0, allocatedSamples = 0; const buffers = [];
  class CountedFloat32Array extends Float32Array {
    constructor(...args) { super(...args); if (!(args[0] instanceof ArrayBuffer)) { allocations++; allocatedSamples += this.length; buffers.push(this); } }
  }
  const context = vm.createContext({ Float32Array: CountedFloat32Array });
  vm.runInContext(fs.readFileSync(require.resolve('../../shared/voice-endpoint'), 'utf8'), context);
  const ring = context.OlangaVoiceEndpoint.createPreRoll(16000), packet = new Float32Array(1024).fill(.25);
  for (let index = 0; index < 1000; index++) ring.push(packet, (index + 1) * packet.length);
  assert.equal(allocations, 1); assert.equal(allocatedSamples, 12000);
  const returned = ring.after(1024000 - 5000);
  assert.equal(allocations, 1 + returned.length); assert.equal(allocatedSamples, 17000);
  ring.clear();
  assert.ok(buffers[0].every(sample => sample === 0), 'Mute/flush clears retained raw audio without waiting for GC');
  assert.ok(buffers[1].every(sample => sample === .25), 'Clearing pre-roll does not corrupt audio already handed to a recording');
});

test('pre-roll keeps capture packet boundaries so wake-tail endpoint decisions remain unchanged', () => {
  const ring = createPreRoll(16000), first = new Float32Array(1024).fill(.1), quiet = new Float32Array(1024);
  ring.push(first, 1024); ring.push(quiet, 2048); ring.push(quiet, 3072);
  const tail = ring.after(0);
  assert.deepEqual(tail.map(chunk => chunk.length), [1024, 1024, 1024]);
  const actual = createEndpoint({ sampleRate: 16000 }), expected = createEndpoint({ sampleRate: 16000 });
  assert.deepEqual(tail.map(chunk => actual.process(chunk, { recording: true })), [first, quiet, quiet].map(chunk => expected.process(chunk, { recording: true })));
  assert.deepEqual(ring.after(1700).map(chunk => chunk.length), [348, 1024]);
});
