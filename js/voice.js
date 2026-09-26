/* ============================================
   OLANGA — VOICE PIPELINE
   Vosk wake word (offline), mic capture, VAD, WAV encoding
   ============================================ */

// ============================================
// VOSK WAKE WORD DETECTION (OFFLINE)
// ============================================
let voskModelLoadPromise = null;

async function initVosk() {
    if (voskModel?.ready) return voskModel;
    if (voskModelLoadPromise) return voskModelLoadPromise;
    if (!window.Vosk?.Model) throw new Error('Vosk library not loaded');
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
        isVoskReady = true;
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

// While recording, the on-device recognizer keeps a rough transcript. It only
// shortens the pause after a complete local command and helps choose a reply
// lane; Gemini's transcript, or the review step, still decides what runs.
let liveTranscript = { finals: [], partial: '' };
let liveCommandCache = { text: null, complete: false };

function resetLiveTranscript() {
  liveTranscript = { finals: [], partial: '' };
}

function getLiveTranscript() {
  return [...liveTranscript.finals, liveTranscript.partial].join(' ').replace(/\[unk\]/gi, ' ').replace(/\s+/g, ' ').trim();
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
  if (microphoneResources === resources) {
    microphoneResources = null;
    if (microphoneMonitorFrame !== null) cancelAnimationFrame(microphoneMonitorFrame);
    microphoneMonitorFrame = null;
    cancelRecording();
  }
  for (const [track, listener] of resources.trackListeners || []) track.removeEventListener?.('ended', listener);
  if (resources.processor) resources.processor.onaudioprocess = null;
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
  resources.model = voskModel;
  const recognizer = resources.recognizer;
  const current = () => microphoneResources === resources && resources.recognizer === recognizer;
  resources.recognizer.setWords(true);
  resources.recognizer.on('result', message => {
    if (current() && !isMicMuted) handleVoskResult(message?.result?.text, true);
  });
  resources.recognizer.on('partialresult', message => {
    if (current() && !isMicMuted) handleVoskResult(message?.result?.partial, false);
  });
  resources.recognizer.on('error', () => {
    if (current()) failMicrophoneRecognition(resources);
  });
  voskRecognizer = resources.recognizer;
}

function failMicrophoneRecognition(resources, message = 'Wake word recognition stopped. Mute and unmute the microphone to retry.') {
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
  if (microphoneInitPromise) return microphoneInitPromise;
  if (microphoneResources && microphoneResources.stream.active !== false && microphoneResources.context.state !== 'closed') {
    attachMicrophoneRecognizer(microphoneResources);
    return true;
  }
  releaseMicrophoneResources(microphoneResources);
  microphoneInitPromise = initializeMicrophoneResources().finally(() => { microphoneInitPromise = null; });
  return microphoneInitPromise;
}

async function initializeMicrophoneResources() {
  const resources = {};
  try {
    resources.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
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
        releaseMicrophoneResources(resources);
        if (wasListening) setState(State.IDLE);
        showError('The microphone disconnected. Reconnect it and select your speech input again.');
      };
      track.addEventListener?.('ended', ended);
      resources.trackListeners.push([track, ended]);
    }

    resources.context = new AudioContext({ sampleRate: 16000 });
    const sampleRate = resources.context.sampleRate;
    console.log(`[Olanga] AudioContext sample rate: ${sampleRate}`);

    attachMicrophoneRecognizer(resources);

    resources.analyser = resources.context.createAnalyser();
    resources.analyser.fftSize = 512;

    resources.processor = resources.context.createScriptProcessor(4096, 1, 1);
    resources.processor.onaudioprocess = (e) => {
        if (microphoneResources !== resources || isMicMuted) return;

        const inputData = e.inputBuffer.getChannelData(0);

        // Idle wake-word listen, custom wake-word enrollment, or listening
        // for the wake word to interrupt a reply.
        if (
          ((currentState === State.IDLE && !isWakeWordCapturing) || isWakeWordCapturing || (currentState === State.SPEAKING && isBargeInEnabled()) || (currentState === State.LISTENING && isRecording))
          && resources.recognizer
          && isVoskReady
        ) {
            try { resources.recognizer.acceptWaveformFloat(inputData, sampleRate); }
            catch (_) { failMicrophoneRecognition(resources); }
        }

        // If recording, collect chunks for Gemini
        if (isRecording) {
          const remaining = Math.max(0, MAX_RECORDING_SECONDS * sampleRate - recordingSampleCount);
          const chunk = new Float32Array(inputData.subarray(0, remaining));
          if (chunk.length) { pcmChunks.push(chunk); recordingSampleCount += chunk.length; }
          if (recordingSampleCount >= MAX_RECORDING_SECONDS * sampleRate) stopRecording();
        }
      };

    resources.source = resources.context.createMediaStreamSource(resources.stream);

    // Connect: source → analyser (for VAD visualization)
    resources.source.connect(resources.analyser);

    // Connect: source → scriptProcessor → silent output (for PCM capture)
    // Must connect to destination for onaudioprocess to fire, but mute it
    resources.gain = resources.context.createGain();
    resources.gain.gain.value = 0;
    resources.source.connect(resources.processor);
    resources.processor.connect(resources.gain);
    resources.gain.connect(resources.context.destination);

    microphoneResources = resources;
    micStream = resources.stream;
    audioContext = resources.context;
    analyser = resources.analyser;
    scriptNode = resources.processor;

    console.log('[Olanga] ✅ Microphone initialized');
    // Initialization may finish after a typed request started. Never overwrite
    // its THINKING/SPEAKING/LISTENING state with an unrelated microphone event.
    if (currentState === State.IDLE) setState(State.IDLE);
    monitorAudio();
    return true;
  } catch (err) {
    releaseMicrophoneResources(resources);
    console.error('[Olanga] Mic init error:', err);
    showError('Microphone access denied or unavailable.');
    return false;
  }
}

// ============================================
// VOSK RESULT HANDLER
// ============================================
function handleVoskResult(text, isFinal = false) {
    if (isMicMuted || typeof text !== 'string' || !text || (wakeCaptureOpen && !isWakeWordCapturing)) return;

    if (isWakeWordCapturing) {
        handleWakeWordCaptureResult(text, isFinal);
        return;
    }

    if (currentState === State.LISTENING && isRecording) {
        if (isFinal) { liveTranscript.finals.push(text.trim()); liveTranscript.partial = ''; }
        else liveTranscript.partial = text.trim();
        return;
    }

    if (currentState === State.SPEAKING) {
        handleBargeIn(text);
        return;
    }

    if (currentState !== State.IDLE) return;
    if (Date.now() - lastIdleTime < 1000) return; // 1-second cooldown to prevent immediate re-triggering

    text = text.toLowerCase();
    console.log(`[Olanga Vosk] Hears: "${text}"`);

    // Word-boundary match so "they" does not trigger on "hey"
    const activeWakeWords = typeof getActiveWakeWords === 'function' ? getActiveWakeWords() : PRESET_WAKE_WORDS;
    if (activeWakeWords.some(ww => new RegExp(`\\b${ww.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))) {
        console.log(`[Olanga] Wake word detected locally! Transcript: "${text}"`);

        setState(State.LISTENING);
        if (startRecording() === false) return;
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
  if (typeof cancelAssistantRequest === 'function') cancelAssistantRequest();
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
    if (typeof cancelAssistantRequest === 'function') cancelAssistantRequest();
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
  console.log(`[Olanga] Wake capture sample ${wakeCaptureSamples.length}: "${normalized}"`);
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
  if (typeof cancelAssistantRequest === 'function') cancelAssistantRequest();
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

  console.log('[Olanga] Custom wake word saved:', group);
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
  if (!microphoneResources || !analyser) return;
  if (currentState === State.THINKING || currentState === State.SPEAKING) {
    microphoneMonitorFrame = requestAnimationFrame(monitorAudio);
    return;
  }

  if (isMicMuted) {
    currentRMS = 0;
    updateWaveBars(0);
    microphoneMonitorFrame = requestAnimationFrame(monitorAudio);
    return;
  }

  const dataArray = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(dataArray);

  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const val = (dataArray[i] - 128) / 128;
    sum += val * val;
  }
  currentRMS = Math.sqrt(sum / dataArray.length) * 100;

  updateWaveBars(currentRMS);

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

  microphoneMonitorFrame = requestAnimationFrame(monitorAudio);
}

function updateWaveBars(rms) {
  if (currentState !== State.LISTENING && currentState !== State.IDLE) return;
  // If idle, don't show huge waves, just very tiny ones to indicate it's alive
  let scale = (currentState === State.LISTENING) ? 2 : 0.5;

  waveBarEls.forEach((bar, i) => {
    const offset = Math.sin(Date.now() * 0.005 + i * 0.7) * 0.5 + 0.5;
    const height = Math.max(4, Math.min(28, rms * scale * offset));
    bar.style.height = `${height}px`;
  });
}

// ============================================
// RECORDING CONTROLS
// ============================================

function startRecording() {
  if (isRecording) return true;
  if (isMicMuted || !micStream || micStream.active === false || !audioContext || audioContext.state === 'closed') {
    if (currentState === State.LISTENING) setState(State.IDLE);
    return false;
  }
  isRecording = true;
  pcmChunks = [];
  recordingSampleCount = 0;
  speechStartTime = null;
  silenceStartTime = Date.now(); // Start silence timer immediately for the 5s timeout
  hasSpokenDuringRecording = false;
  resetLiveTranscript();
  try { if (typeof voskRecognizer !== 'undefined') voskRecognizer?.reset(); } catch (_) {}
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

  // Combine all PCM chunks into one Float32Array
  const totalLength = pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (totalLength === 0) {
    console.log('[Olanga] No audio data captured');
    setState(State.IDLE);
    pcmChunks = [];
    speechStartTime = null;
    silenceStartTime = null;
    return;
  }

  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of pcmChunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  pcmChunks = [];
  speechStartTime = null;
  silenceStartTime = null;

  // Encode as WAV
  const sampleRate = audioContext.sampleRate;
  const wavBlob = encodeWAV(combined, sampleRate);

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
}

// ============================================
// WAV ENCODER
// ============================================

function encodeWAV(samples, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
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
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(writeOffset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    writeOffset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
