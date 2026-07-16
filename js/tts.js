/* ============================================
   OLANGA — TEXT-TO-SPEECH (NVIDIA Magpie via main process)
   Voice catalog, playback, and follow-up listening windows
   ============================================ */

// Curated English Magpie voices only (base speakers, no emotion variants).
const BEST_ENGLISH_VOICES = [
  { value: 'Magpie-Multilingual.EN-US.Sofia', label: 'Sofia', languageCode: 'en-US' },
  { value: 'Magpie-Multilingual.EN-US.Aria', label: 'Aria', languageCode: 'en-US' },
  { value: 'Magpie-Multilingual.EN-US.Mia', label: 'Mia', languageCode: 'en-US' },
  { value: 'Magpie-Multilingual.EN-US.Jason', label: 'Jason', languageCode: 'en-US' },
  { value: 'Magpie-Multilingual.EN-US.Leo', label: 'Leo', languageCode: 'en-US' },
  { value: 'Magpie-Multilingual.EN-US.Ray', label: 'Ray', languageCode: 'en-US' },
  { value: 'Magpie-Multilingual.EN-US.Louise', label: 'Louise', languageCode: 'en-US' },
  { value: 'Magpie-Multilingual.EN-US.Diego', label: 'Diego', languageCode: 'en-US' },
  { value: 'Magpie-Multilingual.EN-US.Isabela', label: 'Isabela', languageCode: 'en-US' },
  { value: 'Magpie-Multilingual.EN-US.Pascal', label: 'Pascal', languageCode: 'en-US' }
];

const ALLOWED_ENGLISH_VOICE_IDS = new Set(BEST_ENGLISH_VOICES.map(voice => voice.value));

function initVoiceSettings() {
  if (ttsEngineSelect) {
    ttsEngineSelect.value = ttsEngine;
    ttsEngineSelect.addEventListener('change', (e) => {
      setTtsEngine(e.target.value);
    });
  }

  // Drop any previously saved non-English / emotion voice.
  if (!ALLOWED_ENGLISH_VOICE_IDS.has(nvidiaVoiceName)) {
    nvidiaVoiceName = defaultNvidiaVoiceName;
    localStorage.setItem('olanga_nvidia_voice', nvidiaVoiceName);
  }

  if (nvidiaVoiceSelect) {
    nvidiaVoiceSelect.addEventListener('change', (e) => {
      const nextVoice = e.target.value.trim() || defaultNvidiaVoiceName;
      nvidiaVoiceName = ALLOWED_ENGLISH_VOICE_IDS.has(nextVoice) ? nextVoice : defaultNvidiaVoiceName;
      localStorage.setItem('olanga_nvidia_voice', nvidiaVoiceName);
    });
  }

  // Always populate the curated list immediately so Settings never stays on
  // the HTML placeholder "Loading voices...".
  refreshVoiceCatalog();
  updateMagpieSettingsVisibility();
}

function setTtsEngine(engine) {
  ttsEngine = engine === 'magpie' ? 'magpie' : 'windows';
  localStorage.setItem('olanga_tts_engine', ttsEngine);
  if (ttsEngineSelect) {
    ttsEngineSelect.value = ttsEngine;
  }
  updateMagpieSettingsVisibility();
  if (ttsEngine === 'magpie') {
    refreshVoiceCatalog();
  }
}

function updateMagpieSettingsVisibility() {
  if (!magpieVoiceSettings) return;
  const showMagpie = ttsEngine === 'magpie';
  magpieVoiceSettings.style.display = showMagpie ? '' : 'none';
  if (showMagpie) {
    const needsPopulate = !nvidiaVoiceSelect
      || nvidiaVoiceSelect.options.length <= 1
      || (nvidiaVoiceSelect.options.length === 1 && !nvidiaVoiceSelect.options[0].value);
    if (needsPopulate) {
      refreshVoiceCatalog();
    }
  }
}

function updateTtsRateLabel(value) {
  if (ttsRateValue) {
    ttsRateValue.textContent = `${Number.parseFloat(value).toFixed(2)}x`;
  }
}

function normalizeLanguageCode(languageCode) {
  if (!languageCode) return 'en-US';
  const parts = String(languageCode).split(/[-_]/);
  if (parts.length !== 2) return String(languageCode);
  return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
}

function inferVoiceLanguageCode(voiceName) {
  if (!voiceName) return 'en-US';
  const match = String(voiceName).match(/\.([A-Za-z]{2}[-_][A-Za-z]{2})\./);
  if (match) return normalizeLanguageCode(match[1]);
  return 'en-US';
}

function englishVoiceCatalog() {
  return BEST_ENGLISH_VOICES.map(voice => ({
    languageCode: voice.languageCode,
    voiceName: voice.value,
    label: voice.label,
    isBase: true
  }));
}

function populateVoiceSelect(selectElement, options, selectedValue, emptyLabel) {
  if (!selectElement) return '';

  selectElement.innerHTML = '';
  if (options.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = emptyLabel;
    selectElement.appendChild(option);
    selectElement.disabled = true;
    return '';
  }

  selectElement.disabled = false;
  for (const optionData of options) {
    const option = document.createElement('option');
    option.value = optionData.value;
    option.textContent = optionData.label;
    selectElement.appendChild(option);
  }

  if (selectedValue && options.some(option => option.value === selectedValue)) {
    selectElement.value = selectedValue;
  } else {
    selectElement.value = options[0].value;
  }

  return selectElement.value;
}

function refreshVoiceCatalog() {
  // Always present the curated English top-10 list (no network call).
  try {
    nvidiaVoiceCatalog = englishVoiceCatalog();
    const selectedVoice = ALLOWED_ENGLISH_VOICE_IDS.has(nvidiaVoiceName)
      ? nvidiaVoiceName
      : defaultNvidiaVoiceName;
    const resolvedVoice = populateVoiceSelect(
      nvidiaVoiceSelect,
      BEST_ENGLISH_VOICES,
      selectedVoice,
      'No Magpie voices found'
    );
    if (resolvedVoice) {
      nvidiaVoiceName = resolvedVoice;
      localStorage.setItem('olanga_nvidia_voice', nvidiaVoiceName);
    }
  } catch (error) {
    console.warn('[Olanga] Voice list refresh failed:', error.message);
    if (nvidiaVoiceSelect) {
      nvidiaVoiceSelect.innerHTML = '';
      const option = document.createElement('option');
      option.value = defaultNvidiaVoiceName;
      option.textContent = 'Sofia';
      nvidiaVoiceSelect.appendChild(option);
      nvidiaVoiceSelect.disabled = false;
      nvidiaVoiceName = defaultNvidiaVoiceName;
    }
  }
}

function getSelectedNvidiaVoiceConfig() {
  const selected = nvidiaVoiceCatalog.find(voice => voice.voiceName === nvidiaVoiceName);
  if (selected) return selected;
  const fallback = BEST_ENGLISH_VOICES.find(voice => voice.value === nvidiaVoiceName) || BEST_ENGLISH_VOICES[0];
  return {
    languageCode: fallback.languageCode,
    voiceName: fallback.value,
    label: fallback.label
  };
}

let speakingWatchdog = null;

function clearSpeakingWatchdog() {
  if (speakingWatchdog) {
    clearTimeout(speakingWatchdog);
    speakingWatchdog = null;
  }
}

function armSpeakingWatchdog(ms = 60000, onTimeout) {
  clearSpeakingWatchdog();
  speakingWatchdog = setTimeout(() => {
    speakingWatchdog = null;
    console.warn('[Olanga] Speaking watchdog fired — forcing exit from SPEAKING');
    try {
      if (currentTTSAudio) currentTTSAudio.pause();
    } catch (_) {}
    currentTTSAudio = null;
    try { synthesis.cancel(); } catch (_) {}
    if (typeof onTimeout === 'function') onTimeout();
    else if (currentState === State.SPEAKING) setState(State.IDLE);
  }, ms);
}

function playAudioBlob(blob, callback, doneLabel) {
  const audioUrl = URL.createObjectURL(blob);
  const audio = new Audio(audioUrl);
  audio.volume = isMuted ? 0 : currentVolume;
  audio.playbackRate = Number.isFinite(ttsRate) ? ttsRate : 1;
  currentTTSAudio = audio;

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearSpeakingWatchdog();
    URL.revokeObjectURL(audioUrl);
    if (currentTTSAudio === audio) currentTTSAudio = null;
    if (doneLabel) console.log(doneLabel);
    if (callback) callback();
    else setState(State.IDLE);
  };

  audio.addEventListener('ended', finish);
  audio.addEventListener('error', (error) => {
    console.error('[Olanga] TTS playback error:', error);
    finish();
  });

  // Safety: if 'ended' never fires, leave speaking state after estimated duration.
  audio.addEventListener('loadedmetadata', () => {
    const durationMs = Number.isFinite(audio.duration) && audio.duration > 0
      ? (audio.duration * 1000) / (Number.isFinite(ttsRate) && ttsRate > 0 ? ttsRate : 1) + 2500
      : 45000;
    armSpeakingWatchdog(Math.min(Math.max(durationMs, 5000), 120000), finish);
  });

  audio.play().catch((error) => {
    console.error('[Olanga] TTS autoplay error:', error);
    finish();
  });
}

async function speakWithNvidiaTts(text, callback) {
  if (!nvidiaApiKey) {
    throw new Error('NVIDIA API key is missing');
  }

  const voiceConfig = getSelectedNvidiaVoiceConfig();
  const synthesizePromise = window.electronAPI.nvidiaTtsSynthesize({
    apiKey: nvidiaApiKey,
    text,
    voiceName: voiceConfig.voiceName || defaultNvidiaVoiceName,
    languageCode: voiceConfig.languageCode || 'en-US'
  });
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Magpie TTS timed out')), 45000);
  });
  const result = await Promise.race([synthesizePromise, timeoutPromise]);
  const audioBytes = decodeBase64ToUint8Array(result.audioBase64 || '');
  if (!audioBytes.length) {
    throw new Error('Magpie returned empty audio');
  }
  const audioBlob = pcmToWav(audioBytes, 22050, 1, 16);
  playAudioBlob(audioBlob, callback, '[Olanga] Done speaking (Magpie TTS)');
  return true;
}

function pickWindowsVoice() {
  const voices = synthesis.getVoices() || [];
  if (voices.length === 0) return null;

  const preferredNames = [
    /microsoft zira/i,
    /microsoft david/i,
    /microsoft mark/i,
    /microsoft aria/i,
    /microsoft jenny/i,
    /microsoft.*english/i,
    /narrator/i,
    /^en[-_]?us/i
  ];

  for (const pattern of preferredNames) {
    const match = voices.find(v => pattern.test(v.name) || pattern.test(v.lang || ''));
    if (match) return match;
  }

  return voices.find(v => (v.lang || '').toLowerCase().startsWith('en')) || voices[0];
}

function speakWithWindowsTts(text, callback) {
  return new Promise((resolve) => {
    const finish = () => {
      if (callback) callback();
      else setState(State.IDLE);
      resolve(true);
    };

    try {
      synthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = pickWindowsVoice();
      if (voice) utterance.voice = voice;
      utterance.rate = Number.isFinite(ttsRate) ? ttsRate : 1;
      utterance.volume = isMuted ? 0 : currentVolume;
      utterance.onend = () => {
        console.log('[Olanga] Done speaking (Windows TTS)');
        finish();
      };
      utterance.onerror = (event) => {
        console.error('[Olanga] Windows TTS error:', event.error || event);
        finish();
      };

      // Voices can load asynchronously on Windows; wait briefly if needed.
      if ((synthesis.getVoices() || []).length === 0) {
        const retry = () => {
          const delayedVoice = pickWindowsVoice();
          if (delayedVoice) utterance.voice = delayedVoice;
          synthesis.speak(utterance);
        };
        synthesis.addEventListener('voiceschanged', retry, { once: true });
        setTimeout(() => {
          if (!synthesis.speaking && !synthesis.pending) {
            synthesis.speak(utterance);
          }
        }, 250);
      } else {
        synthesis.speak(utterance);
      }
    } catch (error) {
      console.error('[Olanga] Windows TTS failed:', error);
      finish();
    }
  });
}

async function speakWithSelectedEngine(text, callback) {
  if (ttsEngine === 'magpie') {
    if (!nvidiaApiKey) {
      throw new Error('Add an NVIDIA API key in Settings to use Magpie TTS, or switch to Windows voice.');
    }
    try {
      await speakWithNvidiaTts(text, callback);
      return;
    } catch (err) {
      console.warn('[Olanga] Magpie TTS failed, falling back to Windows:', err.message);
      await speakWithWindowsTts(text, callback);
      return;
    }
  }

  await speakWithWindowsTts(text, callback);
}

// Speaks a response then fires a callback once done
async function speakResponseAndThen(text, callback) {
  if (isTtsMuted) {
    clearSpeakingWatchdog();
    if (callback) callback();
    else setState(State.IDLE);
    return;
  }

  setState(State.SPEAKING);
  armSpeakingWatchdog(60000);
  synthesis.cancel();
  if (currentTTSAudio) {
    try { currentTTSAudio.pause(); } catch (_) {}
    currentTTSAudio = null;
  }

  try {
    await speakWithSelectedEngine(text, () => {
      clearSpeakingWatchdog();
      if (callback) callback();
      else setState(State.IDLE);
    });
  } catch (err) {
    console.error('[Olanga] TTS failed:', err.message);
    clearSpeakingWatchdog();
    showError(err.message || 'TTS failed');
    if (callback) callback();
    else setState(State.IDLE);
  }
}

async function speakResponse(text) {
  if (isTtsMuted) {
    clearSpeakingWatchdog();
    setState(State.IDLE);
    return;
  }

  setState(State.SPEAKING);
  armSpeakingWatchdog(60000);
  synthesis.cancel();
  if (currentTTSAudio) {
    try { currentTTSAudio.pause(); } catch (_) {}
    currentTTSAudio = null;
  }

  try {
    await speakWithSelectedEngine(text, () => {
      clearSpeakingWatchdog();
      setState(State.IDLE);
    });
  } catch (e) {
    console.error('[Olanga] TTS failed:', e.message);
    clearSpeakingWatchdog();
    showError(e.message || 'TTS failed');
    setState(State.IDLE);
  }
}

// ============================================
// FOLLOW-UP LISTENING WINDOWS
// ============================================

function startFollowUpWindow(durationMs = FOLLOW_UP_WINDOW) {
  if (followUpTimer) {
    clearTimeout(followUpTimer);
    followUpTimer = null;
  }

  setState(State.LISTENING);
  followUpTimer = setTimeout(() => {
    followUpTimer = null;
    if (currentState === State.LISTENING) {
      setState(State.IDLE);
    }
  }, durationMs);
}

function cancelFollowUpWindow() {
  if (followUpTimer) {
    clearTimeout(followUpTimer);
    followUpTimer = null;
  }
}

function pcmToWav(pcmBytes, sampleRate, numChannels, bitDepth) {
  const byteRate = sampleRate * numChannels * (bitDepth / 8);
  const blockAlign = numChannels * (bitDepth / 8);
  const dataSize = pcmBytes.length;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer, 44).set(pcmBytes);
  return new Blob([buffer], { type: 'audio/wav' });
}

function decodeBase64ToUint8Array(base64Text) {
  const binary = atob(base64Text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
