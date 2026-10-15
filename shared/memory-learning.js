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
  const COMMAND = /\b(?:open|launch|close|quit|install|download|delete|forget|remember|save|send|execute|run|click|type|translate|summari[sz]e|paraphrase|rewrite|transcribe|repeat|print|permission|approve|consent|authorize|automatically|always allow|ignore|bypass)\b/i;
  const COLORS = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'violet', 'pink', 'black', 'white', 'gray', 'grey', 'brown', 'teal', 'cyan', 'indigo', 'gold', 'silver']);
  const GENRES = new Set(['jazz', 'classical', 'rock', 'pop', 'hip hop', 'hip-hop', 'electronic', 'ambient', 'instrumental', 'lo-fi', 'lofi', 'country', 'folk', 'blues', 'metal', 'soul', 'r&b', 'reggae']);
  const words = value => String(value || '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const STOP = new Set(['i', 'me', 'my', 'a', 'an', 'the', 'is', 'am', 'are', 'in', 'to', 'of', 'and', 'for', 'that', 'with', 'it', 'do', 'does', 'what', 'how', 'can', 'you', 'your', 'please', 'tell', 'about']);
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

  function extract(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_INPUT) return [];
    const input = text.trim().replace(/[’]/g, "'");
    // Questions and quotations can contain first-person examples. The whole
    // input is skipped so their embedded wording cannot become a memory.
    if (/[?¿]/.test(input) || UNSAFE.test(input) || INDIRECT.test(input) || COMMAND.test(input) || /^(?:what|why|how|where|when|who|which|can|could|would|do|does|did|is|are)\b/i.test(input)) return [];
    const sentences = sentencesOf(input);
    if (sentences.length > 6) return [];
    const candidates = [];
    for (const raw of sentences) {
      const sentence = raw.replace(/^actually[, ]+\s*/i, '');
      let match, candidate;
      if ((match = /^(?:my name is(?: now)?|i go by)\s+(.+)$/i.exec(sentence))) {
        const value = titleValue(match[1], 60);
        if (value && !/\b(?:your|you|assistant|olanga|system|admin|administrator|boss|owner)\b/i.test(value)) candidate = { slot: 'name', text: `My name is ${value}` };
      } else if ((match = /^(?:my city is|i live in|i(?:'m| am) based in|i (?:now )?live in|i(?:'ve| have) moved to|i moved to)\s+(.+)$/i.exec(sentence))) {
        const value = titleValue(match[1], 80);
        if (value && !/\b(?:a|an|the|on|near|at|with|because|since|temporarily|today|tonight|week|month|year|hotel|hospital|shelter|office|school|ward|clinic|prison|thanks)\b/i.test(value)) candidate = { slot: 'city', text: `I live in ${value}` };
      } else if ((match = /^i (?:prefer|use)\s+(celsius|fahrenheit|metric|imperial)(?:\s+(?:units|temperatures|temperature units))?$/i.exec(sentence))) {
        const value = match[1].toLowerCase();
        candidate = { slot: ['celsius', 'fahrenheit'].includes(value) ? 'units' : 'measurement-units', text: `I prefer ${['celsius', 'fahrenheit'].includes(value) ? value[0].toUpperCase() + value.slice(1) : value + ' units'}` };
      } else if ((match = /^i (?:prefer|like)\s+(brief|short|concise|detailed|thorough)(?:\s+(?:answers|replies|responses|explanations))$/i.exec(sentence))) {
        const value = ['brief', 'short', 'concise'].includes(match[1].toLowerCase()) ? 'concise' : 'detailed';
        candidate = { slot: 'answer-style', text: `I prefer ${value} answers` };
      } else if ((match = /^my favou?rite colou?r is\s+(.+)$/i.exec(sentence)) && COLORS.has(match[1].toLowerCase())) {
        candidate = { slot: 'favorite-color', text: `My favorite color is ${match[1].toLowerCase()}` };
      } else if ((match = /^(?:my favou?rite (?:music genre|kind of music) is|i prefer)\s+(.+?)(?: music)?$/i.exec(sentence)) && GENRES.has(match[1].toLowerCase())) {
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

  function select(facts, query, { maxFacts = 8, maxChars = 1800 } = {}) {
    const count = Number.isInteger(maxFacts) ? Math.max(0, Math.min(12, maxFacts)) : 8;
    const budget = Number.isInteger(maxChars) ? Math.max(0, Math.min(3000, maxChars)) : 1800;
    if (!count || !budget || typeof query !== 'string' || query.length > MAX_INPUT) return [];
    const terms = new Set(words(query).filter(word => word.length > 1 && !STOP.has(word)));
    const scored = [];
    for (const fact of Array.isArray(facts) ? facts.slice(0, 50) : []) {
      if (typeof fact?.id !== 'string' || typeof fact.text !== 'string') continue;
      const overlap = words(fact.text).filter(word => terms.has(word)).length;
      let score = overlap;
      if (fact.slot === 'answer-style') score += 2;
      if (fact.slot === 'name' && /\b(?:my name|who am i|call me|greet|greeting|introduction)\b/i.test(query)) score += 8;
      if (fact.slot === 'city' && /\b(?:where i live|my city|weather|forecast|nearby|local|location|restaurants?|time zone)\b/i.test(query)) score += 8;
      if (fact.slot === 'units' && /\b(?:temperature|weather|forecast|celsius|fahrenheit|distance|units|miles?|kilometers?|km|height|weight|measure)\b/i.test(query)) score += 8;
      if (fact.slot === 'measurement-units' && /\b(?:distance|units|miles?|kilometers?|km|height|weight|measure)\b/i.test(query)) score += 8;
      if (fact.slot === 'favorite-color' && /\b(?:colou?r|theme|design|decorate|decoration)\b/i.test(query)) score += 6;
      if (fact.slot === 'music-genre' && /\b(?:music|song|playlist|album|artist|listen|spotify)\b/i.test(query)) score += 6;
      if (score > 0) scored.push({ fact, score });
    }
    scored.sort((a, b) => b.score - a.score || (b.fact.updatedAt || b.fact.at || 0) - (a.fact.updatedAt || a.fact.at || 0));
    const result = []; let used = 0;
    for (const { fact } of scored) {
      if (result.length >= count) break;
      if (used + fact.text.length > budget) continue;
      result.push({ id: fact.id, text: fact.text }); used += fact.text.length;
    }
    return result;
  }
  function classifyFact(text) {
    if (typeof text !== 'string' || sentencesOf(text.trim()).length !== 1) return null;
    const candidates = extract(text);
    return candidates.length === 1 ? candidates[0] : null;
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
  return { extract, classifyFact, isFactOnly, select, SLOTS, MAX_INPUT, MAX_CANDIDATES };
});
