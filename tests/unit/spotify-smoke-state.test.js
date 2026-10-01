'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { playbackState, restoreSpotifyPlayback } = require('../helpers/spotify-smoke-state');
const paused = { ok: true, verified: true, source: 'spotify', status: 'Paused', title: 'Track' };
const playing = { ...paused, status: 'Playing' };
const closed = { ok: false, verified: true, source: 'spotify', status: 'Closed', reason: 'no-session' };

test('Spotify smoke distinguishes confirmed absence from failed or incomplete status reads', () => {
  for (const receipt of [null, { ok: false }, { ...closed, reason: '' }, { ...playing, title: '' }, { ...playing, source: 'media' }]) assert.equal(playbackState(receipt), 'unknown');
  assert.equal(playbackState(playing), 'playing');
  for (const receipt of [paused, closed, { ...paused, status: 'Stopped' }]) assert.equal(playbackState(receipt), 'not-playing');
});

test('Spotify smoke never pauses pre-existing playback, an unknown baseline or an undispatched request', async () => {
  for (const options of [{ baseline: playing, commandStarted: true }, { baseline: { ok: false }, commandStarted: true }, { baseline: paused, commandStarted: false }]) {
    const result = await restoreSpotifyPlayback({ ...options, control() { assert.fail('No media command is authorized by this baseline'); } });
    assert.equal(result.attempted, false);
  }
});

test('Spotify smoke accepts confirmed paused or closed cleanup without another playback action', async () => {
  for (const readback of [paused, closed]) {
    const actions = [];
    const result = await restoreSpotifyPlayback({ baseline: closed, commandStarted: true, control: async action => { actions.push(action); return readback; } });
    assert.deepEqual(actions, ['MEDIA_STATUS']);
    assert.equal(result.verified, true);
  }
});

test('Spotify smoke pauses test-started playback and verifies a fresh stopped state', async () => {
  const actions = [], results = [playing, { ok: true, verified: true }, paused];
  const result = await restoreSpotifyPlayback({ baseline: closed, commandStarted: true, control: async action => { actions.push(action); return results.shift(); } });
  assert.deepEqual(actions, ['MEDIA_STATUS', 'MEDIA_PAUSE', 'MEDIA_STATUS']);
  assert.equal(result.verified, true);
});

test('Spotify smoke retries no actions but attempts explicit pause after a failed status read', async () => {
  const actions = [], results = [new Error('read failed'), { ok: false }, closed];
  const result = await restoreSpotifyPlayback({ baseline: paused, commandStarted: true, control: async action => { actions.push(action); const next = results.shift(); if (next instanceof Error) throw next; return next; } });
  assert.deepEqual(actions, ['MEDIA_STATUS', 'MEDIA_PAUSE', 'MEDIA_STATUS']);
  assert.equal(result.verified, true);
});

test('Spotify smoke does not report restoration when final playback state is unknown or still playing', async () => {
  for (const final of [playing, { ok: false }, new Error('read failed')]) {
    const results = [playing, { ok: true, verified: true }, final];
    const result = await restoreSpotifyPlayback({ baseline: paused, commandStarted: true, control: async () => { const next = results.shift(); if (next instanceof Error) throw next; return next; } });
    assert.equal(result.attempted, true);
    assert.equal(result.verified, false);
  }
});

test('Spotify smoke observes delayed playback after cancellation before accepting a closed session', async () => {
  let time = 0;
  const actions = [], results = [closed, playing, { ok: true }, paused];
  const result = await restoreSpotifyPlayback({ baseline: closed, commandStarted: true, settleMs: 5000, now: () => time, wait: async ms => { time += ms; }, control: async action => { actions.push(action); return results.shift(); } });
  assert.deepEqual(actions, ['MEDIA_STATUS', 'MEDIA_STATUS', 'MEDIA_PAUSE', 'MEDIA_STATUS']);
  assert.equal(result.verified, true);
  assert.equal(result.observations.length, 2);
});
