/* ============================================
   OLANGA — AUDIO CONTROLS (mic mute, TTS mute)
   ============================================ */

function initAudioControls() {
  const savedMicMute = localStorage.getItem('olanga_mic_muted');
  if (savedMicMute === 'true') {
    muteMic();
  } else {
    unmuteMic();
  }

  const savedTtsMute = localStorage.getItem('olanga_tts_muted');
  if (savedTtsMute === 'true') {
    muteTts();
  } else {
    unmuteTts();
  }

  if (micToggleBtn) {
    micToggleBtn.addEventListener('click', toggleMic);
  }

  if (ttsToggleBtn) {
    ttsToggleBtn.addEventListener('click', toggleTts);
  }
}

function muteMic() {
  isMicMuted = true;
  if (micToggleBtn) {
    micToggleBtn.classList.add('muted');
    micToggleBtn.title = "Unmute Microphone";
  }
  if (micIconOn && micIconOff) {
    micIconOn.style.display = 'none';
    micIconOff.style.display = 'block';
  }
  localStorage.setItem('olanga_mic_muted', 'true');
  console.log('[Olanga] Microphone muted');

  if (currentState === State.LISTENING) {
    cancelRecording();
    setState(State.IDLE);
  }
}

function unmuteMic() {
  isMicMuted = false;
  if (micToggleBtn) {
    micToggleBtn.classList.remove('muted');
    micToggleBtn.title = "Mute Microphone";
  }
  if (micIconOn && micIconOff) {
    micIconOn.style.display = 'block';
    micIconOff.style.display = 'none';
  }
  localStorage.setItem('olanga_mic_muted', 'false');
  console.log('[Olanga] Microphone unmuted');
}

function toggleMic() {
  if (isMicMuted) {
    unmuteMic();
  } else {
    muteMic();
  }
}

function muteTts() {
  isTtsMuted = true;
  if (ttsToggleBtn) {
    ttsToggleBtn.classList.add('muted');
    ttsToggleBtn.title = "Unmute Olanga (Enable TTS)";
  }
  if (ttsIconOn && ttsIconOff) {
    ttsIconOn.style.display = 'none';
    ttsIconOff.style.display = 'block';
  }
  localStorage.setItem('olanga_tts_muted', 'true');
  console.log('[Olanga] TTS muted');
}

function unmuteTts() {
  isTtsMuted = false;
  if (ttsToggleBtn) {
    ttsToggleBtn.classList.remove('muted');
    ttsToggleBtn.title = "Silence Olanga (Disable TTS)";
  }
  if (ttsIconOn && ttsIconOff) {
    ttsIconOn.style.display = 'block';
    ttsIconOff.style.display = 'none';
  }
  localStorage.setItem('olanga_tts_muted', 'false');
  console.log('[Olanga] TTS unmuted');
}

function toggleTts() {
  if (isTtsMuted) {
    unmuteTts();
  } else {
    muteTts();
  }
}
