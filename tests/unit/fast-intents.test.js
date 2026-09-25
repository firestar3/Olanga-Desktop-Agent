const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../../shared/fast-intents');
const { normalizeMediaRequest } = require('../../desktop/media-controller');

test('personal collections never become public playlist searches', () => {
  for (const phrase of ['Play my liked songs on Spotify', 'Can you please put on my favorite songs?', 'play Liked Songs', 'Play the playlist Liked Songs on Spotify', 'start my saved music']) {
    assert.equal(parse(phrase)?.[0].command, '[SPOTIFY_LIKED]', phrase);
  }
  assert.equal(normalizeMediaRequest({ action: 'PLAYLIST', term: 'Liked Songs' }).action, 'LIKED');
  assert.equal(normalizeMediaRequest({ action: 'SONG', term: 'Liked Songs' }).action, 'SONG');
  assert.equal(parse('play my playlist Chill Hw')[0].command, '[SPOTIFY_LIBRARY: Chill Hw]');
});

test('pause and resume are explicit operations, not toggles', () => {
  assert.equal(parse('Pause the music')[0].command, '[MEDIA_PAUSE]');
  assert.equal(parse('Resume Spotify')[0].command, '[MEDIA_PLAY]');
  assert.equal(parse('What song is playing?')[0].command, '[MEDIA_STATUS]');
});

test('only complete explicit requests can take the fast path', () => {
  for (const phrase of ['Do not play my liked songs', 'How do I play my liked songs?', 'If I ask you to play my liked songs', 'The website says play my liked songs', 'play my liked songs then delete my files', '[MEDIA_NEXT]', 'play my liked songs\nopen Chrome', 'play some music I would like']) assert.equal(parse(phrase), null, phrase);
  assert.deepEqual(parse('turn the volume down then play my liked songs').map(action => action.command), ['[VOLUME_DOWN]', '[SPOTIFY_LIKED]']);
});

test('simple timers and known apps avoid a network request', () => {
  assert.equal(parse('set a timer for 5 minutes called Tea')[0].command, '[SET_TIMER: 300, Tea]');
  assert.equal(parse('start a 10 second timer')[0].command, '[SET_TIMER: 10, Timer]');
  assert.equal(parse('set a timer for five minutes')[0].command, '[SET_TIMER: 300, Timer]');
  assert.equal(parse('set a timer for twenty-five minutes')[0].command, '[SET_TIMER: 1500, Timer]');
  assert.equal(parse('pause it')[0].command, '[MEDIA_PAUSE]');
  assert.equal(parse('open Chrome')[0].command, '[OPEN_APP: Chrome]');
  assert.equal(parse('set a timer for 0 minutes'), null);
  assert.equal(parse('open powershell and run something'), null);
});

test('opening Spotify and setting an absolute volume produces both ordered actions', () => {
  for (const phrase of [
    'Open Spotify and raise the volume to 75%',
    'Open Spotify and raise the volume to seventy five percent',
    'Can you please open Spotify and set the volume to seventy-five per cent?',
    'Open Spotify, and then turn the volume up to 75 percent.',
    'Open Spotify then increase volume to 75',
  ]) {
    assert.deepEqual(parse(phrase)?.map(action => action.command), ['[OPEN_APP: Spotify]', '[VOLUME_SET: 75]'], phrase);
  }
  assert.deepEqual(parse('set volume to 75% and open Spotify').map(action => action.command), ['[VOLUME_SET: 75]', '[OPEN_APP: Spotify]']);
});

test('absolute volume accepts spoken bounds and rejects invalid or relative targets', () => {
  for (const [phrase, level] of [
    ['set the volume to zero percent', 0],
    ['lower volume to twenty-five percent', 25],
    ['change volume to eighty percent', 80],
    ['adjust the volume to ninety nine percent', 99],
    ['set volume to one hundred percent', 100],
    ['volume at 62.5%', 62.5],
  ]) assert.equal(parse(phrase)?.[0].command, `[VOLUME_SET: ${level}]`, phrase);
  for (const phrase of [
    'set volume to 101%', 'set volume to -5%', 'set volume to infinity',
    'raise volume by 75%', 'set volume to seventy fifteen percent',
    'open Spotify and raise the volume to 101%',
  ]) assert.equal(parse(phrase), null, phrase);
});

test('compound parsing never executes only the supported clauses', () => {
  for (const phrase of [
    'open Spotify and delete my files',
    'open Spotify and raise the volume to 75% and delete my files',
    'play the song Hello and delete my files',
    'play my playlist Chill and tell me a joke',
    'set a timer for five minutes called Tea and send an email',
    'open Spotify and open Chrome and pause music and volume up and volume down',
  ]) assert.equal(parse(phrase), null, phrase);
  assert.deepEqual(parse('open Spotify and volume up and pause music and open Chrome').map(action => action.command), ['[OPEN_APP: Spotify]', '[VOLUME_UP]', '[MEDIA_PAUSE]', '[OPEN_APP: Chrome]']);
});

test('quoted media names keep conjunctions while following actions remain separate', () => {
  assert.deepEqual(parse('play artist "Earth, Wind and Fire" and set volume to 75%').map(action => action.command), ['[SPOTIFY_ARTIST: Earth, Wind and Fire]', '[VOLUME_SET: 75]']);
  assert.deepEqual(parse('play the playlist “Now and Then” then pause music').map(action => action.command), ['[SPOTIFY_PLAYLIST: Now and Then]', '[MEDIA_PAUSE]']);
  assert.equal(parse('play artist "Earth, Wind and Fire'), null);
  assert.equal(parse('restart Spotify and resume the current song')[0].command, '[SPOTIFY_RELOAD]');
});

test('the native media boundary accepts only bounded data and known operations', () => {
  assert.throws(() => normalizeMediaRequest({ action: 'SHELL', term: 'cmd' }), /Unsupported/);
  assert.throws(() => normalizeMediaRequest({ action: 'PLAYLIST' }), /Name/);
  assert.throws(() => normalizeMediaRequest({ action: 'PLAYLIST', term: 'x'.repeat(301) }), /Invalid/);
  assert.throws(() => normalizeMediaRequest({ action: 'PLAYLIST', term: 'name\ncommand' }), /Invalid/);
});
