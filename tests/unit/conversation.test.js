const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, createSentenceSplitter, createReplyParser, parseReply } = require('../../shared/conversation');

test('questions and small talk take the answer lane while tools, screen and pending work keep the router', () => {
  for (const text of ['What is the capital of Australia?', 'how does a black hole form', 'Tell me a joke', 'Explain quantum entanglement simply', 'Good morning', 'thank you', 'Hey Olanga, who painted the Mona Lisa?', "I'm bored"]) assert.equal(classify(text), 'answer', text);
  for (const text of ["What's the weather tomorrow?", 'Any news about SpaceX?', 'Who won the game last night', 'What is the price of bitcoin']) assert.equal(classify(text), 'search', text);
  for (const text of ['put on some jazz', 'can you open my browser', 'what song is this', "what's on my screen", 'what is this error', 'is my alarm set', 'what do I have on my to-do list', 'close Discord', 'turn it up', 'the second one', 'yes please', 'x'.repeat(401), '']) assert.equal(classify(text), 'router', text);
  assert.equal(classify('What is the capital of France?', { pending: true }), 'router');
});

test('sentences stream out as soon as they end without splitting decimals, initials or abbreviations', () => {
  const splitter = createSentenceSplitter();
  const pieces = [];
  for (const chunk of ['Dr. Smith measured 3', '.5 liters. J. K. Rowling wrote it', ', e.g. in 1997! Really? Yes', '\nNew line']) pieces.push(...splitter.push(chunk));
  pieces.push(...splitter.flush());
  assert.deepEqual(pieces, ['Dr. Smith measured 3.5 liters.', 'J. K. Rowling wrote it, e.g. in 1997!', 'Really?', 'Yes', 'New line']);
  const long = createSentenceSplitter({ maxChars: 60 });
  const early = long.push('This sentence keeps going without any punctuation, so it should break at a comma early');
  assert.equal(early.length, 1);
  assert.match(early[0], /^This sentence keeps going without any punctuation,$/);
  assert.deepEqual(long.flush(), ['so it should break at a comma early']);
});

test('a spoken reply reveals its transcript first and escapes before any answer text', () => {
  const parser = createReplyParser({ expectTranscript: true });
  const events = [];
  for (const chunk of ['USER_', 'SAID: What is the capital', ' of Australia?\nRESP', 'ONSE: Canberra', ' is the capital.']) events.push(...parser.push(chunk));
  events.push(...parser.end());
  assert.deepEqual(events.map(event => event.type), ['transcript', 'text', 'text']);
  assert.equal(events[0].text, 'What is the capital of Australia?');
  assert.equal(parser.answer, 'Canberra is the capital.');
  for (const [reply, route] of [['USER_SAID: weather in Paris\nRESPONSE: [SEARCH]', 'search'], ['USER_SAID: open chrome\nRESPONSE: [ROUTE]', 'router'], ['USER_SAID: close it\nRESPONSE: [CLOSE_APP: Chrome]', 'router'], ['RESPONSE: Hello there', 'classic']]) {
    assert.equal(parseReply(reply, { expectTranscript: true }).escape, route, reply);
    assert.equal(parseReply(reply, { expectTranscript: true }).answer, '', reply);
  }
  const silent = parseReply('USER_SAID: [SILENCE]', { expectTranscript: true });
  assert.deepEqual([silent.silence, silent.transcript, silent.answer], [true, '', '']);
  assert.equal(parseReply('USER_SAID: [Tell me a joke]\nRESPONSE: Sure.', { expectTranscript: true }).transcript, 'Tell me a joke');
});

test('typed answers stream plain text and drop bracket markers that appear later', () => {
  const parser = createReplyParser();
  const texts = [];
  for (const chunk of ['Sure, here', ' is one [OPEN_A', 'PP: powershell] joke. [FOLLOW', '_UP]']) for (const event of parser.push(chunk)) texts.push(event.text);
  parser.end();
  assert.equal(texts.join(''), 'Sure, here is one  joke. ');
  assert.equal(parser.answer, 'Sure, here is one  joke.');
  assert.equal(parseReply('[SEARCH]').escape, 'search');
  assert.equal(parseReply('  [ROUTE] ').escape, 'router');
  assert.equal(parseReply('RESPONSE: Canberra.').answer, 'Canberra.');
  assert.equal(parseReply('[unterminated marker that never closes').escape, 'router');
});

test('a RESPONSE label split at any boundary is withheld before answering or escaping', () => {
  for (const full of ['RESPONSE: [ROUTE]', '  RESPONSE: [SEARCH]', 'response: Canberra is the capital.', 'Respect takes time.']) {
    const expected = parseReply(full);
    const splits = [...Array(full.length - 1)].map((_, index) => [full.slice(0, index + 1), full.slice(index + 1)]);
    splits.push([...full]);
    for (const chunks of splits) {
      const parser = createReplyParser();
      const events = chunks.flatMap(chunk => parser.push(chunk));
      events.push(...parser.end());
      assert.equal(parser.answer, expected.answer, JSON.stringify(chunks));
      assert.equal(events.find(event => event.type === 'escape')?.route || null, expected.escape, JSON.stringify(chunks));
      assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), expected.answer, JSON.stringify(chunks));
    }
  }
  const plain = createReplyParser();
  assert.deepEqual(plain.push('Res'), []);
  assert.deepEqual(plain.end(), [{ type: 'text', text: 'Res' }], 'A final partial word remains ordinary text');
});
