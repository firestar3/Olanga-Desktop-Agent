/* ============================================
   OLANGA — SETTINGS, API KEYS, INITIALIZATION, NAVIGATION

   API keys are stored encrypted at rest via the main process
   (Electron safeStorage). Keys previously stored in plaintext
   localStorage are migrated on first launch.
   ============================================ */

const GEMINI_KEYS_STORE = 'gemini_api_keys';
const NVIDIA_KEY_STORE = 'nvidia_api_key';
const APP_PREFS_STORE = 'app_preferences';
const FEATURES_STORAGE_KEY = 'olanga_enabled_features';
const OPTIONAL_FEATURES = ['notepadScreen', 'newsScreen', 'terminalScreen'];

let settingsSaveTimer = null;

function readPrefsFromLocalStorage() {
  let features = [];
  try {
    const stored = JSON.parse(localStorage.getItem(FEATURES_STORAGE_KEY) || '[]');
    features = Array.isArray(stored) ? stored.filter((f) => OPTIONAL_FEATURES.includes(f)) : [];
  } catch {
    features = [];
  }

  return {
    city: localStorage.getItem('olanga_city') || '',
    state: localStorage.getItem('olanga_state') || '',
    country: localStorage.getItem('olanga_country') || '',
    ttsEngine: localStorage.getItem('olanga_tts_engine') === 'magpie' ? 'magpie' : 'windows',
    ttsRate: Number.parseFloat(localStorage.getItem('olanga_tts_rate') || '1.05') || 1.05,
    nvidiaVoice: localStorage.getItem('olanga_nvidia_voice') || defaultNvidiaVoiceName,
    features,
    keyRotation: localStorage.getItem('olanga_key_rotation') === 'true',
    customWakeWordGroups: Array.isArray(customWakeWordGroups) ? customWakeWordGroups : [],
    statusLightMode: ['off', 'active', 'all'].includes(statusLightMode) ? statusLightMode : 'active',
    statusLightMode: ['off', 'active', 'all'].includes(statusLightMode) ? statusLightMode : 'active',
    statusLightSize: ['small', 'normal', 'large'].includes(statusLightSize) ? statusLightSize : 'small',
    statusLightSizeV2: true
  };
}

function collectPrefsFromUI() {
  const features = [];
  document.querySelectorAll('input[data-feature]').forEach((toggle) => {
    if (toggle.checked) {
      const feature = toggle.getAttribute('data-feature');
      if (OPTIONAL_FEATURES.includes(feature)) features.push(feature);
    }
  });

  const engine = (ttsEngineSelect?.value || ttsEngine || 'windows') === 'magpie' ? 'magpie' : 'windows';
  const rateRaw = Number.parseFloat(ttsRateInput?.value || String(ttsRate) || '1.05');
  const voiceRaw = (nvidiaVoiceSelect?.value || nvidiaVoiceName || defaultNvidiaVoiceName).trim();

  return {
    city: (cityInput?.value || '').trim(),
    state: (stateInput?.value || '').trim(),
    country: (countryInput?.value || '').trim(),
    ttsEngine: engine,
    ttsRate: Number.isFinite(rateRaw) ? rateRaw : 1.05,
    nvidiaVoice: voiceRaw || defaultNvidiaVoiceName,
    features,
    keyRotation: !!(rotationToggle?.checked),
    customWakeWordGroups: Array.isArray(customWakeWordGroups) ? customWakeWordGroups : [],
    statusLightMode: ['off', 'active', 'all'].includes(statusLightMode) ? statusLightMode : 'active',
    statusLightSize: ['small', 'normal', 'large'].includes(statusLightSize) ? statusLightSize : 'small',
    statusLightSizeV2: true
  };
}

function normalizeStoredStatusLightSize(prefs) {
  let size = prefs?.statusLightSize;
  if (!prefs?.statusLightSizeV2) {
    if (size === 'large') size = 'normal';
    else size = 'small';
  }
  return ['small', 'normal', 'large'].includes(size) ? size : 'small';
}

function writePrefsToLocalStorage(prefs) {
  localStorage.setItem('olanga_city', prefs.city || '');
  localStorage.setItem('olanga_state', prefs.state || '');
  localStorage.setItem('olanga_country', prefs.country || '');
  localStorage.setItem('olanga_tts_engine', prefs.ttsEngine === 'magpie' ? 'magpie' : 'windows');
  localStorage.setItem('olanga_tts_rate', String(prefs.ttsRate ?? 1.05));
  localStorage.setItem('olanga_nvidia_voice', prefs.nvidiaVoice || defaultNvidiaVoiceName);
  localStorage.setItem(FEATURES_STORAGE_KEY, JSON.stringify(Array.isArray(prefs.features) ? prefs.features : []));
  localStorage.setItem('olanga_key_rotation', prefs.keyRotation ? 'true' : 'false');
  if (prefs.statusLightMode) {
    statusLightMode = ['off', 'active', 'all'].includes(prefs.statusLightMode) ? prefs.statusLightMode : 'active';
    localStorage.setItem('olanga_status_light_mode', statusLightMode);
  }
  if (prefs.statusLightSize != null || prefs.statusLightSizeV2 != null) {
    statusLightSize = normalizeStoredStatusLightSize(prefs);
    localStorage.setItem('olanga_status_light_size', statusLightSize);
    localStorage.setItem('olanga_status_light_size_v2', '1');
  }
  if (Array.isArray(prefs.customWakeWordGroups)) {
    customWakeWordGroups = prefs.customWakeWordGroups;
    persistCustomWakeWordGroups();
  }
}

function applyPrefsToRuntime(prefs) {
  userCity = prefs.city || '';
  userState = prefs.state || '';
  userCountry = prefs.country || '';
  ttsEngine = prefs.ttsEngine === 'magpie' ? 'magpie' : 'windows';
  ttsRate = Number.isFinite(prefs.ttsRate) ? prefs.ttsRate : 1.05;
  nvidiaVoiceName = prefs.nvidiaVoice || defaultNvidiaVoiceName;
  if (typeof ALLOWED_ENGLISH_VOICE_IDS !== 'undefined' && !ALLOWED_ENGLISH_VOICE_IDS.has(nvidiaVoiceName)) {
    nvidiaVoiceName = defaultNvidiaVoiceName;
  }
  apiKeyRotation = !!prefs.keyRotation;
  if (prefs.statusLightMode) {
    statusLightMode = ['off', 'active', 'all'].includes(prefs.statusLightMode) ? prefs.statusLightMode : 'active';
    localStorage.setItem('olanga_status_light_mode', statusLightMode);
    if (window.electronAPI?.setStatusLightMode) {
      window.electronAPI.setStatusLightMode(statusLightMode);
    }
  }
  if (prefs.statusLightSize != null || prefs.statusLightSizeV2 != null) {
    statusLightSize = normalizeStoredStatusLightSize(prefs);
    localStorage.setItem('olanga_status_light_size', statusLightSize);
    localStorage.setItem('olanga_status_light_size_v2', '1');
    if (window.electronAPI?.setStatusLightSize) {
      window.electronAPI.setStatusLightSize(statusLightSize);
    }
  }
  if (Array.isArray(prefs.customWakeWordGroups)) {
    customWakeWordGroups = prefs.customWakeWordGroups
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
    persistCustomWakeWordGroups();
  }
}

function applyPrefsToSettingsUI(prefs) {
  if (cityInput) cityInput.value = prefs.city || '';
  if (stateInput) stateInput.value = prefs.state || '';
  if (countryInput) countryInput.value = prefs.country || '';
  if (rotationToggle) rotationToggle.checked = !!prefs.keyRotation;
  if (ttsEngineSelect) ttsEngineSelect.value = prefs.ttsEngine === 'magpie' ? 'magpie' : 'windows';
  if (ttsRateInput) {
    ttsRateInput.value = String(prefs.ttsRate ?? 1.05);
    if (typeof updateTtsRateLabel === 'function') updateTtsRateLabel(prefs.ttsRate);
  }
  if (typeof refreshVoiceCatalog === 'function') refreshVoiceCatalog();
  if (typeof updateMagpieSettingsVisibility === 'function') updateMagpieSettingsVisibility();
  if (nvidiaVoiceSelect && prefs.nvidiaVoice) {
    nvidiaVoiceSelect.value = prefs.nvidiaVoice;
  }
  document.querySelectorAll('input[data-feature]').forEach((toggle) => {
    toggle.checked = (prefs.features || []).includes(toggle.getAttribute('data-feature'));
  });
  if (typeof applyFeatureToggles === 'function') applyFeatureToggles();
  if (typeof renderCustomWakeWords === 'function') renderCustomWakeWords();
  if (typeof updateStatusLightModeButton === 'function') updateStatusLightModeButton();
  if (typeof updateStatusLightSizeButton === 'function') updateStatusLightSizeButton();
}

function scheduleSaveAppSettings() {
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = null;
    saveAppSettings();
  }, 150);
}

async function persistAppPreferences(prefs) {
  writePrefsToLocalStorage(prefs);
  try {
    if (window.electronAPI?.secureStoreSet) {
      await window.electronAPI.secureStoreSet(APP_PREFS_STORE, JSON.stringify(prefs));
    }
  } catch (error) {
    console.warn('[Olanga] Secure prefs save failed:', error.message);
  }
}

async function loadAppPreferences() {
  let prefs = readPrefsFromLocalStorage();
  try {
    if (window.electronAPI?.secureStoreGet) {
      const raw = await window.electronAPI.secureStoreGet(APP_PREFS_STORE);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          prefs = {
            ...prefs,
            ...parsed,
            features: Array.isArray(parsed.features)
              ? parsed.features.filter((f) => OPTIONAL_FEATURES.includes(f))
              : prefs.features,
            customWakeWordGroups: Array.isArray(parsed.customWakeWordGroups)
              ? parsed.customWakeWordGroups
              : prefs.customWakeWordGroups,
            statusLightMode: ['off', 'active', 'all'].includes(parsed.statusLightMode)
              ? parsed.statusLightMode
              : prefs.statusLightMode,
            statusLightSize: parsed.statusLightSize,
            statusLightSizeV2: !!parsed.statusLightSizeV2
          };
        }
      }
    }
  } catch (error) {
    console.warn('[Olanga] Secure prefs load failed:', error.message);
  }
  applyPrefsToRuntime(prefs);
  writePrefsToLocalStorage(prefs); // keep local mirrors in sync with secure store
  return prefs;
}

async function saveAppSettings() {
  try {
    const prefs = collectPrefsFromUI();
    applyPrefsToRuntime(prefs);
    await persistAppPreferences(prefs);
    if (typeof applyFeatureToggles === 'function') applyFeatureToggles();
    if (typeof updateMagpieSettingsVisibility === 'function') updateMagpieSettingsVisibility();
    return true;
  } catch (error) {
    console.warn('[Olanga] Failed to save settings:', error.message);
    return false;
  }
}

async function persistGeminiKeys() {
  const payload = JSON.stringify(Array.isArray(apiKeys) ? apiKeys.filter(Boolean) : []);
  localStorage.setItem('olanga_api_keys', payload);
  try {
    if (window.electronAPI?.secureStoreSet) {
      await window.electronAPI.secureStoreSet(GEMINI_KEYS_STORE, payload);
    }
    localStorage.removeItem('olanga_api_key');
  } catch (error) {
    console.warn('[Olanga] Secure storage unavailable for Gemini keys:', error.message);
  }
}

async function persistNvidiaKey() {
  const value = String(nvidiaApiKey || '');
  if (value) {
    localStorage.setItem('olanga_nvidia_key', value);
  } else {
    localStorage.removeItem('olanga_nvidia_key');
  }
  try {
    if (window.electronAPI?.secureStoreSet) {
      // Never write an empty string — that deletes the secure entry.
      if (value) {
        await window.electronAPI.secureStoreSet(NVIDIA_KEY_STORE, value);
      }
    }
  } catch (error) {
    console.warn('[Olanga] Secure storage unavailable for NVIDIA key:', error.message);
  }
}

function fillKeyInput(input, value) {
  if (!input || value == null || value === '') return;
  const text = String(value);
  input.value = text;
  input.setAttribute('value', text);
  // Chromium sometimes clears password fields after layout; re-assert next frame.
  requestAnimationFrame(() => {
    if (input.value !== text) input.value = text;
  });
}

function hydrateKeyInputs(geminiKeys, nvidiaKey) {
  const gemini = (Array.isArray(geminiKeys) && geminiKeys[0]) || apiKey || '';
  const nvidia = nvidiaKey || nvidiaApiKey || '';
  fillKeyInput(apiKeyInput, gemini);
  fillKeyInput(nvidiaKeyInput, nvidia);
  fillKeyInput(nvidiaSettingsKeyInput, nvidia);
  fillKeyInput(newKeyInput, gemini);
}

const SETUP_INTRO_MS = 6500;
const SETUP_INTRO_REPLAY_MS = 7200;

function restartSetupIntro() {
  if (!setupScreen) return;
  setupScreen.classList.remove('setup-first-launch', 'setup-intro-done', 'setup-intro-replay');
  void setupScreen.offsetWidth;
  setupScreen.classList.add('setup-first-launch');
  window.setTimeout(() => {
    if (setupScreen && setupScreen.classList.contains('setup-first-launch')) {
      setupScreen.classList.add('setup-intro-done');
    }
  }, SETUP_INTRO_MS);
}

let introReplayTimer = null;

function returnHomeFromIntroReplay() {
  if (introReplayTimer) {
    clearTimeout(introReplayTimer);
    introReplayTimer = null;
  }
  if (!setupScreen) return;

  setupScreen.classList.add('hidden');
  setupScreen.classList.remove('setup-first-launch', 'setup-intro-done', 'setup-intro-replay');

  Object.keys(screens).forEach((key) => {
    if (screens[key]) screens[key].classList.add('hidden');
  });
  if (mainScreen) mainScreen.classList.remove('hidden');

  floatingIcons.forEach((icon) => icon.classList.remove('active'));
  const homeIcon = document.querySelector('.floating-icon[data-screen="mainScreen"]');
  if (homeIcon) homeIcon.classList.add('active');

  const floatingIconsWrapper = document.querySelector('.floating-icons');
  if (floatingIconsWrapper) floatingIconsWrapper.classList.add('visible');
}

function playSetupIntroReplay() {
  if (!setupScreen) return;

  if (introReplayTimer) {
    clearTimeout(introReplayTimer);
    introReplayTimer = null;
  }

  // Hide app screens and nav while the intro plays.
  Object.keys(screens).forEach((key) => {
    if (screens[key]) screens[key].classList.add('hidden');
  });
  const floatingIconsWrapper = document.querySelector('.floating-icons');
  if (floatingIconsWrapper) floatingIconsWrapper.classList.remove('visible');

  setupScreen.classList.remove('hidden');
  setupScreen.classList.add('setup-intro-replay');
  restartSetupIntro();

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  introReplayTimer = window.setTimeout(() => {
    returnHomeFromIntroReplay();
  }, prefersReduced ? 700 : SETUP_INTRO_REPLAY_MS);
}

// Loads keys from the secure store, migrating plaintext localStorage
// values (from earlier versions) if the store is empty.
async function loadStoredKeys() {
  let storedKeys = [];
  try {
    if (!window.electronAPI?.secureStoreGet) {
      throw new Error('secureStoreGet is not available from preload');
    }
    const secureKeys = await window.electronAPI.secureStoreGet(GEMINI_KEYS_STORE);
    console.log('[Olanga] secure Gemini payload type:', typeof secureKeys, secureKeys ? 'non-empty' : 'empty');
    if (secureKeys) {
      const parsed = JSON.parse(secureKeys);
      if (Array.isArray(parsed)) {
        storedKeys = parsed.map(k => String(k || '').trim()).filter(Boolean);
      } else if (typeof parsed === 'string' && parsed.trim()) {
        storedKeys = [parsed.trim()];
      }
    }
  } catch (error) {
    console.warn('[Olanga] Failed to read secure Gemini keys:', error.message);
  }

  if (!Array.isArray(storedKeys) || storedKeys.length === 0) {
    try {
      const rawKeys = localStorage.getItem('olanga_api_keys');
      if (rawKeys) storedKeys = JSON.parse(rawKeys);
      if (!Array.isArray(storedKeys)) storedKeys = [];
      const legacyKey = localStorage.getItem('olanga_api_key');
      if (storedKeys.length === 0 && legacyKey) storedKeys = [legacyKey];
      storedKeys = storedKeys.map(k => String(k || '').trim()).filter(Boolean);
    } catch (e) {
      console.error('Failed to parse stored API keys', e);
      storedKeys = [];
    }
  }

  if (storedKeys.length > 0) {
    apiKeys = storedKeys;
    apiKey = storedKeys[0];
    await persistGeminiKeys();
  }

  let storedNvidiaKey = '';
  try {
    storedNvidiaKey = (await window.electronAPI.secureStoreGet(NVIDIA_KEY_STORE)) || '';
  } catch (error) {
    console.warn('[Olanga] Failed to read secure NVIDIA key:', error.message);
  }
  if (!storedNvidiaKey) {
    storedNvidiaKey = localStorage.getItem('olanga_nvidia_key') || '';
  }
  storedNvidiaKey = String(storedNvidiaKey || '').trim();
  if (storedNvidiaKey) {
    nvidiaApiKey = storedNvidiaKey;
    await persistNvidiaKey();
  }

  console.log(`[Olanga] Loaded keys — Gemini: ${storedKeys.length}, NVIDIA: ${storedNvidiaKey ? 'yes' : 'no'}`);
  return { geminiKeys: storedKeys, nvidiaKey: storedNvidiaKey };
}

// ---- API Key Setup ----
async function handleSaveKey() {
  const key = apiKeyInput.value.trim();
  const nKey = nvidiaKeyInput.value.trim();
  if (!key) {
    showError('Please enter your Gemini API key');
    return;
  }
  if (!apiKeys.includes(key)) {
    apiKeys.push(key);
  }
  apiKey = key;
  await persistGeminiKeys();

  if (nKey) {
    nvidiaApiKey = nKey;
    await persistNvidiaKey();
    if (nvidiaSettingsKeyInput) nvidiaSettingsKeyInput.value = nKey;
    refreshVoiceCatalog();
  }
  if (setupScreen) setupScreen.classList.remove('setup-first-launch');
  showMainScreen();
}

function handleAddKeyFromSettings() {
  const key = newKeyInput.value.trim();
  if (!key) return;
  if (!apiKeys.includes(key)) {
    apiKeys.push(key);
    persistGeminiKeys();
  }
  newKeyInput.value = '';
  renderKeyList();
}

function renderKeyList() {
  if (!keyListContainer) return;
  keyListContainer.innerHTML = '';
  if (apiKeys.length === 0) {
    keyListContainer.innerHTML = '<span style="color:var(--text-dim);font-size:12px;">No keys saved.</span>';
    return;
  }
  apiKeys.forEach((k, i) => {
    const div = document.createElement('div');
    div.className = 'key-item' + (k === apiKey ? ' active' : '');
    div.innerHTML = `
      <span class="key-item-text">Key ${i + 1}: ...${escapeHTML(k.slice(-6))}</span>
      <div class="key-item-actions">
        <button class="key-btn select" data-key="${escapeHTML(k)}">Select</button>
        <button class="key-btn delete" data-key="${escapeHTML(k)}">Del</button>
      </div>
    `;
    keyListContainer.appendChild(div);
  });

  // Bind actions
  keyListContainer.querySelectorAll('.select').forEach(b => {
    b.addEventListener('click', (e) => {
      apiKey = e.target.dataset.key;
      currentKeyIndex = apiKeys.indexOf(apiKey);
      renderKeyList();
    });
  });
  keyListContainer.querySelectorAll('.delete').forEach(b => {
    b.addEventListener('click', (e) => {
      const k = e.target.dataset.key;
      apiKeys = apiKeys.filter(x => x !== k);
      if (apiKey === k) {
        apiKey = apiKeys.length > 0 ? apiKeys[0] : '';
        currentKeyIndex = 0;
      }
      persistGeminiKeys();
      renderKeyList();
    });
  });
}

// ---- Initialize ----
async function init() {
  // Load keys first — before any optional UI wiring that might throw and
  // leave the setup screen stuck with empty fields.
  const { geminiKeys, nvidiaKey } = await loadStoredKeys();
  hydrateKeyInputs(geminiKeys, nvidiaKey);

  // Restore location / features / voice prefs before wiring UI.
  const prefs = await loadAppPreferences();

  if (geminiKeys.length > 0) {
    apiKeys = geminiKeys;
    apiKey = apiKeys[0];
    apiKeyRotation = prefs.keyRotation;
    if (setupScreen) {
      setupScreen.classList.remove('setup-first-launch', 'setup-intro-done');
    }
    showMainScreen();
  } else if (setupScreen) {
    // HTML already has setup-first-launch for first paint; re-trigger so the
    // staged intro always runs when Gemini is missing.
    restartSetupIntro();
  }

  // Audio controls / voice settings (independent of API keys)
  try { initAudioControls(); } catch (error) {
    console.warn('[Olanga] initAudioControls failed:', error.message);
  }
  try { initVoiceSettings(); } catch (error) {
    console.warn('[Olanga] initVoiceSettings failed:', error.message);
  }

  if (minimizeBtn) {
    minimizeBtn.addEventListener('click', () => window.electronAPI.minimize());
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', () => window.electronAPI.close());
  }
  const titlebar = document.getElementById('titlebar');
  if (titlebar && window.electronAPI?.expandWindow) {
    titlebar.addEventListener('dblclick', () => window.electronAPI.expandWindow());
  }
  // Escape forces idle if TTS/listening gets stuck (blue/green orb).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (currentState === State.SPEAKING || currentState === State.LISTENING || currentState === State.THINKING) {
      try { if (typeof clearSpeakingWatchdog === 'function') clearSpeakingWatchdog(); } catch (_) {}
      try { if (currentTTSAudio) currentTTSAudio.pause(); } catch (_) {}
      currentTTSAudio = null;
      try { synthesis.cancel(); } catch (_) {}
      try { if (typeof cancelFollowUpWindow === 'function') cancelFollowUpWindow(); } catch (_) {}
      setState(State.IDLE);
    }
  });
  if (getKeyLink) {
    getKeyLink.addEventListener('click', () => {
      window.electronAPI.openExternal('https://aistudio.google.com/apikey');
    });
  }

  // Start clock + date
  setInterval(updateClock, 1000);
  updateClock();

  if (saveKeyBtn) saveKeyBtn.addEventListener('click', handleSaveKey);
  const setupForm = document.getElementById('setupForm');
  if (setupForm) {
    setupForm.addEventListener('submit', (e) => {
      e.preventDefault();
      handleSaveKey();
    });
  }
  if (apiKeyInput) {
    apiKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSaveKey();
    });
  }

  // Settings initialization helper
  window.loadSettingsValues = function() {
    try {
      renderKeyList();
      hydrateKeyInputs(apiKeys, nvidiaApiKey);
      const prefs = {
        city: userCity,
        state: userState,
        country: userCountry,
        ttsEngine,
        ttsRate,
        nvidiaVoice: nvidiaVoiceName,
        features: getEnabledFeatures(),
        keyRotation: apiKeyRotation,
        customWakeWordGroups,
        statusLightMode,
        statusLightSize
      };
      applyPrefsToSettingsUI(prefs);
    } catch (error) {
      console.warn('[Olanga] loadSettingsValues failed:', error.message);
    }
  };
  window.saveAppSettings = saveAppSettings;
  window.saveLocationSettings = saveAppSettings;

  if (addKeyBtn) addKeyBtn.addEventListener('click', handleAddKeyFromSettings);
  if (newKeyInput) {
    newKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAddKeyFromSettings();
    });
  }
  if (addNvidiaKeyBtn) {
    addNvidiaKeyBtn.addEventListener('click', () => {
      const nKey = nvidiaSettingsKeyInput.value.trim();
      nvidiaApiKey = nKey;
      persistNvidiaKey();
      if (typeof refreshVoiceCatalog === 'function') refreshVoiceCatalog();
    });
  }
  const viewIntroBtn = document.getElementById('viewIntroBtn');
  if (viewIntroBtn) {
    viewIntroBtn.addEventListener('click', playSetupIntroReplay);
  }

  const addWakeWordBtn = document.getElementById('addWakeWordBtn');
  if (addWakeWordBtn) {
    addWakeWordBtn.addEventListener('click', () => {
      if (typeof openWakeWordCaptureScreen === 'function') {
        openWakeWordCaptureScreen();
      }
    });
  }
  const statusLightModeBtn = document.getElementById('statusLightModeBtn');
  if (statusLightModeBtn) {
    statusLightModeBtn.addEventListener('click', cycleStatusLightMode);
  }
  const statusLightSizeBtn = document.getElementById('statusLightSizeBtn');
  if (statusLightSizeBtn) {
    statusLightSizeBtn.addEventListener('click', cycleStatusLightSize);
  }
  updateStatusLightModeButton();
  updateStatusLightSizeButton();
  if (window.electronAPI?.setStatusLightMode) {
    window.electronAPI.setStatusLightMode(statusLightMode);
  }
  if (window.electronAPI?.setStatusLightSize) {
    window.electronAPI.setStatusLightSize(statusLightSize);
  }
  const wakeCaptureContinueBtn = document.getElementById('wakeCaptureContinueBtn');
  if (wakeCaptureContinueBtn) {
    wakeCaptureContinueBtn.addEventListener('click', () => {
      if (typeof beginWakeWordRecording === 'function') beginWakeWordRecording();
    });
  }
  const wakeCaptureIntendedInput = document.getElementById('wakeCaptureIntendedInput');
  if (wakeCaptureIntendedInput) {
    wakeCaptureIntendedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && typeof beginWakeWordRecording === 'function') {
        beginWakeWordRecording();
      }
    });
  }
  const wakeCaptureCancelBtn = document.getElementById('wakeCaptureCancelBtn');
  if (wakeCaptureCancelBtn) {
    wakeCaptureCancelBtn.addEventListener('click', () => {
      if (typeof cancelWakeWordCapture === 'function') cancelWakeWordCapture();
    });
  }
  const wakeCaptureDoneBtn = document.getElementById('wakeCaptureDoneBtn');
  if (wakeCaptureDoneBtn) {
    wakeCaptureDoneBtn.addEventListener('click', () => {
      if (typeof finishWakeWordCapture === 'function') finishWakeWordCapture();
    });
  }
  renderCustomWakeWords();
  if (rotationToggle) {
    rotationToggle.addEventListener('change', scheduleSaveAppSettings);
  }

  // Auto-save on every settings change.
  for (const input of [cityInput, stateInput, countryInput]) {
    if (!input) continue;
    input.addEventListener('input', scheduleSaveAppSettings);
    input.addEventListener('change', scheduleSaveAppSettings);
  }
  if (ttsRateInput) {
    ttsRateInput.addEventListener('input', (e) => {
      ttsRate = Number.parseFloat(e.target.value);
      if (typeof updateTtsRateLabel === 'function') updateTtsRateLabel(ttsRate);
      scheduleSaveAppSettings();
    });
    ttsRateInput.addEventListener('change', scheduleSaveAppSettings);
  }
  if (ttsEngineSelect) {
    ttsEngineSelect.addEventListener('change', scheduleSaveAppSettings);
  }
  if (nvidiaVoiceSelect) {
    nvidiaVoiceSelect.addEventListener('change', scheduleSaveAppSettings);
  }

  nvidiaApiKey = nvidiaKey || nvidiaApiKey;
  if (nvidiaSettingsKeyInput) {
    nvidiaSettingsKeyInput.value = nvidiaApiKey;
  }
  // The hosted Magpie model resolves its own function ID. Remove the
  // obsolete legacy setting now that there is no UI for it.
  localStorage.removeItem('olanga_nvidia_function_id');

  applyPrefsToSettingsUI({
    city: userCity,
    state: userState,
    country: userCountry,
    ttsEngine,
    ttsRate,
    nvidiaVoice: nvidiaVoiceName,
    features: getEnabledFeatures(),
    keyRotation: apiKeyRotation
  });

  if (geminiKeys.length > 0) {
    apiKeys = geminiKeys;
    apiKey = apiKeys[0];
  }

  // Tasks bindings
  const tasksClearBtn = document.getElementById('tasksClearBtn');
  const taskInput = document.getElementById('taskInput');
  const addTaskBtn = document.getElementById('addTaskBtn');

  if (tasksClearBtn) {
    tasksClearBtn.addEventListener('click', clearAllTasks);
  }

  const handleManualAddTask = () => {
    const text = taskInput.value.trim();
    if (text) {
      addTask(text);
      taskInput.value = '';
    }
  };

  if (addTaskBtn) {
    addTaskBtn.addEventListener('click', handleManualAddTask);
  }

  if (taskInput) {
    taskInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleManualAddTask();
    });
  }

  // Load and render initial tasks
  loadTasks();
  renderTasks();

  // Timer widget bindings
  const timersClearBtn = document.getElementById('timersClearBtn');
  const timerInput = document.getElementById('timerInput');
  const addTimerBtn = document.getElementById('addTimerBtn');

  if (timersClearBtn) {
    timersClearBtn.addEventListener('click', clearAllTimers);
  }

  const handleManualAddTimer = () => {
    const raw = timerInput.value.trim();
    if (!raw) return;
    const seconds = parseTimerInput(raw);
    if (seconds > 0) {
      createTimer(seconds);
      timerInput.value = '';
    }
  };

  if (addTimerBtn) {
    addTimerBtn.addEventListener('click', handleManualAddTimer);
  }

  if (timerInput) {
    timerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleManualAddTimer();
    });
  }

  // Text Command bindings
  const textCommandInput = document.getElementById('textCommandInput');
  const textCommandBtn = document.getElementById('textCommandBtn');

  const handleTextCommand = () => {
    const text = textCommandInput.value.trim();
    if (text) {
      processTextCommandWithGemini(text);
      textCommandInput.value = '';
    }
  };

  if (textCommandBtn) {
    textCommandBtn.addEventListener('click', handleTextCommand);
  }

  if (textCommandInput) {
    textCommandInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleTextCommand();
    });
  }

  // Render initial timers (shows empty state)
  renderTimers();

  try {
    if (orbCanvas) {
      orbCanvasCtx = orbCanvas.getContext('2d');
      startOrbAnimation();
    }
  } catch (error) {
    console.warn('[Olanga] Orb animation failed to start:', error.message);
  }
  refreshVoiceCatalog();
}

// ============================================
// CORNER STATUS LIGHT MODE
// ============================================

const STATUS_LIGHT_MODE_ORDER = ['off', 'active', 'all'];
const STATUS_LIGHT_MODE_LABELS = {
  off: 'No Lights',
  active: 'No Constant Light',
  all: 'All Lights'
};
const STATUS_LIGHT_SIZE_ORDER = ['small', 'normal', 'large'];
const STATUS_LIGHT_SIZE_LABELS = {
  small: 'Small',
  normal: 'Normal',
  large: 'Large'
};

function updateStatusLightModeButton() {
  const btn = document.getElementById('statusLightModeBtn');
  if (!btn) return;
  const mode = STATUS_LIGHT_MODE_ORDER.includes(statusLightMode) ? statusLightMode : 'active';
  btn.textContent = STATUS_LIGHT_MODE_LABELS[mode] || STATUS_LIGHT_MODE_LABELS.active;
  btn.dataset.mode = mode;
}

function cycleStatusLightMode() {
  const current = STATUS_LIGHT_MODE_ORDER.includes(statusLightMode) ? statusLightMode : 'active';
  const next = STATUS_LIGHT_MODE_ORDER[(STATUS_LIGHT_MODE_ORDER.indexOf(current) + 1) % STATUS_LIGHT_MODE_ORDER.length];
  statusLightMode = next;
  localStorage.setItem('olanga_status_light_mode', statusLightMode);
  if (window.electronAPI?.setStatusLightMode) {
    window.electronAPI.setStatusLightMode(statusLightMode);
  }
  updateStatusLightModeButton();
  if (typeof scheduleSaveAppSettings === 'function') scheduleSaveAppSettings();
}

function updateStatusLightSizeButton() {
  const btn = document.getElementById('statusLightSizeBtn');
  if (!btn) return;
  const size = STATUS_LIGHT_SIZE_ORDER.includes(statusLightSize) ? statusLightSize : 'small';
  btn.textContent = STATUS_LIGHT_SIZE_LABELS[size] || STATUS_LIGHT_SIZE_LABELS.small;
  btn.dataset.size = size;
}

function cycleStatusLightSize() {
  const current = STATUS_LIGHT_SIZE_ORDER.includes(statusLightSize) ? statusLightSize : 'small';
  const next = STATUS_LIGHT_SIZE_ORDER[(STATUS_LIGHT_SIZE_ORDER.indexOf(current) + 1) % STATUS_LIGHT_SIZE_ORDER.length];
  statusLightSize = next;
  localStorage.setItem('olanga_status_light_size', statusLightSize);
  localStorage.setItem('olanga_status_light_size_v2', '1');
  if (window.electronAPI?.setStatusLightSize) {
    window.electronAPI.setStatusLightSize(statusLightSize);
  }
  updateStatusLightSizeButton();
  if (typeof scheduleSaveAppSettings === 'function') scheduleSaveAppSettings();
}

// ============================================
// CUSTOM WAKE WORDS (SETTINGS LIST)
// ============================================

function renderCustomWakeWords() {
  const presetList = document.getElementById('wakePresetList');
  const customList = document.getElementById('wakeCustomList');
  if (presetList) {
    presetList.innerHTML = `
      <div class="wake-word-row is-preset">
        <div class="wake-word-meta">
          <div class="wake-word-label">Hey Olanga (presets)</div>
          <div class="wake-word-phrases">${PRESET_WAKE_WORDS.join(' · ')}</div>
        </div>
        <span class="wake-word-badge">Locked</span>
      </div>
    `;
  }
  if (!customList) return;

  customList.innerHTML = '';
  if (!Array.isArray(customWakeWordGroups) || customWakeWordGroups.length === 0) {
    customList.innerHTML = '<div class="wake-empty">No custom wake words yet.</div>';
    return;
  }

  customWakeWordGroups.forEach((group) => {
    const row = document.createElement('div');
    row.className = 'wake-word-row';
    row.innerHTML = `
      <div class="wake-word-meta">
        <div class="wake-word-label">${escapeHTML(group.label || 'Custom')}</div>
        <div class="wake-word-phrases">${escapeHTML((group.phrases || []).join(' · '))}</div>
      </div>
      <button type="button" class="wake-word-remove" data-wake-id="${escapeHTML(group.id)}">Remove</button>
    `;
    customList.appendChild(row);
  });

  customList.querySelectorAll('.wake-word-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-wake-id');
      if (!id) return;
      removeCustomWakeWordGroup(id);
      if (typeof saveAppSettings === 'function') {
        saveAppSettings().catch(() => {});
      }
      renderCustomWakeWords();
    });
  });
}

// ============================================
// OPTIONAL FEATURE PANELS
// The voice assistant is the core product; Notepad, News, and Terminal
// are opt-in panels toggled from Settings (off by default).
// ============================================

function getEnabledFeatures() {
  try {
    const stored = JSON.parse(localStorage.getItem(FEATURES_STORAGE_KEY) || '[]');
    return Array.isArray(stored) ? stored.filter(f => OPTIONAL_FEATURES.includes(f)) : [];
  } catch {
    return [];
  }
}

function setFeatureEnabled(feature, enabled) {
  const current = getEnabledFeatures();
  const next = enabled
    ? [...new Set([...current, feature])]
    : current.filter(f => f !== feature);
  localStorage.setItem(FEATURES_STORAGE_KEY, JSON.stringify(next));
  applyFeatureToggles();
  // Durable save (localStorage + secure store).
  if (typeof scheduleSaveAppSettings === 'function') {
    scheduleSaveAppSettings();
  } else if (typeof saveAppSettings === 'function') {
    saveAppSettings();
  }
}

function applyFeatureToggles() {
  const enabled = getEnabledFeatures();

  document.querySelectorAll('.floating-icon').forEach((icon) => {
    const target = icon.getAttribute('data-screen');
    if (!OPTIONAL_FEATURES.includes(target)) return;

    const isEnabled = enabled.includes(target);
    icon.style.display = isEnabled ? '' : 'none';

    // If the user disabled the panel they're currently viewing, go home.
    if (!isEnabled && icon.classList.contains('active')) {
      const homeIcon = document.querySelector('.floating-icon[data-screen="mainScreen"]');
      if (homeIcon) homeIcon.click();
    }
  });

  // Sync the settings checkboxes.
  document.querySelectorAll('input[data-feature]').forEach((toggle) => {
    toggle.checked = enabled.includes(toggle.getAttribute('data-feature'));
  });
}

function initFeatureToggles() {
  document.querySelectorAll('input[data-feature]').forEach((toggle) => {
    toggle.addEventListener('change', (e) => {
      setFeatureEnabled(toggle.getAttribute('data-feature'), e.target.checked);
    });
  });
  applyFeatureToggles();
}

// ============================================
// FLOATING ICONS NAVIGATION
// ============================================

const floatingIcons = document.querySelectorAll('.floating-icon');
const notepadScreen = document.getElementById('notepadScreen');
const newsScreen = document.getElementById('newsScreen');
const terminalScreen = document.getElementById('terminalScreen');
const settingsScreen = document.getElementById('settingsScreen');

const screens = {
  mainScreen,
  notepadScreen,
  newsScreen,
  terminalScreen,
  settingsScreen
};

floatingIcons.forEach(icon => {
  icon.addEventListener('click', () => {
    const targetScreen = icon.getAttribute('data-screen');

    // Update active state
    floatingIcons.forEach(i => i.classList.remove('active'));
    icon.classList.add('active');

    // Persist location before leaving Settings (in case blur didn't fire).
    if (window.saveLocationSettings) {
      window.saveLocationSettings();
    }

    if (typeof isWakeWordCapturing !== 'undefined' && isWakeWordCapturing
        && typeof cancelWakeWordCapture === 'function') {
      cancelWakeWordCapture({ returnToSettings: false });
    }

    // Show target screen
    Object.keys(screens).forEach(key => {
      if (screens[key]) {
        screens[key].classList.add('hidden');
      }
    });
    const wakeCaptureScreen = document.getElementById('wakeWordCaptureScreen');
    if (wakeCaptureScreen) wakeCaptureScreen.classList.add('hidden');

    if (screens[targetScreen]) {
      screens[targetScreen].classList.remove('hidden');
    }

    // Load settings values dynamically when navigating to the settings screen
    if (targetScreen === 'settingsScreen' && window.loadSettingsValues) {
      window.loadSettingsValues();
    }
    if (targetScreen === 'newsScreen') {
      loadNewsBrief().catch((error) => {
        console.warn('[Olanga] Failed to open news brief:', error.message);
      });
    }
  });
});

// ---- Boot ----
document.addEventListener('DOMContentLoaded', () => {
  initFeatureToggles();
  init().catch((error) => {
    console.error('[Olanga] Initialization failed:', error);
    showError(`Initialization failed: ${error.message}`);
  });
});
