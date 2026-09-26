/* ============================================
   OLANGA — SETTINGS, API KEYS, INITIALIZATION, NAVIGATION

   API keys are stored encrypted at rest via the main process
   (Electron safeStorage). Keys previously stored in plaintext
   localStorage are migrated on first launch.
   ============================================ */

const GEMINI_KEYS_STORE = 'gemini_api_keys';
const NVIDIA_KEY_STORE = 'nvidia_api_key';
const APP_PREFS_STORE = 'app_preferences';
const OPTIONAL_FEATURES = OlangaPrefs.OPTIONAL_FEATURES;

let settingsSaveTimer = null;
let savingSettingsGeminiKey = false;
let speechInputChangeVersion = 0;
let runtimeFeatures = null;
// Read by the Workspace health check. `value` is the last shortcut requested.
let pushToTalkStatus = { value: 'off', label: 'Off', registered: false };
let pushToTalkRequest = 0;

function renderPushToTalkStatus() {
  const status = document.getElementById('pushToTalkStatus');
  if (!status) return;
  const { value, label, registered, pending } = pushToTalkStatus;
  status.dataset.state = value === 'off' || pending ? '' : registered ? 'success' : 'error';
  status.textContent = value === 'off' ? 'Off. Choose a shortcut to talk without saying the wake word.'
    : pending ? `Setting up ${label}…`
      : registered ? `Press ${label} anywhere to talk. Press it again to send right away.`
        : `${label} is already used by another app. Choose a different shortcut.`;
}

// Registration happens in the main process; only an actual change (or an
// explicit selection) asks Windows again.
async function applyPushToTalk(value, force = false) {
  const next = OlangaShortcuts.VALUES.includes(value) ? value : 'off';
  if (!force && next === pushToTalkStatus.value) { renderPushToTalkStatus(); return; }
  const request = ++pushToTalkRequest;
  pushToTalkStatus = { value: next, label: OlangaShortcuts.label(next), registered: false, pending: next !== 'off' };
  renderPushToTalkStatus();
  let registered = false;
  try { registered = !!(await window.electronAPI?.setPushToTalk?.(next))?.registered; } catch (error) { console.warn('[Olanga] Push-to-talk shortcut unavailable:', error.message); }
  if (request !== pushToTalkRequest) return;
  pushToTalkStatus = { value: next, label: OlangaShortcuts.label(next), registered };
  renderPushToTalkStatus();
}

function readPrefsFromLocalStorage() {
  return {
    ...OlangaPrefs.load(localStorage),
    // Runtime holds the authoritative copy of these two.
    customWakeWordGroups: Array.isArray(customWakeWordGroups) ? customWakeWordGroups : [],
    statusLightMode: OlangaStatusLight.normalizeMode(statusLightMode),
    statusLightSize: OlangaStatusLight.normalizeSize(statusLightSize),
    quickActions
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

  return {
    ...OlangaPrefs.sanitize({
      city: cityInput?.value,
      state: stateInput?.value,
      country: countryInput?.value,
      ttsEngine: ttsEngineSelect?.value || ttsEngine,
      ttsRate: ttsRateInput?.value || ttsRate,
      nvidiaVoice: nvidiaVoiceSelect?.value || nvidiaVoiceName,
      features,
      keyRotation: !!(rotationToggle?.checked),
      statusLightMode,
      statusLightSize,
      quickActions,
      bargeIn: document.getElementById('bargeInToggle')?.checked ?? bargeInEnabled,
      streamReplies: document.getElementById('streamRepliesToggle')?.checked ?? streamRepliesEnabled,
      endOfSpeech: document.getElementById('endOfSpeechSelect')?.value || endOfSpeechKey(),
      pushToTalk: document.getElementById('pushToTalkSelect')?.value || pushToTalkStatus.value,
      statusLightSizeV2: true
    }),
    customWakeWordGroups: Array.isArray(customWakeWordGroups) ? customWakeWordGroups : []
  };
}

function writePrefsToLocalStorage(prefs) {
  try {
  const clean = OlangaPrefs.applyMigrations(prefs);
  OlangaPrefs.writeToStorage(localStorage, clean);
  statusLightMode = clean.statusLightMode;
  statusLightSize = clean.statusLightSize;
  quickActions = clean.quickActions;
  if (Array.isArray(prefs.customWakeWordGroups)) {
    customWakeWordGroups = prefs.customWakeWordGroups;
    persistCustomWakeWordGroups();
  }
  return true;
  } catch (error) { console.warn('[Olanga] Could not update local preferences:', error.message); return false; }
}

function endOfSpeechKey() {
  return Object.keys(OlangaPrefs.END_OF_SPEECH_MS).find(key => OlangaPrefs.END_OF_SPEECH_MS[key] === endOfSpeechMs) || 'standard';
}

function applyPrefsToRuntime(prefs) {
  const clean = OlangaPrefs.applyMigrations(prefs);
  bargeInEnabled = clean.bargeIn;
  streamRepliesEnabled = clean.streamReplies;
  endOfSpeechMs = OlangaPrefs.END_OF_SPEECH_MS[clean.endOfSpeech] || SILENCE_DURATION;
  applyPushToTalk(clean.pushToTalk);
  runtimeFeatures = [...clean.features];
  userCity = clean.city;
  userState = clean.state;
  userCountry = clean.country;
  ttsEngine = clean.ttsEngine;
  ttsRate = clean.ttsRate;
  nvidiaVoiceName = clean.nvidiaVoice;
  if (typeof ALLOWED_ENGLISH_VOICE_IDS !== 'undefined' && !ALLOWED_ENGLISH_VOICE_IDS.has(nvidiaVoiceName)) {
    nvidiaVoiceName = defaultNvidiaVoiceName;
  }
  apiKeyRotation = clean.keyRotation;

  statusLightMode = clean.statusLightMode;
  statusLightSize = clean.statusLightSize;
  try { OlangaPrefs.writeToStorage(localStorage, clean, ['statusLightMode', 'statusLightSize']); } catch (_) {}
  window.electronAPI?.setStatusLightMode?.(statusLightMode);
  window.electronAPI?.setStatusLightSize?.(statusLightSize);
  quickActions = clean.quickActions;
  window.electronAPI?.setQuickActions?.(quickActions);

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
    try { persistCustomWakeWordGroups(); } catch (_) {}
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
  const bargeInToggle = document.getElementById('bargeInToggle');
  if (bargeInToggle && typeof prefs.bargeIn === 'boolean') bargeInToggle.checked = prefs.bargeIn;
  const streamRepliesToggle = document.getElementById('streamRepliesToggle');
  if (streamRepliesToggle && typeof prefs.streamReplies === 'boolean') streamRepliesToggle.checked = prefs.streamReplies;
  const endOfSpeechSelect = document.getElementById('endOfSpeechSelect');
  if (endOfSpeechSelect && prefs.endOfSpeech) endOfSpeechSelect.value = prefs.endOfSpeech;
  const pushToTalkSelect = document.getElementById('pushToTalkSelect');
  if (pushToTalkSelect && prefs.pushToTalk) pushToTalkSelect.value = prefs.pushToTalk;
  renderPushToTalkStatus();
  if (typeof applyFeatureToggles === 'function') applyFeatureToggles();
  if (typeof renderCustomWakeWords === 'function') renderCustomWakeWords();
  if (typeof updateStatusLightModeButton === 'function') updateStatusLightModeButton();
  if (typeof updateStatusLightSizeButton === 'function') updateStatusLightSizeButton();
  renderQuickActionsEditor();
}

function scheduleSaveAppSettings() {
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = null;
    saveAppSettings();
  }, 150);
}

async function persistAppPreferences(prefs) {
  try {
    if (window.electronAPI?.secureStoreSet) {
      await window.electronAPI.secureStoreSet(APP_PREFS_STORE, JSON.stringify(prefs));
      writePrefsToLocalStorage(prefs);
    } else if (!writePrefsToLocalStorage(prefs)) {
      throw new Error('Preferences could not be saved.');
    }
  } catch (error) {
    console.warn('[Olanga] Secure prefs save failed:', error.message);
    throw error;
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
            ...OlangaPrefs.merge(prefs, parsed),
            customWakeWordGroups: Array.isArray(parsed.customWakeWordGroups)
              ? parsed.customWakeWordGroups
              : prefs.customWakeWordGroups
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
    showError('Your settings could not be saved. Keep Olanga open and try again.');
    return false;
  }
}

async function persistGeminiKeys(keys = apiKeys) {
  let payload;
  try { payload = JSON.stringify(OlangaGeminiKeys.validateCandidateKeys(keys)); }
  catch (error) { showError(error.message); return false; }
  try {
    if (!window.electronAPI?.secureStoreSet) throw new Error('Secure storage unavailable');
    await window.electronAPI.secureStoreSet(GEMINI_KEYS_STORE, payload);
    removeLegacyKeys(['olanga_api_keys', 'olanga_api_key']);
    return true;
  } catch (error) {
    console.warn('[Olanga] Secure storage unavailable for Gemini keys:', error.message);
    showError('Could not securely save your Gemini key. It cannot be used until securely saved; try saving again.');
    return false;
  }
}

async function persistNvidiaKey(candidate = nvidiaApiKey) {
  try {
    const value = OlangaNvidiaKey.normalizeNvidiaKey(String(candidate || ''));
    if (!window.electronAPI?.secureStoreSet) throw new Error('Secure storage unavailable');
    await window.electronAPI.secureStoreSet(NVIDIA_KEY_STORE, value);
    nvidiaApiKey = value;
    removeLegacyKeys(['olanga_nvidia_key']);
    return true;
  } catch (error) {
    console.warn('[Olanga] Secure storage unavailable for NVIDIA key:', error.message);
    showError('Could not securely save your NVIDIA key. Try saving again.');
    return false;
  }
}
function removeLegacyKeys(names) {
  try { for (const name of names) localStorage.removeItem(name); }
  catch (error) { console.warn('[Olanga] Secure save succeeded, but old browser storage could not be cleared:', error.message); }
}

let nvidiaConnectionCheckRunning = false;
async function saveAndTestNvidiaKey() {
  if (nvidiaConnectionCheckRunning) return;
  const status = document.getElementById('nvidiaConnectionStatus');
  nvidiaConnectionCheckRunning = true;
  addNvidiaKeyBtn.disabled = true;
  try {
    const key = OlangaNvidiaKey.normalizeNvidiaKey(nvidiaSettingsKeyInput.value);
    if (key && apiKeys.includes(key)) throw new Error('This is already saved as a Gemini key. Magpie needs a separate NVIDIA key.');
    if (!await persistNvidiaKey(key)) throw new Error('The Magpie key could not be saved.');
    if (typeof nvidiaKeyInput !== 'undefined' && nvidiaKeyInput) nvidiaKeyInput.value = nvidiaApiKey;
    if (!key) { status.textContent = 'Magpie key removed. Gemini and the Windows voice still work.'; status.dataset.state = ''; return; }
    status.textContent = 'Key saved. Checking Magpie voice…'; status.dataset.state = '';
    const result = await window.electronAPI.nvidiaTtsSynthesize({ text: 'Magpie voice connection is ready.' });
    if (!result?.audioBase64) throw new Error('Magpie returned no audio.');
    status.textContent = 'Magpie returned audio successfully. Gemini is used for all reasoning and responses.'; status.dataset.state = 'success';
    if (typeof refreshVoiceCatalog === 'function') refreshVoiceCatalog();
  } catch (error) { status.textContent = error.message || 'Magpie connection failed. Gemini is unaffected.'; status.dataset.state = 'error'; }
  finally { nvidiaConnectionCheckRunning = false; addNvidiaKeyBtn.disabled = false; }
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
  const validKeys = OlangaGeminiKeys.normalizeSavedKeys;
  let storedKeys = [], secureRead = false, secureKeysPresent = false, secureKeysValid = false;
  try {
    const raw = await window.electronAPI.secureStoreGet(GEMINI_KEYS_STORE);
    secureRead = true;
    secureKeysPresent = raw != null;
    if (secureKeysPresent) {
      const parsed = raw === '' ? [] : JSON.parse(raw);
      if (!Array.isArray(parsed) && typeof parsed !== 'string') throw new Error('The secure Gemini entry is invalid.');
      storedKeys = validKeys(parsed);
      if ((Array.isArray(parsed) ? parsed.length : parsed.trim().length) && !storedKeys.length) throw new Error('The secure Gemini entry contains no readable keys.');
      secureKeysValid = true;
    }
  } catch (error) { console.warn('[Olanga] Failed to read secure Gemini keys:', error.message); }

  // An explicitly empty secure entry represents a deletion. Do not resurrect
  // old plaintext credentials, or replace an unreadable secure entry.
  if (secureRead && !secureKeysPresent) {
    try {
      let legacy = [];
      const raw = localStorage.getItem('olanga_api_keys');
      if (raw) {
        try { legacy = validKeys(JSON.parse(raw)); }
        catch (error) { console.warn('[Olanga] Legacy Gemini list could not be read:', error.message); }
      }
      if (!legacy.length) legacy = validKeys(localStorage.getItem('olanga_api_key'));
      if (legacy.length && await persistGeminiKeys(legacy)) storedKeys = legacy;
    } catch (error) { console.warn('[Olanga] Failed to migrate Gemini keys:', error.message); }
  }
  apiKeys = storedKeys;
  apiKey = storedKeys[0] || '';
  currentKeyIndex = 0;
  if (secureRead && secureKeysPresent && secureKeysValid) removeLegacyKeys(['olanga_api_keys', 'olanga_api_key']);

  let storedNvidiaKey = '';
  try {
    const raw = await window.electronAPI.secureStoreGet(NVIDIA_KEY_STORE);
    if (typeof raw === 'string') {
      storedNvidiaKey = raw;
      removeLegacyKeys(['olanga_nvidia_key']);
    } else if (raw == null) {
      const legacy = localStorage.getItem('olanga_nvidia_key') || '';
      if (legacy && await persistNvidiaKey(legacy)) storedNvidiaKey = nvidiaApiKey;
    }
  } catch (error) { console.warn('[Olanga] Failed to load Magpie key:', error.message); }
  nvidiaApiKey = storedNvidiaKey;
  return { geminiKeys: storedKeys, nvidiaKey: storedNvidiaKey };
}

// ---- API Key Setup ----
async function handleSaveKey() {
  if (savingSettingsGeminiKey) return;
  const key = apiKeyInput.value.trim();
  const nKey = nvidiaKeyInput.value.trim();
  if (!key) {
    showError('Please enter your Gemini API key');
    return;
  }
  savingSettingsGeminiKey = true;
  if (saveKeyBtn) saveKeyBtn.disabled = true;
  try {
  const keys = apiKeys.includes(key) ? [...apiKeys] : [...apiKeys, key];
  if (!await persistGeminiKeys(keys)) return;
  apiKeys = keys;
  apiKey = key;
  currentKeyIndex = keys.indexOf(key);

  if (nKey) {
    if (!await persistNvidiaKey(nKey)) return;
    if (nvidiaSettingsKeyInput) nvidiaSettingsKeyInput.value = nvidiaApiKey;
    refreshVoiceCatalog();
  }
  if (setupScreen) setupScreen.classList.remove('setup-first-launch');
  showMainScreen();
  } finally { savingSettingsGeminiKey = false; if (saveKeyBtn) saveKeyBtn.disabled = false; }
}

async function handleAddKeyFromSettings() {
  const key = newKeyInput.value.trim();
  if (!key || savingSettingsGeminiKey) return;
  savingSettingsGeminiKey = true;
  if (addKeyBtn) addKeyBtn.disabled = true;
  try {
    const keys = apiKeys.includes(key) ? [...apiKeys] : [...apiKeys, key];
    if (!await persistGeminiKeys(keys)) return;
    const firstKey = !apiKey;
    apiKeys = keys;
    if (firstKey) { apiKey = key; currentKeyIndex = apiKeys.indexOf(key); }
    if (newKeyInput.value.trim() === key) newKeyInput.value = '';
    renderKeyList();
    // A keyless local setup has never started the wake word or microphone.
    if (firstKey && !micStream) { await initVosk(); if (apiKey && !micStream) await initMicrophone(); }
  } catch (error) {
    showError(error.message || 'Could not initialize voice input.');
  } finally {
    savingSettingsGeminiKey = false;
    if (addKeyBtn) addKeyBtn.disabled = false;
  }
}

async function changeSpeechInput(select) {
  const version = ++speechInputChangeVersion;
  try {
    window.OlangaWorkspace.preference('speechInput', select.value);
    if (!micStream && (apiKey || select.value !== 'cloud')) {
      await initVosk();
      if (version !== speechInputChangeVersion) return;
      // Recheck after model loading: keyless cloud input does not need a mic.
      if (apiKey || window.OlangaWorkspace.snapshot().speechInput !== 'cloud') await initMicrophone();
    }
  } catch (error) {
    if (version !== speechInputChangeVersion) return;
    select.value = window.OlangaWorkspace.snapshot().speechInput;
    showError(error.message);
  }
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
        <button class="key-btn select" data-key-index="${i}">Select</button>
        <button class="key-btn delete" data-key-index="${i}">Del</button>
      </div>
    `;
    keyListContainer.appendChild(div);
  });

  // Bind actions
  keyListContainer.querySelectorAll('.select').forEach(b => {
    b.addEventListener('click', (e) => {
      if (savingSettingsGeminiKey) return;
      apiKey = apiKeys[Number(e.currentTarget.dataset.keyIndex)] || '';
      currentKeyIndex = apiKeys.indexOf(apiKey);
      renderKeyList();
    });
  });
  keyListContainer.querySelectorAll('.delete').forEach(b => {
    b.addEventListener('click', (e) => removeGeminiKey(Number(e.currentTarget.dataset.keyIndex)));
  });
}
async function removeGeminiKey(index) {
  if (savingSettingsGeminiKey || !Number.isInteger(index) || !apiKeys[index]) return;
  savingSettingsGeminiKey = true;
  try {
    const removed = apiKeys[index];
    const keys = apiKeys.filter((_, i) => i !== index);
    if (!await persistGeminiKeys(keys)) return;
    apiKeys = keys;
    if (apiKey === removed) apiKey = keys[0] || '';
    currentKeyIndex = Math.max(0, keys.indexOf(apiKey));
    renderKeyList();
  } finally { savingSettingsGeminiKey = false; }
}

// ---- Initialize ----
function hasCompletedLocalSetup() {
  try { return localStorage.getItem('olanga_local_setup') === 'true'; } catch (_) { return false; }
}
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
  } else if (hasCompletedLocalSetup()) {
    showMainScreen({ voice: window.OlangaWorkspace?.snapshot().speechInput !== 'cloud' });
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
    if (typeof cancelAssistantRequest === 'function') cancelAssistantRequest();
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
  document.getElementById('startLocalBtn')?.addEventListener('click', () => {
    try { localStorage.setItem('olanga_local_setup', 'true'); } catch (_) {}
    showMainScreen({ voice: false });
  });
  const speechInputSelect = document.getElementById('speechInputSelect');
  if (speechInputSelect && window.OlangaWorkspace) {
    speechInputSelect.value = window.OlangaWorkspace.snapshot().speechInput;
    speechInputSelect.addEventListener('change', () => changeSpeechInput(speechInputSelect));
  }
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
        statusLightSize,
        bargeIn: bargeInEnabled,
        streamReplies: streamRepliesEnabled,
        endOfSpeech: endOfSpeechKey(),
        pushToTalk: pushToTalkStatus.value
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
    addNvidiaKeyBtn.addEventListener('click', saveAndTestNvidiaKey);
  }
  document.getElementById('getNvidiaKeyBtn')?.addEventListener('click', () => window.electronAPI.openExternal('https://build.nvidia.com/settings/api-keys'));
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
  renderQuickActionsEditor();
  document.getElementById('resetQuickActionsBtn')?.addEventListener('click', () => {
    quickActions = OlangaQuickActions.normalizeQuickActions();
    renderQuickActionsEditor();
    scheduleSaveAppSettings();
  });
  window.electronAPI?.onQuickAction?.((action) => {
    const slot = OlangaQuickActions.getQuickAction(quickActions, action?.id);
    if (!slot) return;
    const home = document.querySelector('.floating-icon[data-screen="mainScreen"]');
    home?.click();
    if (currentState !== State.IDLE || window.OlangaDesktop?.isBusy?.()) {
      const input = document.getElementById('textCommandInput');
      if (input) { input.value = slot.prompt; input.focus(); }
      showError('Finish or cancel the current task, then send this shortcut.');
      return;
    }
    processTextCommandWithGemini(slot.prompt);
  });
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
  initOpenAtLoginToggle();

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
  document.getElementById('bargeInToggle')?.addEventListener('change', scheduleSaveAppSettings);
  document.getElementById('streamRepliesToggle')?.addEventListener('change', scheduleSaveAppSettings);
  // Typing is a strong hint that a request is coming; warm the connection.
  document.getElementById('textCommandInput')?.addEventListener('focus', () => warmProviderConnection());
  document.getElementById('endOfSpeechSelect')?.addEventListener('change', scheduleSaveAppSettings);
  const pushToTalkSelect = document.getElementById('pushToTalkSelect');
  if (pushToTalkSelect) {
    pushToTalkSelect.replaceChildren(...OlangaShortcuts.PUSH_TO_TALK.map(({ value, label }) => Object.assign(document.createElement('option'), { value, textContent: label })));
    pushToTalkSelect.value = pushToTalkStatus.value;
    pushToTalkSelect.addEventListener('change', () => {
      applyPushToTalk(pushToTalkSelect.value, true);
      scheduleSaveAppSettings();
    });
  }
  window.electronAPI?.onPushToTalk?.(() => handlePushToTalk());

  nvidiaApiKey = nvidiaKey || nvidiaApiKey;
  if (nvidiaSettingsKeyInput) {
    nvidiaSettingsKeyInput.value = nvidiaApiKey;
  }
  // The hosted Magpie model resolves its own function ID. Remove the
  // obsolete legacy setting now that there is no UI for it.
  removeLegacyKeys(['olanga_nvidia_function_id']);

  applyPrefsToSettingsUI({
    city: userCity,
    state: userState,
    country: userCountry,
    ttsEngine,
    ttsRate,
    nvidiaVoice: nvidiaVoiceName,
    features: getEnabledFeatures(),
    keyRotation: apiKeyRotation,
    bargeIn: bargeInEnabled,
    streamReplies: streamRepliesEnabled,
    endOfSpeech: endOfSpeechKey(),
    pushToTalk: pushToTalkStatus.value
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
      if (addTask(text).ok) taskInput.value = '';
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
      if (createTimer(seconds).ok) timerInput.value = '';
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

  // Restore deadlines, including timers that expired while Olanga was closed.
  loadTimers();

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

// Windows owns the login-item state, so the checkbox mirrors the OS rather
// than a stored preference.
async function initOpenAtLoginToggle() {
  const toggle = document.getElementById('openAtLoginToggle');
  if (!toggle) return;

  if (!window.electronAPI?.getOpenAtLogin) {
    applyOpenAtLoginState(toggle, { supported: false, enabled: false });
    return;
  }

  try {
    applyOpenAtLoginState(toggle, await window.electronAPI.getOpenAtLogin());
  } catch (error) {
    console.warn('[Olanga] Could not read launch-at-login state:', error.message);
  }

  toggle.addEventListener('change', async () => {
    try {
      applyOpenAtLoginState(toggle, await window.electronAPI.setOpenAtLogin(toggle.checked));
    } catch (error) {
      console.warn('[Olanga] Could not change launch-at-login:', error.message);
    }
  });
}

function applyOpenAtLoginState(toggle, state) {
  const supported = !!state?.supported;
  toggle.checked = !!state?.enabled;
  toggle.disabled = !supported;
  const row = toggle.closest('.rotation-toggle-row');
  if (row) {
    row.title = supported ? '' : 'Available once Olanga is installed (not in npm start).';
    row.style.opacity = supported ? '' : '0.55';
  }
}

function updateStatusLightModeButton() {
  const btn = document.getElementById('statusLightModeBtn');
  if (!btn) return;
  const mode = OlangaStatusLight.normalizeMode(statusLightMode);
  btn.textContent = OlangaStatusLight.MODE_LABELS[mode];
  btn.dataset.mode = mode;
}

function cycleStatusLightMode() {
  statusLightMode = OlangaStatusLight.nextMode(statusLightMode);
  try { OlangaPrefs.writeToStorage(localStorage, { statusLightMode }, ['statusLightMode']); } catch (_) {}
  if (window.electronAPI?.setStatusLightMode) {
    window.electronAPI.setStatusLightMode(statusLightMode);
  }
  updateStatusLightModeButton();
  if (typeof scheduleSaveAppSettings === 'function') scheduleSaveAppSettings();
}

function updateStatusLightSizeButton() {
  const btn = document.getElementById('statusLightSizeBtn');
  if (!btn) return;
  const size = OlangaStatusLight.normalizeSize(statusLightSize);
  btn.textContent = OlangaStatusLight.SIZE_LABELS[size];
  btn.dataset.size = size;
}

function cycleStatusLightSize() {
  statusLightSize = OlangaStatusLight.nextSize(statusLightSize);
  try { OlangaPrefs.writeToStorage(
    localStorage,
    { statusLightSize, statusLightSizeV2: true },
    ['statusLightSize']
  ); } catch (_) {}
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
      try { removeCustomWakeWordGroup(id); } catch (error) { showError('The wake word could not be removed. Please try again.'); return; }
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
  return runtimeFeatures ? [...runtimeFeatures] : OlangaPrefs.readFromStorage(localStorage).features;
}

function setFeatureEnabled(feature, enabled) {
  const current = getEnabledFeatures();
  const next = enabled
    ? [...new Set([...current, feature])]
    : current.filter(f => f !== feature);
  runtimeFeatures = next;
  try { OlangaPrefs.writeToStorage(localStorage, { features: next }, ['features']); } catch (_) {}
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

// The editor stores requests as data; a shortcut never contains executable code.
function renderQuickActionsEditor() {
  const container = document.getElementById('quickActionsEditor');
  if (!container || container.contains(document.activeElement)) return;
  container.replaceChildren();
  OlangaQuickActions.normalizeQuickActions(quickActions).forEach((slot, index) => {
    const row = document.createElement('fieldset');
    row.className = 'quick-action-editor';
    const legend = document.createElement('legend');
    legend.textContent = `Shortcut ${index + 1}`;
    row.appendChild(legend);
    for (const [key, caption, maximum] of [
      ['label', 'Name', OlangaQuickActions.LABEL_MAX_LENGTH],
      ['prompt', 'Request', OlangaQuickActions.PROMPT_MAX_LENGTH]
    ]) {
      const label = document.createElement('label');
      label.textContent = caption;
      const input = document.createElement(key === 'prompt' ? 'textarea' : 'input');
      input.id = `quick-action-${index}-${key}`;
      label.htmlFor = input.id;
      input.maxLength = maximum;
      input.value = slot[key];
      if (key === 'prompt') input.rows = 2;
      input.addEventListener('change', async () => {
        quickActions[index] = { ...quickActions[index], [key]: input.value };
        quickActions = OlangaQuickActions.normalizeQuickActions(quickActions);
        input.value = quickActions[index][key];
        const saved = await saveAppSettings();
        const status = document.getElementById('quickActionsSaveStatus');
        if (status) status.textContent = saved ? 'Shortcuts saved.' : 'Could not save shortcuts.';
      });
      row.append(label, input);
    }
    container.appendChild(row);
  });
}
