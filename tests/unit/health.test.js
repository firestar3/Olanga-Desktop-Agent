const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, summarize, sort } = require('../../shared/health');

const healthy = {
  online: true, speechInput: 'cloud', storage: { writable: true },
  microphone: { inputs: 1, active: true, muted: false }, wakeWord: { ready: true },
  gemini: { configured: true, recent: [{ status: 200 }], test: { ok: true, ms: 642.4 } },
  voice: { engine: 'windows', windowsVoices: 3, muted: false },
  pushToTalk: { value: 'Control+Alt+Space', label: 'Ctrl + Alt + Space', registered: true },
  app: { version: '1.4.0', packaged: false }
};
const byId = checks => Object.fromEntries(checks.map(check => [check.id, check]));

test('a healthy setup reports every check without problems', () => {
  const checks = evaluate(healthy);
  assert.deepEqual(checks.map(check => check.id), ['microphone', 'wake-word', 'speech', 'gemini', 'voice', 'network', 'storage', 'shortcut', 'version']);
  assert.equal(checks.filter(check => ['fail', 'warn'].includes(check.status)).length, 0);
  assert.equal(byId(checks).gemini.detail, 'Gemini answered in 642 ms.');
  assert.equal(byId(checks).shortcut.detail, 'Press Ctrl + Alt + Space anywhere to talk.');
  assert.match(byId(checks).version.detail, /1\.4\.0, running from source/);
  assert.equal(summarize(checks), 'Everything looks good.');
});

test('common failures explain themselves with a concrete fix and sort first', () => {
  const checks = evaluate({
    ...healthy, online: false, storage: { writable: false },
    microphone: { inputs: 0, active: false }, wakeWord: { ready: false },
    gemini: { configured: true, recent: [{ status: 429 }, { status: 429 }], test: null },
    voice: { engine: 'magpie', magpieKey: false, windowsVoices: 2 },
    pushToTalk: { value: 'Control+Alt+Space', label: 'Ctrl + Alt + Space', registered: false }
  });
  const found = byId(checks);
  assert.equal(found.microphone.status, 'fail'); assert.match(found.microphone.fix, /Connect a microphone/);
  assert.equal(found['wake-word'].status, 'warn');
  assert.equal(found.gemini.status, 'warn'); assert.match(found.gemini.detail, /2 times/);
  assert.match(found.voice.detail, /no NVIDIA key/);
  assert.equal(found.network.status, 'warn'); assert.equal(found.storage.status, 'fail');
  assert.match(found.shortcut.detail, /already used by another app/);
  assert.deepEqual(sort(checks).slice(0, 2).map(check => check.status), ['fail', 'fail']);
  assert.equal(summarize(checks), '2 problems need attention, plus 5 suggestions.');
});

test('keyless and on-device setups are not reported as broken', () => {
  const keyless = byId(evaluate({ ...healthy, gemini: { configured: false }, microphone: { inputs: 1, active: false }, wakeWord: { ready: false }, pushToTalk: { value: 'off' } }));
  assert.equal(keyless.microphone.status, 'info');
  assert.equal(keyless['wake-word'].status, 'info');
  assert.equal(keyless.speech.status, 'warn');
  assert.match(keyless.gemini.detail, /Local commands, timers and reminders still work/);
  assert.equal(keyless.shortcut.status, 'info');
  const offline = byId(evaluate({ ...healthy, speechInput: 'offline', gemini: { configured: false } }));
  assert.equal(offline.speech.status, 'ok');
  assert.equal(offline.microphone.status, 'ok');
});

test('authentication failures and failed live tests outrank older successes', () => {
  assert.equal(byId(evaluate({ ...healthy, gemini: { configured: true, recent: [{ status: 403 }] } })).gemini.status, 'fail');
  const failed = byId(evaluate({ ...healthy, gemini: { configured: true, test: { ok: false, message: 'Google Gemini quota or rate limit reached (429).' } } })).gemini;
  assert.equal(failed.status, 'fail'); assert.match(failed.fix, /key rotation/);
  assert.equal(summarize(evaluate({ ...healthy, voice: { muted: true } })), 'Working, with 1 suggestion.');
});
