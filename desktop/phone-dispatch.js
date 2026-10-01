// One-use handoff from an authenticated phone to the trusted main renderer.
const { parseCommand } = require('./phone-remote');
function createPhoneDispatch({ getWindow }) {
  const pending = new Map();
  const delivered = new Set();
  const failed = message => ({ ok: false, verified: false, message });
  function execute(payload) {
    try {
      if (!payload || typeof payload.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(payload.requestId) || !payload.signal || typeof payload.signal.aborted !== 'boolean' || typeof payload.signal.addEventListener !== 'function' || parseCommand(payload.text)[0].command !== payload.command) throw new Error('Invalid phone command.');
    } catch (_) { return Promise.resolve(failed('This phone command is invalid.')); }
    const window = getWindow();
    if (!window || window.isDestroyed() || payload.signal.aborted) return Promise.resolve(failed('Olanga is unavailable. Open it and try again.'));
    if (delivered.has(payload.requestId)) return Promise.resolve(failed('This request has already been delivered.'));
    return new Promise(resolve => {
      const entry = { window, claimed: false, finish: value => { if (pending.get(payload.requestId) !== entry) return; pending.delete(payload.requestId); payload.signal.removeEventListener('abort', abort); resolve(value); } };
      const abort = () => { try { if (!window.isDestroyed()) window.webContents.send('phone-command-cancel', payload.requestId); } catch (_) {} entry.finish(failed('The phone request stopped. Check Olanga for any completed action.')); };
      delivered.add(payload.requestId);
      if (delivered.size > 2048) delivered.delete(delivered.values().next().value);
      pending.set(payload.requestId, entry); payload.signal.addEventListener('abort', abort, { once: true });
      try { window.webContents.send('phone-command', { requestId: payload.requestId, text: payload.text, command: payload.command }); }
      catch (_) { entry.finish(failed('Olanga could not receive this command.')); }
    });
  }
  return {
    execute,
    claim(id) {
      const item = pending.get(id); if (!item || item.claimed) return false;
      if (item.window !== getWindow() || item.window.isDestroyed()) { item.finish(failed('Olanga changed windows before this command could begin.')); return false; }
      item.claimed = true; return true;
    },
    complete({ requestId, result } = {}) {
      const item = pending.get(requestId); if (!item?.claimed || typeof result?.ok !== 'boolean' || typeof result?.verified !== 'boolean' || typeof result?.message !== 'string' || !result.message.trim() || result.message.length > 2000) return false;
      if (item.window !== getWindow() || item.window.isDestroyed()) { item.finish(failed('Olanga changed windows before the result arrived. Check any dispatched action.')); return false; }
      item.finish({ ok: result.ok, verified: result.verified, message: result.message }); return true;
    },
    cancelAll() { for (const item of [...pending.values()]) item.finish(failed('Olanga closed or reloaded. Check any dispatched action before retrying.')); }
  };
}
module.exports = { createPhoneDispatch };
