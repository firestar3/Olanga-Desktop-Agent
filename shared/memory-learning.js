/* Local, deliberately narrow memory extraction. Only direct user input belongs
   here: never pass model replies, documents, screen text or tool output. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaMemoryLearning = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SLOTS = ['name', 'city', 'units', 'measurement-units', 'answer-style', 'favorite-color', 'music-genre'];
  const MAX_INPUT = 4000;
  const MAX_CANDIDATES = 3;
  // Reject uncertain/reported/private/operational input rather than guessing.
  const UNSAFE = /[\[\]{}<>`"“”\r\n\x00-\x1f]|(?:^|\s)>|https?:\/\/|\b(?:password|passcode|pin|secret|token|api[ -]?key|credential|code|bank|account|credit|debit|salary|income|debt|loan|medical|health|diagnos\w*|medicat\w*|allerg\w*|therapy|pregnan\w*|sex\w*|gender|transgender|gay|lesbian|bisexual|psychiatr\w*|diabet\w*|cancer|hiv|depression|anxiety|religio\w*|politic\w*|passport|social security|ssn|address|street|apartment|zip|postal|phone|email|birthday|born|age)\b/i;
  const INDIRECT = /\b(?:if|unless|suppose|imagine|pretend|example|demo|fixture|test|hypothetic\w*|quoted?|says?|said|writes?|wrote|document|article|transcript|excerpt|pasted?|copied|following|reported|message|source|system|assistant|maybe|perhaps|might|would|could|should|not|never|no longer|used to|don['’]t|doesn['’]t|didn['’]t|isn['’]t|wasn['’]t|aren['’]t|can['’]t|won['’]t|instead of|rather than)\b/i;
  const META = /\b(?:sentence|statement|phrase|wording|grammar|quotation|fiction|fictional|character|roleplay|role-play)\b/i;
  const COMMAND = /\b(?:open|launch|close|quit|install|download|delete|forget|remember|save|send|execute|run|click|type|translate|summari[sz]e|paraphrase|rewrite|transcribe|repeat|print|permission|approve|consent|authorize|automatically|always allow|ignore|bypass)\b/i;
  const COLORS = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'violet', 'pink', 'black', 'white', 'gray', 'grey', 'brown', 'teal', 'cyan', 'indigo', 'gold', 'silver']);
  const GENRES = new Set(['jazz', 'classical', 'rock', 'pop', 'hip hop', 'hip-hop', 'electronic', 'ambient', 'instrumental', 'lo-fi', 'lofi', 'country', 'folk', 'blues', 'metal', 'soul', 'r&b', 'reggae']);
  // Fold accents for matching only; saved names and facts keep their exact text.
  const words = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const STOP = new Set(['i', 'me', 'my', 'a', 'an', 'the', 'is', 'am', 'are', 'was', 'be', 'been', 'in', 'at', 'on', 'to', 'of', 'and', 'or', 'for', 'that', 'this', 'with', 'it', 'do', 'does', 'did', 'what', 'how', 'can', 'you', 'your', 'please', 'tell', 'about', 'prefer', 'like', 'favorite', 'favourite', 'have', 'has', 'now']);
  const TERM_ALIASES = new Map([['colour', 'color'], ['colours', 'color'], ['colors', 'color'], ['projects', 'project'], ['launches', 'launch'], ['meetings', 'meeting'], ['deadlines', 'deadline'], ['restaurants', 'restaurant']]);
  function termsOf(text) {
    const result = new Set();
    for (const word of words(text)) if (word.length > 1 && !STOP.has(word)) result.add(TERM_ALIASES.get(word) || word);
    return result;
  }
  function sentencesOf(input) {
    const result = []; let start = 0;
    const boundaries = /[.!;](?:\s+|$)/g;
    for (let match = boundaries.exec(input); match; match = boundaries.exec(input)) {
      const word = /([\p{L}]+)$/u.exec(input.slice(start, match.index))?.[1] || '';
      if (match[0][0] === '.' && match.index + match[0].length < input.length && (/^[A-Za-z]$/.test(word) || /^(?:st|mt|ft|dr|mr|mrs|ms|jr|sr)$/i.test(word))) continue;
      result.push(input.slice(start, match.index).trim()); start = match.index + match[0].length;
    }
    if (input.slice(start).trim()) result.push(input.slice(start).trim().replace(/[.!;]+$/, ''));
    return result.filter(Boolean);
  }
  const titleValue = (value, max) => typeof value === 'string' && value.length <= max && /^[\p{L}][\p{L}\p{M} .'’\-]*[\p{L}\p{M}]$|^[\p{L}]$/u.test(value) && value.split(/\s+/).length <= 5 && !UNSAFE.test(value) && !INDIRECT.test(value) && !COMMAND.test(value) && !/\b(?:and|or|but|then|because|prefer|like|love|want|need|think|live|work|please)\b/i.test(value) ? value : null;

  function factQuestionParts(text) {
    if (typeof text !== 'string' || text.length > MAX_INPUT) return null;
    const input = text.trim().replace(/[’]/g, "'");
    // A separately spoken information question can follow a real fact. Keep
    // whole-turn privacy/reporting safeguards; never mine quoted examples or
    // a language exercise containing first-person wording.
    if (!input || UNSAFE.test(input) || INDIRECT.test(input) || COMMAND.test(input) || META.test(input)) return null;
    const statements = sentencesOf(input);
    if (statements.length < 2 || statements.length > MAX_CANDIDATES + 1) return null;
    const question = statements.at(-1);
    if (!/^(?:what(?:'s)?|why|how|where|when|who|which)\b[^?¿]*\??$/i.test(question) || /\b(?:set|raise|lower|mute|unmute|turn|play|pause|resume|skip|stop|cancel|add|remove|complete|restart|reload|arrange|move|snap|maximize|minimize|scroll|record|capture)\b/i.test(question)) return null;
    const prefix = statements.slice(0, -1).join('. ');
    if (/[?¿]/.test(prefix) || !isFactOnly(prefix)) return null;
    return { prefix, question };
  }
  function questionAfterFacts(text) { return factQuestionParts(text)?.question || null; }

  function extract(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_INPUT) return [];
    const input = text.trim().replace(/[’]/g, "'");
    // A complete supported fact prefix before a separate information question
    // can be learned. No text inside the question becomes a candidate.
    if (/[?¿]/.test(input)) { const mixed = factQuestionParts(input); return mixed ? extract(mixed.prefix) : []; }
    if (UNSAFE.test(input) || INDIRECT.test(input) || COMMAND.test(input) || /^(?:what|why|how|where|when|who|which|can|could|would|do|does|did|is|are)\b/i.test(input)) return [];
    const sentences = sentencesOf(input);
    if (sentences.length > 6 || sentences.length > 1 && META.test(input)) return [];
    if (sentences.length > 1 && /^(?:what(?:'s)?|why|how|where|when|who|which)\b/i.test(sentences.at(-1))) { const mixed = factQuestionParts(input); return mixed ? extract(mixed.prefix) : []; }
    const candidates = [];
    for (const raw of sentences) {
      const sentence = raw.replace(/^actually[, ]+\s*/i, '');
      let match, candidate;
      if ((match = /^(?:my name(?: is(?: now)?|'s)|i go by|i(?:'m| am) called)\s+(.+)$/i.exec(sentence))) {
        const value = titleValue(match[1], 60);
        if (value && !/\b(?:your|you|assistant|olanga|system|admin|administrator|boss|owner)\b/i.test(value)) candidate = { slot: 'name', text: `My name is ${value}` };
      } else if ((match = /^(?:my city is|i live in|i(?:'m| am) based in|i (?:now )?live in|i(?:'ve| have) moved to|i moved to)\s+(.+)$/i.exec(sentence))) {
        const value = titleValue(match[1], 80);
        if (value && !/\b(?:a|an|the|on|near|at|with|because|since|temporarily|today|tonight|week|month|year|hotel|hospital|shelter|office|school|ward|clinic|prison|thanks)\b/i.test(value)) candidate = { slot: 'city', text: `I live in ${value}` };
      } else if ((match = /^i (?:prefer|use)\s+(celsius|fahrenheit|metric|imperial)(?:\s+(?:units|temperatures|temperature units))?$/i.exec(sentence))) {
        const value = match[1].toLowerCase();
        candidate = { slot: ['celsius', 'fahrenheit'].includes(value) ? 'units' : 'measurement-units', text: `I prefer ${['celsius', 'fahrenheit'].includes(value) ? value[0].toUpperCase() + value.slice(1) : value + ' units'}` };
      } else if ((match = /^i (?:prefer|like)\s+(?:(brief|short|concise|detailed|thorough)\s+(?:answers|replies|responses|explanations)|(?:answers|replies|responses|explanations)\s+(?:that are|to be)\s+(brief|short|concise|detailed|thorough))$/i.exec(sentence))) {
        const value = ['brief', 'short', 'concise'].includes((match[1] || match[2]).toLowerCase()) ? 'concise' : 'detailed';
        candidate = { slot: 'answer-style', text: `I prefer ${value} answers` };
      } else if ((match = /^my favou?rite colou?r is\s+(.+)$/i.exec(sentence)) && COLORS.has(match[1].toLowerCase())) {
        candidate = { slot: 'favorite-color', text: `My favorite color is ${match[1].toLowerCase()}` };
      } else if ((match = /^(?:my favou?rite (?:music(?: genre)?|kind of music) is|i (?:prefer|like))\s+(.+?)(?: music)?$/i.exec(sentence)) && GENRES.has(match[1].toLowerCase())) {
        candidate = { slot: 'music-genre', text: `I prefer ${match[1].toLowerCase()} music` };
      }
      if (candidate) candidates.push(candidate);
    }
    // Multiple different values for one slot in a turn are ambiguous. Do not
    // pick whichever clause happened to be last.
    const result = [];
    for (const slot of SLOTS) {
      const entries = candidates.filter(item => item.slot === slot);
      const distinct = [...new Map(entries.map(item => [item.text.toLocaleLowerCase(), item])).values()];
      if (distinct.length === 1) result.push(distinct[0]);
    }
    return result.slice(0, MAX_CANDIDATES);
  }

  function querySlots(query) {
    const scores = new Map();
    const personal = /\b(?:do i (?:prefer|use)|units i (?:prefer|use)|my preferred (?:temperature|measurement) (?:units?|scale|system))\b/i.test(query);
    const explicitStyle = /\b(?:briefly|concisely|in detail|in depth)\b|\b(?:brief|short|concise|detailed|thorough)\s+(?:answer|reply|response|explanation)s?\b|\b(?:be|keep|make|give|answer|respond|reply|explain)\b.{0,45}\b(?:brief|short|concise|detailed|thorough)\b/i.test(query);
    if (!explicitStyle) scores.set('answer-style', 2);
    if (/\b(?:my name|who am i|call me|greet|greeting|introduction)\b/i.test(query)) scores.set('name', 8);
    const local = /\b(?:where i live|my city|nearby|local|here|location|restaurants?|time zone)\b|\b(?:what|which) city\b|\bwhere\b.{0,20}\blive\b/i.test(query);
    const weather = /\b(?:weather|forecast|temperature)\b/i.test(query);
    // A destination in the current request takes precedence over a home city.
    // Temporal phrases and "my city" are not destinations.
    const destination = /\b(?:weather|forecast|temperature)\b.{0,100}?\b(?:in|for|at)\s+(?!my\b|our\b|home\b|here\b|today\b|tomorrow\b|tonight\b|this\b|next\b|the\b|a\b|an\b|celsius\b|fahrenheit\b|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b|ten\b|spring\b|summer\b|autumn\b|fall\b|winter\b|january\b|february\b|march\b|april\b|may\b|june\b|july\b|august\b|september\b|october\b|november\b|december\b|\d)([\p{L}])/iu.test(query);
    if (local || weather && !destination) scores.set('city', 8);
    if ((personal || !/\b(?:celsius|fahrenheit)\b|°\s*[cf]\b/i.test(query)) && /\b(?:temperature|weather|forecast|celsius|fahrenheit|units)\b/i.test(query)) scores.set('units', 8);
    if ((personal || !/\b(?:metric|imperial)\b/i.test(query)) && /\b(?:distance|units|miles?|kilometers?|kilometres?|km|centimeters?|centimetres?|cm|meters?|metres?|height|weight|measure|measurement|speed|length|width)\b/i.test(query)) scores.set('measurement-units', 8);
    if (/\b(?:colou?r|theme|design|decorate|decoration)\b/i.test(query)) scores.set('favorite-color', 6);
    if (/\b(?:music|songs?|playlists?|albums?|artists?|listen|spotify)\b/i.test(query)) scores.set('music-genre', 6);
    return { scores, explicitStyle, explicitTemperature: !personal && /\b(?:celsius|fahrenheit)\b|°\s*[cf]\b/i.test(query), explicitMeasurement: !personal && /\b(?:metric|imperial)\b/i.test(query) };
  }

  // This index belongs to one store revision. It holds at most 50 short facts,
  // never query text, and is discarded when the store changes. Classification,
  // and tokenization happen once instead of every turn.
  function createSelector(facts) {
    const entries = [], ids = new Set();
    for (const fact of Array.isArray(facts) ? facts.slice(0, 50) : []) {
      if (typeof fact?.id !== 'string' || !fact.id || ids.has(fact.id) || typeof fact.text !== 'string' || !fact.text.trim() || fact.text.length > 300) continue;
      ids.add(fact.id);
      const classified = classifyFact(fact.text);
      const slot = classified?.slot || null;
      // Stored slots are validated on load; do not trust an arbitrary caller's
      // mismatched slot to make unrelated text part of every response.
      if (fact.slot && fact.slot !== slot) continue;
      const entry = { id: fact.id, text: fact.text, slot, terms: termsOf(fact.text), order: entries.length, at: Number.isFinite(fact.updatedAt) ? fact.updatedAt : Number.isFinite(fact.at) ? fact.at : 0 };
      entries.push(entry);
    }
    return function selectQuery(query, { maxFacts = 8, maxChars = 1800 } = {}) {
      const count = Number.isInteger(maxFacts) ? Math.max(0, Math.min(12, maxFacts)) : 8;
      const budget = Number.isInteger(maxChars) ? Math.max(0, Math.min(3000, maxChars)) : 1800;
      if (!count || !budget || typeof query !== 'string' || !query.trim() || query.length > MAX_INPUT || !entries.length) return [];
      const ranked = [], intents = querySlots(query), terms = termsOf(query);
      for (const entry of entries) {
        // Explicit instructions win even when the old preference shares words
        // with the request. Each matched word counts once, never by repetition.
        if (entry.slot === 'answer-style' && intents.explicitStyle || entry.slot === 'units' && intents.explicitTemperature || entry.slot === 'measurement-units' && intents.explicitMeasurement) continue;
        let score = intents.scores.get(entry.slot) || 0;
        for (const term of entry.terms) if (terms.has(term)) score++;
        if (score) ranked.push([entry, score]);
      }
      ranked.sort(([left, a], [right, b]) => b - a || right.at - left.at || left.order - right.order);
      const result = []; let used = 0;
      for (const [entry] of ranked) {
        if (result.length >= count) break;
        if (used + entry.text.length > budget) continue;
        result.push({ id: entry.id, text: entry.text }); used += entry.text.length;
      }
      return result;
    };
  }
  function select(facts, query, options) { return createSelector(facts)(query, options); }
  function classifyFact(text) {
    if (typeof text !== 'string' || !/^(?:actually[, ]+\s*)?(?:my\s|i[ '’])/i.test(text.trim()) || sentencesOf(text.trim()).length !== 1) return null;
    const candidates = extract(text);
    return candidates.length === 1 ? candidates[0] : null;
  }
  // Used only to withhold shortcuts or protect an explicit saved record. A
  // supported sentence inside a compound memory is never promoted to a fact:
  // extraction must retain its whole-input privacy and ambiguity safeguards.
  function mentionsSlot(text, slot) {
    if (typeof text !== 'string' || text.length > MAX_INPUT || !SLOTS.includes(slot)) return false;
    return sentencesOf(text.trim()).some(sentence => classifyFact(sentence)?.slot === slot);
  }
  const RECALL_QUESTIONS = [
    ['name', /^(?:what(?: is|'s) my name|who am i|tell me my name)$/i],
    ['city', /^(?:where do i live|where am i based|what(?: is|'s) my city|(?:what|which) city do i live in|tell me (?:my city|where i live))$/i],
    ['units', /^(?:(?:what|which) temperature (?:units|scale) do i (?:prefer|use)|do i prefer (?:celsius or fahrenheit|fahrenheit or celsius)|what(?: is|'s) my preferred temperature (?:unit|scale))$/i],
    ['measurement-units', /^(?:(?:what|which) measurement (?:units|system) do i (?:prefer|use)|do i prefer (?:metric or imperial|imperial or metric)(?: units)?|what(?: is|'s) my preferred measurement system)$/i],
    ['answer-style', /^(?:how do i prefer my (?:answers|replies|responses)|do i prefer (?:concise or detailed|detailed or concise) (?:answers|replies|responses)|what(?: is|'s) my preferred (?:answer|response) style)$/i],
    ['favorite-color', /^(?:what(?: is|'s) my favou?rite colou?r|which colou?r is my favou?rite|tell me my favou?rite colou?r)$/i],
    ['music-genre', /^(?:what(?: is|'s) my favou?rite (?:music(?: genre)?|kind of music)|what(?: kind of)? music do i (?:prefer|like)|which music genre do i (?:prefer|like)|tell me my favou?rite music genre)$/i]
  ];
  function recall(facts, question) {
    if (typeof question !== 'string' || question.length > 250 || /[\[\]{}<>`"“”\r\n\x00-\x1f]/.test(question)) return null;
    const input = question.trim().replace(/[’]/g, "'").replace(/\s+/g, ' ').replace(/[?!.]+$/, '').replace(/^please,?\s+/i, '').replace(/,?\s+please$/i, '').replace(/^(?:can|could|would) you (?:please )?tell me\s+/i, '');
    const slot = RECALL_QUESTIONS.find(([, pattern]) => pattern.test(input))?.[0];
    if (!slot) return null;
    let result = null;
    for (const fact of Array.isArray(facts) ? facts.slice(0, 50) : []) {
      if (typeof fact?.id !== 'string' || !fact.id || typeof fact.text !== 'string' || fact.text.length > 300) continue;
      const classified = classifyFact(fact.text);
      const relevant = classified ? classified.slot === slot : mentionsSlot(fact.text, slot);
      if (!relevant) continue;
      // A compound memory or two saved values requires normal clarification;
      // the local shortcut must never pick one or disclose unrelated details.
      if (!classified || result) return null;
      result = { id: fact.id, text: fact.text, slot, answer: classified.text.replace(/^My /, 'Your ').replace(/^I /, 'You ') + '.' };
    }
    return result;
  }
  function isFactOnly(text) {
    if (typeof text !== 'string') return false;
    const sentences = sentencesOf(text.trim()), candidates = extract(text);
    if (!sentences.length || sentences.length > MAX_CANDIDATES || !candidates.length) return false;
    return sentences.every(sentence => {
      const candidate = classifyFact(sentence);
      return candidate && candidates.some(item => item.slot === candidate.slot && item.text === candidate.text);
    });
  }
  return { extract, classifyFact, mentionsSlot, isFactOnly, questionAfterFacts, select, createSelector, recall, SLOTS, MAX_INPUT, MAX_CANDIDATES };
});
