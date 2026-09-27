/* Turns a read-only snapshot of Olanga's runtime state into plain-language
   checks with a suggested fix. It performs no requests and changes nothing. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaHealth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const RANK = { fail: 0, warn: 1, info: 2, ok: 3 };
  function evaluate(snapshot = {}) {
    const checks = [];
    const add = (id, label, status, detail, fix = '') => checks.push({ id, label, status, detail, fix });
    const speechInput = ['offline', 'offline-general'].includes(snapshot.speechInput) ? snapshot.speechInput : 'cloud';
    const gemini = snapshot.gemini || {};
    const mic = snapshot.microphone || {};
    const voiceNeeded = speechInput !== 'cloud' || !!gemini.configured;

    if (mic.inputs === 0) add('microphone', 'Microphone', 'fail', 'Windows reports no microphone.', 'Connect a microphone, then choose your speech input again in Settings.');
    else if (mic.muted) add('microphone', 'Microphone', 'warn', 'The microphone is muted in Olanga.', 'Select the microphone button on the home screen to unmute it.');
    else if (!mic.active && voiceNeeded) add('microphone', 'Microphone', 'warn', 'The microphone is not listening.', 'Choose your speech input again in Settings, and allow microphone access in Windows privacy settings.');
    else if (!mic.active) add('microphone', 'Microphone', 'info', 'Voice input is off until you add a Gemini key or choose on-device speech.', 'Settings → Speech recognition.');
    else add('microphone', 'Microphone', 'ok', 'The microphone is listening.');

    const wake = snapshot.wakeWord || {};
    if (!voiceNeeded) add('wake-word', 'Wake word', 'info', 'The wake word starts after voice input is enabled.');
    else if (!wake.ready) add('wake-word', 'Wake word', 'warn', 'The offline wake-word model is not loaded.', 'Restart Olanga. If this continues, reinstall to restore the bundled speech model.');
    else add('wake-word', 'Wake word', 'ok', 'Listening for “Hey Olanga” on this device. Idle audio is not uploaded.');

    if (speechInput !== 'cloud') add('speech', 'Speech recognition', 'ok', 'On-device English recognition, with a review step before anything runs.');
    else if (gemini.configured) add('speech', 'Speech recognition', 'ok', 'Gemini transcribes each request after the wake word.');
    else add('speech', 'Speech recognition', 'warn', 'Voice requests need a Gemini key or on-device speech. Typed local commands still work.', 'Add a key in Settings → API Keys, or choose on-device speech.');

    const recent = Array.isArray(gemini.recent) ? gemini.recent.slice(-10) : [];
    const count = status => recent.filter(item => item?.status === status).length;
    const test = gemini.test;
    if (!gemini.configured) add('gemini', 'Gemini', 'warn', 'No Gemini key is saved. Local commands, timers and reminders still work.', 'Add a free key from Google AI Studio in Settings → API Keys.');
    else if (test && !test.ok) add('gemini', 'Gemini', 'fail', test.message || 'The connection test failed.', /quota|429/i.test(test.message || '') ? 'Check your usage in Google AI Studio, or add a second key and turn on key rotation.' : 'Check your key in Settings and your internet connection.');
    else if (count(401) + count(403)) add('gemini', 'Gemini', 'fail', 'Gemini rejected your saved key recently.', 'Replace the key in Settings → API Keys.');
    else if (count(429)) add('gemini', 'Gemini', 'warn', `Gemini reported its quota or rate limit ${count(429) === 1 ? 'once' : `${count(429)} times`} recently.`, 'Wait for the limit to reset, check Google AI Studio, or add a second key with rotation.');
    else if (count(503)) add('gemini', 'Gemini', 'warn', 'Gemini was temporarily unavailable recently.', 'Try again shortly. Local commands keep working.');
    else if (test?.ok) add('gemini', 'Gemini', 'ok', `Gemini answered in ${Math.round(test.ms)} ms.`);
    else add('gemini', 'Gemini', 'ok', 'A key is saved. Run the connection test to confirm it works.');

    const voice = snapshot.voice || {};
    if (voice.muted) add('voice', 'Olanga’s voice', 'warn', 'Olanga’s voice is muted.', 'Select the headphones button on the home screen.');
    else if (voice.engine === 'magpie' && !voice.magpieKey) add('voice', 'Olanga’s voice', 'warn', 'Magpie is selected but no NVIDIA key is saved, so the Windows voice is used.', 'Add an NVIDIA key in Settings, or choose the Windows voice.');
    else if (voice.engine === 'magpie' && voice.magpieCoolingDown) add('voice', 'Olanga’s voice', 'warn', 'Magpie was unavailable recently, so the Windows voice is covering for a few minutes.', 'Nothing to do; Magpie is retried automatically.');
    else if (voice.windowsVoices === 0) add('voice', 'Olanga’s voice', 'warn', 'Windows reports no installed voices.', 'Install an English voice in Windows Settings → Time & language → Speech.');
    else add('voice', 'Olanga’s voice', 'ok', voice.engine === 'magpie' ? 'NVIDIA Magpie, with the Windows voice as a fallback.' : 'The built-in Windows voice.');

    if (snapshot.online === false) add('network', 'Internet', 'warn', 'You appear to be offline. Local commands, timers and reminders still work.', 'Reconnect for questions, news and cloud speech.');
    else add('network', 'Internet', 'ok', 'Connected.');

    if (snapshot.storage?.writable === false) add('storage', 'Local storage', 'fail', 'Olanga cannot save settings, timers or tasks.', 'Free some disk space, then restart Olanga.');
    else add('storage', 'Local storage', 'ok', 'Settings, timers and memories save on this device.');

    const shortcut = snapshot.pushToTalk || {};
    if (!shortcut.value || shortcut.value === 'off') add('shortcut', 'Push-to-talk', 'info', 'Off. Choose a shortcut in Settings to talk without the wake word.');
    else if (!shortcut.registered) add('shortcut', 'Push-to-talk', 'warn', `${shortcut.label || shortcut.value} is already used by another app.`, 'Choose a different shortcut in Settings.');
    else add('shortcut', 'Push-to-talk', 'ok', `Press ${shortcut.label || shortcut.value} anywhere to talk.`);

    if (snapshot.app?.version) add('version', 'Version', 'info', `Olanga ${snapshot.app.version}${snapshot.app.packaged === false ? ', running from source' : ''}.`, 'Workspace → Apps & updates → Check for updates.');
    return checks;
  }
  function summarize(checks) {
    const failures = checks.filter(check => check.status === 'fail').length, warnings = checks.filter(check => check.status === 'warn').length;
    if (failures) return `${failures} problem${failures === 1 ? ' needs' : 's need'} attention${warnings ? `, plus ${warnings} suggestion${warnings === 1 ? '' : 's'}` : ''}.`;
    if (warnings) return `Working, with ${warnings} suggestion${warnings === 1 ? '' : 's'}.`;
    return 'Everything looks good.';
  }
  const sort = checks => [...checks].sort((a, b) => RANK[a.status] - RANK[b.status]);
  return { evaluate, summarize, sort };
});
