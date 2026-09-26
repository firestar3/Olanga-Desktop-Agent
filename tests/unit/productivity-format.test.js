const test = require('node:test');
const assert = require('node:assert/strict');
const { formatCommand } = require('../../shared/productivity');
const { parse } = require('../../shared/fast-intents');

test('routine labels preserve exact percentages, timer durations and names without internal markers', () => {
  const cases = [
    ['[VOLUME_SET: 75]', 'Set system volume to 75%'],
    ['[VOLUME_SET: 12.5]', 'Set system volume to 12.5%'],
    ['[VOLUME_SET: 0]', 'Set system volume to 0%'],
    ['[SET_TIMER: 1200, Focus]', 'Start timer: 20 minutes · “Focus”'],
    ['[SET_TIMER: 3661, Tea, then walk]', 'Start timer: 1 hour 1 minute 1 second · “Tea, then walk”'],
    ['[SET_TIMER: 90, Breath & reset]', 'Start timer: 1 minute 30 seconds · “Breath & reset”'],
    ['[SET_TIMER: 86400, Tomorrow]', 'Start timer: 24 hours · “Tomorrow”'],
    ['[CANCEL_TIMER: Café timer]', 'Cancel timer: “Café timer”']
  ];
  for (const [command, expected] of cases) assert.equal(formatCommand(command), expected);
});

test('routine app and Spotify labels distinguish the exact target, layout and collection type', () => {
  const cases = [
    ['[OPEN_APP: Visual Studio Code]', 'Open app: “Visual Studio Code”'],
    ['[CLOSE_APP: Notepad]', 'Request app close: “Notepad”'],
    ['[ARRANGE_APP: Chrome, left]', 'Move “Chrome” to the left half'],
    ['[ARRANGE_APP: Edge, right]', 'Move “Edge” to the right half'],
    ['[ARRANGE_APP: Word, maximize]', 'Maximize “Word”'],
    ['[SPOTIFY_LIBRARY: My Mix, Vol. 2]', 'Play private Spotify playlist: “My Mix, Vol. 2”'],
    ['[SPOTIFY_PLAYLIST: Focus]', 'Play public Spotify playlist: “Focus”'],
    ['[SPOTIFY_SONG: Hello]', 'Play Spotify song: “Hello”'],
    ['[SPOTIFY_ALBUM: Hello]', 'Play Spotify album: “Hello”'],
    ['[SPOTIFY_ARTIST: Hello]', 'Play Spotify artist: “Hello”'],
    ['[SPOTIFY_LIKED]', 'Play your Spotify Liked Songs'],
    ['[SPOTIFY_RELOAD]', 'Restart Spotify and resume playback']
  ];
  for (const [command, expected] of cases) assert.equal(formatCommand(command), expected);
});

test('routine checklist labels retain literal text and dates, including punctuation and markup as text', () => {
  const cases = [
    ['[ADD_TASK: <b>Draft</b> & review]', 'Add task: “<b>Draft</b> & review”'],
    ['[ADD_TASK: Submit report, 2026-10-01]', 'Add task: “Submit report” · due “2026-10-01”'],
    ['[SET_TASK_DUE: Submit report, 2026-10-02]', 'Set due date for “Submit report” to “2026-10-02”'],
    ['[REMOVE_TASK: Buy bread, milk]', 'Remove task: “Buy bread, milk”'],
    ['[COMPLETE_TASK: Task 123]', 'Complete task: “Task 123”'],
    ['[UNCOMPLETE_TASK: Task 123]', 'Reopen task: “Task 123”']
  ];
  for (const [command, expected] of cases) assert.equal(formatCommand(command), expected);
});

test('parameterless controls have clear operation names and formatting never changes authoritative commands', () => {
  for (const [operation, label] of Object.entries({
    MEDIA_PLAY_PAUSE: 'Toggle play / pause', MEDIA_PLAY: 'Resume playback', MEDIA_PAUSE: 'Pause playback',
    MEDIA_STATUS: 'Check current playback', MEDIA_NEXT: 'Skip to next track', MEDIA_PREV: 'Go to previous track',
    VOLUME_UP: 'Turn system volume up', VOLUME_DOWN: 'Turn system volume down', VOLUME_STATUS: 'Check system volume',
    VOLUME_MUTE: 'Toggle system mute', VOLUME_MUTE_ON: 'Mute system audio', VOLUME_MUTE_OFF: 'Unmute system audio',
    MUTE_MIC: 'Mute microphone', UNMUTE_MIC: 'Unmute microphone', MUTE_TTS: 'Mute Olanga’s voice', UNMUTE_TTS: 'Unmute Olanga’s voice',
    CLEAR_ALL_TIMERS: 'Clear all timers', TIMER_STATUS: 'Check timers', CLEAR_ALL_TASKS: 'Clear all checklist tasks', TASK_STATUS: 'Check checklist'
  })) assert.equal(formatCommand(`[${operation}]`), label);
  const actions = parse('Open Spotify and raise the volume to 75%');
  const before = JSON.stringify(actions);
  assert.deepEqual(actions.map(action => formatCommand(action.command)), ['Open app: “Spotify”', 'Set system volume to 75%']);
  assert.equal(JSON.stringify(actions), before);
  for (const invalid of [null, 'Set volume', '[SET_TIMER: 5, x][VOLUME_SET: 90]']) assert.equal(formatCommand(invalid), 'Unavailable command');
});

test('reminders, alarms, memories and briefings stay readable in routine reviews', () => {
  for (const [command, expected] of [
    ['[SET_REMINDER: 5400, stretch]', 'Reminder in 1 hour 30 minutes: “stretch”'],
    ['[SET_ALARM: 7:00 AM tomorrow, Alarm]', 'Alarm at 7:00 AM tomorrow: “Alarm”'],
    ['[SET_ALARM: 5:30 PM, call mom, then dad]', 'Reminder at 5:30 PM: “call mom, then dad”'],
    ['[REMEMBER: my locker code is 4312]', 'Remember: “my locker code is 4312”'],
    ['[DAILY_BRIEFING]', 'Daily briefing'],
    ['[STOP_TIMER]', 'Stop the ringing alarm or timer']
  ]) assert.equal(formatCommand(command), expected);
});
