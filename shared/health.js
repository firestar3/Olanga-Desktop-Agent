/* Configuration and a successful device/service check are different evidence.
   This assessment reads supplied state and never performs a request. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaHealth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const RANK = { fail: 0, warn: 1, info: 2, ok: 3 };
  const AUDIO_CHECK_TTL_MS = 10 * 60 * 1000;
  const fresh = (check, now) => Number.isFinite(check?.checkedAt) && check.checkedAt <= now && now - check.checkedAt <= AUDIO_CHECK_TTL_MS;
  function evaluate(snapshot = {}) {
    const checks = [], now = Number.isFinite(snapshot.now) ? snapshot.now : Date.now();
    const add = (id, label, status, detail, fix = '', fixAction = '', verified = status === 'ok') => checks.push({ id, label, status, detail, fix, fixAction, verified });
    const speechInput = ['offline', 'offline-general'].includes(snapshot.speechInput) ? snapshot.speechInput : 'cloud';
    const gemini = snapshot.gemini || {}, mic = snapshot.microphone || {}, audio = snapshot.audioChecks || {};
    const voiceNeeded = speechInput !== 'cloud' || !!gemini.configured;
    const phrase = audio.phrase;
    const currentPhrase = fresh(phrase, now) && phrase.currentDevice !== false && (typeof mic.preferredDeviceId !== 'string' || phrase.deviceId === mic.preferredDeviceId);

    if (mic.inputs === 0) add('microphone', 'Microphone', 'fail', 'Windows reports no microphone.', 'Connect a microphone, then refresh the device list in Audio setup.', 'audio-setup');
    else if (mic.muted) add('microphone', 'Microphone', 'warn', 'The microphone is muted in Olanga.', 'Unmute on the home screen, then run the local phrase check.', 'audio-setup');
    else if (!mic.active && voiceNeeded) add('microphone', 'Microphone', 'warn', 'The microphone is not listening.', 'Choose a microphone in Audio setup and check Windows microphone access.', 'audio-setup');
    else if (!mic.active) add('microphone', 'Microphone', 'info', 'Voice input is off. Typed local commands remain available.', 'Choose on-device speech or configure cloud speech in Core settings.', 'audio-setup', false);
    else if (currentPhrase && phrase.verified === true) add('microphone', 'Microphone', 'ok', 'The selected microphone passed the local phrase check. No audio was uploaded.', 'Run another check after changing your audio devices.', 'audio-setup');
    else if (currentPhrase && phrase.verified === false) add('microphone', 'Microphone', 'warn', 'The local phrase check did not recognize the complete test phrase.', 'Check the selected device, input level and background noise, then try again.', 'audio-setup');
    else add('microphone', 'Microphone', 'info', 'A microphone stream is active. Recognition has not been verified for this device.', 'Run the local phrase check in Audio setup.', 'audio-setup', false);

    const wake = snapshot.wakeWord || {};
    if (!voiceNeeded) add('wake-word', 'Wake word', 'info', 'The wake word starts after voice input is enabled.', '', 'audio-setup', false);
    else if (!wake.ready) add('wake-word', 'Wake word', 'warn', 'The offline wake-word model is not loaded.', 'Check Audio setup. If loading still fails, restart Olanga to reload the bundled model.', 'audio-setup');
    else add('wake-word', 'Wake word', 'info', 'The local wake-word model is loaded. This does not verify a real wake-word detection.', 'Try your wake phrase after the local microphone check.', 'audio-setup', false);

    if (speechInput !== 'cloud') add('speech', 'Speech recognition', 'info', 'On-device English recognition is selected. Each transcript is reviewed before anything runs.', 'Use the local phrase check to assess this microphone; it does not test every command.', 'audio-setup', false);
    else if (gemini.configured) add('speech', 'Speech recognition', 'info', 'Cloud recognition is configured. A saved key or text connection test does not verify transcription.', 'Try a voice request after checking the microphone.', 'audio-setup', false);
    else add('speech', 'Speech recognition', 'warn', 'Voice requests need a Gemini key or on-device speech. Typed local commands still work.', 'Add a key or choose on-device recognition in Core settings.', 'core-settings');

    const recent = Array.isArray(gemini.recent) ? gemini.recent.slice(-10) : [];
    const count = status => recent.filter(item => item?.status === status).length;
    const connection = gemini.test;
    if (!gemini.configured) add('gemini', 'Gemini', 'warn', 'No Gemini key is saved. Local commands, timers and reminders still work.', 'Add a key from Google AI Studio in Core settings.', 'core-settings');
    else if (connection && !connection.ok) add('gemini', 'Gemini', 'fail', connection.message || 'The connection test failed.', /quota|429/i.test(connection.message || '') ? 'Check your usage in Google AI Studio, or add a second key and turn on key rotation.' : 'Check your saved key and internet connection.', 'test-gemini');
    else if (count(401) + count(403)) add('gemini', 'Gemini', 'fail', 'Gemini rejected your saved key recently.', 'Replace the key in Core settings and run the connection test.', 'core-settings');
    else if (count(429)) add('gemini', 'Gemini', 'warn', `Gemini reported its quota or rate limit ${count(429) === 1 ? 'once' : `${count(429)} times`} recently.`, 'Wait for the limit to reset, check Google AI Studio, or add a second key with rotation.', 'core-settings');
    else if (count(503)) add('gemini', 'Gemini', 'warn', 'Gemini was temporarily unavailable recently.', 'Try again shortly. Local commands keep working.', 'test-gemini');
    else if (connection?.ok) add('gemini', 'Gemini', 'ok', Number.isFinite(connection.ms) ? `Gemini answered the text connection test in ${Math.round(connection.ms)} ms.` : 'Gemini answered the text connection test.', 'This checks the current key, not every model or voice feature.', 'test-gemini');
    else add('gemini', 'Gemini', 'info', 'A key is saved. The current connection has not been tested.', 'Run the explicit Gemini connection test.', 'test-gemini', false);

    const voice = snapshot.voice || {}, reply = audio.reply;
    const currentReply = fresh(reply, now) && reply.currentEngine !== false && (!reply.engine || reply.engine === voice.engine);
    if (voice.muted) add('voice', 'Olanga’s voice', 'warn', 'Olanga’s voice is muted.', 'Unmute the assistant voice on the home screen, then play the reply sample.', 'audio-setup');
    else if (voice.engine === 'magpie' && !voice.magpieKey) add('voice', 'Olanga’s voice', 'warn', 'Magpie is selected but no NVIDIA key is saved, so the Windows voice is used.', 'Add an NVIDIA key in Core settings, or choose the Windows voice.', 'core-settings');
    else if (voice.engine === 'magpie' && voice.magpieCoolingDown) add('voice', 'Olanga’s voice', 'warn', 'Magpie was unavailable recently, so the Windows voice is covering for a few minutes.', 'The reply sample can check the current playback path.', 'audio-setup');
    else if (voice.engine !== 'magpie' && voice.windowsVoices === 0) add('voice', 'Olanga’s voice', 'warn', 'Windows reports no installed voices.', 'Install a voice in Windows Settings → Time & language → Speech.', 'audio-setup');
    else if (currentReply && reply.status === 'failed') add('voice', 'Olanga’s voice', 'fail', 'The reply sample could not finish playing.', 'Check the selected voice and Windows output device, then try again.', 'audio-setup');
    else if (currentReply && ['cancelled', 'muted'].includes(reply.status)) add('voice', 'Olanga’s voice', 'warn', 'The reply sample was interrupted or muted.', 'Play the sample again when you are ready.', 'audio-setup');
    else if (currentReply && reply.status === 'completed') add('voice', 'Olanga’s voice', 'info', 'The reply sample completed playback. Olanga cannot determine whether you heard the speakers.', 'If you heard nothing, check Windows output and volume.', 'audio-setup', false);
    else add('voice', 'Olanga’s voice', 'info', voice.engine === 'magpie' ? 'Magpie is configured, with Windows voice as a fallback. Playback has not been checked.' : 'The Windows voice is configured. Playback has not been checked.', 'Play a reply sample in Audio setup.', 'audio-setup', false);

    if (snapshot.online === false) add('network', 'Internet', 'warn', 'Windows reports that you are offline. Local commands, timers and reminders still work.', 'Reconnect for questions, news and cloud speech.', 'core-settings');
    else add('network', 'Internet', 'info', snapshot.online === true ? 'Windows reports a network connection. Service access is verified separately by a connection test.' : 'The network connection state is unavailable. Service access has not been verified.', '', '', false);

    const storage = snapshot.storage || {};
    if (storage.writable === false) add('storage', 'Local storage', 'fail', 'The local storage write check failed.', 'Free some disk space and retry. Check Workspace and Notes recovery before replacing any data.', 'workspace-recovery');
    else if (storage.writable === true) add('storage', 'Local storage', 'ok', 'The local storage write check passed. Saved collections are checked separately.');
    else add('storage', 'Local storage', 'info', 'Local storage has not been checked.', '', '', false);
    for (const [id, label, recovery, fixAction] of [
      ['workspace-storage', 'Workspace storage', storage.workspaceRecovery, 'workspace-recovery'],
      ['notes-storage', 'Notes storage', storage.notesRecovery, 'notes-recovery']
    ]) {
      if (recovery?.blocked === true) add(id, label, 'fail', `${label} needs recovery. Saved changes are paused; review the existing data before replacing it.`, 'Open recovery to review and keep the original before resetting or replacing it.', fixAction);
      else if (recovery?.blocked === false) add(id, label, 'ok', `${label} is readable and is not blocked for recovery.`);
      else add(id, label, 'info', `${label} recovery state has not been checked.`, 'Open the collection to check it.', fixAction, false);
    }

    const shortcut = snapshot.pushToTalk || {};
    if (!shortcut.value || shortcut.value === 'off') add('shortcut', 'Push-to-talk', 'info', 'Off. Choose a shortcut in User settings to talk without the wake word.', '', 'user-settings', true);
    else if (!shortcut.registered) add('shortcut', 'Push-to-talk', 'warn', `${shortcut.label || shortcut.value} is already used by another app.`, 'Choose a different shortcut in User settings.', 'user-settings');
    else add('shortcut', 'Push-to-talk', 'ok', `Press ${shortcut.label || shortcut.value} anywhere to talk.`);
    if (snapshot.app?.version) add('version', 'Version', 'info', `Olanga ${snapshot.app.version}${snapshot.app.packaged === false ? ', running from source' : ''}.`, 'Check Apps & updates for a newer release.', 'check-updates', true);
    return checks;
  }
  function summarize(checks) {
    const failures = checks.filter(check => check.status === 'fail').length, warnings = checks.filter(check => check.status === 'warn').length;
    if (failures) return `${failures} problem${failures === 1 ? ' needs' : 's need'} attention${warnings ? `, plus ${warnings} suggestion${warnings === 1 ? '' : 's'}` : ''}.`;
    if (warnings) return `Local checks found ${warnings} suggestion${warnings === 1 ? '' : 's'}. Some features may still need verification.`;
    const unchecked = checks.filter(check => check.verified === false).length;
    return unchecked ? `No problems found in the available checks. ${unchecked} check${unchecked === 1 ? '' : 's'} still need${unchecked === 1 ? 's' : ''} verification.` : 'The available checks passed.';
  }
  const sort = checks => [...checks].sort((a, b) => RANK[a.status] - RANK[b.status]);
  return { evaluate, summarize, sort, AUDIO_CHECK_TTL_MS };
});
