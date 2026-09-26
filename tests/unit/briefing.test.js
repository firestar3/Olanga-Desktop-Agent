const test = require('node:test');
const assert = require('node:assert/strict');
const { compose, greeting, headline } = require('../../shared/briefing');

const now = new Date(2026, 8, 26, 7, 30, 0);
const at = minutes => now.getTime() + minutes * 60000;

test('a briefing speaks the time, open tasks, upcoming timers and top headlines', () => {
  const text = compose({
    now,
    tasks: [{ text: 'Buy milk', completed: false }, { text: 'Done already', completed: true }, { text: 'Call Alex', completed: false }],
    timers: [
      { label: 'Tea', kind: 'timer', endTime: at(4) },
      { label: 'Alarm', kind: 'alarm', endTime: new Date(2026, 8, 27, 7, 0).getTime() },
      { label: 'stretch', kind: 'reminder', endTime: at(90) }
    ],
    headlines: ['Markets rally after rate decision - Reuters', 'Markets rally after rate decision - AP', 'Storm heads north?'],
    weather: 'Sunny and 72 degrees, with a high of 78'
  });
  assert.equal(text, "Good morning, Boss. It's 7:30 AM on Saturday, September 26. Sunny and 72 degrees, with a high of 78. " +
    'You have 2 open tasks: Buy milk and Call Alex. Coming up: the Tea timer with 4 minutes left, a reminder in 1 hour 30 minutes to stretch, and your alarm at 7:00 AM. ' +
    'In the news: Markets rally after rate decision. Storm heads north.');
});

test('a briefing stays useful with no data and caps long lists', () => {
  assert.equal(compose({ now }), "Good morning, Boss. It's 7:30 AM on Saturday, September 26. Your checklist is clear.");
  const tasks = ['One', 'Two', 'Three', 'Four', 'Five'].map(text => ({ text, completed: false }));
  const text = compose({ now, tasks, timers: [{ label: 'Tea', kind: 'timer', endTime: at(-1), ringing: true }, { label: 'Broken', endTime: 'soon' }] });
  assert.match(text, /You have 5 open tasks: One, Two, and Three, plus 2 more\./);
  assert.match(text, /Tea is ringing now\./);
  assert.doesNotMatch(text, /Broken/);
});

test('greetings follow the local hour and headlines drop publishers and punctuation', () => {
  assert.deepEqual([4, 5, 12, 17, 22].map(greeting), ['Hello', 'Good morning', 'Good afternoon', 'Good evening', 'Hello']);
  assert.equal(headline('  City council approves budget - The Local Paper  '), 'City council approves budget');
  assert.equal(headline('Is AI coming for your job?'), 'Is AI coming for your job');
  assert.equal(headline('Exclusive | Council rejects the plan - WSJ'), 'Council rejects the plan');
  assert.equal(headline('Live: Storm updates'), 'Storm updates');
});
