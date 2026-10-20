/* Bounded checklist context. This selects data; it never resolves or executes an action. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaChecklistContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LIMITS = Object.freeze({ maxChars: 6000, maxTasks: 20, hardMaxChars: 12000, hardMaxTasks: 40, queryChars: 6000 });
  const selectionEvidence = new WeakMap();
  const STOP = new Set(('a an the and or to of for in on at by with from as is are was were be been being i me my we our you your it its this that these those please can could would should will do does did have has had what which who when where why how show list tell give get need want task tasks checklist checklists todo done complete completed finished incomplete unfinished remaining active all any some due today tomorrow yesterday week month next last still mark remove delete reopen uncheck set change update').split(' '));
  const canonical = value => {
    const text = String(value);
    return /[^\x00-\x7F]/.test(text)
      ? text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
      : text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  };
  const bounded = (value, fallback, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  const contains = (query, name) => !!name && (' ' + query + ' ').includes(' ' + name + ' ');
  function mentionsId(query, id) {
    if (query.trim() === id) return true;
    let at = -1;
    while ((at = query.indexOf(id, at + 1)) !== -1) {
      const before = query.slice(0, at), after = query.slice(at + id.length);
      if ((before && /[\p{L}\p{M}\p{N}_]$/u.test(before)) || (after && /^[\p{L}\p{M}\p{N}_]/u.test(after))) continue;
      // Short IDs need an explicit cue, so articles and ordinary words are not IDs.
      if (id.length >= 4 || /(?:["“'‘]|\b(?:task|id)\s+)$/i.test(before)) return true;
    }
    return false;
  }

  function isChecklistQuery(input) {
    if (typeof input !== 'string') return false;
    const text = input.slice(0, LIMITS.queryChars).replace(/["“][^"”]*["”]/g, '').replace(/[’‘]/g, "'").trim();
    if (/^(?:if|suppose|imagine|the (?:website|document|message|article) says)\b/i.test(text)) return false;
    if (/\b(?:my|our) (?:(?:active|open|remaining|unfinished|incomplete|completed|finished|next|current|overdue) )?(?:tasks?|checklists?|to[ -]?do(?: list)?)\b/i.test(text)) return true;
    if (/^(?:(?:hey[, ]+)?olanga[, ]+)?(?:(?:can|could|would) you )?(?:please )?(?:show|list|read|check|review|summarize|prioritize|organize)\b/i.test(text) && /\b(?:tasks?|checklist|to[ -]?do(?: list)?)\b/i.test(text)) return true;
    if (/^what tasks?\b/i.test(text)) return true;
    return /^(?:what (?:do I (?:need|have) to do|is left to do)|what's left to do)(?: (?:(?:for|by) )?(?:today|tomorrow|tonight|now|right now|this (?:morning|afternoon|evening|week|weekend|month)|next (?:week|weekend|month)))?[.!?]*$/i.test(text);
  }

  function select(input, query, options = {}) {
    options = options && typeof options === 'object' ? options : {};
    const forAction = options.forAction === true;
    if (!forAction && !isChecklistQuery(query)) return null;
    const maxChars = bounded(options.maxChars, LIMITS.maxChars, 512, LIMITS.hardMaxChars);
    const maxTasks = bounded(options.maxTasks, LIMITS.maxTasks, 1, LIMITS.hardMaxTasks);
    const rawQuery = typeof query === 'string' ? query : '';
    const text = rawQuery.slice(0, LIMITS.queryChars), normalized = canonical(text);
    const rankingText = normalized.replace(/^(?:(?:hey )?olanga )?(?:(?:can|could|would) you )?(?:please )?(?:show|list|read|check|review|summarize|prioritize|organize|mark|complete|finish|remove|delete|reopen|uncheck|update|change|set) /, '');
    const terms = [...new Set(rankingText.split(' ').filter(word => word.length > 1 && !STOP.has(word)))].slice(0, 48);
    const completedFirst = /\b(?:completed|finished|done)\b/i.test(text) && !/\b(?:not|un) ?(?:completed|finished|done)\b|\b(?:incomplete|unfinished|remaining)\b/i.test(text);
    const dueFirst = /\b(?:due|overdue|deadline|today|tomorrow)\b/i.test(text);
    const candidates = [], seenIds = new Set(), exactNames = new Map();
    const result = { selection: 'checklist', tasks: [], totalCount: 0, activeCount: 0, completedCount: 0,
      omittedCount: 0, matchedCount: 0, omittedMatches: 0, exactIdMatches: 0, duplicateExactNames: 0,
      oversizedCount: 0, unscoredCount: 0, invalidCount: 0, queryTruncated: rawQuery.length > LIMITS.queryChars };
    // Keep a small ranked candidate set even when an old local checklist is huge.
    const capacity = maxTasks * 4;
    const compare = (a, b) => b.score - a.score || (dueFirst && a.date && b.date ? a.date.localeCompare(b.date) : 0) || a.index - b.index;
    function retain(candidate) {
      let low = 0, high = candidates.length;
      while (low < high) { const middle = (low + high) >>> 1; if (compare(candidate, candidates[middle]) < 0) high = middle; else low = middle + 1; }
      if (low >= capacity) return;
      candidates.splice(low, 0, candidate);
      if (candidates.length > capacity) candidates.pop();
    }
    const tasks = Array.isArray(input) ? input : [];
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index];
      if (!task || typeof task.id !== 'string' || !task.id || typeof task.text !== 'string' || !task.text.trim() || seenIds.has(task.id)) { result.invalidCount++; continue; }
      seenIds.add(task.id); result.totalCount++;
      const completed = task.completed === true;
      if (completed) result.completedCount++; else result.activeCount++;
      const scoreNames = forAction || terms.length > 0;
      const exactId = scoreNames && task.id.length <= text.length && mentionsId(text, task.id);
      // Imported entries are <=2000 characters; bound work for malformed legacy records too.
      // An unscored entry can still match a target: omission is never proof of uniqueness.
      const canScoreName = task.text.length <= LIMITS.hardMaxChars;
      const name = canScoreName && scoreNames ? canonical(task.text) : '';
      if (!canScoreName) result.unscoredCount++;
      const exactName = contains(normalized, name);
      const overlap = terms.reduce((count, term) => count + Number(contains(name, term)), 0);
      const matched = exactId || exactName || overlap > 0;
      if (matched) result.matchedCount++;
      if (exactId) result.exactIdMatches++;
      if (exactName) exactNames.set(name, (exactNames.get(name) || 0) + 1);
      // Never shorten names or IDs: a shortened label could refer to another task.
      if (task.id.length + task.text.length > maxChars - 350) { result.oversizedCount++; continue; }
      const data = { id: task.id, text: task.text, completed };
      if (task.dueDate === null || task.dueDate === undefined) data.dueDate = null;
      else if (typeof task.dueDate === 'string' && task.dueDate.length <= 200) data.dueDate = task.dueDate;
      else data.dueDateOmitted = true;
      const size = JSON.stringify(data).length;
      if (size > maxChars - 350) { result.oversizedCount++; continue; }
      const date = typeof data.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(data.dueDate) ? data.dueDate : '';
      const score = (exactId ? 100000 : exactName ? 10000 : overlap * 100) + (completed === completedFirst ? 20 : 0) + (dueFirst && date ? 5 : 0);
      retain({ data, size, score, matched, index, date });
    }
    result.duplicateExactNames = [...exactNames.values()].filter(count => count > 1).length;
    result.omittedCount = result.totalCount; result.omittedMatches = result.matchedCount;
    result.selection = result.matchedCount ? 'matching' : completedFirst ? 'completed-first' : 'active-first';
    let chars = JSON.stringify(result).length;
    for (const candidate of candidates) {
      if (result.tasks.length === maxTasks) break;
      // Counts only shrink, so this upper bound includes JSON escaping and commas.
      const added = candidate.size + (result.tasks.length ? 1 : 0);
      if (chars + added > maxChars) continue;
      result.tasks.push(candidate.data); chars += added;
      result.omittedCount--; if (candidate.matched) result.omittedMatches--;
    }
    selectionEvidence.set(result, { query: text, exactNames, ids: seenIds });
    return result;
  }

  function mentionsName(query, name) {
    const literal = name.trim().toLowerCase();
    if (!literal) return false;
    const text = query.toLowerCase();
    let at = -1;
    while ((at = text.indexOf(literal, at + 1)) !== -1) {
      const before = text.slice(0, at), after = text.slice(at + literal.length);
      if ((!before || !/[\p{L}\p{M}\p{N}_]$/u.test(before)) && (!after || !/^[\p{L}\p{M}\p{N}_]/u.test(after))) return true;
    }
    return false;
  }

  function mentionsDistinctName(query, name, evidence) {
    if (!mentionsName(query, name)) return false;
    const normalizedName = canonical(name);
    let normalizedQuery = canonical(query);
    // A name embedded only in another known full name is not a separate target.
    for (const other of evidence?.exactNames.keys() || []) {
      if (other !== normalizedName && contains(other, normalizedName)) normalizedQuery = normalizedQuery.split(other).join(' ');
    }
    return contains(normalizedQuery, normalizedName);
  }

  // Apply after validating the specialist plan and before dispatching any command.
  // This is a summary-safety guard, not action authorization or target resolution.
  // userGoals may contain the current goal and the original pending USER goal only.
  function needsTargetClarification(commands, selection, userGoals) {
    if (!selection || (!selection.omittedCount && !selection.queryTruncated && !selection.unscoredCount && !selection.invalidCount && !selection.duplicateExactNames)) return false;
    const goals = (Array.isArray(userGoals) ? userGoals : [userGoals]).filter(goal => typeof goal === 'string').slice(0, 4).map(goal => goal.slice(0, LIMITS.queryChars));
    const evidence = selectionEvidence.get(selection);
    for (const command of Array.isArray(commands) ? commands : []) {
      const match = /^\[(REMOVE_TASK|COMPLETE_TASK|UNCOMPLETE_TASK|SET_TASK_DUE):\s*([^\]\r\n]+)\]$/i.exec(command);
      if (!match) continue;
      const target = (match[1].toUpperCase() === 'SET_TASK_DUE' ? match[2].split(',')[0] : match[2]).trim();
      if (!target || selection.queryTruncated) return true;
      const displayed = selection.tasks.find(task => task.id === target);
      if (displayed) {
        if (goals.some(goal => mentionsId(goal, target))) continue;
        // Full-name grounding is safe only when the complete local scan established
        // uniqueness for that name. Serialized/cloned summaries lack this evidence.
        const uniqueName = !selection.unscoredCount && !selection.invalidCount && evidence?.exactNames.get(canonical(displayed.text)) === 1;
        if (uniqueName && mentionsName(evidence.query, displayed.text) && goals.some(goal => mentionsDistinctName(goal, displayed.text, evidence))) continue;
        return true;
      }
      // An omitted known ID still has exact, case-sensitive identity. It must
      // never enter case-insensitive name matching merely because it did not fit.
      if (evidence?.ids.has(target)) {
        if (goals.some(goal => mentionsId(goal, target))) continue;
        return true;
      }
      // Keep user-supplied text (including a partial name) intact for the existing
      // full-store resolver. Do not accept a model-expanded name from the shortlist.
      if (!goals.some(goal => mentionsDistinctName(goal, target, evidence))) return true;
    }
    return false;
  }
  return { LIMITS, isChecklistQuery, select, needsTargetClarification };
});
