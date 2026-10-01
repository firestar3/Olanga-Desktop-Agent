(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaTurnLifecycle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'awaiting-input', 'timed-out', 'unverified']);
  const copy = value => JSON.parse(JSON.stringify(value));
  function create({ now = Date.now, schedule = setTimeout, unschedule = clearTimeout, onChange = () => {}, onStall = () => {}, onTimeout = () => {}, timeoutMs = 120000, stallMs = 12000 } = {}) {
    let sequence = 0, current = null, deadline, notice;
    const emit = () => { try { onChange(copy(current)); } catch (_) {} };
    const clear = () => { unschedule(deadline); unschedule(notice); deadline = notice = null; };
    const owns = id => !!current && current.id === id && !current.outcome;
    const finish = (id, outcome, detail = '') => {
      if (!owns(id) || !TERMINAL.has(outcome)) return false;
      for (const step of current.steps) {
        if (step.state === 'working') step.state = 'uncertain';
        else if (step.state === 'pending') step.state = 'skipped';
      }
      clear(); Object.assign(current, { outcome, detail: String(detail).slice(0, 2000), finishedAt: now() }); emit(); return true;
    };
    const arm = id => {
      clear();
      notice = schedule(() => { if (owns(id)) onStall(copy(current)); }, stallMs);
      deadline = schedule(() => {
        if (!owns(id)) return;
        finish(id, 'timed-out', 'The current stage did not finish in time. Completed steps were retained.');
        onTimeout(copy(current));
      }, timeoutMs);
      // Unit and command-line callers should not be kept alive by a dormant turn.
      notice?.unref?.(); deadline?.unref?.();
    };
    return {
      snapshot: () => current ? copy(current) : null,
      begin() {
        if (current && !current.outcome) finish(current.id, 'cancelled', 'Replaced by a newer request.');
        current = { id: ++sequence, phase: 'recognizing', outcome: null, startedAt: now(), phaseStartedAt: now(), actionsFinishedAt: null, playbackStartedAt: null, playbackFinishedAt: null, speechStatus: null, steps: [] };
        arm(current.id); emit(); return current.id;
      },
      phase(id, phase) {
        if (!owns(id) || !['recognizing', 'planning', 'working', 'speaking', 'awaiting-review'].includes(phase)) return false;
        current.phase = phase; current.phaseStartedAt = now(); if (phase === 'awaiting-review') clear(); else arm(id); emit(); return true;
      },
      steps(id, steps) { if (owns(id)) { current.steps = copy(steps); emit(); } },
      actionsFinished(id) { if (owns(id) && current.actionsFinishedAt === null) { current.actionsFinishedAt = now(); emit(); } },
      playbackStarted(id) { if (owns(id) && current.playbackStartedAt === null) { current.playbackStartedAt = now(); emit(); } },
      playbackFinished(id, status) { if (owns(id)) { current.playbackFinishedAt = now(); current.speechStatus = status; emit(); } },
      finish,
      dispose() { clear(); }
    };
  }
  return { create };
});
