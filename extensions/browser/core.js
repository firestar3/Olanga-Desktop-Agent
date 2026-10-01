(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaBrowserCompanion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function webUrl(value) {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('Choose a supported page URL.');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP and HTTPS pages without embedded credentials are supported.');
    return url.href;
  }
  function endpoint(value) {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use the exact local endpoint shown in Olanga.');
    return url.origin;
  }
  function createBrowserAdapter(chrome) {
    async function tabsPermission() { if (!await chrome.permissions.contains({ permissions: ['tabs'] })) throw new Error('Enable tab sharing in the companion before this operation.'); }
    function tabItem(tab) {
      if (tab.incognito || !Number.isInteger(tab.id)) return null;
      try { return { id: tab.id, tabId: tab.id, windowId: tab.windowId, title: (tab.title || '').slice(0, 200), url: webUrl(tab.url) }; } catch { return null; }
    }
    async function matchingTab(payload) {
      if (!Number.isInteger(payload.tabId) || payload.tabId < 0) throw new Error('The chosen tab is invalid.');
      const tab = await chrome.tabs.get(payload.tabId);
      if (tab.incognito || webUrl(tab.url) !== webUrl(payload.url) || (tab.pendingUrl && webUrl(tab.pendingUrl) !== webUrl(payload.url))) throw new Error('The selected tab navigated. Share its current page again.');
      return tab;
    }
    async function run(operation, payload = {}, { authorize = async () => {} } = {}) {
      if (operation === 'browser.listTabs') {
        await tabsPermission(); await authorize();
        return { ok: true, verified: true, message: 'Current browser tabs shared.', items: (await chrome.tabs.query({})).map(tabItem).filter(Boolean).slice(0, 200) };
      }
      if (operation === 'browser.focusTab') {
        await tabsPermission(); await authorize(); const tab = await matchingTab(payload);
        await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true });
        const current = await matchingTab(payload);
        return { ok: current.active === true, verified: current.active === true, message: current.active ? 'The selected tab is active.' : 'The browser did not confirm the active tab.' };
      }
      if (operation === 'browser.resumeTabs') {
        await tabsPermission();
        if (!Array.isArray(payload.tabs) || !payload.tabs.length || payload.tabs.length > 30) throw new Error('Choose between 1 and 30 tabs.');
        const urls = [...new Set(payload.tabs.map(item => webUrl(item.url)))], receipts = [];
        for (const url of urls) {
          const existing = (await chrome.tabs.query({})).map(tabItem).filter(Boolean).filter(tab => tab.url === url);
          if (existing.length) { receipts.push({ url, status: 'already-open', tabId: existing[0].tabId }); continue; }
          await authorize();
          const opened = await chrome.tabs.create({ url, active: false });
          const current = await chrome.tabs.get(opened.id);
          if (webUrl(current.pendingUrl || current.url) !== url) throw new Error('A newly opened tab could not be verified. Earlier tabs may already have opened.');
          receipts.push({ url, status: 'opened', tabId: opened.id });
        }
        return { ok: true, verified: true, message: `${receipts.length} tabs restored or already open.`, items: receipts };
      }
      if (operation === 'browser.readSelection') {
        await authorize(); await matchingTab(payload);
        const results = await chrome.scripting.executeScript({ target: { tabId: payload.tabId }, func: () => ({ text: window.getSelection()?.toString() || '', url: location.href, title: document.title }) });
        await matchingTab(payload);
        const selection = results.find(result => result.frameId === 0)?.result;
        if (!selection || webUrl(selection.url) !== webUrl(payload.url) || typeof selection.text !== 'string' || !selection.text.trim()) throw new Error('Select page text first, then invoke the Olanga extension on that tab.');
        if (selection.text.length > 50000) throw new Error('Select at most 50,000 characters.');
        return { ok: true, verified: true, message: 'Selected page text shared.', text: selection.text, url: selection.url, title: String(selection.title).slice(0, 200) };
      }
      throw new Error('Unsupported browser operation.');
    }
    return { run, tabItem };
  }
  return { createBrowserAdapter, webUrl, endpoint };
});
