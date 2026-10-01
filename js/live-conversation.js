/* Explicitly started conversation preview. It never dispatches assistant tools. */
(function () {
  let generation = 0, sessionId = null, active = false, starting = false;
  let playback = null, nextAudioTime = 0, outgoing = [], sending = false, muteMonitor = null;
  let unsubscribe = null, status = { phase: 'idle', inputText: '', outputText: '', message: '' };
  const sources = new Set(), listeners = new Set();
  function notify(change) {
    status = { ...status, ...change };
    for (const listener of listeners) { try { listener({ ...status }); } catch (_) {} }
  }
  function clearPlayback() {
    for (const source of sources) { try { source.stop(); } catch (_) {} }
    sources.clear(); nextAudioTime = 0;
  }
  function api() { return window.electronAPI; }
  async function stop(message = '') {
    if (!active && !starting && !sessionId && !playback) return;
    generation++; const previous = sessionId;
    sessionId = null; active = false; starting = false; outgoing = []; sending = false;
    clearInterval(muteMonitor); muteMonitor = null;
    unsubscribe?.(); unsubscribe = null;
    clearPlayback(); const context = playback; playback = null;
    // Dispatch stop before yielding, so an immediate new Start cannot be
    // disconnected by this session's late cleanup.
    let closing; try { closing = api()?.conversationLiveStop?.(previous ? { sessionId: previous } : {}); } catch (_) {}
    if (typeof resetMicrophoneRecognition === 'function') resetMicrophoneRecognition();
    if (currentState === State.LISTENING || currentState === State.SPEAKING) setState(State.IDLE);
    notify({ phase: 'idle', message: typeof message === 'string' ? message : '' });
    try { await Promise.all([Promise.resolve(context?.close()).catch(() => {}), Promise.resolve(closing).catch(() => {})]); } catch (_) {}
  }
  function playAudio(event) {
    if (typeof isTtsMuted !== 'undefined' && isTtsMuted) { clearPlayback(); return; }
    if (!playback || event.sampleRate !== 24000) return;
    if (nextAudioTime - playback.currentTime > 12) { stop('Live playback could not keep up. Start again when ready.'); return; }
    try {
      const binary = atob(event.audioBase64);
      if (!binary.length || binary.length > 524288 || binary.length % 2) throw new Error('Invalid PCM');
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
      const view = new DataView(bytes.buffer), samples = new Float32Array(bytes.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      const buffer = playback.createBuffer(1, samples.length, 24000); buffer.copyToChannel(samples, 0);
      const source = playback.createBufferSource(); source.buffer = buffer; source.connect(playback.destination);
      const at = Math.max(playback.currentTime + 0.015, nextAudioTime);
      sources.add(source); source.onended = () => { sources.delete(source); source.disconnect(); };
      source.start(at); nextAudioTime = at + buffer.duration;
    } catch (_) { stop('Live audio playback failed.'); }
  }
  async function start({ model } = {}) {
    if (active || starting) throw new Error('Live conversation is already active.');
    if (!api()?.conversationLiveStart || !api()?.onConversationLiveEvent) throw new Error('Live conversation is unavailable.');
    if (isMicMuted || !micStream || micStream.active === false) throw new Error('Unmute and enable voice input before starting Live conversation.');
    if (currentState !== State.IDLE || window.OlangaDesktop?.isBusy?.()) throw new Error('Finish the current request before starting Live conversation.');
    const token = ++generation; starting = true;
    notify({ phase: 'connecting', inputText: '', outputText: '', message: '' });
    try {
      // A user click creates/resumes output. No microphone audio crosses IPC
      // until the setup handshake has completed and this session is active.
      playback = new AudioContext({ sampleRate: 24000 }); await playback.resume();
      if (generation !== token) return;
      unsubscribe = api().onConversationLiveEvent(event => {
        if (generation !== token || event.sessionId !== sessionId) return;
        if (event.type === 'audio') playAudio(event);
        else if (event.type === 'interrupted') clearPlayback();
        else if (event.type === 'input-text') notify({ inputText: (status.inputText + event.text).slice(-8000) });
        else if (event.type === 'output-text') notify({ outputText: (status.outputText + event.text).slice(-16000) });
        else if (event.type === 'error' || event.type === 'closed') stop(event.message);
      });
      const result = await api().conversationLiveStart({ model });
      if (generation !== token) { await api().conversationLiveStop({ sessionId: result.sessionId }); return; }
      if (!result?.ok || typeof result.sessionId !== 'string') throw new Error('Live conversation could not start.');
      sessionId = result.sessionId; active = true; starting = false;
      setState(State.LISTENING); notify({ phase: 'active', message: 'Live conversation is sending microphone audio to Gemini. Desktop actions are unavailable here.' });
      muteMonitor = setInterval(() => {
        if (isMicMuted || !micStream || micStream.active === false) stop('Live conversation stopped because the microphone is unavailable or muted.');
        else if (typeof isTtsMuted !== 'undefined' && isTtsMuted) clearPlayback();
      }, 100);
      return result;
    } catch (error) {
      if (generation === token) await stop(error?.message || 'Live conversation could not start.');
      throw error;
    }
  }
  async function flush(token) {
    if (sending) return;
    sending = true;
    try {
      while (active && token === generation && outgoing.length) await api().conversationLiveAudio(outgoing.shift());
    } catch (_) { if (token === generation) await stop('Live audio could not be sent. Start again when ready.'); }
    finally { if (token === generation) sending = false; }
  }
  function acceptSamples(samples, sampleRate) {
    if (!active || isMicMuted) return;
    if (outgoing.length >= 16) { stop('Live conversation could not keep up with the microphone.'); return; }
    const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i++) {
      const value = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0));
      view.setInt16(i * 2, value < 0 ? value * 32768 : value * 32767, true);
    }
    let binary = ''; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    outgoing.push({ sessionId, sampleRate, audioBase64: btoa(binary) }); flush(generation);
  }
  window.OlangaLiveConversation = { start, stop, acceptSamples, clearPlayback,
    isActive: () => active || starting,
    getState: () => ({ ...status }),
    onChange(listener) { listeners.add(listener); listener({ ...status }); return () => listeners.delete(listener); } };
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && (active || starting)) stop(); });
  window.addEventListener('beforeunload', () => { if (active || starting) stop(); });
})();
