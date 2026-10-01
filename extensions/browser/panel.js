const adapter = OlangaBrowserCompanion.createBrowserAdapter(chrome);
const el = id => document.getElementById(id);
const sourceTabId = Number(new URL(location.href).searchParams.get('tab'));
let connection = null, pending = null, polling = false, executing = false, timer = null;
function status(message) { el('status').textContent = message; }
function connectedUI(value) { for (const id of ['disconnect', 'share-tabs', 'share-selection']) el(id).disabled = !value; el('pair-form').hidden = value; }
async function send(route, data = {}, secret = connection?.token, base = connection?.endpoint) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, body: JSON.stringify(data), credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000) });
  const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.message || 'The local companion connection failed.'); return result;
}
function sendFor(session, route, data) {
  if (!session || connection !== session) return Promise.reject(new Error('The companion connection changed. Start this request again.'));
  return send(route, data, session.token, session.endpoint);
}
function stop(message = 'Disconnected.') { clearInterval(timer); timer = null; connection = null; pending = null; el('review').hidden = true; connectedUI(false); status(message); }
function describe(command) {
  const p = command.payload;
  if (command.operation === 'browser.listTabs') return 'Share the titles and URLs of your current non-private HTTP and HTTPS tabs with Olanga.';
  if (command.operation === 'browser.focusTab') return `Switch to this exact tab only if its URL is unchanged:\n${p.url}`;
  if (command.operation === 'browser.readSelection') return `Read only your selected text from:\n${p.url}`;
  if (command.operation === 'browser.resumeTabs') return 'Reuse matching open tabs and open missing pages:\n' + p.tabs.map(tab => tab.url).join('\n');
  return 'Unsupported request.';
}
async function poll() {
  if (!connection || polling) return; polling = true;
  try {
    const result = await send('/poll', { busy: executing });
    if (pending && result.cancelled?.includes(pending.id)) { pending = null; el('review').hidden = true; status('The request was cancelled by Olanga.'); }
    if (result.command && !pending) { pending = result.command; el('request').textContent = describe(pending); el('review').hidden = false; status('Review the requested action below.'); }
    if (pending && Date.now() >= pending.expiresAt) { pending = null; el('review').hidden = true; status('The request expired. Request it again from Olanga.'); }
  } catch (error) { stop(error.message); }
  finally { polling = false; }
}
el('pair-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const endpoint = OlangaBrowserCompanion.endpoint(el('endpoint').value.trim()), code = el('code').value.trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('Paste the one-time code shown in Olanga.');
    const result = await send('/pair', { name: 'Browser companion' }, code, endpoint);
    connection = { endpoint, token: result.token }; el('code').value = ''; connectedUI(true); status('Connected. Nothing has been shared yet.');
    timer = setInterval(poll, 1000); await poll();
  } catch (error) { status(error.message); }
});
el('disconnect').addEventListener('click', async () => { try { await send('/disconnect'); } catch {} stop(); });
el('share-tabs').addEventListener('click', async () => {
  const session = connection;
  try {
    if (!await chrome.permissions.request({ permissions: ['tabs'] })) throw new Error('Tab sharing was not enabled.');
    const result = await adapter.run('browser.listTabs'); await sendFor(session, '/publish', { kind: 'tabs', title: 'Shared browser tabs', items: result.items }); status(`${result.items.length} tab titles and URLs shared with Olanga.`);
  } catch (error) { status(error.message); }
});
el('share-selection').addEventListener('click', async () => {
  const session = connection;
  try {
    const tab = await chrome.tabs.get(sourceTabId), result = await adapter.run('browser.readSelection', { tabId: sourceTabId, url: tab.url });
    await sendFor(session, '/publish', { kind: 'selection', title: result.title, url: result.url, text: result.text }); status('Selected text shared with Olanga.');
  } catch (error) { status(error.message); }
});
el('approve').addEventListener('click', async () => {
  const command = pending, session = connection; if (!command || command.expiresAt <= Date.now()) return;
  executing = true; el('approve').disabled = true; el('decline').disabled = true;
  let result;
  try {
    if (['browser.listTabs', 'browser.focusTab', 'browser.resumeTabs'].includes(command.operation) && !await chrome.permissions.request({ permissions: ['tabs'] })) throw new Error('Tab access was declined.');
    if (command.expiresAt <= Date.now()) throw new Error('The request expired before it could start.');
    result = await adapter.run(command.operation, command.payload, { authorize: () => sendFor(session, '/authorize', { id: command.id }) });
    if (result.items && command.operation === 'browser.listTabs') await sendFor(session, '/publish', { kind: 'tabs', title: 'Shared browser tabs', items: result.items });
    if (result.text) await sendFor(session, '/publish', { kind: 'selection', title: result.title, url: result.url, text: result.text });
  } catch (error) { result = { ok: false, verified: false, message: error.message }; }
  try { await sendFor(session, '/result', { id: command.id, result }); status(result.message); } catch (error) { status(error.message); }
  executing = false; pending = null; el('review').hidden = true; el('approve').disabled = false; el('decline').disabled = false;
});
el('decline').addEventListener('click', async () => {
  if (!pending) return;
  try { await send('/result', { id: pending.id, result: { ok: false, verified: false, message: 'The browser request was declined.' } }); } catch (error) { status(error.message); }
  pending = null; el('review').hidden = true; status('Request declined.');
});
