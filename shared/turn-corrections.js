(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaTurnCorrections = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TTL_MS = 60000;
  const operation = command => /^\[([A-Z_]+)/.exec(command)?.[1] || '';
  function createPlan(commands) { return commands.map(command => ({ command, operation: operation(command), state: 'pending' })); }
  // A correction must be explicit, numeric and unambiguous. Bare numbers and
  // names from screen content or prior assistant prose are never authority.
  function resolve(text, { steps = [], at = 0, now = Date.now() } = {}) {
    const clean = String(text || '').trim().replace(/[.!?]+$/, '').trim();
    const volume = /^(?:actually|no[, ]+|instead[, ]+)[, ]*(?:(?:set|make|change)(?: it| the volume)?(?: to)?\s+)?(\d{1,3})(?:\s*(?:%|percent))?$/i.exec(clean);
    if (volume) {
      const candidates = steps.filter(step => step.operation === 'VOLUME_SET');
      if (Number(volume[1]) > 100) return { kind: 'clarify', message: 'Choose a volume between 0 and 100 percent.' };
      if (now - at > TTL_MS || candidates.length !== 1 || ['failed', 'cancelled'].includes(candidates[0].state)) return { kind: 'clarify', message: 'Which setting should I change? For example, say “set volume to 30 percent.”' };
      return { kind: 'volume', index: steps.indexOf(candidates[0]), command: `[VOLUME_SET: ${Number(volume[1])}]`, message: `Setting volume to ${Number(volume[1])} percent.` };
    }
    const timer = /^(?:keep .{1,80} open[, ]+but\s+)?cancel (?:the |that |pending )?timer(?: step)?$/i.test(clean);
    if (timer && now - at <= TTL_MS && steps.some(step => step.operation === 'SET_TIMER')) {
      const candidates = steps.filter(step => step.operation === 'SET_TIMER' && step.state === 'pending');
      if (candidates.length === 1) return { kind: 'cancel-pending', index: steps.indexOf(candidates[0]), message: 'The pending timer step was cancelled. Other steps are unchanged.' };
      return { kind: 'clarify', message: 'There is no single pending timer step. If a timer has already started, say “cancel timer” followed by its name.' };
    }
    return null;
  }
  function inline(text) {
    const match = /^(.*\bvolume\b.*?)\s*[,;]?\s+actually[, ]+(\d{1,3})(?:\s*(?:%|percent))?[.!?]*$/i.exec(String(text || '').trim());
    if (!match || Number(match[2]) > 100) return text;
    // Replace only a final explicit volume target, preserving the other clauses.
    const revised = match[1].replace(/(\bvolume\s+(?:to\s+)?)(\d{1,3})(?:\s*(?:%|percent))?\s*[,;]?$/i, `$1${Number(match[2])}%`);
    return revised === match[1] ? text : revised;
  }
  return { TTL_MS, createPlan, resolve, inline };
});
