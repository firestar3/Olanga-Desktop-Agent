const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserAdapter, webUrl, endpoint } = require('../../extensions/browser/core');
function fixture() {
  const state = { permitted: true, tabs: [{ id: 1, windowId: 10, url: 'https://example.com/notes', title: 'Notes', active: false }, { id: 2, windowId: 10, url: 'https://private.example/', title: 'Private', incognito: true }, { id: 3, windowId: 10, url: 'chrome://settings', title: 'Settings' }], created: [], updates: [], text: 'Chosen paragraph' };
  const chrome = { permissions: { contains: async () => state.permitted }, tabs: {
    query: async () => structuredClone(state.tabs), get: async id => { const found = state.tabs.find(tab => tab.id === id); if (!found) throw new Error('Tab closed.'); return { ...found }; },
    update: async (id, props) => { state.updates.push(id); Object.assign(state.tabs.find(tab => tab.id === id), props); },
    create: async props => { const tab = { id: state.tabs.length + 1, windowId: 10, ...props }; state.tabs.push(tab); state.created.push(tab); return tab; },
  }, windows: { update: async () => {} }, scripting: { executeScript: async () => [{ frameId: 0, result: { text: state.text, url: state.tabs[0].url, title: 'Notes' } }] } };
  return { state, adapter: createBrowserAdapter(chrome) };
}
test('browser optional tab permission gates metadata; private and browser-internal tabs are excluded', async () => {
  const { state, adapter } = fixture(); state.permitted = false;
  await assert.rejects(adapter.run('browser.listTabs'), /Enable tab sharing/); state.permitted = true;
  const result = await adapter.run('browser.listTabs'); assert.equal(result.items.length, 1); assert.equal(result.items[0].id, 1);
});
test('tab focus requires exact current URL identity and does not affect a navigated or private tab', async () => {
  const { state, adapter } = fixture();
  await assert.rejects(adapter.run('browser.focusTab', { tabId: 1, url: 'https://example.com/stale' }), /navigated/);
  await assert.rejects(adapter.run('browser.focusTab', { tabId: 2, url: 'https://private.example/' }), /navigated/);
  assert.equal(state.updates.length, 0);
  assert.equal((await adapter.run('browser.focusTab', { tabId: 1, url: state.tabs[0].url })).verified, true);
});
test('tab restore is idempotent and opens missing URLs only once without activating them', async () => {
  const { state, adapter } = fixture(); const payload = { tabs: [{ url: 'https://example.com/notes' }, { url: 'https://example.com/new' }, { url: 'https://example.com/new' }] };
  const first = await adapter.run('browser.resumeTabs', payload); assert.equal(first.items.length, 2); assert.equal(state.created.length, 1); assert.equal(state.created[0].active, false);
  assert.equal((await adapter.run('browser.resumeTabs', payload)).ok, true); assert.equal(state.created.length, 1);
});
test('selected text readback requires the same page and a nonempty bounded selection', async () => {
  const { state, adapter } = fixture(); const payload = { tabId: 1, url: state.tabs[0].url };
  assert.equal((await adapter.run('browser.readSelection', payload)).text, state.text);
  state.text = ''; await assert.rejects(adapter.run('browser.readSelection', payload), /Select page text/);
});
test('cancellation authorization checkpoint stops a previously approved effect', async () => {
  const { state, adapter } = fixture();
  await assert.rejects(adapter.run('browser.focusTab', { tabId: 1, url: state.tabs[0].url }, { authorize: async () => { throw new Error('Cancelled by Olanga.'); } }), /Cancelled/);
  assert.equal(state.updates.length, 0);
});
test('browser companion rejects executable URLs and external pairing endpoints', () => {
  assert.throws(() => webUrl('javascript:alert(1)')); assert.throws(() => webUrl('https://user:secret@example.com'));
  assert.throws(() => endpoint('http://example.com:8080')); assert.throws(() => endpoint('http://127.0.0.1:1234/path')); assert.equal(endpoint('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
});
