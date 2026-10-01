const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('browser disconnect and re-pair cannot publish a delayed selection into the new connection', async () => {
  const elements = new Map(), sent = []; let resolveSelection;
  const selection = new Promise(resolve => { resolveSelection = resolve; });
  const element = id => { if (!elements.has(id)) elements.set(id, { value: '', textContent: '', hidden: false, disabled: false, listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } }); return elements.get(id); };
  const context = vm.createContext({ URL, Date, AbortSignal, setInterval: () => 1, clearInterval() {}, location: { href: 'chrome-extension://' + 'a'.repeat(32) + '/panel.html?tab=1' }, document: { getElementById: element },
    chrome: { tabs: { get: async () => ({ id: 1, url: 'https://example.com/' }) } },
    OlangaBrowserCompanion: { endpoint: value => value, createBrowserAdapter: () => ({ run: () => selection }) },
    fetch: async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => url.endsWith('/pair') ? { ok: true, token: 't'.repeat(43) } : { ok: true, command: null } }; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../extensions/browser/panel.js'), 'utf8'), context);
  async function pair(port) { element('endpoint').value = `http://127.0.0.1:${port}`; element('code').value = 'p'.repeat(43); await element('pair-form').listeners.submit({ preventDefault() {} }); }
  await pair(8001);
  const share = element('share-selection').listeners.click(); await tick();
  await element('disconnect').listeners.click(); await pair(8002);
  resolveSelection({ text: 'Old selected content', title: 'Old selection', url: 'https://example.com/' }); await share;
  assert.equal(sent.filter(item => item.url.endsWith('/publish')).length, 0);
  assert.match(element('status').textContent, /connection changed/);
});

test('VS Code disconnect and re-pair cannot publish a delayed document approval to the new session', async () => {
  const commands = new Map(), sent = [], messages = [], answers = ['http://127.0.0.1:8001', 'p'.repeat(43), 'http://127.0.0.1:8002', 'q'.repeat(43)];
  let resolveDocuments; const documents = new Promise(resolve => { resolveDocuments = resolve; });
  const adapter = { listDocuments: () => documents, cancelAll() {}, dispose() {} };
  const vscode = { window: { showInputBox: async () => answers.shift(), showInformationMessage: message => messages.push(message), showWarningMessage: message => messages.push(message), showErrorMessage: message => messages.push(message) }, commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; } } };
  const http = { request(url, options, callback) {
    const request = new EventEmitter(); request.end = body => {
      sent.push({ url, body: JSON.parse(body) });
      setImmediate(() => { const response = new EventEmitter(); response.statusCode = 200; response.setEncoding = () => {}; callback(response); response.emit('data', JSON.stringify(url.endsWith('/pair') ? { ok: true, token: 't'.repeat(43) } : { ok: true, command: null })); response.emit('end'); });
    }; request.destroy = error => request.emit('error', error); return request;
  } };
  const context = vm.createContext({ module: { exports: {} }, Buffer, URL, Date, setInterval: () => 1, clearInterval() {}, require(name) { if (name === 'vscode') return vscode; if (name === 'node:http') return http; if (name === './core') return { createVscodeAdapter: () => adapter, endpoint: value => value }; throw new Error(`Unexpected module ${name}`); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../extensions/vscode/extension.js'), 'utf8'), context);
  const extension = { subscriptions: [], globalState: { get: () => [], update: async () => {} } }; context.module.exports.activate(extension);
  await commands.get('olanga.connect')();
  const share = commands.get('olanga.shareDocuments')(); await tick();
  await commands.get('olanga.disconnect')(); await commands.get('olanga.connect')();
  resolveDocuments({ kind: 'documents', title: 'Old documents', items: [{ uri: 'file:///C:/old.txt' }], message: 'Shared' }); await share;
  assert.equal(sent.filter(item => item.url.endsWith('/publish')).length, 0); assert.ok(messages.some(message => /connection changed/.test(message)));
  for (const subscription of extension.subscriptions) subscription.dispose();
});
