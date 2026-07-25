/* ============================================
   OLANGA — CORE STATE, DOM REFERENCES, UI BASICS
   Loaded first; every other module relies on the
   globals defined here (classic scripts share scope).
   ============================================ */

// ---- State Machine ----
const State = {
  IDLE: 'idle',           // Monitoring mic with Vosk for "Hey Olanga"
  LISTENING: 'listening', // Recording user query (post-wake-word)
  THINKING: 'thinking',   // Waiting for AI response
  SPEAKING: 'speaking'    // Speaking the response
};

let currentState = State.IDLE;
let apiKeys = [];
let apiKeyRotation = false;
let currentKeyIndex = 0;
let apiKey = ''; // current active key
let nvidiaApiKey = ''; // NVIDIA API key for TTS
const defaultNvidiaVoiceName = OlangaPrefs.DEFAULT_NVIDIA_VOICE;

// Boot values come from the shared schema, which also runs any one-time
// migrations before the rest of the app reads these globals.
const bootPrefs = OlangaPrefs.load(localStorage);
OlangaPrefs.writeToStorage(localStorage, bootPrefs, ['statusLightSize']);

let nvidiaVoiceName = bootPrefs.nvidiaVoice;
let ttsRate = bootPrefs.ttsRate;
// Default to Windows built-in TTS; Magpie is opt-in until it's working reliably.
let ttsEngine = bootPrefs.ttsEngine;
let nvidiaVoiceCatalog = [];
let statusLightMode = bootPrefs.statusLightMode;
let statusLightSize = bootPrefs.statusLightSize;
let userCity = '';
let userState = '';
let userCountry = '';
let synthesis = window.speechSynthesis;
let conversationHistory = []; // {role: 'user'|'model', text: '...'}
let orbCanvasCtx = null;
let animationFrameId = null;

// Audio capture
let audioContext = null;
let analyser = null;
let micStream = null;
let scriptNode = null;
let pcmChunks = [];
let isRecording = false;
let speechStartTime = null;
let silenceStartTime = null;
let followUpTimer = null;
let currentRMS = 0;
let hasSpokenDuringRecording = false;
let currentTTSAudio = null; // Reference to current TTS audio element
let isMuted = false;
let currentVolume = 0.8; // 0-1 range
let isMicMuted = false;
let isTtsMuted = false;
let activeTimers = [];
let alarmIntervalId = null;
let activeTasks = [];

// Vosk Wake Word
let voskModel = null;
let voskRecognizer = null;
let isVoskReady = false;

// Tuning
const SPEECH_THRESHOLD = 6;      // RMS above this = speech detected (during listening mode)
const SILENCE_THRESHOLD = 4;     // RMS below this = silence
const SILENCE_DURATION = 1500;   // ms of silence to finalize recording
const MIN_SPEECH_DURATION = 500; // minimum ms of speech to bother processing
const FOLLOW_UP_WINDOW = 4000;   // ms to wait for follow-up after speaking

const PRESET_WAKE_WORDS = Object.freeze([
  'hey',
  'hail',
  'hey olanga',
  'hey alanga',
  'hay olanga',
  'a olanga',
  'hey longo',
  'he olanga',
  'hey along the',
  'hail longer',
  'hey or longer',
  'hey longer',
  'hail along the',
  'hey alonso'
]);

// Back-compat alias for older references.
const WAKE_WORDS = PRESET_WAKE_WORDS;

/** @type {{ id: string, label: string, phrases: string[], createdAt: number }[]} */
let customWakeWordGroups = [];

const CUSTOM_WAKE_WORDS_KEY = 'olanga_custom_wake_words';

function normalizeWakePhrase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCustomWakePhrases() {
  const phrases = [];
  for (const group of customWakeWordGroups) {
    if (!group || !Array.isArray(group.phrases)) continue;
    for (const phrase of group.phrases) {
      const normalized = normalizeWakePhrase(phrase);
      if (normalized) phrases.push(normalized);
    }
  }
  return phrases;
}

function getActiveWakeWords() {
  const seen = new Set();
  const all = [];
  for (const phrase of [...PRESET_WAKE_WORDS, ...getCustomWakePhrases()]) {
    const normalized = normalizeWakePhrase(phrase);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    all.push(normalized);
  }
  return all;
}

function loadCustomWakeWordGroups() {
  try {
    const raw = localStorage.getItem(CUSTOM_WAKE_WORDS_KEY);
    if (!raw) {
      customWakeWordGroups = [];
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      customWakeWordGroups = [];
      return;
    }
    customWakeWordGroups = parsed
      .map((group) => {
        if (!group || typeof group !== 'object') return null;
        const phrases = Array.isArray(group.phrases)
          ? [...new Set(group.phrases.map(normalizeWakePhrase).filter(Boolean))]
          : [];
        if (phrases.length === 0) return null;
        return {
          id: String(group.id || `ww_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
          label: normalizeWakePhrase(group.label) || phrases[0],
          phrases,
          createdAt: Number(group.createdAt) || Date.now()
        };
      })
      .filter(Boolean);
  } catch {
    customWakeWordGroups = [];
  }
}

function persistCustomWakeWordGroups() {
  localStorage.setItem(CUSTOM_WAKE_WORDS_KEY, JSON.stringify(customWakeWordGroups));
}

function addCustomWakeWordGroup(phrases, labelOverride) {
  const unique = [...new Set((phrases || []).map(normalizeWakePhrase).filter(Boolean))];
  if (unique.length === 0) return null;
  const label = normalizeWakePhrase(labelOverride) || unique.find((p) => p.includes(' ')) || unique[0];
  const group = {
    id: `ww_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    label,
    phrases: unique.slice(0, 6),
    createdAt: Date.now()
  };
  customWakeWordGroups.push(group);
  persistCustomWakeWordGroups();
  return group;
}

function removeCustomWakeWordGroup(groupId) {
  const before = customWakeWordGroups.length;
  customWakeWordGroups = customWakeWordGroups.filter((group) => group.id !== groupId);
  if (customWakeWordGroups.length !== before) {
    persistCustomWakeWordGroups();
    return true;
  }
  return false;
}

loadCustomWakeWordGroups();

let isWakeWordCapturing = false;

// ---- DOM Elements ----
const setupScreen = document.getElementById('setupScreen');
const mainScreen = document.getElementById('mainScreen');
const apiKeyInput = document.getElementById('apiKeyInput');
const nvidiaKeyInput = document.getElementById('nvidiaKeyInput');
const saveKeyBtn = document.getElementById('saveKeyBtn');
const getKeyLink = document.getElementById('getKeyLink');
const clockDisplay = document.getElementById('clockDisplay');
const orbContainer = document.getElementById('orbContainer');
const orbGlow = document.getElementById('orbGlow');
const orb = document.getElementById('orb');
const orbCanvas = document.getElementById('orbCanvas');
const waveBars = document.getElementById('waveBars');
const waveBarEls = document.querySelectorAll('.wave-bar');
const transcriptUser = document.getElementById('transcriptUser');
const transcriptAi = document.getElementById('transcriptAi');
const userText = document.getElementById('userText');
const aiText = document.getElementById('aiText');
const hint = document.getElementById('hint');
const minimizeBtn = document.getElementById('minimizeBtn');
const closeBtn = document.getElementById('closeBtn');
const keyListContainer = document.getElementById('keyListContainer');
const newKeyInput = document.getElementById('newKeyInput');
const addKeyBtn = document.getElementById('addKeyBtn');
const nvidiaSettingsKeyInput = document.getElementById('nvidiaSettingsKeyInput');
const addNvidiaKeyBtn = document.getElementById('addNvidiaKeyBtn');
const rotationToggle = document.getElementById('rotationToggle');
const nvidiaVoiceSelect = document.getElementById('nvidiaVoiceSelect');
const ttsEngineSelect = document.getElementById('ttsEngineSelect');
const magpieVoiceSettings = document.getElementById('magpieVoiceSettings');
const ttsRateInput = document.getElementById('ttsRateInput');
const ttsRateValue = document.getElementById('ttsRateValue');
const cityInput = document.getElementById('cityInput');
const stateInput = document.getElementById('stateInput');
const countryInput = document.getElementById('countryInput');
const dateDisplay = document.getElementById('dateDisplay');
const micToggleBtn = document.getElementById('micToggleBtn');
const micIconOn = document.getElementById('micIconOn');
const micIconOff = document.getElementById('micIconOff');
const ttsToggleBtn = document.getElementById('ttsToggleBtn');
const ttsIconOn = document.getElementById('ttsIconOn');
const ttsIconOff = document.getElementById('ttsIconOff');
const timersContainer = document.getElementById('timersList');

let lastIdleTime = 0;

// ---- State Management ----
function setState(newState, preserveHistory = false) {
  const prev = currentState;
  currentState = newState;

  document.body.classList.remove('state-idle', 'state-listening', 'state-thinking', 'state-speaking');
  document.body.classList.add(`state-${newState}`);

  switch (newState) {
    case State.IDLE:
      lastIdleTime = Date.now();
      if (!preserveHistory) {
        conversationHistory = []; // Only contain memory for the current strand of conversation
      }
      hint.textContent = 'Listening for "Hey Olanga"...';
      hint.classList.remove('hidden');
      hint.innerHTML = 'Say <strong>"Hey Olanga"</strong> (or your custom wake word) to start';
      // Reset Vosk recognizer to clear old state
      if (voskRecognizer && !isWakeWordCapturing) {
          try {
              voskRecognizer.reset();
          } catch(e) {}
      }
      break;
    case State.LISTENING:
    case State.THINKING:
    case State.SPEAKING:
      break;
  }

  console.log(`[Olanga] State: ${prev} → ${newState}`);
  try {
    if (window.electronAPI?.setStatusState) {
      window.electronAPI.setStatusState(newState);
    }
  } catch (_) {}
}

async function showMainScreen() {
  setupScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  // Show floating icons after setup is complete
  const floatingIconsWrapper = document.querySelector('.floating-icons');
  if (floatingIconsWrapper) {
    floatingIconsWrapper.classList.add('visible');
  }
  hint.textContent = "Loading offline wake word model...";
  try {
    await initVosk();
    await initMicrophone();
  } catch(e) {
    console.error("Init error", e);
    showError("Failed to initialize system: " + e.message);
  }
}

// ============================================
// ORB CANVAS ANIMATION
// ============================================

function startOrbAnimation() {
  const canvas = orbCanvas;
  const ctx = orbCanvasCtx;
  if (!ctx) return;

  let time = 0;

  function draw() {
    time += 0.02;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const radius = 80;

    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2 + time;
      const dist = radius * 0.5 + Math.sin(time * 2 + i) * 20;
      const x = cx + Math.cos(angle) * dist * 0.6;
      const y = cy + Math.sin(angle) * dist * 0.6;
      const size = 2 + Math.sin(time + i * 0.5) * 1.5;

      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${0.1 + Math.sin(time + i) * 0.08})`;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.7, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.03 + Math.sin(time * 1.5) * 0.02})`;
    ctx.lineWidth = 1;
    ctx.stroke();

    animationFrameId = requestAnimationFrame(draw);
  }

  draw();
}

// ============================================
// CLOCK LOGIC
// ============================================
function updateClock() {
  if (!clockDisplay) return;
  const now = new Date();
  let hours = now.getHours();
  let minutes = now.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // the hour '0' should be '12'
  minutes = minutes < 10 ? '0' + minutes : minutes;
  clockDisplay.textContent = `${hours}:${minutes} ${ampm}`;

  // Update date
  if (dateDisplay) {
    const options = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
    dateDisplay.textContent = now.toLocaleDateString('en-US', options);
  }
}

// ============================================
// ERROR TOAST
// ============================================

function showError(message) {
  const existing = document.querySelector('.error-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'error-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 5000);
}

function escapeHTML(str) {
  return String(str ?? '').replace(/[&<>'"]/g,
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// ============================================
// CLEANUP
// ============================================

window.addEventListener('beforeunload', () => {
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  if (audioContext) audioContext.close();
  synthesis.cancel();
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  if (voskModel) voskModel.terminate();
});

// Ensure voices are loaded
if (synthesis.onvoiceschanged !== undefined) {
  synthesis.onvoiceschanged = () => {
    console.log('[Olanga] Voices loaded:', synthesis.getVoices().length);
  };
}
