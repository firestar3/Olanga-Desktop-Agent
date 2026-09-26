'use strict';
const { VALUES } = require('../shared/shortcuts');

// Registers at most one push-to-talk accelerator from the fixed list. It only
// unregisters its own accelerator, so Escape during desktop input is untouched.
function createPushToTalk({ globalShortcut, onTrigger }) {
  let current = null;
  function release() {
    if (!current) return;
    try { globalShortcut.unregister(current); } catch { /* Already released by the system. */ }
    current = null;
  }
  function set(value) {
    const next = typeof value === 'string' && value !== 'off' && VALUES.includes(value) ? value : null;
    if (next && next === current && globalShortcut.isRegistered?.(next) !== false) return { value: next, registered: true };
    release();
    if (!next) return { value: 'off', registered: false };
    let registered = false;
    try { registered = globalShortcut.register(next, () => onTrigger()) === true; } catch { registered = false; }
    if (registered) current = next;
    return { value: next, registered };
  }
  return { set, dispose: release, current: () => current };
}

module.exports = { createPushToTalk };
