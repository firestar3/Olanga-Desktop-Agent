/* ============================================
   OLANGA — VOICE PIPELINE
   Vosk wake word (offline), mic capture, VAD, WAV encoding
   ============================================ */

// ============================================
// VOSK WAKE WORD DETECTION (OFFLINE)
// ============================================
let microphonePreferredDeviceId = (() => { try { return String(localStorage.getItem('olanga_microphone_device') || '').slice(0, 256); } catch (_) { return ''; } })();
let audioInputSwitching = false;
let audioPhraseTest = null;
let audioReplyTesting = false;
let voskModelLoadPromise = null;
let voskLibraryLoadPromise = null;
let voskModelCleanup = null;
let voskIdleTimer = null;
let voskModelUsers = 0;
let voskReleaseAfterLoad = false;
const VOSK_IDLE_RELEASE_MS = 5000;

function loadVoskLibrary() {
  if (window.Vosk?.Model) return Promise.resolve(window.Vosk);
  if (voskLibraryLoadPromise) return voskLibraryLoadPromise;
  voskLibraryLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    // Keep this local and fixed: typed-only or muted startup does not need to
    // parse the 5.8 MB speech bundle or construct its embedded worker source.
    script.src = './node_modules/vosk-browser/dist/vosk.js';
    script.async = true;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      script.onload = null; script.onerror = null;
      if (error) { script.remove(); reject(error); }
      else resolve(window.Vosk);
    };
    const timeout = setTimeout(() => finish(new Error('The offline speech library took too long to load. Please try again.')), 15000);
    script.onload = () => finish(window.Vosk?.Model ? null : new Error('The offline speech library is unavailable. Please try again.'));
    script.onerror = () => finish(new Error('The offline speech library could not load. Please try again.'));
    try { document.head.appendChild(script); } catch (error) { finish(error); }
  }).finally(() => { voskLibraryLoadPromise = null; });
  return voskLibraryLoadPromise;
}

function retainVoskModel() {
  voskModelUsers++;
  voskReleaseAfterLoad = false;
  clearTimeout(voskIdleTimer); voskIdleTimer = null;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    voskModelUsers--;
    scheduleIdleVoskRelease();
  };
}

function scheduleIdleVoskRelease() {
  clearTimeout(voskIdleTimer); voskIdleTimer = null;
  voskReleaseAfterLoad = false;
  if (voskModelUsers || (microphoneRequested && !isMicMuted)) return;
  // A cancelled offline request may release its lease while the shared model
  // is still loading. Release that late result too, unless another user joined.
  if (!voskModel) { voskReleaseAfterLoad = !!(voskModelLoadPromise || voskLibraryLoadPromise); return; }
  // Brief mute toggles stay instant. A sustained mute releases the worker's
  // model, decoded archive and WASM heap instead of retaining them all day.
  voskIdleTimer = setTimeout(() => {
    voskIdleTimer = null;
    if (voskModelUsers || (microphoneRequested && !isMicMuted) || voskModelLoadPromise) return;
    const model = voskModel;
    if (!model || microphoneResources?.recognizer) return;
    voskModel = null; isVoskReady = false;
    voskModelCleanup?.(); voskModelCleanup = null;
    try { model.worker?.terminate(); } catch (_) {}
  }, VOSK_IDLE_RELEASE_MS);
}

async function initVosk({ microphone = false } = {}) {
    if (microphone && isMicMuted) return null;
    voskReleaseAfterLoad = false;
    if (!window.Vosk?.Model) await loadVoskLibrary();
    if (microphone && isMicMuted) return null;
    clearTimeout(voskIdleTimer); voskIdleTimer = null;
    if (voskModel?.ready) return voskModel;
    if (voskModelLoadPromise) return voskModelLoadPromise;
    console.log('[Olanga] Loading Vosk model from local tar.gz...');
    // The bundled 0.0.8 createModel wrapper does not reject model error events.
    // Observe both events directly, and share one load with the wake-word and
    // optional offline transcription paths. No API key is needed for this model.
    voskModelLoadPromise = new Promise((resolve, reject) => {
      const model = new window.Vosk.Model('olanga-asset://local/vosk-model-v2.tar.gz', -1);
      let settled = false;
      const removeFailureListeners = () => {
        model.removeEventListener('error', failed);
        model.worker?.removeEventListener?.('error', workerFailed);
        model.worker?.removeEventListener?.('messageerror', workerFailed);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        model.removeEventListener('load', loaded);
        if (error) {
          removeFailureListeners();
          // terminate() in 0.0.8 assumes a successfully constructed native
          // model; a startup failure must terminate its worker directly.
          try { model.worker.terminate(); } catch (_) {}
          isVoskReady = false;
          reject(error);
          return;
        }
        voskModel = model;
        voskModelCleanup = removeFailureListeners;
        isVoskReady = true;
        if (voskReleaseAfterLoad || (typeof isMicMuted !== 'undefined' && isMicMuted)) scheduleIdleVoskRelease();
        console.log('[Olanga] Vosk model loaded successfully.');
        resolve(model);
      };
      const loaded = event => finish(event.detail?.result ? null : new Error('The offline speech model could not load.'));
      const failed = event => {
        const error = new Error(event?.detail?.error || event?.message || 'The offline speech worker stopped. Select your speech input again to retry.');
        if (!settled) { finish(error); return; }
        removeFailureListeners();
        try { model.worker.terminate(); } catch (_) {}
        // A dead worker can still report model.ready in the bundled library.
        // Evict it so the next explicit initialization can recover.
        if (voskModel !== model) return;
        voskModel = null;
        voskModelCleanup = null;
        isVoskReady = false;
        if (microphoneResources?.model === model) {
          failMicrophoneRecognition(microphoneResources, 'Offline speech stopped. Select your speech input again to retry.');
        }
      };
      const workerFailed = event => failed(event);
      const timeout = setTimeout(() => finish(new Error('The offline speech model took too long to load.')), 45000);
      model.addEventListener('load', loaded);
      model.addEventListener('error', failed);
      model.worker?.addEventListener?.('error', workerFailed);
      model.worker?.addEventListener?.('messageerror', workerFailed);
    }).finally(() => { voskModelLoadPromise = null; });
    return voskModelLoadPromise;
}

// ============================================
// MICROPHONE + RAW PCM CAPTURE
// ============================================

let microphoneInitPromise = null;
let microphoneResources = null;
let microphoneMonitorFrame = null;
const MAX_RECORDING_SECONDS = 60;
let recordingSampleCount = 0;
let microphoneRecoveryNeeded = false;
let microphoneDeviceListenerInstalled = false;
let microphoneRequested = false;
let microphoneResumePromise = null;
let microphoneVisualSubscription = null;
let microphoneScreenObserver = null;

function microphoneVisualsVisible() {
  return (window.OlangaVisibility?.isVisible?.() ?? (typeof document === 'undefined' || !document.hidden)) &&
    (typeof mainScreen === 'undefined' || (!mainScreen?.hidden && !mainScreen?.classList.contains('hidden')));
}

function microphoneMonitorNeeded(resources) {
  // The production endpoint uses sample time and keeps running without frames.
  // Only listening displays a microphone waveform; speaking has its own CSS
  // animation. The legacy analyser still needs frames for its recording VAD.
  return !!resources && !isMicMuted && (!resources.endpoint ||
    (currentState === State.LISTENING && microphoneVisualsVisible()));
}

function refreshMicrophoneMonitor() {
  const resources = microphoneResources;
  const needed = microphoneMonitorNeeded(resources);
  if (!needed && microphoneMonitorFrame !== null) {
    cancelAnimationFrame(microphoneMonitorFrame); microphoneMonitorFrame = null;
  }
  if (needed && microphoneMonitorFrame === null) monitorAudio();
}

async function resumeMicrophoneGraph(resources) {
  await resources.suspendPromise;
  if (microphoneResources !== resources || isMicMuted) return false;
  if (resources.context.state === 'suspended') await resources.context.resume();
  if (microphoneResources !== resources) return false;
  if (isMicMuted) {
    if (resources.context.state === 'running') await resources.context.suspend?.();
    return false;
  }
  discardLocalSpeechCapture();
  refreshMicrophoneMonitor();
  return true;
}

function refreshMicrophoneActivity() {
  if (isMicMuted) {
    cancelAudioPhraseTest('The microphone was muted.');
    resetMicrophoneRecognition();
    currentRMS = 0;
    if (typeof waveBarEls !== 'undefined') updateWaveBars(0);
    refreshMicrophoneMonitor();
    const resources = microphoneResources;
    try {
      if (resources?.context.state === 'running') resources.suspendPromise = Promise.resolve(resources.context.suspend?.()).catch(() => {});
    } catch (_) {}
    scheduleIdleVoskRelease();
    return;
  }
  clearTimeout(voskIdleTimer); voskIdleTimer = null;
  if (!microphoneRequested) { resetMicrophoneRecognition(); return; }
  if (microphoneResumePromise) return;
  microphoneResumePromise = (async () => {
    try {
      // Microphone permission and the suspended graph are reused when possible.
      // A muted startup has neither and creates them only after unmuting.
      const existing = microphoneResources;
      // Push-to-talk can capture immediately on the existing graph while the
      // full wake model reloads. Its WAV and endpointing do not depend on Vosk.
      await Promise.all([initVosk({ microphone: true }), existing ? resumeMicrophoneGraph(existing) : Promise.resolve()]);
      if (isMicMuted) { scheduleIdleVoskRelease(); return; }
      // A disconnect during resume belongs to the device-recovery path. Do
      // not silently reopen the microphone while finishing this old attempt.
      if (existing && !microphoneResources) return;
      if (!await initMicrophone() || isMicMuted) return;
      const resources = microphoneResources;
      if (!resources) return;
      await resources.suspendPromise;
      if (microphoneResources !== resources || isMicMuted) return;
      if (resources.context.state === 'suspended' && !await resumeMicrophoneGraph(resources)) return;
      refreshMicrophoneMonitor();
      if (currentState === State.IDLE) setState(State.IDLE);
    } catch (error) {
      if (!isMicMuted) showError(error.message || 'Could not resume voice input. Select your speech input again to retry.');
    } finally {
      microphoneResumePromise = null;
    }
  })();
}

function installMicrophoneDeviceRecovery() {
  if (microphoneDeviceListenerInstalled || !navigator.mediaDevices?.addEventListener) return;
  microphoneDeviceListenerInstalled = true;
  navigator.mediaDevices.addEventListener('devicechange', () => {
    // Only recover a graph the user already enabled. Never turn voice on, change
    // the selected recognizer, or unmute because a new device appeared.
    if (!microphoneRecoveryNeeded || isMicMuted || microphoneInitPromise || microphoneResources) return;
    microphoneRecoveryNeeded = false;
    initMicrophone().then(ok => { if (!ok) microphoneRecoveryNeeded = true; });
  });
}

function receiveMicrophoneSamples(resources, inputData) {
  if (microphoneResources !== resources || isMicMuted || !(inputData instanceof Float32Array)) return;
  resources.frame += inputData.length;
  if (resources.captureBarrier) { resources.preRoll?.clear(); return; }
  const recordingAtEntry = isRecording;
  const live = window.OlangaLiveConversation;
  if (live?.isActive?.()) { resources.preRoll?.clear(); live.acceptSamples(inputData, resources.context.sampleRate); return; }
  if (window.OlangaLocalSpeech?.isActive?.()) { resources.preRoll?.clear(); return; }
  if (currentState === State.IDLE && !isWakeWordCapturing) resources.preRoll?.push(inputData, resources.frame);
  else if (!isRecording) resources.preRoll?.clear();
  if (((currentState === State.IDLE && !isWakeWordCapturing) || isWakeWordCapturing ||
      ((currentState === State.SPEAKING || currentState === State.THINKING) && isBargeInEnabled()) || (currentState === State.LISTENING && isRecording)) && resources.recognizer && isVoskReady) {
    try { resources.recognizer.acceptWaveformFloat(inputData, resources.context.sampleRate); }
    catch (_) { failMicrophoneRecognition(resources); }
  }
  if (isRecording && recordingAtEntry) {
    const remaining = Math.max(0, MAX_RECORDING_SECONDS * resources.context.sampleRate - recordingSampleCount);
    const chunk = new Float32Array(inputData.subarray(0, remaining));
    if (chunk.length) { pcmChunks.push(chunk); recordingSampleCount += chunk.length; }
  }
  if (resources.endpoint) {
    const result = resources.endpoint.process(inputData, { recording: isRecording,
      endDelay: isRecording ? endOfSpeechDelay() : 1500,
      waitMs: typeof followUpTimer !== 'undefined' && followUpTimer ? 12000 : 4000 });
    currentRMS = result.rms * 100;
    if (isRecording && result.speech && !hasSpokenDuringRecording) {
      hasSpokenDuringRecording = true;
      if (typeof followUpTimer !== 'undefined' && followUpTimer) { clearTimeout(followUpTimer); followUpTimer = null; }
    }
    if (isRecording && result.cancel) { cancelRecording(); setState(State.IDLE); }
    else if (isRecording && result.stop) stopRecording();
  }
  if (isRecording && recordingSampleCount >= MAX_RECORDING_SECONDS * resources.context.sampleRate) stopRecording();
}

function useLegacyMicrophoneProcessor(resources) {
  const processor = resources.context.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = event => { if (resources.processor === processor) receiveMicrophoneSamples(resources, event.inputBuffer.getChannelData(0)); };
  return processor;
}

function replaceCaptureWithLegacy(resources) {
  const previous = resources.processor, replacement = useLegacyMicrophoneProcessor(resources);
  resources.source.disconnect(previous); previous.disconnect();
  previous.onaudioprocess = null; previous.onprocessorerror = null;
  if (previous.port) previous.port.onmessage = null;
  resources.processor = replacement; scriptNode = replacement;
  resources.source.connect(replacement); replacement.connect(resources.gain);
  clearTimeout(resources.captureFlushTimer); resources.captureFlushTimer = null; resources.captureBarrier = null;
}

// Drop speaker-era buffers and queued recognizer callbacks at both ends of
// local playback. This never changes the microphone or interruption settings.
function discardLocalSpeechCapture() {
  const resources = microphoneResources;
  if (!resources) return;
  resetMicrophoneRecognition();
  const recover = () => {
    if (microphoneResources !== resources) return;
    try { replaceCaptureWithLegacy(resources); resetMicrophoneRecognition(); }
    catch (_) { microphoneRecoveryNeeded = true; releaseMicrophoneResources(resources); showError('Audio capture stopped. Select your speech input again.'); }
  };
  if (!resources.processor?.port) { recover(); return; }
  const id = (resources.captureFlushSequence || 0) + 1; resources.captureFlushSequence = id; resources.captureBarrier = id;
  clearTimeout(resources.captureFlushTimer);
  // A failed worklet must not leave voice blocked behind an unanswered flush.
  resources.captureFlushTimer = setTimeout(() => { if (resources.captureBarrier === id) recover(); }, 500);
  try { resources.processor.port.postMessage({ type: 'flush', id }); } catch (_) { recover(); }
}

// While recording, the on-device recognizer keeps a rough transcript. It only
// shortens the pause after a complete local command and helps choose a reply
// lane; Gemini's transcript, or the review step, still decides what runs.
let liveTranscript = { finals: [], partial: '', cached: '' };
let liveCommandCache = { text: null, complete: false };

function resetLiveTranscript() {
  liveTranscript = { finals: [], partial: '', cached: '' };
}

function getLiveTranscript() {
  if (liveTranscript.cached === null) {
    liveTranscript.cached = [...liveTranscript.finals, liveTranscript.partial].join(' ').replace(/\[unk\]/gi, ' ').replace(/\s+/g, ' ').trim();
  }
  return liveTranscript.cached;
}

// The chosen pause (1.5 s by default) ends a spoken request. A complete local
// command in the rough transcript needs only 60% of it, never under 600 ms.
function endOfSpeechDelay() {
  const base = typeof endOfSpeechMs === 'number' && endOfSpeechMs > 0 ? endOfSpeechMs : SILENCE_DURATION;
  return liveCommandComplete() ? Math.max(600, Math.round(base * 0.6)) : base;
}

function liveCommandComplete() {
  const text = getLiveTranscript();
  if (text !== liveCommandCache.text) {
    liveCommandCache = { text, complete: !!text && typeof OlangaIntents !== 'undefined' && !!OlangaIntents.parse(text, window.OlangaWorkspace?.options?.()) };
  }
  return liveCommandCache.complete;
}

function releaseMicrophoneResources(resources) {
  if (!resources) return;
  if (audioPhraseTest?.resources === resources) cancelAudioPhraseTest('The microphone changed or disconnected.');
  clearTimeout(resources.captureFlushTimer); resources.captureBarrier = null;
  if (microphoneResources === resources) {
    microphoneResources = null;
    if (microphoneMonitorFrame !== null) cancelAnimationFrame(microphoneMonitorFrame);
    microphoneMonitorFrame = null;
    cancelRecording();
  }
  for (const [track, listener] of resources.trackListeners || []) track.removeEventListener?.('ended', listener);
  if (resources.processor) { resources.processor.onaudioprocess = null; resources.processor.onprocessorerror = null; if (resources.processor.port) resources.processor.port.onmessage = null; }
  resources.preRoll?.clear();
  for (const node of [resources.source, resources.processor, resources.gain, resources.analyser]) {
    try { node?.disconnect(); } catch (_) {}
  }
  try { resources.recognizer?.remove(); } catch (_) {}
  try { resources.stream?.getTracks().forEach(track => track.stop()); } catch (_) {}
  try { if (resources.context?.state !== 'closed') Promise.resolve(resources.context?.close()).catch(() => {}); } catch (_) {}
  if (micStream === resources.stream) micStream = null;
  if (audioContext === resources.context) audioContext = null;
  if (voskRecognizer === resources.recognizer) voskRecognizer = null;
  if (scriptNode === resources.processor) scriptNode = null;
  if (analyser === resources.analyser) analyser = null;
}

function attachMicrophoneRecognizer(resources) {
  if (isMicMuted || !voskModel?.ready || (resources.recognizer && resources.model === voskModel)) return;
  try { resources.recognizer?.remove(); } catch (_) {}
  resources.recognizer = new voskModel.KaldiRecognizer(resources.context.sampleRate);
  resources.recognizerStartFrame = resources.frame || 0;
  resources.model = voskModel;
  const recognizer = resources.recognizer;
  const current = () => microphoneResources === resources && resources.recognizer === recognizer;
  resources.recognizer.setWords(true);
  resources.recognizer.on('result', message => {
    if (current() && !isMicMuted) handleVoskResult(message?.result?.text, true, message?.result?.result);
  });
  resources.recognizer.on('partialresult', message => {
    if (current() && !isMicMuted) handleVoskResult(message?.result?.partial, false);
  });
  resources.recognizer.on('error', () => {
    if (current()) failMicrophoneRecognition(resources);
  });
  if (microphoneResources === resources) voskRecognizer = resources.recognizer;
}

function failMicrophoneRecognition(resources, message = 'Wake word recognition stopped. Mute and unmute the microphone to retry.') {
  if (audioPhraseTest?.resources === resources) cancelAudioPhraseTest('Local speech recognition stopped. Try the microphone check again after recognition recovers.');
  const recognizer = resources.recognizer;
  resources.recognizer = null;
  resources.model = null;
  if (voskRecognizer === recognizer) voskRecognizer = null;
  try { recognizer?.remove(); } catch (_) {}
  showError(message);
}

function resetMicrophoneRecognition() {
  const resources = microphoneResources;
  if (!resources) return;
  resources.preRoll?.clear();
  if (isMicMuted && window.OlangaLiveConversation?.isActive?.()) window.OlangaLiveConversation.stop();
  const recognizer = resources.recognizer;
  resources.recognizer = null;
  resources.model = null;
  if (voskRecognizer === recognizer) voskRecognizer = null;
  try { recognizer?.remove(); } catch (_) {}
  if (!isMicMuted) {
    try { attachMicrophoneRecognizer(resources); }
    catch (_) { failMicrophoneRecognition(resources); }
  }
}

async function initMicrophone() {
  microphoneRequested = true;
  installMicrophoneDeviceRecovery();
  if (isMicMuted && !microphoneInitPromise) { scheduleIdleVoskRelease(); return true; }
  if (microphoneInitPromise) return microphoneInitPromise;
  if (microphoneResources && microphoneResources.stream.active !== false && microphoneResources.context.state !== 'closed') {
    attachMicrophoneRecognizer(microphoneResources);
    return true;
  }
  releaseMicrophoneResources(microphoneResources);
  microphoneInitPromise = initializeMicrophoneResources().finally(() => { microphoneInitPromise = null; });
  return microphoneInitPromise;
}

async function initializeMicrophoneResources({ deviceId = microphonePreferredDeviceId, quiet = false, canPublish = () => true } = {}) {
  const resources = { frame: 0 };
  try {
    resources.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 16000 // Vosk works best at 16k
      }
    });
    resources.trackListeners = [];
    for (const track of resources.stream.getTracks()) {
      track.enabled = !isMicMuted;
      const ended = () => {
        if (microphoneResources !== resources) return;
        const wasListening = currentState === State.LISTENING;
        microphoneRecoveryNeeded = true;
        window.OlangaLiveConversation?.stop?.();
        releaseMicrophoneResources(resources);
        if (wasListening) setState(State.IDLE);
        showError('The microphone disconnected. Reconnect it to recover voice input, or select your speech input again.');
      };
      track.addEventListener?.('ended', ended);
      resources.trackListeners.push([track, ended]);
    }

    resources.context = new AudioContext({ sampleRate: 16000 });
    const sampleRate = resources.context.sampleRate;
    const endpointAPI = typeof OlangaVoiceEndpoint !== 'undefined' ? OlangaVoiceEndpoint : null;
    resources.endpoint = endpointAPI?.createEndpoint({ sampleRate });
    resources.preRoll = endpointAPI?.createPreRoll(sampleRate);
    console.log(`[Olanga] AudioContext sample rate: ${sampleRate}`);

    attachMicrophoneRecognizer(resources);

    if (!resources.endpoint) {
      resources.analyser = resources.context.createAnalyser();
      resources.analyser.fftSize = 512;
    }

    if (resources.context.audioWorklet?.addModule && typeof AudioWorkletNode === 'function') {
      try {
        await resources.context.audioWorklet.addModule('js/audio-capture-worklet.js');
        resources.processor = new AudioWorkletNode(resources.context, 'olanga-capture');
        const processor = resources.processor;
        processor.port.onmessage = event => {
          if (microphoneResources !== resources || resources.processor !== processor) return;
          if (Number.isSafeInteger(event.data?.flushed)) {
            if (resources.captureBarrier === event.data.flushed) {
              clearTimeout(resources.captureFlushTimer); resources.captureFlushTimer = null; resources.captureBarrier = null;
              resetMicrophoneRecognition();
            }
            return;
          }
          if (event.data?.gap) {
            if (resources.captureBarrier || window.OlangaLocalSpeech?.isActive?.()) return;
            // Dropped audio must never be submitted as a complete command.
            cancelRecording(); resources.preRoll?.clear();
            window.OlangaLiveConversation?.stop?.('Audio capture was interrupted. Start again when ready.');
            if (currentState === State.LISTENING) setState(State.IDLE);
            resetMicrophoneRecognition();
            showError('Audio capture was interrupted. Please repeat your request.');
            return;
          }
          try { receiveMicrophoneSamples(resources, event.data?.samples); }
          finally { processor.port.postMessage('ack'); }
        };
        resources.processor.onprocessorerror = () => {
          if (microphoneResources !== resources) return;
          cancelRecording();
          if (currentState === State.LISTENING) setState(State.IDLE);
          try {
            replaceCaptureWithLegacy(resources);
            showError('Audio capture recovered. Please repeat the interrupted request.');
          } catch (_) { microphoneRecoveryNeeded = true; releaseMicrophoneResources(resources); showError('Audio capture stopped. Select your speech input again.'); }
        };
      } catch (_) { resources.processor = useLegacyMicrophoneProcessor(resources); }
    } else resources.processor = useLegacyMicrophoneProcessor(resources);

    resources.source = resources.context.createMediaStreamSource(resources.stream);

    // The sample-clock endpoint already computes RMS for the waveform. Only
    // the legacy endpoint fallback needs a separate analyser/audio graph.
    if (resources.analyser) resources.source.connect(resources.analyser);

    // Connect: source → scriptProcessor → silent output (for PCM capture)
    // Must connect to destination for onaudioprocess to fire, but mute it
    resources.gain = resources.context.createGain();
    resources.gain.gain.value = 0;
    resources.source.connect(resources.processor);
    resources.processor.connect(resources.gain);
    resources.gain.connect(resources.context.destination);

    // Mute may have changed while the worklet module was loading, before this
    // graph was published as micStream and visible to the audio controls.
    for (const track of resources.stream.getTracks()) track.enabled = !isMicMuted;

    // Selecting an input may await Windows permission or graph setup. A new
    // recording/request in that interval retains its original capture graph.
    if (!canPublish()) { releaseMicrophoneResources(resources); return false; }

    const previous = microphoneResources;
    microphoneResources = resources;
    microphoneRecoveryNeeded = false;
    micStream = resources.stream;
    audioContext = resources.context;
    analyser = resources.analyser || null;
    scriptNode = resources.processor;
    voskRecognizer = resources.recognizer || null;
    if (previous && previous !== resources) releaseMicrophoneResources(previous);

    console.log('[Olanga] ✅ Microphone initialized');
    // Initialization may finish after a typed request started. Never overwrite
    // its THINKING/SPEAKING/LISTENING state with an unrelated microphone event.
    if (currentState === State.IDLE) setState(State.IDLE);
    if (!microphoneVisualSubscription && window.OlangaVisibility?.subscribe) {
      microphoneVisualSubscription = window.OlangaVisibility.subscribe(refreshMicrophoneMonitor);
    }
    if (!microphoneScreenObserver && typeof MutationObserver === 'function' && typeof mainScreen !== 'undefined' && mainScreen) {
      microphoneScreenObserver = new MutationObserver(refreshMicrophoneMonitor);
      microphoneScreenObserver.observe(mainScreen, { attributes: true, attributeFilter: ['class', 'hidden'] });
    }
    if (isMicMuted) refreshMicrophoneActivity();
    else refreshMicrophoneMonitor();
    return true;
  } catch (err) {
    releaseMicrophoneResources(resources);
    console.error('[Olanga] Mic init error:', err);
    if (!quiet) showError('Microphone access denied or unavailable.');
    return false;
  }
}

// ============================================
// VOSK RESULT HANDLER
// ============================================
function handleVoskResult(text, isFinal = false, words) {
    // Setup speech is local evidence only. It never enters wake-word, assistant,
    // learning, command or provider paths, even if the phrase sounds like a task.
    if (audioPhraseTest) {
      if (!isMicMuted && typeof text === 'string' && text) {
        if (isFinal) { if (audioPhraseTest.finals.length < 32) audioPhraseTest.finals.push(text.slice(0, 500)); audioPhraseTest.partial = ''; }
        else audioPhraseTest.partial = text.slice(0, 500);
      }
      return;
    }
    if (audioInputSwitching || audioReplyTesting) return;
    if (window.OlangaLiveConversation?.isActive?.()) return;
    if (window.OlangaLocalSpeech?.isActive?.()) return;
    if (microphoneResources?.captureBarrier) return;
    if (isMicMuted || typeof text !== 'string' || !text || (wakeCaptureOpen && !isWakeWordCapturing)) return;

    if (isWakeWordCapturing) {
        handleWakeWordCaptureResult(text, isFinal);
        return;
    }

    if (currentState === State.LISTENING && isRecording) {
        const next = text.trim();
        if (isFinal) { liveTranscript.finals.push(next); liveTranscript.partial = ''; liveTranscript.cached = null; }
        else if (liveTranscript.partial !== next) { liveTranscript.partial = next; liveTranscript.cached = null; }
        return;
    }

    if (currentState === State.SPEAKING || currentState === State.THINKING) {
        handleBargeIn(text);
        return;
    }

    if (currentState !== State.IDLE) return;
    if (Date.now() - lastIdleTime < 1000) return; // 1-second cooldown to prevent immediate re-triggering

    text = text.toLowerCase();
    // Background recognition text is private; never copy it into console logs.

    // Word-boundary match so "they" does not trigger on "hey"
    const activeWakeWords = typeof getActiveWakeWords === 'function' ? getActiveWakeWords() : PRESET_WAKE_WORDS;
    if (activeWakeWords.some(ww => new RegExp(`\\b${ww.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))) {
        console.log('[Olanga] Wake word detected locally.');

        setState(State.LISTENING);
        // Word timestamps are relative to this recognizer. Reuse only samples
        // after the detected wake phrase; partials have no trusted boundary and
        // deliberately get no wake pre-roll rather than repeating its audio.
        const wakeWords = Array.isArray(words) ? words : [];
        const normalized = text.trim().split(/\s+/);
        let wakeEnd = null;
        for (const phrase of activeWakeWords) {
          const tokens = phrase.toLowerCase().split(/\s+/);
          for (let i = 0; i <= normalized.length - tokens.length; i++) {
            if (tokens.every((token, n) => normalized[i + n] === token) && Number.isFinite(wakeWords[i + tokens.length - 1]?.end)) {
              const candidate = microphoneResources?.recognizerStartFrame + Math.ceil(wakeWords[i + tokens.length - 1].end * audioContext.sampleRate);
              if (Number.isFinite(candidate)) wakeEnd = Math.max(wakeEnd ?? 0, candidate);
            }
          }
        }
        if (startRecording({ afterFrame: wakeEnd }) === false) return;
        if (typeof warmProviderConnection === 'function') warmProviderConnection();

        userText.textContent = "Listening...";
        transcriptUser.classList.remove('hidden');
        transcriptAi.classList.add('hidden');
    }
}

// ============================================
// WAKE-WORD INTERRUPTION (BARGE-IN)
// ============================================

function isBargeInEnabled() {
  return typeof bargeInEnabled !== 'undefined' && bargeInEnabled === true;
}

// Olanga's own voice can reach the microphone, so only a greeting followed by
// a name ("hey olanga") or a multi-word custom phrase interrupts a reply.
// Single words such as "hey" and fuzzy presets such as "a olanga" never do.
function getBargeInPhrases() {
  const custom = typeof getCustomWakePhrases === 'function' ? getCustomWakePhrases() : [];
  return [...PRESET_WAKE_WORDS.filter(phrase => /^(?:hey|hay|hail) \S/.test(phrase)), ...custom.filter(phrase => phrase.split(' ').length >= 2)];
}

function handleBargeIn(text) {
  if (!isBargeInEnabled()) return;
  const heard = normalizeWakePhrase(text);
  const matched = getBargeInPhrases().some(phrase => new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(heard));
  if (!matched) return;
  console.log('[Olanga] Wake word heard during a reply; interrupting.');
  // Stopping speech alone leaves a streamed Gemini turn running; cancel the
  // request the same way push-to-talk and Escape do so late chunks cannot
  // overwrite the next listen.
  if (typeof interruptAssistantForFollowUp === 'function') interruptAssistantForFollowUp();
  else if (typeof cancelAssistantRequest === 'function') cancelAssistantRequest();
  else if (typeof stopAssistantSpeech === 'function') stopAssistantSpeech();
  if (followUpTimer) { clearTimeout(followUpTimer); followUpTimer = null; }
  try { voskRecognizer?.reset(); } catch (_) {}
  setState(State.LISTENING);
  if (startRecording() === false) return;
  if (typeof warmProviderConnection === 'function') warmProviderConnection();
  userText.textContent = 'Listening...';
  transcriptUser.classList.remove('hidden');
  transcriptAi.classList.add('hidden');
}

// Push-to-talk works like the wake word: it interrupts a reply or a pending
// request, and a second press while listening sends what was said so far.
function handlePushToTalk() {
  if (window.OlangaLiveConversation?.isActive?.()) { window.OlangaLiveConversation.stop(); return; }
  if (wakeCaptureOpen || window.OlangaDesktop?.isBusy?.()) return;
  if (currentState === State.LISTENING && isRecording) {
    if (hasSpokenDuringRecording) stopRecording();
    else { cancelRecording(); setState(State.IDLE); }
    return;
  }
  if (isMicMuted || !micStream || micStream.active === false) {
    window.electronAPI?.expandWindow?.();
    document.getElementById('textCommandInput')?.focus();
    showError(isMicMuted ? 'The microphone is muted. Type your request, or unmute to talk.' : 'Voice input is off. Type your request, or choose a speech input in Settings.');
    return;
  }
  if (currentState === State.SPEAKING || currentState === State.THINKING) {
    if (typeof interruptAssistantForFollowUp === 'function') interruptAssistantForFollowUp();
  else if (typeof cancelAssistantRequest === 'function') cancelAssistantRequest();
    else if (typeof stopAssistantSpeech === 'function') stopAssistantSpeech();
  }
  if (followUpTimer) { clearTimeout(followUpTimer); followUpTimer = null; }
  setState(State.LISTENING);
  if (startRecording() === false) return;
  if (typeof warmProviderConnection === 'function') warmProviderConnection();
  userText.textContent = 'Listening...';
  transcriptUser.classList.remove('hidden');
  transcriptAi.classList.add('hidden');
}

// ============================================
// CUSTOM WAKE WORD CAPTURE (type + 5 utterances)
// ============================================

const WAKE_CAPTURE_TARGET = 5;
let wakeCaptureSamples = [];
let wakeCaptureIntended = '';
let wakeCapturePhase = 'type'; // 'type' | 'record'
let wakeCaptureOpen = false;
let wakeCaptureLastAccepted = '';
let wakeCaptureLastAcceptedAt = 0;

function getWakeCaptureEls() {
  return {
    screen: document.getElementById('wakeWordCaptureScreen'),
    title: document.getElementById('wakeCaptureTitle'),
    progress: document.getElementById('wakeCaptureProgress'),
    status: document.getElementById('wakeCaptureStatus'),
    heard: document.getElementById('wakeCaptureHeard'),
    samples: document.getElementById('wakeCaptureSamples'),
    typeStep: document.getElementById('wakeCaptureTypeStep'),
    recordStep: document.getElementById('wakeCaptureRecordStep'),
    intendedInput: document.getElementById('wakeCaptureIntendedInput'),
    continueBtn: document.getElementById('wakeCaptureContinueBtn'),
    cancelBtn: document.getElementById('wakeCaptureCancelBtn'),
    doneBtn: document.getElementById('wakeCaptureDoneBtn')
  };
}

function renderWakeCaptureUi() {
  const els = getWakeCaptureEls();
  if (!els.samples) return;

  if (els.typeStep && els.recordStep) {
    els.typeStep.classList.toggle('hidden', wakeCapturePhase !== 'type');
    els.recordStep.classList.toggle('hidden', wakeCapturePhase !== 'record');
  }

  if (wakeCapturePhase === 'type') {
    if (els.title) els.title.textContent = 'Type your wake word';
    if (els.status) els.status.textContent = 'Enter the phrase you want Olanga to listen for.';
    if (els.progress) els.progress.textContent = '';
    return;
  }

  const count = wakeCaptureSamples.length;
  if (els.title) els.title.textContent = `Say “${wakeCaptureIntended}”`;
  if (els.progress) els.progress.textContent = `${count} / ${WAKE_CAPTURE_TARGET}`;
  if (els.status) {
    if (count >= WAKE_CAPTURE_TARGET) {
      els.status.textContent = 'All set — saving your typed phrase plus spoken variations.';
    } else {
      els.status.textContent = `Say “${wakeCaptureIntended}” clearly (${WAKE_CAPTURE_TARGET - count} left).`;
    }
  }

  els.samples.innerHTML = '';
  const typedItem = document.createElement('div');
  typedItem.className = 'wake-capture-sample is-intended';
  typedItem.textContent = `Typed: “${wakeCaptureIntended}”`;
  els.samples.appendChild(typedItem);

  wakeCaptureSamples.forEach((phrase, index) => {
    const item = document.createElement('div');
    item.className = 'wake-capture-sample';
    item.textContent = `${index + 1}. “${phrase}”`;
    els.samples.appendChild(item);
  });

  if (els.doneBtn) {
    els.doneBtn.disabled = count < WAKE_CAPTURE_TARGET;
  }
}

function handleWakeWordCaptureResult(text, isFinal) {
  if (wakeCapturePhase !== 'record') return;

  const normalized = normalizeWakePhrase(text);
  if (!normalized) return;

  const els = getWakeCaptureEls();
  if (els.heard) {
    els.heard.textContent = normalized;
  }

  // Only commit final utterances so partials don't burn a take.
  if (!isFinal) return;
  if (wakeCaptureSamples.length >= WAKE_CAPTURE_TARGET) return;

  // Ignore empty/very short finals and rapid duplicates from the same utterance.
  if (normalized.length < 2) return;
  const now = Date.now();
  if (
    normalized === wakeCaptureLastAccepted
    && now - wakeCaptureLastAcceptedAt < 1800
  ) {
    return;
  }

  wakeCaptureLastAccepted = normalized;
  wakeCaptureLastAcceptedAt = now;
  wakeCaptureSamples.push(normalized);
  console.log(`[Olanga] Wake capture sample ${wakeCaptureSamples.length} accepted.`);
  renderWakeCaptureUi();

  if (voskRecognizer) {
    try { voskRecognizer.reset(); } catch (_) {}
  }

  if (wakeCaptureSamples.length >= WAKE_CAPTURE_TARGET) {
    finishWakeWordCapture();
  }
}

function beginWakeWordRecording() {
  const els = getWakeCaptureEls();
  const typed = normalizeWakePhrase(els.intendedInput?.value || '');
  if (isMicMuted) { showError('Unmute the microphone before recording a wake word.'); return; }
  if (typed.length < 2) {
    showError('Type a wake word of at least 2 characters first.');
    els.intendedInput?.focus();
    return;
  }

  if (!isVoskReady || !voskRecognizer) {
    showError('Wake word model is still loading. Try again in a moment.');
    return;
  }

  wakeCaptureIntended = typed;
  wakeCaptureSamples = [];
  wakeCaptureLastAccepted = '';
  wakeCaptureLastAcceptedAt = 0;
  wakeCapturePhase = 'record';
  isWakeWordCapturing = true;

  if (els.heard) els.heard.textContent = 'Listening…';
  if (els.doneBtn) els.doneBtn.disabled = true;
  renderWakeCaptureUi();

  try { voskRecognizer.reset(); } catch (_) {}
}

function openWakeWordCaptureScreen() {
  if (typeof interruptAssistantForFollowUp === 'function') interruptAssistantForFollowUp();
  else if (typeof cancelAssistantRequest === 'function') cancelAssistantRequest();
  else if (typeof stopAssistantSpeech === 'function') stopAssistantSpeech();
  wakeCaptureOpen = true;
  wakeCaptureSamples = [];
  wakeCaptureIntended = '';
  wakeCapturePhase = 'type';
  wakeCaptureLastAccepted = '';
  wakeCaptureLastAcceptedAt = 0;
  isWakeWordCapturing = false; // don't feed Vosk until recording step

  // Pause normal assistant wake detection / UI.
  if (currentState === State.LISTENING) {
    try { cancelRecording(); } catch (_) {}
  }
  if (currentState === State.SPEAKING) {
    try { if (currentTTSAudio) currentTTSAudio.pause(); } catch (_) {}
    currentTTSAudio = null;
    try { synthesis.cancel(); } catch (_) {}
  }
  setState(State.IDLE, true);

  if (typeof screens === 'object' && screens) {
    Object.keys(screens).forEach((key) => {
      if (screens[key]) screens[key].classList.add('hidden');
    });
  }
  const floatingIconsWrapper = document.querySelector('.floating-icons');
  if (floatingIconsWrapper) floatingIconsWrapper.classList.remove('visible');

  const els = getWakeCaptureEls();
  if (els.screen) els.screen.classList.remove('hidden');
  if (els.intendedInput) {
    els.intendedInput.value = '';
    setTimeout(() => els.intendedInput.focus(), 50);
  }
  if (els.heard) els.heard.textContent = 'Listening…';
  if (els.doneBtn) els.doneBtn.disabled = true;
  renderWakeCaptureUi();
}

function closeWakeWordCaptureScreen(options = {}) {
  const returnToSettings = options.returnToSettings !== false;
  isWakeWordCapturing = false;
  wakeCaptureOpen = false;
  wakeCaptureSamples = [];
  wakeCaptureIntended = '';
  wakeCapturePhase = 'type';
  wakeCaptureLastAccepted = '';
  wakeCaptureLastAcceptedAt = 0;

  const els = getWakeCaptureEls();
  if (els.screen) els.screen.classList.add('hidden');

  if (returnToSettings) {
    // Return to Settings.
    if (typeof screens === 'object' && screens) {
      Object.keys(screens).forEach((key) => {
        if (screens[key]) screens[key].classList.add('hidden');
      });
    }
    if (settingsScreen) settingsScreen.classList.remove('hidden');
    if (typeof floatingIcons !== 'undefined') {
      floatingIcons.forEach((icon) => icon.classList.remove('active'));
    }
    const settingsIcon = document.querySelector('.floating-icon[data-screen="settingsScreen"]');
    if (settingsIcon) settingsIcon.classList.add('active');
    const floatingIconsWrapper = document.querySelector('.floating-icons');
    if (floatingIconsWrapper) floatingIconsWrapper.classList.add('visible');
    if (window.loadSettingsValues) window.loadSettingsValues();
    if (typeof renderCustomWakeWords === 'function') renderCustomWakeWords();
  }

  setState(State.IDLE, true);
}

function finishWakeWordCapture() {
  const spoken = wakeCaptureSamples.map(normalizeWakePhrase).filter(Boolean);
  const intended = normalizeWakePhrase(wakeCaptureIntended);
  // Typed phrase + up to 5 spoken variations (unique, max 6 total).
  const phrases = [...new Set([intended, ...spoken].filter(Boolean))].slice(0, 6);
  if (phrases.length === 0) {
    showError('No wake word phrases were captured. Try again.');
    closeWakeWordCaptureScreen();
    return;
  }

  const previous = customWakeWordGroups.slice();
  let group;
  try { group = addCustomWakeWordGroup(phrases, intended); }
  catch (error) {
    customWakeWordGroups = previous;
    showError('The wake word could not be saved. Free some storage and try again.');
    return;
  }
  if (typeof saveAppSettings === 'function') {
    saveAppSettings().catch(() => {});
  } else {
    try {
      const prefs = typeof collectPrefsFromUI === 'function' ? collectPrefsFromUI() : {};
      prefs.customWakeWordGroups = customWakeWordGroups;
      if (typeof persistAppPreferences === 'function') {
        persistAppPreferences(prefs).catch(() => {});
      }
    } catch (_) {}
  }

  console.log('[Olanga] Custom wake word saved.');
  closeWakeWordCaptureScreen();
}

function cancelWakeWordCapture(options) {
  closeWakeWordCaptureScreen(options);
}

// ============================================
// VOICE ACTIVITY DETECTION (For Ending Recording)
// ============================================

function monitorAudio() {
  microphoneMonitorFrame = null;
  if (!microphoneMonitorNeeded(microphoneResources)) return;
  if (currentState === State.THINKING || currentState === State.SPEAKING) {
    microphoneMonitorFrame = requestAnimationFrame(monitorAudio);
    return;
  }

  // Capture callbacks already compute RMS and own endpointing even when the
  // window is hidden. Reuse that value instead of analyzing the same mic twice.
  if (microphoneResources.endpoint) {
    updateWaveBars(currentRMS);
    microphoneMonitorFrame = requestAnimationFrame(monitorAudio);
    return;
  }
  if (!analyser) return;

  const dataArray = microphoneResources.visualSamples?.length === analyser.fftSize
    ? microphoneResources.visualSamples : (microphoneResources.visualSamples = new Uint8Array(analyser.fftSize));
  analyser.getByteTimeDomainData(dataArray);

  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const val = (dataArray[i] - 128) / 128;
    sum += val * val;
  }
  currentRMS = Math.sqrt(sum / dataArray.length) * 100;

  if (microphoneVisualsVisible()) updateWaveBars(currentRMS);

  // VAD logic ONLY for stopping the recording once it has started
  if (currentState === State.LISTENING) {
      if (currentRMS > SPEECH_THRESHOLD) {
        silenceStartTime = null;
        if (!hasSpokenDuringRecording) {
            hasSpokenDuringRecording = true;
            speechStartTime = Date.now();
            if (followUpTimer) {
              clearTimeout(followUpTimer);
              followUpTimer = null;
            }
        }
      } else if (isRecording) {
        if (!silenceStartTime) {
          silenceStartTime = Date.now();
        }

        // Wait 4 seconds for them to START speaking, then the end-of-speech pause.
        const timeout = hasSpokenDuringRecording ? endOfSpeechDelay() : (followUpTimer ? 12000 : 4000);

        if (Date.now() - silenceStartTime > timeout) {
          if (hasSpokenDuringRecording && (Date.now() - speechStartTime) > MIN_SPEECH_DURATION) {
            stopRecording();
          } else {
            console.log('[Olanga] Recording timed out or too short (no speech), returning to IDLE');
            cancelRecording();
            setState(State.IDLE);
          }
        }
      }
  }

  // A legacy timeout may call setState(), which refreshes this monitor while
  // the current callback is still unwinding. Keep one frame in that case too.
  if (microphoneMonitorFrame === null) microphoneMonitorFrame = requestAnimationFrame(monitorAudio);
}

function updateWaveBars(rms) {
  if (currentState !== State.LISTENING && currentState !== State.IDLE) return;
  // If idle, don't show huge waves, just very tiny ones to indicate it's alive
  const scale = (currentState === State.LISTENING) ? 2 : 0.5;
  const floorOnly = !Number.isFinite(rms) || rms * scale <= 4;
  const time = floorOnly ? 0 : Date.now() * 0.005;
  waveBarEls.forEach((bar, i) => {
    const offset = floorOnly ? 0 : Math.sin(time + i * 0.7) * 0.5 + 0.5;
    const height = `${floorOnly ? 4 : Math.max(4, Math.min(28, rms * scale * offset))}px`;
    if (bar.style.height !== height) bar.style.height = height;
  });
}

// ============================================
// RECORDING CONTROLS
// ============================================

function startRecording({ afterFrame = null } = {}) {
  if (window.OlangaLocalSpeech?.isActive?.()) window.OlangaLocalSpeech.stop();
  if (isRecording) return true;
  if (isMicMuted || !micStream || micStream.active === false || !audioContext || audioContext.state === 'closed') {
    if (currentState === State.LISTENING) setState(State.IDLE);
    return false;
  }
  isRecording = true;
  pcmChunks = Number.isFinite(afterFrame) ? (microphoneResources?.preRoll?.after(afterFrame) || []) : [];
  recordingSampleCount = pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  microphoneResources?.preRoll?.clear();
  microphoneResources?.endpoint?.reset();
  speechStartTime = null;
  silenceStartTime = Date.now(); // Start silence timer immediately for the 5s timeout
  hasSpokenDuringRecording = false;
  for (const chunk of pcmChunks) {
    if (microphoneResources?.endpoint?.process(chunk, { recording: true }).speech) hasSpokenDuringRecording = true;
  }
  resetLiveTranscript();
  try { if (typeof voskRecognizer !== 'undefined') voskRecognizer?.reset(); } catch (_) {}
  if (microphoneResources) microphoneResources.recognizerStartFrame = microphoneResources.frame;
  console.log('[Olanga] 🎙️ Recording user query started');
  return true;
}

function stopRecording() {
  if (!isRecording) return;
  if (isMicMuted || !audioContext || audioContext.state === 'closed' || !micStream || micStream.active === false) {
    cancelRecording();
    if (currentState === State.LISTENING) setState(State.IDLE);
    return;
  }
  isRecording = false;
  recordingSampleCount = 0;

  console.log(`[Olanga] 🎙️ Recording stopped — processing with Gemini`);
  setState(State.THINKING);

  // Encode the captured chunks directly. Merging them first allocated another
  // full recording and copied every sample immediately before the request.
  const totalLength = pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (totalLength === 0) {
    console.log('[Olanga] No audio data captured');
    setState(State.IDLE);
    pcmChunks = [];
    speechStartTime = null;
    silenceStartTime = null;
    return;
  }

  const capturedChunks = pcmChunks;
  pcmChunks = [];
  speechStartTime = null;
  silenceStartTime = null;

  // Encode as WAV
  const sampleRate = audioContext.sampleRate;
  const wavBlob = encodeWAVChunks(capturedChunks, sampleRate, totalLength);

  const rough = getLiveTranscript();
  resetLiveTranscript();
  processAudioBlobWithGemini(wavBlob, { rough });
}

function cancelRecording() {
  isRecording = false;
  recordingSampleCount = 0;
  pcmChunks = [];
  speechStartTime = null;
  silenceStartTime = null;
  hasSpokenDuringRecording = false;
  resetLiveTranscript();
  microphoneResources?.endpoint?.reset();
  microphoneResources?.preRoll?.clear();
}

// ============================================
// WAV ENCODER
// ============================================

function encodeWAV(samples, sampleRate) {
  return encodeWAVChunks([samples], sampleRate, samples.length);
}

function encodeWAVChunks(chunks, sampleRate, sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0)) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = sampleCount * (bitsPerSample / 8);
  const bufferSize = 44 + dataSize;

  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let writeOffset = 44;
  for (const samples of chunks) {
    for (let i = 0; i < samples.length; i++) {
      const value = samples[i];
      const s = value > 1 ? 1 : value < -1 ? -1 : value;
      view.setInt16(writeOffset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      writeOffset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function cancelAudioPhraseTest(message) {
  if (audioPhraseTest) audioPhraseTest.finish(new Error(message));
}
function audioInputSnapshot() {
  const track = micStream?.getAudioTracks?.()[0] || micStream?.getTracks?.()[0];
  return { preferredDeviceId: microphonePreferredDeviceId, active: !!(micStream && micStream.active !== false && microphoneResources && microphoneResources.context?.state !== 'closed'), muted: !!isMicMuted,
    label: track?.label || '', level: isMicMuted ? 0 : Math.min(100, Math.max(0, Number(currentRMS) || 0)), modelReady: !!isVoskReady && !!microphoneResources?.recognizer };
}
function audioSetupBusy(ignoreSwitch = false) {
  return (!ignoreSwitch && audioInputSwitching) || audioPhraseTest || audioReplyTesting || microphoneInitPromise || microphoneResumePromise || isRecording || isWakeWordCapturing || wakeCaptureOpen || currentState !== State.IDLE || window.OlangaTurns?.isActive?.() || window.OlangaLiveConversation?.isActive?.() || window.OlangaBackupCenter?.isBusy?.();
}
window.OlangaAudioInput = Object.freeze({
  snapshot: audioInputSnapshot,
  async devices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default').map(device => ({ deviceId: device.deviceId, label: device.label || 'Microphone' }));
  },
  async choose(id) {
    if (typeof id !== 'string' || id.length > 256 || /[\x00-\x1f\x7f]/.test(id)) throw new Error('Choose a valid microphone.');
    if (audioSetupBusy()) throw new Error('Finish the current request or audio check before changing microphone.');
    audioInputSwitching = true;
    try {
      const devices = await window.OlangaAudioInput.devices();
      if (id && !devices.some(device => device.deviceId === id)) throw new Error('That microphone is no longer connected. Refresh the list.');
      if (audioSetupBusy(true)) throw new Error('A new request started. Finish it before changing microphone.');
      const previous = microphonePreferredDeviceId;
      if (id === previous && (!microphoneRequested || isMicMuted || audioInputSnapshot().active)) return audioInputSnapshot();
      if (!window.OlangaMicrophonePreference) throw new Error('Microphone preferences are still loading.');
      await window.OlangaMicrophonePreference.save(id);
      microphonePreferredDeviceId = id;
      let interrupted = !!audioSetupBusy(true), opened = true;
      // A mute while preferences were being saved cancels the need to open a
      // new graph. Selection never starts voice input the user left off.
      if (!interrupted && microphoneRequested && !isMicMuted) opened = await initializeMicrophoneResources({ deviceId: id, quiet: true, canPublish: () => {
        const allowed = !isMicMuted && !audioSetupBusy(true); if (!allowed) interrupted = true; return allowed;
      } });
      if (interrupted || !opened) {
        microphonePreferredDeviceId = previous;
        try { await window.OlangaMicrophonePreference.save(previous); }
        catch (_) { throw new Error('The microphone change did not finish. Its saved selection could not be restored. Re-select your microphone when settings can be saved.'); }
        throw new Error(interrupted ? 'The microphone change was interrupted by another request or mute. The previous selection was retained.' : 'That microphone could not open. The previous microphone is still selected.');
      }
      if (microphoneResources) discardLocalSpeechCapture();
      return audioInputSnapshot();
    } finally { audioInputSwitching = false; }
  },
  testPhrase() {
    if (audioSetupBusy()) return Promise.reject(new Error('Finish the current request before checking the microphone.'));
    const state = audioInputSnapshot();
    if (state.muted || !state.active || !state.modelReady) return Promise.reject(new Error('Enable and unmute voice input, then wait for offline recognition to be ready.'));
    return new Promise((resolve, reject) => {
      resetMicrophoneRecognition();
      const test = { resources: microphoneResources, finals: [], partial: '', timer: null, finish(error) {
        if (audioPhraseTest !== test) return;
        clearTimeout(test.timer); audioPhraseTest = null;
        const heard = [...test.finals, test.partial].join(' ').replace(/\[unk\]/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
        discardLocalSpeechCapture();
        if (error) reject(error);
        else resolve({ heard, verified: heard.toLowerCase().replace(/[^a-z ]/g, '').trim() === 'olanga audio check', checkedAt: Date.now(), deviceId: microphonePreferredDeviceId, label: state.label });
      } };
      audioPhraseTest = test;
      test.timer = setTimeout(() => test.finish(), 5000);
    });
  },
  async testReply() {
    if (audioSetupBusy()) throw new Error('Finish the current request or audio check before testing speech.');
    if (isTtsMuted) throw new Error('Unmute spoken replies before testing speech.');
    audioReplyTesting = true;
    const engine = ttsEngine;
    try { const result = await speakResponse('This is Olanga. Your spoken reply check is ready.'); return { ...result, engine }; }
    finally { discardLocalSpeechCapture(); audioReplyTesting = false; if (!window.OlangaTurns?.isActive?.() && currentState === State.SPEAKING) setState(State.IDLE); }
  }
});
