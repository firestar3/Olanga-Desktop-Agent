const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, clockTime, isDismissal } = require('../../shared/fast-intents');
const { normalizeMediaRequest } = require('../../desktop/media-controller');

test('mixed duration commands preserve all units and compounds retain later actions', () => {
  for (const [phrase, seconds] of [['set a timer for one hour and thirty minutes', 5400], ['set a timer for 1 hour 20 minutes 5 seconds', 4805], ['start a 5minute timer', 300], ['set a timer for half an hour', 1800]]) assert.equal(parse(phrase)?.[0].command, `[SET_TIMER: ${seconds}, Timer]`, phrase);
  assert.deepEqual(parse('set a timer for 1 hour and 30 minutes and open Chrome')?.map(action => action.command), ['[SET_TIMER: 5400, Timer]', '[OPEN_APP: Chrome]']);
  assert.deepEqual(parse('set a timer for one hour and thirty minutes called "Tea and toast" and open Chrome')?.map(action => action.command), ['[SET_TIMER: 5400, Tea and toast]', '[OPEN_APP: Chrome]']);
  for (const phrase of ['set a timer for one hour and delete files', 'set a timer for 1 hour and -30 minutes', 'set a timer for 1 hour and', 'set a timer for 25 hours']) assert.equal(parse(phrase), null, phrase);
});

test('local checklist, timer and volume queries do not reinterpret names as actions', () => {
  for (const [phrase, command] of [['add "bread and milk" to my checklist', '[ADD_TASK: bread and milk]'], ['complete task "Bread and milk"', '[COMPLETE_TASK: Bread and milk]'], ['remove task Read', '[REMOVE_TASK: Read]'], ['reopen task Read', '[UNCOMPLETE_TASK: Read]'], ['show my tasks', '[TASK_STATUS]'], ['show active timers', '[TIMER_STATUS]'], ['cancel the Tea timer', '[CANCEL_TIMER: Tea]'], ['cancel all timers', '[CLEAR_ALL_TIMERS]'], ['what is the volume?', '[VOLUME_STATUS]']]) assert.equal(parse(phrase)?.[0].command, command, phrase);
  for (const phrase of ['add bread and delete files to my checklist', 'do not remove task Read', 'complete task Read and delete files', 'add Milk, Bread to my tasks']) assert.equal(parse(phrase), null, phrase);
});

test('aliases and saved playlists resolve only exact configured names', () => {
  const options = { aliases: [{ alias: 'work browser', target: 'Chrome' }, { alias: 'evil', target: 'Chrome] [VOLUME_SET: 100' }], playlists: [{ alias: 'focus music', target: 'Deep Focus' }] };
  assert.equal(parse('open work browser', options)[0].command, '[OPEN_APP: Chrome]');
  assert.equal(parse('play my focus music', options)[0].command, '[SPOTIFY_LIBRARY: Deep Focus]');
  assert.equal(parse('open evil', options), null);
  assert.equal(parse('open work', options), null);
  assert.deepEqual(parse('open work browser then move work browser to the left', options).map(action => action.command), ['[OPEN_APP: Chrome]', '[ARRANGE_APP: Chrome, left]']);
  assert.equal(parse('maximize Notepad')[0].command, '[ARRANGE_APP: Notepad, maximize]');
});

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

test('playing Spotify preserves both playback and the requested volume', () => {
  for (const phrase of ['Play Spotify and raise the volume to 75%', 'Play Spotify and raise the volume to75%', 'resume Spotify then raise volume']) {
    assert.deepEqual(parse(phrase)?.map(action => action.command), ['[MEDIA_PLAY]', phrase.endsWith('raise volume') ? '[VOLUME_UP]' : '[VOLUME_SET: 75]'], phrase);
  }
});

test('concrete song searches avoid model routing without losing the artist or following action', () => {
  for (const [phrase, title] of [
    ['play Shape of You by Ed Sheeran and set volume to 75%', 'Shape of You by Ed Sheeran'],
    ['play The Scientist by Coldplay and set volume to 75%', 'The Scientist by Coldplay'],
    ['play "Shape of You" by Ed Sheeran and set volume to 75%', 'Shape of You by Ed Sheeran'],
    ['play "Now and Then" and set volume to 75%', 'Now and Then'],
    ['put on Billie Jean on Spotify and set volume to 75%', 'Billie Jean'],
  ]) assert.deepEqual(parse(phrase)?.map(action => action.command), [`[SPOTIFY_SONG: ${title}]`, '[VOLUME_SET: 75]'], phrase);
  for (const phrase of ['play some music I would like on Spotify', 'play my favorite band on Spotify', 'play a song by Ed Sheeran', 'play Shape of You by Ed Sheeran and delete files', 'play Rock and Roll by Led Zeppelin and set volume to 75%']) assert.equal(parse(phrase), null, phrase);
  assert.equal(parse('start Chrome')[0].command, '[OPEN_APP: Chrome]');
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

test('relative volume wording never becomes an absolute percentage', () => {
  for (const phrase of [
    'turn volume up 10%',
    'turn the volume down ten percent',
    'volume up 10',
    'volume down twenty-five percent',
    'raise the volume 10%',
    'increase volume ten percent',
    'lower volume 10%',
    'decrease the volume ten percent',
    'increase volume by ten percent',
    'turn the volume down by 10%',
    'open Spotify and turn the volume up 10%',
  ]) assert.equal(parse(phrase), null, phrase);
});

test('explicit volume targets and parameterless relative controls keep their meaning', () => {
  for (const [phrase, level] of [
    ['turn volume up to 75%', 75],
    ['turn the volume down to twenty-five percent', 25],
    ['raise volume to 75', 75],
    ['increase the volume to 75 percent', 75],
    ['lower volume to 25%', 25],
    ['decrease volume to twenty-five percent', 25],
    ['volume at 75%', 75],
    ['volume 75', 75],
    ['set volume 75%', 75],
  ]) assert.equal(parse(phrase)?.[0].command, `[VOLUME_SET: ${level}]`, phrase);
  for (const phrase of ['volume up', 'turn the volume up', 'increase volume']) assert.equal(parse(phrase)?.[0].command, '[VOLUME_UP]', phrase);
  for (const phrase of ['volume down', 'turn the volume down', 'decrease volume']) assert.equal(parse(phrase)?.[0].command, '[VOLUME_DOWN]', phrase);
});

test('system mute and unmute use explicit states while toggle stays explicit', () => {
  for (const phrase of ['mute volume', 'mute the volume', 'mute system audio', 'please mute the speakers']) assert.equal(parse(phrase)?.[0].command, '[VOLUME_MUTE_ON]', phrase);
  for (const phrase of ['unmute volume', 'unmute the system audio', 'unmute sound', 'unmute my speakers']) assert.equal(parse(phrase)?.[0].command, '[VOLUME_MUTE_OFF]', phrase);
  assert.equal(parse('toggle system mute')?.[0].command, '[VOLUME_MUTE]');
  assert.deepEqual(parse('mute the volume and unmute the volume').map(action => action.command), ['[VOLUME_MUTE_ON]', '[VOLUME_MUTE_OFF]']);
  for (const phrase of [
    'mute', 'unmute', 'mute it', 'mute my microphone', 'unmute the mic',
    'mute Olanga', 'mute your voice', 'unmute TTS', 'mute Spotify',
    'do not mute the volume', 'how do I unmute the volume?',
    'mute volume and unmute my microphone',
  ]) assert.equal(parse(phrase), null, phrase);
});

test('ambiguous fractional volume and incomplete articles do not become tiny absolute targets', () => {
  for (const phrase of ['set volume to half', 'set volume to a', 'volume an', 'open Spotify and set volume to half']) assert.equal(parse(phrase), null, phrase);
  assert.equal(parse('set volume to half percent')[0].command, '[VOLUME_SET: 0.5]');
  assert.equal(parse('set volume to a percent')[0].command, '[VOLUME_SET: 1]');
  assert.equal(parse('set a timer for half an hour')[0].command, '[SET_TIMER: 1800, Timer]');
});

test('malformed optional saved names cannot crash local command parsing', () => {
  for (const options of [{ aliases: {} }, { aliases: [null, 7] }, { playlists: {} }, { playlists: [null, 7] }, null]) {
    assert.equal(parse('open work browser', options), null);
    assert.equal(parse('play my focus music', options), null);
    assert.equal(parse('open Chrome', options)[0].command, '[OPEN_APP: Chrome]');
  }
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

const commands = phrase => parse(phrase)?.map(action => action.command) ?? null;

test('time, date, help and dismissal answer locally while broader questions still reach Gemini', () => {
  for (const phrase of ['What time is it?', 'what is the current time', "what's the time now", 'tell me the time']) assert.deepEqual(commands(phrase), ['[TIME_STATUS]'], phrase);
  for (const phrase of ['What’s today’s date?', 'what day is it', 'what is the date today', 'what day is today']) assert.deepEqual(commands(phrase), ['[DATE_STATUS]'], phrase);
  for (const phrase of ['help', 'what can you do', 'what commands do you know']) assert.deepEqual(commands(phrase), ['[HELP]'], phrase);
  for (const phrase of ['never mind', 'forget it', 'no thanks', "that's all"]) assert.deepEqual(commands(phrase), ['[DISMISS]'], phrase);
  for (const phrase of ['what time is it in Tokyo', 'what day is Christmas', 'help me write an email', 'cancel', 'cancel that', 'no']) assert.equal(parse(phrase), null, phrase);
  assert.equal(isDismissal('Never mind.'), true);
  assert.equal(isDismissal('open Chrome'), false);
});

test('reminders keep the whole reminder text and accept durations or clock times', () => {
  for (const [phrase, command] of [
    ['remind me to call mom in 10 minutes', '[SET_REMINDER: 600, call mom]'],
    ['remind me in an hour and a half to stretch', '[SET_REMINDER: 5400, stretch]'],
    ['remind me to put the clothes in the dryer in 20 minutes', '[SET_REMINDER: 1200, put the clothes in the dryer]'],
    ['set a reminder for 10 minutes to check the oven', '[SET_REMINDER: 600, check the oven]'],
    ['remind me to call mom and dad at 5 pm', '[SET_ALARM: 5:00 PM, call mom and dad]'],
    ['remind me at 5:30 p.m. to join the meeting', '[SET_ALARM: 5:30 PM, join the meeting]'],
    ['remind me to call mom tomorrow at 9', '[SET_ALARM: 9:00 tomorrow, call mom]'],
    ['set a reminder for 5pm to leave', '[SET_ALARM: 5:00 PM, leave]']
  ]) assert.deepEqual(commands(phrase), [command], phrase);
  assert.deepEqual(commands('remind me to call mom in 10 minutes and open Spotify'), ['[SET_REMINDER: 600, call mom]', '[OPEN_APP: Spotify]']);
  for (const phrase of ['remind me to call mom', 'remind me tomorrow to call mom', 'remind me to call mom in 30 hours', 'remind me to it in 5 minutes']) assert.equal(parse(phrase), null, phrase);
});

test('alarms normalize clock times without guessing an unstated morning or evening', () => {
  for (const [phrase, command] of [
    ['set an alarm for 7 am', '[SET_ALARM: 7:00 AM, Alarm]'],
    ['set an alarm for 7:30 tomorrow', '[SET_ALARM: 7:30 tomorrow, Alarm]'],
    ['wake me up at six thirty', '[SET_ALARM: 6:30, Wake up]'],
    ['set an alarm for 17:45 called gym', '[SET_ALARM: 5:45 PM, gym]'],
    ['set an alarm for noon', '[SET_ALARM: 12:00 PM, Alarm]'],
    ['set an alarm in 20 minutes', '[SET_TIMER: 1200, Alarm]']
  ]) assert.deepEqual(commands(phrase), [command], phrase);
  for (const [input, value] of [['7 am', '7:00 AM'], ['seven thirty', '7:30'], ['twelve oh five pm', '12:05 PM'], ['midnight', '12:00 AM'], ['07:00', '7:00 AM'], ['5 in the evening', '5:00 PM'], ['9 tonight', '9:00 PM'], ['tomorrow at 9', '9:00 tomorrow']]) assert.equal(clockTime(input), value, input);
  for (const input of ['25:00', '7 am tonight', 'half past seven', '7:75', '', 'soon']) assert.equal(clockTime(input), null, input);
  assert.equal(parse('set an alarm'), null);
});

test('stopping an alarm is explicit and a bare stop still means pause unless something rings', () => {
  for (const phrase of ['stop the alarm', 'turn off the alarm', 'stop the timer', 'cancel my reminder', 'dismiss']) assert.deepEqual(commands(phrase), ['[STOP_TIMER]'], phrase);
  assert.deepEqual(commands('cancel the Tea timer'), ['[CANCEL_TIMER: Tea]']);
  assert.deepEqual(commands('cancel all timers'), ['[CLEAR_ALL_TIMERS]']);
  for (const phrase of ['stop', 'stop it']) {
    const [action] = parse(phrase);
    assert.equal(action.command, '[MEDIA_PAUSE]'); assert.equal(action.stopsAlarm, true);
  }
  assert.equal(parse('pause the music')[0].stopsAlarm, undefined);
});

test('memories are saved only on an explicit request and keep the user wording', () => {
  assert.deepEqual(commands('remember that my locker code is 4312'), ['[REMEMBER: my locker code is 4312]']);
  assert.deepEqual(commands('please remember I parked on level 3'), ['[REMEMBER: I parked on level 3]']);
  assert.deepEqual(commands('remember that I like pizza and pasta'), ['[REMEMBER: I like pizza and pasta]']);
  assert.deepEqual(commands('open spotify and remember that I like jazz'), ['[OPEN_APP: spotify]', '[REMEMBER: I like jazz]']);
  assert.deepEqual(commands('what do you remember about me'), ['[MEMORY_STATUS]']);
  assert.deepEqual(commands('forget my locker code'), ['[FORGET: my locker code]']);
  assert.deepEqual(commands('forget everything you know about me'), ['[CLEAR_MEMORIES]']);
  for (const phrase of ['remember to buy milk', 'remember when we met', 'do you remember my name', 'remember that', 'forget']) assert.equal(parse(phrase), null, phrase);
});

test('briefing requests are recognized without capturing ordinary greetings or calendar questions', () => {
  for (const phrase of ['brief me', 'give me my morning briefing', 'daily briefing', 'how’s my day looking', "what's on my agenda today"]) assert.deepEqual(commands(phrase), ['[DAILY_BRIEFING]'], phrase);
  for (const phrase of ['good morning', 'what is on my calendar', 'brief me on the stock market']) assert.equal(parse(phrase), null, phrase);
});

test('half units extend durations without letting a trailing clause bypass validation', () => {
  assert.deepEqual(commands('set a timer for an hour and a half'), ['[SET_TIMER: 5400, Timer]']);
  assert.deepEqual(commands('set a timer for a minute and a half'), ['[SET_TIMER: 90, Timer]']);
  assert.deepEqual(commands('set a timer for two and a half hours called Tea and open chrome'), ['[SET_TIMER: 9000, Tea]', '[OPEN_APP: chrome]']);
  assert.equal(parse('play a song and a half'), null);
  assert.equal(parse('set a timer for an hour and a half and delete my files'), null);
});

test('the native media boundary accepts only bounded data and known operations', () => {
  assert.throws(() => normalizeMediaRequest({ action: 'SHELL', term: 'cmd' }), /Unsupported/);
  assert.throws(() => normalizeMediaRequest({ action: 'PLAYLIST' }), /Name/);
  assert.throws(() => normalizeMediaRequest({ action: 'PLAYLIST', term: 'x'.repeat(301) }), /Invalid/);
  assert.throws(() => normalizeMediaRequest({ action: 'PLAYLIST', term: 'name\ncommand' }), /Invalid/);
});
