/* ============================================
   OLANGA — AUDIO CONTROLS (mic mute, TTS mute)
   ============================================ */

const boundAudioControls = new WeakSet();

function readAudioPreference(key, fallback) {
  try { return localStorage.getItem(key) === 'true'; }
  catch (error) { console.warn('[Olanga] Audio preference unavailable:', error.message); return fallback; }
}

function saveAudioPreference(key, muted) {
  try { localStorage.setItem(key, String(muted)); }
  catch (error) {
    console.warn('[Olanga] Audio preference could not be saved:', error.message);
    if (typeof showError === 'function') showError('Audio setting applied for this session, but could not be saved.');
  }
}

function applyMicrophoneMuteState() {
  try { micStream?.getTracks().forEach(track => { track.enabled = !isMicMuted; }); } catch (_) {}
  if (typeof resetMicrophoneRecognition === 'function') resetMicrophoneRecognition();
}

function initAudioControls() {
  if (readAudioPreference('olanga_mic_muted', isMicMuted)) muteMic(false);
  else unmuteMic(false);

  if (readAudioPreference('olanga_tts_muted', isTtsMuted)) muteTts(false);
  else unmuteTts(false);

  if (micToggleBtn && !boundAudioControls.has(micToggleBtn)) {
    boundAudioControls.add(micToggleBtn);
    micToggleBtn.addEventListener('click', toggleMic);
  }

  if (ttsToggleBtn && !boundAudioControls.has(ttsToggleBtn)) {
    boundAudioControls.add(ttsToggleBtn);
    ttsToggleBtn.addEventListener('click', toggleTts);
  }
}

function muteMic(persist = true) {
  isMicMuted = true;
  applyMicrophoneMuteState();
  if (typeof cancelRecording === 'function') cancelRecording();
  if (typeof cancelFollowUpWindow === 'function') cancelFollowUpWindow();
  if (micToggleBtn) {
    micToggleBtn.classList.add('muted');
    micToggleBtn.title = "Unmute Microphone";
  }
  if (micIconOn && micIconOff) {
    micIconOn.style.display = 'none';
    micIconOff.style.display = 'block';
  }
  console.log('[Olanga] Microphone muted');

  if (currentState === State.LISTENING || currentState === State.IDLE) {
    setState(State.IDLE);
  }
  if (persist) saveAudioPreference('olanga_mic_muted', true);
}

function unmuteMic(persist = true) {
  isMicMuted = false;
  applyMicrophoneMuteState();
  if (micToggleBtn) {
    micToggleBtn.classList.remove('muted');
    micToggleBtn.title = "Mute Microphone";
  }
  if (micIconOn && micIconOff) {
    micIconOn.style.display = 'block';
    micIconOff.style.display = 'none';
  }
  if (persist) saveAudioPreference('olanga_mic_muted', false);
  console.log('[Olanga] Microphone unmuted');
  if (currentState === State.IDLE) setState(State.IDLE);
}

function toggleMic() {
  if (isMicMuted) {
    unmuteMic();
  } else {
    muteMic();
  }
}

function muteTts(persist = true) {
  isTtsMuted = true;
  if (typeof stopAssistantSpeech === 'function') stopAssistantSpeech();
  else {
    try { currentTTSAudio?.pause(); } catch (_) {}
    try { synthesis.cancel(); } catch (_) {}
  }
  if (currentState === State.SPEAKING) setState(State.IDLE);
  if (ttsToggleBtn) {
    ttsToggleBtn.classList.add('muted');
    ttsToggleBtn.title = "Unmute Olanga (Enable TTS)";
  }
  if (ttsIconOn && ttsIconOff) {
    ttsIconOn.style.display = 'none';
    ttsIconOff.style.display = 'block';
  }
  if (persist) saveAudioPreference('olanga_tts_muted', true);
  console.log('[Olanga] TTS muted');
}

function unmuteTts(persist = true) {
  isTtsMuted = false;
  if (ttsToggleBtn) {
    ttsToggleBtn.classList.remove('muted');
    ttsToggleBtn.title = "Silence Olanga (Disable TTS)";
  }
  if (ttsIconOn && ttsIconOff) {
    ttsIconOn.style.display = 'block';
    ttsIconOff.style.display = 'none';
  }
  if (persist) saveAudioPreference('olanga_tts_muted', false);
  console.log('[Olanga] TTS unmuted');
}

function toggleTts() {
  if (isTtsMuted) {
    unmuteTts();
  } else {
    muteTts();
  }
}
