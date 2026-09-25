/* The same closed action vocabulary is used by the planner, native boundary and tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaActionPlan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const LIMITS = Object.freeze({ steps: 12, text: 2000, summary: 400, waitMs: 2000, totalWaitMs: 8000, ttlMs: 5 * 60 * 1000, runMs: 30000 });
  const HOTKEYS = Object.freeze([
    ...['ENTER', 'TAB', 'BACKSPACE', 'DELETE', 'LEFT', 'RIGHT', 'UP', 'DOWN', 'HOME', 'END', 'PAGEUP', 'PAGEDOWN', 'F2', 'F5', 'F6'].map(k => Object.freeze([k])),
    ...['A', 'C', 'V', 'X', 'Z', 'Y', 'S', 'F', 'H', 'L', 'LEFT', 'RIGHT', 'HOME', 'END', 'BACKSPACE'].map(k => Object.freeze(['CTRL', k])),
    ...['TAB', 'LEFT', 'RIGHT', 'UP', 'DOWN', 'HOME', 'END'].map(k => Object.freeze(['SHIFT', k])),
    ...['N', 'S', 'LEFT', 'RIGHT', 'HOME', 'END'].map(k => Object.freeze(['CTRL', 'SHIFT', k])),
    Object.freeze(['ALT', 'LEFT']), Object.freeze(['ALT', 'RIGHT'])
  ]);
  const allowedHotkeys = new Set(HOTKEYS.map(k => k.join('+')));
  const REGION_HOTKEYS = Object.freeze(HOTKEYS.filter(keys =>
    /^(?:ENTER|BACKSPACE|DELETE|LEFT|RIGHT|UP|DOWN|HOME|END|PAGEUP|PAGEDOWN|CTRL\+(?:A|C|V|X|Z|Y|LEFT|RIGHT|HOME|END|BACKSPACE)|SHIFT\+(?:LEFT|RIGHT|UP|DOWN|HOME|END)|CTRL\+SHIFT\+(?:LEFT|RIGHT|HOME|END))$/.test(keys.join('+'))));
  const regionHotkeys = new Set(REGION_HOTKEYS.map(k => k.join('+')));
  // A terminal is never a supported target, even if it appears in the window list.
  const BLOCKED_PROCESSES = /^(?:cmd|powershell|pwsh|windowsterminal|conhost|openconsole|bash|wsl|mintty|alacritty|wezterm|hyper|putty|wt|regedit|taskmgr)$/i;
  function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
  function exactKeys(value, allowed) {
    if (!plain(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Unexpected action fields.');
  }
  function string(value, name, max) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error('Invalid ' + name + '.');
    return value;
  }
  function integer(value, min, max, name) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid ' + name + '.');
    return value;
  }
  function supportedWindow(win) {
    return !!win && /^\d{1,20}$/.test(win.handle) && win.handle !== '0' && Number.isInteger(win.processId) && win.processId > 0 &&
      typeof win.processName === 'string' && !!win.processName && !BLOCKED_PROCESSES.test(win.processName.replace(/\.exe$/i, '')) &&
      !/^(?:run|windows powershell|command prompt|terminal)$/i.test(String(win.title || '').trim());
  }
  function freeze(value) {
    Object.values(value).forEach(v => { if (v && typeof v === 'object') freeze(v); });
    return Object.freeze(value);
  }
  function validatePlan(input, capture) {
    exactKeys(input, ['captureId', 'summary', 'steps', 'scope']);
    if (!capture || input.captureId !== capture.captureId) throw new Error('Capture is missing or has expired. Observe the screen again.');
    const summary = string(input.summary, 'plan summary', LIMITS.summary).trim();
    exactKeys(input.scope, ['mode', 'handle', 'region']);
    const target = capture.windows.find(w => w.handle === input.scope.handle);
    if (!supportedWindow(target)) throw new Error('Choose a supported observed target window.');
    if (!['window', 'region'].includes(input.scope.mode)) throw new Error('Choose a window or editor region scope.');
    const scope = { mode: input.scope.mode, handle: target.handle };
    if (scope.mode === 'region') {
      const r = input.scope.region;
      exactKeys(r, ['x', 'y', 'width', 'height']);
      if (![r.x,r.y,r.width,r.height].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) || r.width <= 0 || r.height <= 0 || r.x + r.width > 1.000001 || r.y + r.height > 1.000001) throw new Error('Invalid approved editor region.');
      scope.region = { x: r.x, y: r.y, width: r.width, height: r.height };
    } else if (input.scope.region !== undefined) throw new Error('Unexpected region for a window scope.');
    if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > LIMITS.steps) throw new Error('A plan must have 1–12 steps.');
    let textLength = 0, waits = 0;
    const steps = input.steps.map(step => {
      if (!plain(step)) throw new Error('Invalid action.');
      switch (step.type) {
        case 'click': {
          exactKeys(step, ['type', 'x', 'y', 'button', 'count']);
          if (![step.x, step.y].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Click coordinates must be between 0 and 1.');
          if (scope.region && (step.x < scope.region.x || step.y < scope.region.y || step.x > scope.region.x + scope.region.width || step.y > scope.region.y + scope.region.height)) throw new Error('A click is outside the approved editor region.');
          const button = step.button === undefined ? 'left' : step.button;
          if (!['left', 'right'].includes(button)) throw new Error('Unsupported mouse button.');
          if (scope.region && button !== 'left') throw new Error('Context menus require a separately approved window scope.');
          return { type: 'click', x: step.x, y: step.y, button, count: integer(step.count === undefined ? 1 : step.count, 1, 2, 'click count') };
        }
        case 'type': {
          exactKeys(step, ['type', 'text']);
          const text = string(step.text, 'typed text', LIMITS.text);
          textLength += text.length;
          if (textLength > LIMITS.text) throw new Error('A plan may type at most 2,000 characters.');
          return { type: 'type', text };
        }
        case 'hotkey': {
          exactKeys(step, ['type', 'keys']);
          if (!Array.isArray(step.keys) || !allowedHotkeys.has(step.keys.join('+')) || step.keys.some(k => typeof k !== 'string')) throw new Error('Unsupported keyboard shortcut.');
          if (scope.region && !regionHotkeys.has(step.keys.join('+'))) throw new Error('That shortcut can leave the approved editor region.');
          return { type: 'hotkey', keys: [...step.keys] };
        }
        case 'scroll':
          exactKeys(step, ['type', 'amount']);
          if (!step.amount) throw new Error('Scroll amount cannot be zero.');
          return { type: 'scroll', amount: integer(step.amount, -10, 10, 'scroll amount') };
        case 'wait': {
          exactKeys(step, ['type', 'ms']);
          const ms = integer(step.ms, 100, LIMITS.waitMs, 'wait duration');
          waits += ms;
          if (waits > LIMITS.totalWaitMs) throw new Error('A plan may wait at most 8 seconds in total.');
          return { type: 'wait', ms };
        }
        case 'focus': {
          exactKeys(step, ['type', 'handle']);
          const win = capture.windows.find(w => w.handle === step.handle);
          if (!supportedWindow(win)) throw new Error('Only a supported window observed in this capture can be focused.');
          if (step.handle !== scope.handle) throw new Error('Changing another window requires a new capture, scope and confirmation.');
          return { type: 'focus', handle: win.handle };
        }
        default: throw new Error('Unsupported action type.');
      }
    });
    if (target.handle !== capture.foreground?.handle && steps.some(step => step.type !== 'focus' && step.type !== 'wait')) throw new Error('This target was not foreground in the captured screen. Approve a focus-only plan, then observe it again before editing.');
    return freeze({ captureId: input.captureId, summary, scope, steps });
  }
  function describeStep(step, windows = []) {
    switch (step.type) {
      case 'click': return `${step.count === 2 ? 'Double-click' : 'Click'} ${step.button} at ${(step.x * 100).toFixed(1)}%, ${(step.y * 100).toFixed(1)}% of the primary display`;
      case 'type': return 'Type exactly: ' + JSON.stringify(step.text);
      case 'hotkey': return 'Press ' + step.keys.join(' + ');
      case 'scroll': return `Scroll ${Math.abs(step.amount)} notch(es) ${step.amount > 0 ? 'down' : 'up'} at the pointer`;
      case 'wait': return `Wait ${step.ms} ms`;
      case 'focus': { const win = windows.find(w => w.handle === step.handle); return 'Focus ' + (win ? `${win.title} (${win.processName}, window ${win.handle})` : step.handle); }
      default: throw new Error('Unsupported action type.');
    }
  }
  return Object.freeze({ LIMITS, HOTKEYS, REGION_HOTKEYS, supportedWindow, validatePlan, describeStep });
});
