/* Conversation lanes and streaming text helpers shared by the renderer and
   tests. Pure text processing: nothing here performs a request or an action. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaConversation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Requests that touch Olanga's tools, the screen or the desktop keep the
  // full router with its validated action proposals.
  const ACTION = /\b(?:open|launch|close|quit|exit|play|put on|pause|resume|skip|stop|turn (?:it |the volume |the sound )?(?:up|down|on|off)|volume|mute|unmute|louder|quieter|set|cancel|remind|alarm|timer|timers|wake me|add|remove|delete|complete|check off|mark|clear|remember|forget|move|snap|maximize|minimize|arrange|type|click|scroll|edit|fix|rewrite|restart|reload|install|download|send|email|screenshot|record)\b/i;
  const DOMAIN = /\b(?:screen|window|error|errors|spotify|songs?|music|playlists?|album|artist|track|alarms?|reminders?|tasks?|checklist|to-?do|memory|memories|routines?|desktop|apps?|files?|folders?|settings?|microphone|mic|brief|briefing|olanga)\b|\bwhat(?:'s| is) (?:this|that)\b|\blooking at\b/i;
  const LIVE = /\b(?:weather|forecast|temperature|raining|rain|snowing|snow|humidity|news|headlines?|scores?|standings|stocks?|share price|price of|bitcoin|crypto|exchange rate|traffic|election|who won|won the|latest)\b/i;
  const CONVERSATIONAL = /^(?:what|what's|whats|who|who's|whom|whose|where|where's|when|why|how|how's|which|is|are|was|were|do|does|did|can|could|would|should|will|shall|tell me|explain|describe|define|give me|teach me|help me understand|compare|summarize|translate|hi|hello|hey there|good (?:morning|afternoon|evening|night)|thanks|thank you|i'm|i am|i feel|i think|let's|lets)\b/i;

  // 'answer': a question or small talk for the streamed answer lane.
  // 'search': live information for the streamed Google Search lane.
  // 'router': everything else, including pending clarifications.
  function classify(text, context = {}) {
    const value = String(text || '').trim().replace(/[’‘]/g, "'").replace(/^(?:(?:hey\s+)?olanga[, ]+)/i, '');
    if (!value || value.length > 400 || context.pending) return 'router';
    if (ACTION.test(value) || DOMAIN.test(value)) return 'router';
    if (LIVE.test(value)) return 'search';
    return CONVERSATIONAL.test(value) ? 'answer' : 'router';
  }

  const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'u.s', 'u.k', 'no', 'approx', 'inc', 'ltd', 'mt', 'ft', 'a.m', 'p.m']);
  // Returns speakable pieces as soon as a sentence ends. A long run without
  // punctuation breaks at a comma or space so audio keeps flowing.
  function createSentenceSplitter({ maxChars = 220 } = {}) {
    let buffer = '';
    const take = index => { const piece = buffer.slice(0, index).trim(); buffer = buffer.slice(index); return piece; };
    function boundary() {
      const pattern = /[.!?…]+["')\]]*(?=\s)|\n+/g;
      for (let match = pattern.exec(buffer); match; match = pattern.exec(buffer)) {
        if (match[0][0] !== '\n' && match[0] === '.') {
          const word = (/([A-Za-z.]+)$/.exec(buffer.slice(0, match.index))?.[1] || '').toLowerCase();
          if (ABBREVIATIONS.has(word) || /^[a-z]$/.test(word)) continue;
        }
        return match.index + match[0].length;
      }
      return -1;
    }
    return {
      push(text) {
        buffer += String(text || '');
        const pieces = [];
        for (let end = boundary(); end > 0; end = boundary()) { const piece = take(end); if (piece) pieces.push(piece); }
        if (buffer.length > maxChars) {
          const comma = buffer.lastIndexOf(', ', maxChars);
          const cut = comma > 40 ? comma + 1 : buffer.lastIndexOf(' ', maxChars);
          if (cut > 40) { const piece = take(cut); if (piece) pieces.push(piece); }
        }
        return pieces;
      },
      flush() { const piece = buffer.trim(); buffer = ''; return piece ? [piece] : []; }
    };
  }

  const ESCAPES = Object.freeze({ SEARCH: 'search', ROUTE: 'router', SILENCE: 'silence' });
  // Parses a streamed reply. With expectTranscript, the reply must begin with
  // "USER_SAID: …" so the caller can verify the words before anything is
  // spoken. A reply that starts with a bracket marker escapes; markers later
  // in an answer are dropped. Events: transcript, escape and text.
  function createReplyParser({ expectTranscript = false, escapes = true } = {}) {
    let buffer = '', held = '', answer = '', phase = expectTranscript ? 'transcript' : 'start';
    let events = [];
    function emitText(text) {
      held += text;
      let output = '';
      for (;;) {
        const open = held.indexOf('[');
        if (open < 0) { output += held; held = ''; break; }
        output += held.slice(0, open);
        const close = held.indexOf(']', open);
        if (close < 0) { if (held.length - open > 80) { output += held.slice(open); held = ''; } else held = held.slice(open); break; }
        held = held.slice(close + 1);
      }
      if (output) { answer += output; events.push({ type: 'text', text: output }); }
    }
    function escape(route) { events.push({ type: 'escape', route }); phase = 'done'; buffer = ''; }
    function run(final) {
      if (phase === 'transcript') {
        const head = buffer.trimStart();
        const label = /^USER_SAID:/i.exec(head);
        if (!label) {
          if (final || !'USER_SAID:'.startsWith(head.slice(0, 10).toUpperCase())) escape('classic');
          return;
        }
        const rest = head.slice(label[0].length);
        const end = rest.search(/\n|RESPONSE:/i);
        if (end < 0 && !final) return;
        const raw = (end < 0 ? rest : rest.slice(0, end)).trim();
        const silence = !raw || /^\[?\s*silence\s*\]?$/i.test(raw);
        events.push({ type: 'transcript', text: silence ? '' : raw.replace(/^\[([^\[\]]+)\]$/, '$1').trim(), silence });
        buffer = end < 0 ? '' : rest.slice(end);
        phase = silence ? 'done' : 'label';
        if (silence) return;
      }
      if (phase === 'label') {
        const label = /RESPONSE:/i.exec(buffer);
        if (label) { buffer = buffer.slice(label.index + label[0].length); phase = 'start'; }
        else if (final) { phase = 'done'; return; }
        else if (buffer.trim().length > 40) phase = 'start';
        else return;
      }
      if (phase === 'start') {
        let head = buffer.trimStart().replace(/^RESPONSE:\s*/i, '');
        if (!head) { if (final) phase = 'done'; return; }
        if (escapes && head[0] === '[') {
          const close = head.indexOf(']');
          if (close < 0 && !final && head.length < 40) return;
          const marker = close < 0 ? '' : head.slice(1, close).trim().toUpperCase();
          escape(ESCAPES[marker] || 'router');
          return;
        }
        phase = 'answer'; buffer = head;
      }
      if (phase === 'answer') {
        emitText(buffer); buffer = '';
        if (final) { held = ''; phase = 'done'; }
      }
    }
    return {
      push(delta) { if (phase === 'done') return []; buffer += String(delta || ''); events = []; run(false); return events; },
      end() { if (phase === 'done') return []; events = []; run(true); return events; },
      get answer() { return answer.trim(); }
    };
  }

  // Parses a complete reply with the same rules as the streaming parser.
  function parseReply(text, options) {
    const parser = createReplyParser(options);
    const result = { transcript: null, silence: false, escape: null };
    for (const event of [...parser.push(text), ...parser.end()]) {
      if (event.type === 'transcript') { result.transcript = event.text; result.silence = event.silence; }
      if (event.type === 'escape') result.escape = event.route;
    }
    result.answer = parser.answer;
    return result;
  }

  return { classify, createSentenceSplitter, createReplyParser, parseReply };
});
