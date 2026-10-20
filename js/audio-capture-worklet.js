/* No network or recognition here: bounded mono PCM batches only. */
class OlangaCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1024);
    this.offset = 0;
    this.pending = 0;
    this.overflow = false;
    this.port.onmessage = event => {
      if (event.data === 'ack') this.pending = Math.max(0, this.pending - 1);
      else if (event.data?.type === 'flush' && Number.isSafeInteger(event.data.id)) {
        this.buffer.fill(0); this.offset = 0; this.overflow = false;
        // Port ordering puts every earlier PCM packet before this boundary.
        this.port.postMessage({ flushed: event.data.id });
      }
    };
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    let read = 0;
    while (read < samples.length) {
      const count = Math.min(samples.length - read, this.buffer.length - this.offset);
      // Audio render quanta normally fit in full. Reuse that view instead of
      // creating a subarray object for every 128 samples of always-on capture.
      this.buffer.set(read === 0 && count === samples.length ? samples : samples.subarray(read, read + count), this.offset);
      this.offset += count; read += count;
      if (this.offset === this.buffer.length) {
        if (this.pending < 8) {
          if (this.overflow) { this.port.postMessage({ gap: true }); this.overflow = false; }
          this.port.postMessage({ samples: this.buffer }, [this.buffer.buffer]); this.pending++;
          // Transferred storage belongs to the receiver; only this path needs
          // a new buffer. Backpressure can overwrite its unsent buffer safely.
          this.buffer = new Float32Array(1024);
        } else this.overflow = true;
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('olanga-capture', OlangaCaptureProcessor);
