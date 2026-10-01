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
    let chunks = [], end = 0;
    function clear() { chunks = []; }
    function push(samples, endFrame) {
      end = endFrame;
      chunks.push({ start: endFrame - samples.length, samples: new Float32Array(samples) });
      const first = endFrame - capacity;
      while (chunks.length && chunks[0].start + chunks[0].samples.length <= first) chunks.shift();
      if (chunks.length && chunks[0].start < first) {
        chunks[0] = { start: first, samples: chunks[0].samples.slice(first - chunks[0].start) };
      }
    }
    function after(frame) {
      if (!Number.isFinite(frame) || frame > end) return [];
      return chunks.map(chunk => new Float32Array(chunk.samples.subarray(Math.max(0, frame - chunk.start)))).filter(chunk => chunk.length);
    }
    return { push, after, clear, get endFrame() { return end; } };
  }
  return { createEndpoint, createPreRoll };
});
