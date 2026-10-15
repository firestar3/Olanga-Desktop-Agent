/* Explicit, guided checks reuse the existing audio graph. This view never
   requests microphone access, opens a provider, or dispatches an assistant action. */
(() => {
  'use strict';
  const panel = document.getElementById('settingsPanelCore'), screen = document.getElementById('settingsScreen');
  if (!panel || !screen) return;
  const section = document.createElement('section'); section.id = 'audioSetupSection'; section.className = 'settings-section';
  section.setAttribute('aria-labelledby', 'audioSetupHeading');
  section.innerHTML = `<h3 id="audioSetupHeading">Audio setup</h3>
    <p class="settings-hint">Choose your microphone, check the input, then listen to a reply. These checks run only when you choose them.</p>
    <div class="voice-settings-grid"><div class="voice-settings-row full-width"><label for="audioSetupDevice">Microphone</label>
    <select id="audioSetupDevice" aria-describedby="audioSetupDeviceStatus"><option value="">Windows default microphone</option></select>
    <p id="audioSetupDeviceStatus" class="settings-hint" role="status">Refresh to list microphones. This does not turn the microphone on.</p></div>
    <div class="voice-settings-row full-width" id="audioSetupLevelRow"><label for="audioSetupLevel">Input level</label><meter id="audioSetupLevel" min="0" max="100" value="0" aria-describedby="audioSetupLevelStatus"></meter>
    <p id="audioSetupLevelStatus" class="settings-hint">The microphone is off.</p></div></div>
    <div class="audio-setup-actions"><button type="button" class="settings-text-link" id="audioSetupRefresh">Refresh devices</button><button type="button" class="settings-text-link" id="audioSetupPhrase">Check a spoken phrase</button><button type="button" class="settings-text-link" id="audioSetupReply">Play a reply sample</button></div>
    <p class="settings-hint settings-hint-after">For the phrase check, say “Olanga audio check”. Recognition stays on this device and never runs a command. A reply sample uses your selected voice; Magpie sends the sample text to NVIDIA.</p>
    <p id="audioSetupStatus" class="settings-hint settings-hint-after" role="status" aria-live="polite">No audio checks have been run this session.</p>`;
  const speech = document.getElementById('speechSettingsHeading')?.closest('section');
  if (speech) speech.after(section); else panel.append(section);
  const $ = id => section.querySelector('#' + id), device = $('audioSetupDevice'), refreshButton = $('audioSetupRefresh'), phraseButton = $('audioSetupPhrase'), replyButton = $('audioSetupReply'), status = $('audioSetupStatus'), meter = $('audioSetupLevel'), levelRow = $('audioSetupLevelRow');
  let phrase = null, reply = null, timer = null, busy = false, deviceSequence = 0, disposed = false;
  const api = () => window.OlangaAudioInput;
  const engine = () => typeof ttsEngine === 'string' ? ttsEngine : document.getElementById('ttsEngineSelect')?.value || 'windows';
  const current = () => { try { return api()?.snapshot?.() || {}; } catch (_) { return {}; } };
  const visible = () => !disposed && !document.hidden && !screen.classList.contains('hidden') && !panel.hidden && (window.OlangaVisibility?.isVisible?.() ?? true);
  const announce = (text, error = false) => { status.textContent = text; status.dataset.state = error ? 'error' : ''; };
  function render() {
    const state = current();
    if (!busy) {
      const saved = state.preferredDeviceId === 'default' ? '' : state.preferredDeviceId || '';
      if (saved && ![...device.options].some(option => option.value === saved)) { const option = document.createElement('option'); option.value = saved; option.textContent = state.label || 'Saved microphone'; device.append(option); }
      device.value = saved;
    }
    meter.value = state.active && !state.muted && Number.isFinite(state.level) ? Math.max(0, Math.min(100, state.level)) : 0;
    levelRow.hidden = !visible();
    $('audioSetupLevelStatus').textContent = state.muted ? 'The microphone is muted. Unmute on the home screen to check it.'
      : !state.active ? 'The microphone is off. Enable voice input on the home screen to check it.'
        : state.modelReady === false ? 'Microphone active. The local speech model is still loading.'
          : 'Microphone active. Speak normally and watch for a changing level.';
    phraseButton.disabled = busy || !api()?.testPhrase || !state.active || !!state.muted || state.modelReady === false;
    replyButton.disabled = busy || !api()?.testReply;
    refreshButton.disabled = busy || !api()?.devices;
    device.disabled = busy || !api()?.choose;
  }
  function refreshVisibility() {
    if (visible()) { render(); if (!timer) timer = setInterval(render, 250); }
    else { if (timer) clearInterval(timer); timer = null; meter.value = 0; levelRow.hidden = true; }
  }
  async function refreshDevices() {
    if (!api()?.devices || busy) return;
    const sequence = ++deviceSequence; refreshButton.disabled = true;
    try {
      const items = await api().devices();
      if (sequence !== deviceSequence || disposed) return;
      const selection = current().preferredDeviceId || '', seen = new Set(['', 'default']);
      device.replaceChildren(); const defaultOption = document.createElement('option'); defaultOption.value = ''; defaultOption.textContent = 'Windows default microphone'; device.append(defaultOption);
      for (const item of Array.isArray(items) ? items.slice(0, 100) : []) {
        if (typeof item?.deviceId !== 'string' || !item.deviceId || seen.has(item.deviceId)) continue;
        seen.add(item.deviceId); const option = document.createElement('option'); option.value = item.deviceId; option.textContent = typeof item.label === 'string' && item.label ? item.label.slice(0, 200) : `Microphone ${device.options.length}`; device.append(option);
      }
      if (selection && !seen.has(selection)) { const missing = document.createElement('option'); missing.value = selection; missing.textContent = 'Saved microphone (not currently available)'; device.append(missing); }
      device.value = selection === 'default' ? '' : selection;
      $('audioSetupDeviceStatus').textContent = selection && !seen.has(selection) ? 'Your saved microphone is unavailable. Choose an available device or Windows default.' : `${Math.max(0, seen.size - 2)} named microphone${seen.size === 3 ? '' : 's'} listed. Labels may appear only after Windows microphone access is enabled.`;
    } catch (error) { if (sequence === deviceSequence) announce(error.message || 'The microphone list could not be read.', true); }
    finally { if (sequence === deviceSequence && !disposed) render(); }
  }
  device.addEventListener('change', async () => {
    if (busy || !api()?.choose) return;
    const selected = device.value;
    busy = true; ++deviceSequence; render(); announce('Selecting the microphone…');
    try {
      await api().choose(selected); phrase = null;
      announce('Microphone selection saved. Run the local phrase check for this device.');
    } catch (error) { const state = current(); device.value = state.preferredDeviceId === 'default' ? '' : state.preferredDeviceId || ''; announce(error.message || 'The microphone could not be selected.', true); }
    finally { busy = false; render(); }
  });
  refreshButton.addEventListener('click', refreshDevices);
  phraseButton.addEventListener('click', async () => {
    if (busy || phraseButton.disabled || !api()?.testPhrase) return;
    const before = current(); busy = true; render(); announce('Listening locally for 5 seconds. Say “Olanga audio check”.');
    try {
      const result = await api().testPhrase(), after = current();
      const sameDevice = (before.preferredDeviceId || '') === (after.preferredDeviceId || '') && (before.label || '') === (after.label || '');
      phrase = { heard: String(result?.heard || '').slice(0, 200), verified: result?.verified === true && sameDevice, checkedAt: Number.isFinite(result?.checkedAt) ? result.checkedAt : Date.now(), deviceId: before.preferredDeviceId || '', label: String(before.label || '').slice(0, 200), currentDevice: sameDevice };
      announce(!sameDevice ? 'The microphone changed during the check. Try again with the selected device.' : phrase.verified ? 'Local phrase recognized. The selected microphone and local recognizer responded; no command ran and no audio was uploaded.' : `The complete phrase was not recognized.${phrase.heard ? ` Heard: “${phrase.heard}”.` : ' No words were recognized.'} Check the microphone and try again.`, !phrase.verified);
    } catch (error) {
      phrase = { heard: '', verified: false, checkedAt: Date.now(), deviceId: before.preferredDeviceId || '', label: String(before.label || '').slice(0, 200), error: String(error.message || 'The phrase check could not run.').slice(0, 300) };
      announce(phrase.error, true);
    } finally { busy = false; render(); }
  });
  replyButton.addEventListener('click', async () => {
    if (busy || !api()?.testReply) return;
    const selectedEngine = engine(); busy = true; render(); announce('Playing a sample with the selected voice…');
    try {
      const result = await api().testReply();
      reply = { status: ['completed', 'failed', 'cancelled', 'muted'].includes(result?.status) ? result.status : 'failed', checkedAt: Date.now(), engine: selectedEngine, currentEngine: engine() === selectedEngine };
      announce(!reply.currentEngine ? 'The voice changed during playback. Play the sample again with the selected voice.' : reply.status === 'completed' ? 'Playback finished. If you heard nothing, check Windows output and volume. This check cannot determine whether you heard the speakers.' : `The reply sample ${reply.status === 'muted' ? 'was muted' : reply.status === 'cancelled' ? 'was interrupted' : 'could not finish'}.`, reply.status !== 'completed');
    } catch (error) { reply = { status: 'failed', checkedAt: Date.now(), engine: selectedEngine, error: String(error.message || 'The reply sample could not play.').slice(0, 300) }; announce(reply.error, true); }
    finally { busy = false; render(); }
  });
  const observer = new MutationObserver(refreshVisibility); observer.observe(screen, { attributes: true, attributeFilter: ['class'] }); observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', refreshVisibility);
  const unsubscribe = window.OlangaVisibility?.subscribe?.(refreshVisibility);
  window.addEventListener('beforeunload', () => { disposed = true; ++deviceSequence; if (timer) clearInterval(timer); observer.disconnect(); unsubscribe?.(); }, { once: true });
  window.OlangaAudioSetup = Object.freeze({
    open() { window.OlangaSettingsNavigation?.open?.('core'); section.scrollIntoView?.({ block: 'center' }); device.focus?.({ preventScroll: true }); refreshVisibility(); void refreshDevices(); },
    snapshot() {
      const state = current();
      return { phrase: phrase ? { ...phrase, currentDevice: phrase.currentDevice !== false && phrase.deviceId === (state.preferredDeviceId || '') && phrase.label === String(state.label || '').slice(0, 200) } : null,
        reply: reply ? { ...reply, currentEngine: reply.currentEngine !== false && reply.engine === engine() } : null };
    }
  });
  render(); refreshVisibility();
})();
