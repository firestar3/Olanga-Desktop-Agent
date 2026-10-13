/* The privacy notice is packaged with the app and rendered as text, never HTML. */
(() => {
  const details = document.getElementById('privacyFullNotice');
  const body = document.getElementById('privacyFullNoticeBody');
  let loading = false, loaded = false;
  function inline(parent, text) {
    const parts = text.split(/(\[[^\]]+\]\(https?:\/\/[^)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g);
    for (const part of parts) {
      const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
      if (link) {
        const a = document.createElement('a'); a.textContent = link[1]; a.href = link[2];
        a.addEventListener('click', event => { event.preventDefault(); window.electronAPI?.openExternal?.(a.href); });
        parent.append(a);
      } else if (part.startsWith('**') && part.endsWith('**')) {
        const strong = document.createElement('strong'); strong.textContent = part.slice(2, -2); parent.append(strong);
      } else parent.append(document.createTextNode(part.replace(/^`|`$/g, '')));
    }
  }
  async function loadNotice() {
    if (loading || loaded) return;
    loading = true; body.textContent = 'Opening the privacy notice…';
    try {
      const response = await fetch('./PRIVACY.md');
      if (!response.ok) throw new Error('Notice unavailable');
      const text = await response.text();
      const fragment = document.createDocumentFragment();
      for (const block of text.trim().split(/\r?\n\s*\r?\n/)) {
        const heading = block.match(/^(#{1,3}) (.+)$/);
        if (heading) { const node = document.createElement(heading[1].length === 1 ? 'h4' : 'h5'); inline(node, heading[2]); fragment.append(node); }
        else if (block.startsWith('| ')) {
          const list = document.createElement('dl'); list.className = 'privacy-facts';
          for (const row of block.split(/\r?\n/).slice(2)) {
            const cells = row.split('|').slice(1, -1).map(cell => cell.trim());
            if (cells.length !== 2) continue;
            const group = document.createElement('div'), term = document.createElement('dt'), definition = document.createElement('dd');
            inline(term, cells[0]); inline(definition, cells[1]); group.append(term, definition); list.append(group);
          }
          fragment.append(list);
        }
        else if (/^- /m.test(block)) {
          const list = document.createElement('ul');
          for (const line of block.split(/\r?\n(?=- )/)) { const li = document.createElement('li'); inline(li, line.replace(/^- /, '').replace(/\r?\n/g, ' ')); list.append(li); }
          fragment.append(list);
        } else { const p = document.createElement('p'); inline(p, block.replace(/\r?\n/g, ' ')); fragment.append(p); }
      }
      body.replaceChildren(fragment); loaded = true;
    } catch (_) {
      const p = document.createElement('p'); p.textContent = 'The bundled notice could not be opened. Close this section and open it to retry.';
      body.replaceChildren(p);
    } finally { loading = false; }
  }
  details?.addEventListener('toggle', () => { if (details.open) loadNotice(); });
  document.querySelectorAll('[data-privacy-workspace]').forEach(button => {
    button.addEventListener('click', () => {
      document.getElementById('workspaceOpen')?.click();
      document.querySelector('[data-workspace-tab="' + button.dataset.privacyWorkspace + '"]')?.click();
    });
  });
})();
