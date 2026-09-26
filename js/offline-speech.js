/* Optional local transcription with the already bundled vosk-browser 0.0.8.
   Load after voice.js. This module never selects a transcription mode or calls
   a provider; callers must explicitly opt into transcribe(). */
(function () {
  'use strict';
  const SAMPLE_RATE = 16000;
  const CHUNK_SAMPLES = 4096;
  const MAX_AUDIO_SECONDS = 60;
  const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
  const DEADLINE_MS = 90000;
  function numberWords(value) {
    const small = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
    const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
    if (value < 20) return small[value];
    if (value === 100) return 'one hundred';
    return tens[Math.floor(value / 10)] + (value % 10 ? ' ' + small[value % 10] : '');
  }

  function buildCommandGrammar() {
    // An optional recognizer vocabulary, never a transcript repair map. Vosk
    // may ignore words absent from the bundled acoustic model's lexicon; [unk]
    // must remain available rather than forcing every sound into an action.
    const phrases = new Set(['[unk]', 'and', 'then', 'and then', 'please', 'can you', 'could you', 'would you']);
    const apps = ['spotify', 'discord', 'chrome', 'google chrome', 'edge', 'microsoft edge', 'firefox', 'notepad', 'calculator',
      'word', 'excel', 'powerpoint', 'outlook', 'teams', 'slack', 'vs code', 'visual studio code', 'file explorer'];
    for (const verb of ['open', 'launch', 'start']) for (const app of apps) phrases.add(`${verb} ${app}`);
    for (const verb of ['pause', 'stop', 'resume', 'continue', 'play']) {
      phrases.add(verb);
      for (const target of ['the music', 'my music', 'the song', 'playback', 'spotify']) phrases.add(`${verb} ${target}`);
    }
    for (const phrase of ['next track', 'next song', 'skip', 'skip this song', 'previous track', 'previous song', 'volume up', 'volume down',
      'increase the volume', 'lower the volume', 'louder', 'quieter', 'restart spotify', 'reload spotify']) phrases.add(phrase);
    for (let value = 0; value <= 100; value++) {
      const number = numberWords(value);
      for (const verb of ['set', 'raise', 'increase', 'lower', 'decrease', 'change', 'adjust']) {
        phrases.add(`${verb} the volume to ${number} percent`);
        phrases.add(`${verb} volume to ${number}`);
      }
      if (value > 0) {
        for (const unit of ['seconds', 'minutes', ...(value <= 24 ? ['hours'] : [])]) {
          const duration = `${number} ${value === 1 ? unit.slice(0, -1) : unit}`;
          phrases.add(`set a timer for ${duration}`);
          phrases.add(`start a ${duration} timer`);
        }
      }
    }
    return JSON.stringify([...phrases]);
  }
  const COMMAND_GRAMMAR = buildCommandGrammar();
  let active = null;
  let lastError = '';
  let lastRun = null;

  const abortError = () => new DOMException('Offline transcription cancelled', 'AbortError');
  function assertActive(run) {
    if (run.controller.signal.aborted) throw run.controller.signal.reason || abortError();
    if (active !== run) throw abortError();
  }

  function validateWav(bytes) {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 44 || bytes.byteLength > MAX_AUDIO_BYTES) throw new Error('The WAV recording is invalid or too large.');
    const view = new DataView(bytes);
    const tag = offset => String.fromCharCode(...new Uint8Array(bytes, offset, 4));
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Offline speech expects a PCM WAV recording.');
    if (view.getUint32(4, true) + 8 !== bytes.byteLength) throw new Error('The WAV recording has an inconsistent size.');
    let format = null, dataBytes = 0, dataChunks = 0;
    for (let offset = 12; offset + 8 <= bytes.byteLength;) {
      const size = view.getUint32(offset + 4, true);
      if (offset + 8 + size > bytes.byteLength) throw new Error('The WAV recording is truncated.');
      if (tag(offset) === 'fmt ' && size >= 16) {
        if (format) throw new Error('The WAV recording has conflicting format headers.');
        format = { encoding: view.getUint16(offset + 8, true), channels: view.getUint16(offset + 10, true),
          sampleRate: view.getUint32(offset + 12, true), byteRate: view.getUint32(offset + 16, true), frameBytes: view.getUint16(offset + 20, true), bits: view.getUint16(offset + 22, true) };
      }
      if (tag(offset) === 'data') {
        if (++dataChunks > 1) throw new Error('The WAV recording has conflicting audio data.');
        dataBytes = size;
      }
      offset += 8 + size + (size % 2);
    }
    if (!format || format.encoding !== 1 || format.bits !== 16 || ![1, 2].includes(format.channels) ||
        format.frameBytes !== format.channels * 2 || format.sampleRate < 8000 || format.sampleRate > 96000 ||
        format.byteRate !== format.sampleRate * format.frameBytes ||
        !dataBytes || dataBytes % format.frameBytes) throw new Error('Offline speech expects a mono or stereo 16-bit PCM WAV recording.');
    if (dataBytes / format.frameBytes / format.sampleRate > MAX_AUDIO_SECONDS) throw new Error('Offline speech supports recordings up to 60 seconds.');
  }

  function awaitAbortable(promise, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(signal.reason || abortError()); };
      const cleanup = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      if (signal.aborted) abort();
    });
  }

  // The installed worker emits one result/partialresult for each audioChunk.
  // Wait for each response before flushing: retrieveFinalResult also emits a
  // plain "result", with no distinct final flag. This avoids truncating at an
  // earlier silence endpoint or appending partial hypotheses twice.
  function recognizerResponse(recognizer, send, signal, final = false) {
    return new Promise((resolve, reject) => {
      const events = final ? ['result', 'error'] : ['result', 'partialresult', 'error'];
      const cleanup = () => {
        for (const name of events) recognizer.removeEventListener(name, receive);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => { cleanup(); reject(signal.reason || abortError()); };
      const receive = event => {
        cleanup();
        const message = event.detail;
        if (event.type === 'error') reject(new Error(message?.error || 'Offline recognition failed.'));
        else resolve(message);
      };
      for (const name of events) recognizer.addEventListener(name, receive);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      try { send(); } catch (error) { cleanup(); reject(error); }
    });
  }

  function cancel() {
    active?.controller.abort(abortError());
  }

  async function transcribe(blob, { signal, mode = 'general' } = {}) {
    if (signal?.aborted) throw abortError();
    if (!['general', 'commands'].includes(mode)) throw new Error('Unknown offline transcription mode.');
    if (!blob || typeof blob.arrayBuffer !== 'function' || !Number.isFinite(blob.size) || blob.size <= 0 || blob.size > MAX_AUDIO_BYTES) {
      throw new Error('Offline speech needs a nonempty audio recording smaller than 8 MB.');
    }
    cancel();
    const run = { controller: new AbortController(), recognizer: null, decoder: null, started: Date.now() };
    active = run;
    lastError = '';
    const abort = () => run.controller.abort(abortError());
    signal?.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => run.controller.abort(new Error('Offline transcription took too long. Please try a shorter recording.')), DEADLINE_MS);
    const localSignal = run.controller.signal;
    try {
      const bytes = await awaitAbortable(blob.arrayBuffer(), localSignal);
      assertActive(run);
      validateWav(bytes); // Bound duration before decoding, not after allocating decoded audio.
      const AudioDecoder = window.AudioContext || window.webkitAudioContext;
      if (!AudioDecoder) throw new Error('Audio decoding is unavailable on this device.');
      run.decoder = new AudioDecoder({ sampleRate: SAMPLE_RATE });
      const decoded = await awaitAbortable(run.decoder.decodeAudioData(bytes), localSignal);
      assertActive(run);
      if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > MAX_AUDIO_SECONDS ||
          !Number.isInteger(decoded.length) || decoded.length <= 0 || decoded.length > SAMPLE_RATE * MAX_AUDIO_SECONDS ||
          decoded.sampleRate !== SAMPLE_RATE || decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2) {
        throw new Error('Offline speech supports mono or stereo recordings up to 60 seconds.');
      }
      // decodeAudioData resamples to the context's requested 16 kHz. It never
      // needs a source node, output playback, or a microphone permission.
      const mono = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const samples = decoded.getChannelData(channel);
        for (let index = 0; index < mono.length; index++) {
          const sample = samples[index];
          if (!Number.isFinite(sample)) throw new Error('The audio recording contains invalid samples.');
          mono[index] += Math.max(-1, Math.min(1, sample)) / decoded.numberOfChannels;
        }
      }
      await awaitAbortable(run.decoder.close(), localSignal);
      run.decoder = null;
      assertActive(run);
      const model = await awaitAbortable(initVosk(), localSignal);
      assertActive(run);
      const modelFailed = event => run.controller.abort(new Error(event?.detail?.error || event?.message || 'The offline speech worker stopped. Please try again.'));
      model.addEventListener?.('error', modelFailed);
      model.worker?.addEventListener?.('error', modelFailed);
      model.worker?.addEventListener?.('messageerror', modelFailed);
      run.removeModelListeners = () => {
        model.removeEventListener?.('error', modelFailed);
        model.worker?.removeEventListener?.('error', modelFailed);
        model.worker?.removeEventListener?.('messageerror', modelFailed);
      };
      run.recognizer = new model.KaldiRecognizer(SAMPLE_RATE, mode === 'commands' ? COMMAND_GRAMMAR : undefined);
      const parts = [];
      for (let offset = 0; offset < mono.length; offset += CHUNK_SAMPLES) {
        assertActive(run);
        const message = await recognizerResponse(run.recognizer,
          () => run.recognizer.acceptWaveformFloat(mono.subarray(offset, offset + CHUNK_SAMPLES), SAMPLE_RATE), localSignal);
        if (message?.event === 'result' && typeof message.result?.text === 'string' && message.result.text.trim()) parts.push(message.result.text.trim());
      }
      const final = await recognizerResponse(run.recognizer, () => run.recognizer.retrieveFinalResult(), localSignal, true);
      assertActive(run);
      if (typeof final?.result?.text === 'string' && final.result.text.trim()) parts.push(final.result.text.trim());
      lastRun = { durationMs: Date.now() - run.started, audioSeconds: decoded.duration, sampleRate: SAMPLE_RATE, mode };
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    } catch (error) {
      if (active === run && error.name !== 'AbortError') lastError = error.message || 'Offline transcription failed.';
      throw error;
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      run.removeModelListeners?.();
      if (run.recognizer) {
        try { run.recognizer.remove(); } catch (_) {}
        run.recognizer = null;
      }
      if (run.decoder) {
        try { Promise.resolve(run.decoder.close()).catch(() => {}); } catch (_) {}
        run.decoder = null;
      }
      if (active === run) active = null;
    }
  }

  window.OlangaOfflineSpeech = Object.freeze({
    transcribe, cancel,
    getStatus: () => ({
      ready: typeof voskModel !== 'undefined' && !!voskModel?.ready,
      loading: typeof voskModelLoadPromise !== 'undefined' && !!voskModelLoadPromise,
      busy: !!active, recognizers: active?.recognizer ? 1 : 0,
      decoding: !!active?.decoder, lastError, lastRun,
      maxAudioSeconds: MAX_AUDIO_SECONDS, maxAudioBytes: MAX_AUDIO_BYTES
    })
  });
})();
