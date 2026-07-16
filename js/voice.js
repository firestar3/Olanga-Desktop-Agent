/* ============================================
   OLANGA — VOICE PIPELINE
   Vosk wake word (offline), mic capture, VAD, WAV encoding
   ============================================ */

// ============================================
// VOSK WAKE WORD DETECTION (OFFLINE)
// ============================================
async function initVosk() {
    if (!window.Vosk) {
        throw new Error("Vosk library not loaded");
    }
    console.log("[Olanga] Loading Vosk model from local tar.gz...");

    // Served by the main process over olanga-asset:// (webSecurity stays on).
    voskModel = await window.Vosk.createModel('olanga-asset://local/vosk-model-v2.tar.gz');
    console.log("[Olanga] Vosk model loaded successfully.");
    isVoskReady = true;
}

// ============================================
// MICROPHONE + RAW PCM CAPTURE
// ============================================

async function initMicrophone() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 16000 // Vosk works best at 16k
      }
    });

    audioContext = new AudioContext({ sampleRate: 16000 });
    const sampleRate = audioContext.sampleRate;
    console.log(`[Olanga] AudioContext sample rate: ${sampleRate}`);

    // Create Vosk recognizer
    if (voskModel) {
        voskRecognizer = new voskModel.KaldiRecognizer(sampleRate);
        voskRecognizer.setWords(true);
        voskRecognizer.on("result", (message) => {
            handleVoskResult(message.result.text, true);
        });
        voskRecognizer.on("partialresult", (message) => {
            handleVoskResult(message.result.partial, false);
        });
    }

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;

    scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
    scriptNode.onaudioprocess = (e) => {
        if (isMicMuted) return;

        const inputData = e.inputBuffer.getChannelData(0);

        // Idle wake-word listen, or active custom wake-word enrollment.
        if (
          ((currentState === State.IDLE && !isWakeWordCapturing) || isWakeWordCapturing)
          && voskRecognizer
          && isVoskReady
        ) {
            voskRecognizer.acceptWaveformFloat(inputData, sampleRate);
        }

        // If recording, collect chunks for Gemini
        if (isRecording) {
          pcmChunks.push(new Float32Array(inputData));
        }
      };

    const source = audioContext.createMediaStreamSource(micStream);

    // Connect: source → analyser (for VAD visualization)
    source.connect(analyser);

    // Connect: source → scriptProcessor → silent output (for PCM capture)
    // Must connect to destination for onaudioprocess to fire, but mute it
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(scriptNode);
    scriptNode.connect(silentGain);
    silentGain.connect(audioContext.destination);

    console.log('[Olanga] ✅ Microphone initialized');
    setState(State.IDLE);
    monitorAudio();

  } catch (err) {
    console.error('[Olanga] Mic init error:', err);
    showError('Microphone access denied or unavailable.');
  }
}

// ============================================
// VOSK RESULT HANDLER
// ============================================
function handleVoskResult(text, isFinal = false) {
    if (!text) return;

    if (isWakeWordCapturing) {
        handleWakeWordCaptureResult(text, isFinal);
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
        startRecording();

        userText.textContent = "Listening...";
        transcriptUser.classList.remove('hidden');
        transcriptAi.classList.add('hidden');
    }
}

// ============================================
// CUSTOM WAKE WORD CAPTURE (type + 5 utterances)
// ============================================

const WAKE_CAPTURE_TARGET = 5;
let wakeCaptureSamples = [];
let wakeCaptureIntended = '';
let wakeCapturePhase = 'type'; // 'type' | 'record'
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

  const group = addCustomWakeWordGroup(phrases, intended);
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
  if (currentState === State.THINKING || currentState === State.SPEAKING) {
    requestAnimationFrame(monitorAudio);
    return;
  }

  if (isMicMuted) {
    currentRMS = 0;
    updateWaveBars(0);
    requestAnimationFrame(monitorAudio);
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

        // Wait 4 seconds for them to START speaking. If they're already speaking, wait 1.5s to STOP.
        const timeout = hasSpokenDuringRecording ? SILENCE_DURATION : 4000;

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

  requestAnimationFrame(monitorAudio);
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
  if (isRecording) return;
  isRecording = true;
  pcmChunks = [];
  speechStartTime = null;
  silenceStartTime = Date.now(); // Start silence timer immediately for the 5s timeout
  hasSpokenDuringRecording = false;
  console.log('[Olanga] 🎙️ Recording user query started');
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

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

  processAudioBlobWithGemini(wavBlob);
}

function cancelRecording() {
  if (!isRecording) return;
  isRecording = false;
  pcmChunks = [];
  speechStartTime = null;
  silenceStartTime = null;
  hasSpokenDuringRecording = false;
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
