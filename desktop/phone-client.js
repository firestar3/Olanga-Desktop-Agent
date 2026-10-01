/* Same-origin HTTPS client. Pair/session credentials never enter URL or localStorage. */
(() => {
  const byId = id => document.getElementById(id);
  let csrf = '', expiresAt = 0, pending = null, busy = false, recognition = null;
  const status = text => { byId('status').textContent = text; };
  function paired(value) {
    csrf = value?.csrf || ''; expiresAt = value?.expiresAt || 0;
    byId('pairing').hidden = !!csrf; byId('controls').hidden = !csrf;
    byId('expiry').textContent = csrf ? `This phone stays paired until ${new Date(expiresAt).toLocaleTimeString()}.` : '';
  }
  async function request(route, payload) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(route, { method: payload ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'X-Olanga-Client': 'phone-v1', ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-Olanga-CSRF': csrf } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: controller.signal });
      const data = await response.json();
      if (!response.ok) { if (response.status === 401 || response.status === 410) paired(null); const error = new Error(data.error || 'The request failed.'); error.status = response.status; throw error; }
      return data;
    } finally { clearTimeout(timer); }
  }
  byId('pairForm').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; busy = true;
    const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try { paired(await request('/pair', { code: byId('code').value.trim() })); byId('code').value = ''; status('Paired. Ready for a command.'); }
    catch (error) { status(error.message); } finally { busy = false; button.disabled = false; }
  });
  async function send(retry = false) {
    if (busy || !csrf) return;
    if (!retry) {
      if (pending) { status('Check the previous request first. It may already have run.'); return; }
      const text = byId('command').value.trim(); if (!text) return;
      if (!crypto.randomUUID) { status('This browser needs a trusted HTTPS connection to create request identifiers.'); return; }
      pending = { text, requestId: crypto.randomUUID() };
    }
    if (!pending) return;
    recognition?.stop(); busy = true; byId('send').disabled = true; byId('retry').hidden = true; status('Olanga is working…');
    try {
      const result = await request('/command', pending);
      byId('result').textContent = `${result.message}${result.ok && !result.verified ? '\nThe app did not verify the final state.' : ''}`;
      pending = null; status(result.ok ? 'Request finished.' : 'Review the result before trying another command.');
    } catch (error) {
      if (error.status && error.status !== 500) { pending = null; status(error.message); }
      else { status('The connection was interrupted. The command may already have run. Check the same request again to retrieve its result without repeating it.'); byId('retry').hidden = false; }
    } finally { busy = false; byId('send').disabled = false; }
  }
  byId('commandForm').addEventListener('submit', event => { event.preventDefault(); send(); });
  byId('retry').addEventListener('click', () => send(true));
  for (const button of document.querySelectorAll('[data-example]')) button.addEventListener('click', () => { byId('command').value = button.dataset.example; byId('command').focus(); });
  byId('disconnect').addEventListener('click', async () => {
    recognition?.stop();
    try { await request('/revoke', {}); paired(null); pending = null; status('Unpaired. Restart phone control in Olanga to pair again.'); }
    catch (error) { status(error.message); }
  });
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { byId('dictate').hidden = true; byId('dictationHelp').textContent = 'This browser does not provide web dictation. You can type or use your phone keyboard’s dictation, then review the text and send it.'; }
  else {
    byId('dictate').addEventListener('click', () => {
      if (busy) return;
      if (recognition) { recognition.stop(); return; }
      try {
        recognition = new SpeechRecognition(); recognition.lang = navigator.language || 'en-US'; recognition.continuous = false; recognition.interimResults = false;
        recognition.onresult = event => { byId('command').value = String(event.results?.[0]?.[0]?.transcript || '').slice(0, 300); status('Review the transcript, then press Send command.'); };
        recognition.onerror = () => status('Dictation could not finish. You can type the command instead.');
        recognition.onend = () => { recognition = null; byId('dictate').textContent = 'Dictate'; };
        recognition.start(); byId('dictate').textContent = 'Stop dictation'; status('Listening through your browser’s speech service…');
      } catch (_) { recognition = null; status('Dictation is unavailable. Check microphone permission or type instead.'); }
    });
  }
  window.addEventListener('pagehide', () => recognition?.stop());
  request('/session').then(value => { paired(value); status('Paired. Ready for a command.'); }).catch(() => { paired(null); status('Enter the code shown in Olanga.'); });
})();
