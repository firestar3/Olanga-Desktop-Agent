const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const KEY = 'olanga_companion_sessions_v1';
function fixture(initial = []) {
  const all = [], buttons = [], fields = new Map(), messages = [], storage = new Map([[KEY, JSON.stringify(initial)]]), requests = [], close = [], cancellations = [];
  const document = { activeElement: null, createTextNode: text => node('#text', text) };
  function node(tag, text = '') {
    const value = { tag, textContent: text, children: [], attributes: {}, checked: false, value: '', hidden: false, parentElement: null,
      append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } },
      replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); },
      setAttribute(key, value) { this.attributes[key] = value; },
      remove() { const parent = this.parentElement; if (parent) parent.children = parent.children.filter(item => item !== this); this.parentElement = null; },
      replaceWith(next) { const parent = this.parentElement; if (!parent) return; parent.children[parent.children.indexOf(this)] = next; next.parentElement = parent; this.parentElement = null; },
      focus() { document.activeElement = this; },
    }; all.push(value); return value;
  }
  const section = node('section'), button = (text, action) => { const value = node('button', text); value.click = action; buttons.push(value); return value; };
  const field = (parent, label) => { const input = node('input'); fields.set(label, input); parent.append(input); return input; };
  let notify, current = { connections: [], inbox: [] };
  const context = vm.createContext({ document, URL, Date, console, crypto: { randomUUID }, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: { electronAPI: { onCompanionState: fn => { notify = fn; }, companionList: async () => current, companionCancel: async () => { cancellations.push('cancel'); }, companionRequest: async payload => { requests.push(payload); return { ok: true, verified: true, message: 'Completed.' }; }, companionPair: async () => ({ ok: false, message: 'Pairing failed.' }), companionForget: async () => {}, companionDisconnect: async () => {} },
      OlangaWorkbench: { addPage(id, label, build) { if (id === 'companions') build({ section, node, button, field, actions: (parent, ...items) => parent.append(...items), detail: (parent, text) => parent.append(node('p', text)), report: (parent, text) => parent.replaceChildren(node('pre', text)), showMessage: text => messages.push(text) }); }, onClose(fn) { close.push(fn); } } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/workbench-connections.js'), 'utf8'), context);
  function connected(element) { while (element) { if (element === section) return true; element = element.parentElement; } return false; }
  return { all, buttons, fields, messages, storage, requests, document, close, cancellations, emit(value) { current = value; notify(value); }, controls: label => buttons.filter(item => item.textContent === label && connected(item)), checks: () => all.filter(item => item.tag === 'input' && item.type === 'checkbox' && connected(item)) };
}
const browser = { id: 'browser-1', kind: 'browser', name: 'Browser', connected: true };
const tabs = count => ({ id: 'tabs-1', connectionId: browser.id, kind: 'tabs', companionKind: 'browser', title: 'Tabs', at: 1, items: Array.from({ length: count }, (_, index) => ({ id: index + 1, title: `Tab ${index + 1}`, url: `https://example.com/${index + 1}` })) });
const validSaved = { id: 'saved-valid', name: 'Existing', kind: 'browser', items: [{ url: 'https://example.com/saved', title: 'Saved' }] };

test('tab save requires an explicit subset and refuses oversized selections without changing saved data', () => {
  const f = fixture([validSaved]); f.emit({ connections: [browser], inbox: [tabs(35)] }); f.fields.get('Tab or document session name').value = 'Research';
  assert.equal(f.checks().length, 35); assert.ok(f.checks().every(item => !item.checked));
  const original = f.storage.get(KEY);
  assert.throws(() => f.controls('Save selected tabs')[0].click(), /between 1 and 30/);
  f.checks().slice(0, 31).forEach(item => { item.checked = true; });
  assert.throws(() => f.controls('Save selected tabs')[0].click(), /between 1 and 30/); assert.equal(f.storage.get(KEY), original);
  f.checks()[30].checked = false; f.controls('Save selected tabs')[0].click();
  const saved = JSON.parse(f.storage.get(KEY)); assert.equal(saved.length, 2); assert.equal(saved[1].items.length, 30); assert.equal(saved[0].name, 'Existing');
});
test('document subsets obey the backend limit of 20 and save only selected references', () => {
  const f = fixture(); f.fields.get('Tab or document session name').value = 'Project';
  f.emit({ connections: [], inbox: [{ id: 'docs', kind: 'documents', title: 'Documents', at: 1, items: Array.from({ length: 22 }, (_, index) => ({ name: `File ${index}`, uri: `file:///C:/project/${index}.txt` })) }] });
  f.checks().slice(0, 21).forEach(item => { item.checked = true; }); assert.throws(() => f.controls('Save selected documents')[0].click(), /between 1 and 20/);
  f.checks().forEach((item, index) => { item.checked = index === 1 || index === 20; }); f.controls('Save selected documents')[0].click();
  const saved = JSON.parse(f.storage.get(KEY)); assert.equal(saved[0].items.length, 2); assert.equal(saved[0].items[0].uri, 'file:///C:/project/1.txt');
});
test('queued request and heartbeat events preserve keyboard focus and checked subsets', () => {
  const f = fixture(); const inbox = [tabs(2)]; f.emit({ connections: [browser], inbox });
  const control = f.controls('Focus tab')[0], check = f.checks()[0]; check.checked = true; control.focus(); const count = f.buttons.length;
  f.emit({ connections: [{ ...browser, lastSeen: 900 }], inbox: structuredClone(inbox), pending: [{ id: 'pending' }] });
  assert.equal(f.controls('Focus tab')[0], control); assert.equal(f.document.activeElement, control); assert.equal(f.checks()[0], check); assert.equal(check.checked, true); assert.equal(f.buttons.length, count);
  f.emit({ connections: [browser], inbox: [...inbox, { ...tabs(1), id: 'tabs-2' }] }); assert.equal(f.controls('Focus tab')[0], control); assert.equal(f.checks()[0].checked, true);
});
test('unsupported saved entries do not hide valid sessions or alter storage until explicit removal', () => {
  const invalid = { id: 'bad', name: 'Unsafe', kind: 'browser', items: [{ url: 'javascript:alert(1)' }] };
  const f = fixture([validSaved, invalid]), original = f.storage.get(KEY);
  f.controls('Show saved tab and document sessions')[0].click(); assert.equal(f.controls('Review restore in companion').length, 1); assert.equal(f.storage.get(KEY), original);
  f.controls('Remove unsupported saved entries')[0].click(); assert.deepEqual(JSON.parse(f.storage.get(KEY)), [validSaved]);
});
test('session names are bounded and invalid external file targets cannot become saved actions', () => {
  const f = fixture([validSaved]); f.emit({ connections: [browser], inbox: [tabs(1), { id: 'docs', kind: 'documents', at: 1, title: 'Untrusted', items: [{ uri: 'file://remote/share.txt', name: 'Remote' }, null] }] });
  f.checks()[0].checked = true; f.fields.get('Tab or document session name').value = 'x'.repeat(101);
  assert.throws(() => f.controls('Save selected tabs')[0].click(), /between 1 and 100/); assert.equal(f.checks().length, 1);
  assert.deepEqual(JSON.parse(f.storage.get(KEY)), [validSaved]);
});
test('saved session restore uses only the reviewed saved subset and pairing failure is clear', async () => {
  const f = fixture([validSaved]); f.emit({ connections: [browser], inbox: [] }); f.controls('Show saved tab and document sessions')[0].click();
  await f.controls('Review restore in companion')[0].click(); assert.equal(f.requests[0].payload.tabs.length, 1); assert.equal(f.requests[0].payload.tabs[0].url, validSaved.items[0].url);
  await assert.rejects(f.controls('Pair browser')[0].click(), /Pairing failed/);
});
test('closing Work tools cancels outstanding requests while leaving the companion connection displayed', async () => {
  const f = fixture(); f.emit({ connections: [browser], inbox: [] });
  for (const cleanup of f.close) cleanup();
  await Promise.resolve(); assert.equal(f.cancellations.length, 1); assert.equal(f.controls('Request tab list').length, 1);
});
