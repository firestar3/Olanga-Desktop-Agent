const test = require('node:test');
const assert = require('node:assert/strict');
const { createPushToTalk } = require('../../desktop/push-to-talk');

function shortcuts(taken = []) {
  const registered = new Map();
  return {
    registered,
    register(accelerator, callback) { if (taken.includes(accelerator) || registered.has(accelerator)) return false; registered.set(accelerator, callback); return true; },
    unregister(accelerator) { registered.delete(accelerator); },
    isRegistered: accelerator => registered.has(accelerator)
  };
}

test('only allow-listed shortcuts register, and switching releases the previous one', () => {
  const globalShortcut = shortcuts(); let triggered = 0;
  const service = createPushToTalk({ globalShortcut, onTrigger: () => triggered++ });
  assert.deepEqual(service.set('Control+Alt+Space'), { value: 'Control+Alt+Space', registered: true });
  globalShortcut.registered.get('Control+Alt+Space')();
  assert.equal(triggered, 1);
  assert.deepEqual(service.set('Control+Alt+Space'), { value: 'Control+Alt+Space', registered: true });
  service.set('Control+Shift+Space');
  assert.deepEqual([...globalShortcut.registered.keys()], ['Control+Shift+Space']);
  for (const value of ['Control+Alt+Delete', 'Escape', 'off', null, 7]) {
    assert.deepEqual(service.set(value), { value: 'off', registered: false }, String(value));
    assert.equal(globalShortcut.registered.size, 0);
  }
});

test('a shortcut held by another app is reported without disturbing other global shortcuts', () => {
  const globalShortcut = shortcuts(['Alt+Space']);
  globalShortcut.register('Escape', () => {});
  const service = createPushToTalk({ globalShortcut, onTrigger() {} });
  assert.deepEqual(service.set('Alt+Space'), { value: 'Alt+Space', registered: false });
  assert.equal(service.current(), null);
  service.set('Control+Alt+Space');
  service.dispose();
  assert.deepEqual([...globalShortcut.registered.keys()], ['Escape']);
  const throwing = createPushToTalk({ globalShortcut: { register() { throw new Error('Invalid'); }, unregister() {} }, onTrigger() {} });
  assert.deepEqual(throwing.set('Control+Alt+Space'), { value: 'Control+Alt+Space', registered: false });
});
