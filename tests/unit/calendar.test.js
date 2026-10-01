const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, date } = require('../../shared/calendar');
test('calendar handles UTC, timezone-aware events, folded text and escaped descriptions locally', () => {
  const source = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;TZID=America/Los_Angeles:20260930T090000\r\nDTEND;TZID=America/Los_Angeles:20260930T100000\r\nSUMMARY:Project\r\n  review\r\nDESCRIPTION:Read notes\\nBring a draft\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const result = parse(source, Date.parse('2026-09-29T00:00:00Z'));
  assert.equal(result.events[0].start, Date.parse('2026-09-30T16:00:00Z')); assert.equal(result.events[0].title, 'Project review'); assert.match(result.events[0].description, /notes\nBring/);
  assert.equal(date('20260930T160000Z'), result.events[0].start);
});
test('calendar excludes unsupported recurrence, cancelled and invalid events honestly', () => {
  const source = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260930T160000Z\nRRULE:FREQ=DAILY\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:20260230T160000Z\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:20260930T160000Z\nSTATUS:CANCELLED\nEND:VEVENT\nEND:VCALENDAR';
  const result = parse(source, Date.parse('2026-09-29')); assert.equal(result.events.length, 0); assert.equal(result.skipped, 3); assert.equal(result.recurrenceSupported, false);
  assert.equal(date('20260308T023000', 'TZID=America/Los_Angeles'), null);
  assert.equal(date('20260930T160000', 'TZID=Invalid/Zone'), null);
});
test('nested alarm text cannot replace the event title or time', () => {
  const result = parse('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260930T160000Z\nSUMMARY:Design review\nBEGIN:VALARM\nSUMMARY:Alarm\nDESCRIPTION:Alarm content\nEND:VALARM\nEND:VEVENT\nEND:VCALENDAR', Date.parse('2026-09-29'));
  assert.equal(result.events[0].title, 'Design review'); assert.equal(result.events[0].description, '');
});
test('clearing a calendar invalidates a pending native picker without importing later', async () => {
  let choose; const service = require('../../desktop/calendar-service').createCalendarService({ chooseFile: () => new Promise(resolve => { choose = resolve; }) });
  const pending = service.importFile(); service.clear(); choose('C:\\unused.ics'); assert.deepEqual(await pending, { cancelled: true }); assert.deepEqual(service.list().events, []);
});
