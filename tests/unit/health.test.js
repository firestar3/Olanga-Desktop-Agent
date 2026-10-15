const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, summarize, sort } = require('../../shared/health');

const healthy = {
  online: true, speechInput: 'cloud', storage: { writable: true, workspaceRecovery: { blocked: false }, notesRecovery: { blocked: false } },
  microphone: { inputs: 1, active: true, muted: false }, wakeWord: { ready: true },
  gemini: { configured: true, recent: [{ status: 200 }], test: { ok: true, ms: 642.4 } },
  voice: { engine: 'windows', windowsVoices: 3, muted: false },
  pushToTalk: { value: 'Control+Alt+Space', label: 'Ctrl + Alt + Space', registered: true },
  app: { version: '1.4.0', packaged: false }
};
const byId = checks => Object.fromEntries(checks.map(check => [check.id, check]));

test('a healthy setup reports every check without problems', () => {
  const checks = evaluate(healthy);
  assert.deepEqual(checks.map(check => check.id), ['microphone', 'wake-word', 'speech', 'gemini', 'voice', 'network', 'storage', 'workspace-storage', 'notes-storage', 'shortcut', 'version']);
  assert.equal(checks.filter(check => ['fail', 'warn'].includes(check.status)).length, 0);
  assert.equal(byId(checks).gemini.detail, 'Gemini answered the text connection test in 642 ms.');
  assert.equal(byId(checks).shortcut.detail, 'Press Ctrl + Alt + Space anywhere to talk.');
  assert.match(byId(checks).version.detail, /1\.4\.0, running from source/);
  assert.match(summarize(checks), /No problems found.*still need verification/);
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
  assert.equal(offline.speech.status, 'info');
  assert.equal(offline.microphone.status, 'info');
});

test('authentication failures and failed live tests outrank older successes', () => {
  assert.equal(byId(evaluate({ ...healthy, gemini: { configured: true, recent: [{ status: 403 }] } })).gemini.status, 'fail');
  const failed = byId(evaluate({ ...healthy, gemini: { configured: true, test: { ok: false, message: 'Google Gemini quota or rate limit reached (429).' } } })).gemini;
  assert.equal(failed.status, 'fail'); assert.match(failed.fix, /key rotation/);
  assert.equal(summarize(evaluate({ ...healthy, voice: { muted: true } })), 'Local checks found 1 suggestion. Some features may still need verification.');
});

test('saved configuration, an online flag and a loaded model do not claim successful recognition or playback', () => {
  const found = byId(evaluate({ ...healthy, gemini: { configured: true, recent: [{ status: 200 }] } }));
  for (const id of ['microphone', 'wake-word', 'speech', 'gemini', 'voice', 'network']) { assert.equal(found[id].status, 'info', id); assert.equal(found[id].verified, false, id); }
  assert.match(found.gemini.detail, /not been tested/); assert.match(found.speech.detail, /does not verify transcription/);
  assert.equal(found.gemini.fixAction, 'test-gemini'); assert.equal(found.microphone.fixAction, 'audio-setup');
});

test('blocked Workspace and Notes are actionable failures even when a generic storage write succeeds', () => {
  const found = byId(evaluate({ ...healthy, storage: { writable: true, workspaceRecovery: { blocked: true }, notesRecovery: { blocked: true } } }));
  assert.equal(found.storage.status, 'ok');
  assert.equal(found['workspace-storage'].status, 'fail'); assert.equal(found['workspace-storage'].fixAction, 'workspace-recovery');
  assert.equal(found['notes-storage'].status, 'fail'); assert.equal(found['notes-storage'].fixAction, 'notes-recovery');
  assert.match(found['notes-storage'].detail, /Saved changes are paused/);
  const unknown = byId(evaluate({ ...healthy, storage: { writable: true } }));
  assert.equal(unknown['notes-storage'].status, 'info'); assert.equal(unknown['notes-storage'].verified, false);
});

test('a phrase check is valid only for the current device, within its session freshness window', () => {
  const now = 2000000, mic = { ...healthy.microphone, preferredDeviceId: 'mic-one' };
  const audioChecks = { phrase: { verified: true, checkedAt: now - 1000, deviceId: 'mic-one', currentDevice: true } };
  assert.equal(byId(evaluate({ ...healthy, now, microphone: mic, audioChecks })).microphone.status, 'ok');
  for (const patch of [{ checkedAt: now - 600001 }, { checkedAt: now + 1 }, { deviceId: 'mic-two' }, { currentDevice: false }]) {
    const found = byId(evaluate({ ...healthy, now, microphone: mic, audioChecks: { phrase: { ...audioChecks.phrase, ...patch } } }));
    assert.equal(found.microphone.status, 'info'); assert.equal(found.microphone.verified, false);
  }
  assert.equal(byId(evaluate({ ...healthy, now, microphone: { ...mic, muted: true }, audioChecks })).microphone.status, 'warn');
  assert.equal(byId(evaluate({ ...healthy, now, microphone: mic, audioChecks: { phrase: { ...audioChecks.phrase, verified: false } } })).microphone.status, 'warn');
});

test('a completed reply sample proves playback API completion and never claims the user heard it', () => {
  const now = 2000000, audioChecks = { reply: { status: 'completed', checkedAt: now, engine: 'windows' } };
  const found = byId(evaluate({ ...healthy, now, audioChecks }));
  assert.equal(found.voice.status, 'info'); assert.equal(found.voice.verified, false); assert.match(found.voice.detail, /cannot determine whether you heard/);
  const failed = byId(evaluate({ ...healthy, now, audioChecks: { reply: { ...audioChecks.reply, status: 'failed' } } }));
  assert.equal(failed.voice.status, 'fail'); assert.equal(failed.voice.fixAction, 'audio-setup');
  const changed = byId(evaluate({ ...healthy, now, audioChecks: { reply: { ...audioChecks.reply, status: 'failed', engine: 'magpie' } } }));
  assert.equal(changed.voice.status, 'info');
});

test('Magpie is not reported broken solely because Windows has no installed fallback voice', () => {
  const found = byId(evaluate({ ...healthy, voice: { engine: 'magpie', magpieKey: true, windowsVoices: 0 } }));
  assert.equal(found.voice.status, 'info'); assert.match(found.voice.detail, /configured/);
});

test('missing snapshots stay unverified and summaries cannot claim universal health', () => {
  const checks = evaluate({}), found = byId(checks);
  assert.equal(found.storage.verified, false); assert.equal(found['workspace-storage'].verified, false);
  assert.match(found.network.detail, /unavailable/);
  assert.doesNotMatch(summarize(checks), /Everything looks good/);
  assert.equal(summarize([{ status: 'ok', verified: true }]), 'The available checks passed.');
});
