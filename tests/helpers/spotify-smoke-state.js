'use strict';

function playbackState(receipt) {
  if (!receipt?.verified || receipt.source !== 'spotify') return 'unknown';
  if (receipt.status === 'Closed' && receipt.reason === 'no-session') return 'not-playing';
  if (!receipt.ok) return 'unknown';
  if (receipt.status === 'Playing' && typeof receipt.title === 'string' && receipt.title.trim()) return 'playing';
  if (receipt.status === 'Paused' || receipt.status === 'Stopped') return 'not-playing';
  return 'unknown';
}

async function restoreSpotifyPlayback({ baseline, commandStarted, control, settleMs = 0, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!commandStarted || playbackState(baseline) !== 'not-playing') {
    return { attempted: false, reason: 'No test-started playback to restore.' };
  }
  const invoke = async action => {
    try { return await control(action); }
    catch (error) { return { ok: false, error: String(error.message || error) }; }
  };
  let before = await invoke('MEDIA_STATUS');
  const observations = [before];
  const deadline = now() + Math.max(0, Math.min(5000, settleMs));
  // An already-posted native Play can publish its session after cancellation.
  // Observe a bounded quiet period before accepting a stopped state.
  while (playbackState(before) === 'not-playing' && now() < deadline) {
    await wait(Math.min(200, deadline - now()));
    before = await invoke('MEDIA_STATUS');
    observations.push(before);
  }
  if (playbackState(before) === 'not-playing') return { attempted: false, verified: true, readback: before, observations };
  // A failed status read cannot prove silence. Explicit Pause is idempotent;
  // it cannot start music, and this baseline was confirmed not playing.
  const pause = await invoke('MEDIA_PAUSE');
  const readback = await invoke('MEDIA_STATUS');
  return { attempted: true, verified: playbackState(readback) === 'not-playing', before, pause, readback, observations };
}

module.exports = { playbackState, restoreSpotifyPlayback };
