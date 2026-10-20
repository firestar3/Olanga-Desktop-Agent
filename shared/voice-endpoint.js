/* Sample-clock endpointing shared by the capture paths and deterministic tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaVoiceEndpoint = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createEndpoint({ sampleRate, threshold = 0.06 } = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Invalid capture rate');
    let noise = 0.004, elapsed = 0, quiet = 0, voiced = 0, speech = false;
    function reset() { elapsed = 0; quiet = 0; voiced = 0; speech = false; }
    function process(samples, { recording = false, endDelay = 1500, waitMs = 4000 } = {}) {
      let energy = 0;
      for (let i = 0; i < samples.length; i++) { const value = Number.isFinite(samples[i]) ? samples[i] : 0; energy += value * value; }
      const rms = samples.length ? Math.sqrt(energy / samples.length) : 0;
      // Never let a loud environment raise the original speech threshold: that
      // could turn a quiet voice into silence. Learn only probable background.
      const limit = Math.min(threshold, Math.max(0.018, noise * 3));
      const active = rms > limit;
      if (!active && !speech) noise = noise * 0.99 + rms * 0.01;
      if (!recording) return { rms, active, speech: false, stop: false, cancel: false };
      const ms = samples.length * 1000 / sampleRate;
      elapsed += ms;
      if (active) { voiced += ms; quiet = 0; if (voiced >= 60) speech = true; }
      else quiet += ms;
      const delay = Math.max(600, Number.isFinite(endDelay) ? endDelay : 1500);
      return { rms, active, speech, stop: speech && elapsed >= 500 && quiet >= delay, cancel: !speech && elapsed >= waitMs };
    }
    return { process, reset };
  }

  function createPreRoll(sampleRate, milliseconds = 750) {
    const capacity = Math.ceil(sampleRate * Math.min(1000, Math.max(0, milliseconds)) / 1000);
    // Retain one fixed sample buffer. The wake listener runs all day; allocating
    // and trimming a copied chunk on every packet creates avoidable GC pressure.
    const buffer = new Float32Array(capacity);
    const packetEnds = [];
    let write = 0, count = 0, end = 0;
    function clear() { if (count) buffer.fill(0); write = 0; count = 0; packetEnds.length = 0; }
    function push(samples, endFrame) {
      // Never join audio across a capture discontinuity. Normal packets are
      // contiguous, but recovery/flush boundaries may discard earlier samples.
      if (count && endFrame - samples.length !== end) clear();
      end = endFrame;
      if (!capacity || !samples.length) return;
      const length = Math.min(samples.length, capacity), start = samples.length - length;
      const first = Math.min(length, capacity - write);
      buffer.set(samples.subarray(start, start + first), write);
      if (first < length) buffer.set(samples.subarray(start + first), 0);
      write = (write + length) % capacity;
      count = Math.min(capacity, count + length);
      packetEnds.push(endFrame);
      while (packetEnds.length && packetEnds[0] <= endFrame - capacity) packetEnds.shift();
    }
    function after(frame) {
      if (!count || !Number.isFinite(frame) || frame >= end) return [];
      const skip = Math.max(0, Math.trunc(frame - (end - count))), result = [];
      let from = end - count + skip, start = (write - count + skip + capacity) % capacity;
      // Preserve packet boundaries: recording startup feeds these chunks to
      // the RMS endpoint, where merging speech and silence changes decisions.
      for (const packetEnd of packetEnds) {
        const length = packetEnd - from;
        if (length <= 0) continue;
        const first = Math.min(length, capacity - start), samples = new Float32Array(length);
        samples.set(buffer.subarray(start, start + first));
        if (first < length) samples.set(buffer.subarray(0, length - first), first);
        result.push(samples); from = packetEnd; start = (start + length) % capacity;
      }
      return result;
    }
    return { push, after, clear, get endFrame() { return end; } };
  }
  return { createEndpoint, createPreRoll };
});
