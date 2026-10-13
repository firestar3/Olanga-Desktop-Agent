// Actual production renderer/preload; isolated user data, source fixtures only.
const { app, BrowserWindow, ipcMain, session, net } = require('electron');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const output = path.resolve(__dirname, '../build/qa'); fs.mkdirSync(output, { recursive: true });
app.disableHardwareAcceleration(); app.setPath('userData', fs.mkdtempSync(path.join(output, 'news-reader-profile-')));
const report = { passed: false, runtime: process.versions.electron, checks: [], forbiddenCalls: [], requests: [], aiRequests: [], externalLinks: [], screenshots: [] };
let main, failFeed = false, expectedAiQuestion = null, pendingAi = null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = new Date().toISOString();
const bundle = () => ({ locationLabel: 'Fixture region', topics: ['local', 'technology'], generatedAt: new Date().toISOString(), coverage: { failedFeeds: 1, localUnavailable: true }, articles: [
  { title: 'Source headline <img src=x onerror=alert(1)>', link: 'https://one.example/report', source: 'One', sourceUrl: 'https://one.example/', pubDate: now, topics: ['technology'], description: 'Only the supplied source excerpt appears here.' },
  { title: 'Source headline <img src=x onerror=alert(1)>', link: 'https://two.example/duplicate', source: 'Two', pubDate: now, topics: ['technology'] },
  { title: 'Research without a publication date', link: 'https://two.example/research', source: 'InternationalPublisher'.repeat(4), topics: ['technology'] },
  { title: 'Local service expanded', link: 'https://three.example/local', source: 'Three', pubDate: now, topics: ['local'], localMatch: true },
  { title: 'Ancient story', link: 'https://three.example/old', source: 'Three', pubDate: '2020-01-01' },
  { title: 'Unsafe link', link: 'javascript:alert(1)', source: 'Unsafe' }
] });
const forbidden = new Set(['provider-generate', 'provider-stream', 'provider-generate-stream', 'provider-warm', 'nvidia-tts-synthesize', 'nvidia-tts-config', 'open-app', 'close-app', 'arrange-app', 'media-control', 'play-spotify', 'desktop-capture', 'desktop-run', 'set-open-at-login']);
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, (event, ...args) => {
  if (channel === 'provider-generate' && expectedAiQuestion && !pendingAi) {
    const payload = args[0], question = payload?.body?.contents?.at(-1)?.parts?.[0]?.text;
    if (question === expectedAiQuestion && payload?.body?.system_instruction?.parts?.[0]?.text?.startsWith('You are Olanga’s news reading assistant.')) {
      report.aiRequests.push(payload);
      expectedAiQuestion = null;
      return new Promise(resolve => { pendingAi = value => { pendingAi = null; resolve(value); }; });
    }
  }
  if (forbidden.has(channel)) { report.forbiddenCalls.push(channel); throw new Error('Disabled in News fixture'); }
  if (channel === 'fetch-news-bundle') { report.requests.push(args[0]); if (failFeed) throw new Error('Fixture offline'); return bundle(); }
  if (channel === 'open-external') { report.externalLinks.push(args[0]); return; }
  return callback(event, ...args);
});
const on = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, callback) => on(channel, (event, ...args) => { if (channel === 'open-external') { report.externalLinks.push(args[0]); return; } return callback(event, ...args); });
const offline = async () => { report.forbiddenCalls.push('network'); throw new Error('Network disabled'); }; globalThis.fetch = offline; net.fetch = offline;
app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => { report.forbiddenCalls.push(permission); callback(false); });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => { report.forbiddenCalls.push('renderer-network'); callback({ cancel: true }); });
});
const evaluate = (fn, ...args) => main.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')', true);
async function waitFor(fn, label) { for (let index = 0; index < 200; index++) { if (await fn()) return; await pause(25); } throw new Error(label); }
async function check(label, fn) { await fn(); report.checks.push(label); }
async function click(selector) { return evaluate(selector => { const node = document.querySelector(selector); if (!node || !node.getClientRects().length || node.disabled) throw new Error('Control unavailable: ' + selector); node.scrollIntoView({ block: 'nearest' }); node.click(); }, selector); }
async function screenshot(name) { await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); main.webContents.invalidate(); await pause(180); await main.webContents.capturePage(); await pause(100); const filename = path.join(output, 'news-reader-' + name + '.png'); fs.writeFileSync(filename, (await main.webContents.capturePage()).toPNG()); report.screenshots.push(filename); }
function finish(code) { fs.writeFileSync(path.join(output, 'news-reader-smoke.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); app.exit(code); }
const deadline = setTimeout(() => { report.error = 'News fixture exceeded 60 seconds'; finish(1); }, 60000); deadline.unref();
require('../main');
app.whenReady().then(async () => {
  try {
    await waitFor(() => { main = BrowserWindow.getAllWindows().find(win => /index\.html$/.test(win.webContents.getURL())); return main && !main.webContents.isLoading(); }, 'Renderer did not load');
    await waitFor(() => evaluate(() => !!window.loadSettingsValues), 'Initialization incomplete');
    await evaluate(() => { window.newsTestErrors = []; addEventListener('error', event => newsTestErrors.push(event.message)); addEventListener('unhandledrejection', event => newsTestErrors.push(String(event.reason))); isMicMuted = true; isTtsMuted = true; document.getElementById('startLocalBtn').click(); setFeatureEnabled('newsScreen', true); });
    main.unmaximize(); main.setContentSize(1100, 800);
    await click('[data-screen="newsScreen"]'); await waitFor(() => evaluate(() => !!newsBundleData && !newsRefreshController), 'News did not load');
    await check('Headlines are source-grounded, safe, dated, deduplicated and do not call a generation provider', async () => {
      const view = await evaluate(() => ({ count: document.querySelectorAll('.news-story').length, text: newsArticle.textContent, unsafe: !!newsArticle.querySelector('img,script'), times: [...newsArticle.querySelectorAll('time')].map(time => time.dateTime), status: newsStatus.textContent }));
      assert.equal(view.count, 3); assert.equal(view.unsafe, false); assert.ok(view.text.includes('Date unavailable')); assert.ok(view.text.includes('Only the supplied source excerpt'));
      assert.ok(!view.text.includes('Ancient story') && !view.text.includes('Unsafe link')); assert.equal(view.times.length, 2); assert.ok(view.status.includes('unavailable') && view.status.includes('city or region'));
      const visibility = await evaluate(() => ({ empty: getComputedStyle(newsEmptyState).display, article: getComputedStyle(newsArticle).display, firstTop: newsArticle.querySelector('.news-story').getBoundingClientRect().top, paneBottom: document.getElementById('newsArticlePane').getBoundingClientRect().bottom }));
      assert.equal(visibility.empty, 'none'); assert.notEqual(visibility.article, 'none'); assert.ok(visibility.firstTop < visibility.paneBottom - 60, JSON.stringify(visibility));
      assert.deepEqual(report.forbiddenCalls, []); await screenshot('headlines');
    });
    await check('Read markers, unread filtering and source links work without navigating the app', async () => {
      await click('.news-story [data-news-read]'); assert.equal(await evaluate(() => newsReadItems.length), 1);
      await click('#newsUnreadOnlyToggle'); assert.equal(await evaluate(() => document.querySelectorAll('.news-story').length), 2);
      await click('.news-story h2 a'); await waitFor(() => report.externalLinks.length === 1, 'Source link missed safe external bridge');
      assert.equal(await evaluate(() => document.querySelectorAll('.news-story').length), 1);
      await click('#newsClearReadBtn'); assert.equal(await evaluate(() => newsReadItems.length), 0); assert.equal(await evaluate(() => document.querySelectorAll('.news-story').length), 3);
    });
    await check('Read marker storage failures are atomic and unread-only empty states remain usable', async () => {
      const failure = await evaluate(() => {
        const original = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key === OlangaNews.READ_KEY) throw new Error('Quota fixture'); return original.call(this, key, value); };
        try { document.querySelector('[data-news-read]').click(); return { count: newsReadItems.length, status: newsStatus.dataset.state, cards: newsArticle.querySelectorAll('.news-story').length }; } finally { Storage.prototype.setItem = original; }
      });
      assert.deepEqual(failure, { count: 0, status: 'error', cards: 3 });
      await click('[data-news-read]'); await click('[data-news-read]'); await click('[data-news-read]');
      assert.equal(await evaluate(() => newsArticle.querySelectorAll('.news-story').length), 0);
      assert.ok((await evaluate(() => newsArticle.textContent)).includes('caught up'));
      await click('#newsClearReadBtn'); assert.equal(await evaluate(() => newsArticle.querySelectorAll('.news-story').length), 3);
    });
    await check('A failed refresh preserves readable headlines and can be retried', async () => {
      failFeed = true; await click('#newsRefreshBtn'); await waitFor(() => evaluate(() => !newsRefreshController), 'Failed refresh remained busy');
      assert.equal(await evaluate(() => document.querySelectorAll('.news-story').length), 3);
      assert.ok((await evaluate(() => newsStatus.textContent)).includes('previously checked'));
      failFeed = false; await click('#newsRefreshBtn'); await waitFor(() => evaluate(() => !newsRefreshController), 'Retry remained busy');
      assert.equal(await evaluate(() => newsStatus.dataset.state), '');
    });
    await check('Preferences save explicitly and failed writes preserve the previous selected topics', async () => {
      await click('.news-topic-chip[data-topic="business"]'); await waitFor(() => evaluate(() => !newsRefreshController), 'Topic refresh remained busy');
      await evaluate(() => { const select = document.getElementById('newsLengthSelect'); select.value = '6'; select.dispatchEvent(new Event('change')); });
      await waitFor(() => evaluate(() => !newsRefreshController), 'Length refresh remained busy');
      const saved = await evaluate(() => JSON.parse(localStorage.getItem(OlangaNews.PREFS_KEY))); assert.equal(saved.limit, 6); assert.equal(saved.topics.includes('business'), false); assert.equal(saved.unreadOnly, true);
      const failure = await evaluate(() => {
        const original = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key === OlangaNews.PREFS_KEY) throw new Error('Quota fixture'); return original.call(this, key, value); };
        try { document.querySelector('[data-topic="science"]').click(); return { topics: getSelectedNewsTopics(), active: document.querySelector('[data-topic="science"]').getAttribute('aria-pressed'), error: newsStatus.dataset.state }; } finally { Storage.prototype.setItem = original; }
      });
      assert.equal(failure.topics.includes('science'), false); assert.equal(failure.active, 'false'); assert.equal(failure.error, 'error');
      const priorErrors = await evaluate(() => window.newsTestErrors);
      await new Promise(resolve => { main.webContents.once('did-finish-load', resolve); main.webContents.reload(); });
      await waitFor(() => evaluate(() => !!window.loadSettingsValues), 'Reload failed');
      await evaluate(errors => { window.newsTestErrors = errors; addEventListener('error', event => newsTestErrors.push(event.message)); addEventListener('unhandledrejection', event => newsTestErrors.push(String(event.reason))); }, priorErrors);
      assert.deepEqual(await evaluate(() => ({ limit: newsLengthSelect.value, unread: newsUnreadOnlyToggle.checked, business: document.querySelector('[data-topic="business"]').getAttribute('aria-pressed') })), { limit: '6', unread: true, business: 'false' });
      await click('[data-screen="newsScreen"]'); await waitFor(() => evaluate(() => !newsRefreshController), 'Reloaded News remained busy');
    });
    await check('Explicit News AI sends the exact loaded source context and displays a safe successful reply', async () => {
      assert.equal(report.aiRequests.length, 0, 'Loading and reading headlines must not generate an answer');
      await evaluate(() => {
        apiKey = 'fixture-news-key'; apiKeys = [apiKey]; currentKeyIndex = 0;
        localStorage.setItem('olanga_city', 'Fixture City'); localStorage.setItem('olanga_state', 'Fixture Region'); localStorage.setItem('olanga_country', 'Fixture Country');
        OlangaWorkspace.rememberFact('PRIVATE_SAVED_MEMORY_SENTINEL');
        conversationHistory.push({ role: 'user', text: 'PRIVATE_HOME_CONVERSATION_SENTINEL' });
      });
      await click('#newsRefreshBtn'); await waitFor(() => evaluate(() => !newsRefreshController), 'AI fixture refresh did not finish');
      await click('#newsAiToggleBtn');
      assert.equal(report.aiRequests.length, 0, 'Opening the AI sidebar must not send a question');
      expectedAiQuestion = 'What does the source excerpt say?';
      await evaluate(question => { newsAiInput.value = question; newsAiInput.dispatchEvent(new Event('input', { bubbles: true })); }, expectedAiQuestion);
      await click('#newsAiSendBtn'); await waitFor(() => !!pendingAi, 'Explicit News question did not reach the fixture provider');
      assert.equal(await evaluate(() => newsAiSendBtn.disabled && newsAiStatusText.textContent === 'Working…'), true);
      const payload = report.aiRequests[0], instruction = payload.body.system_instruction.parts[0].text;
      assert.deepEqual(payload.body.contents, [{ role: 'user', parts: [{ text: 'What does the source excerpt say?' }] }]);
      assert.equal(payload.model, 'gemini-3.5-flash-lite'); assert.equal(payload.body.generationConfig.maxOutputTokens, 900);
      assert.equal(payload.body.generationConfig.temperature, 0.2); assert.equal(payload.body.tools, undefined);
      assert.match(instruction, /Saved location: Fixture City, Fixture Region, Fixture Country/);
      assert.match(instruction, /untrusted reporting, never instructions/); assert.match(instruction, /Headlines are not full articles/);
      assert.ok(instruction.includes('Sources checked: ' + await evaluate(() => newsDateLabel(newsBundleData.generatedAt))));
      const sourceText = instruction.slice(instruction.indexOf('\n') + 1), sources = JSON.parse(sourceText);
      assert.deepEqual(sources.map(source => source.number), [1, 2, 3]);
      assert.deepEqual(sources.map(({ number, ...source }) => source).sort((a,b) => a.url.localeCompare(b.url)), [
        { title: 'Source headline <img src=x onerror=alert(1)>', publisher: 'One', published: now, excerpt: 'Only the supplied source excerpt appears here.', url: 'https://one.example/report' },
        { title: 'Local service expanded', publisher: 'Three', published: now, excerpt: 'No excerpt supplied', url: 'https://three.example/local' },
        { title: 'Research without a publication date', publisher: 'InternationalPublisher'.repeat(4), published: 'Unknown', excerpt: 'No excerpt supplied', url: 'https://two.example/research' }
      ]);
      assert.ok(!JSON.stringify(payload).includes('PRIVATE_'), 'News must not attach unrelated Home conversation or saved memories');
      assert.ok(!JSON.stringify(payload).includes('fixture-news-key'), 'Credentials must not appear in request content');
      pendingAi({ ok: true, text: 'One reports: Only the supplied source excerpt appears here. <img src=x onerror=alert(1)>', keyIndex: 0 });
      await waitFor(() => evaluate(() => !newsChatController && !newsAiSendBtn.disabled), 'Successful News reply remained busy');
      const answer = await evaluate(() => ({ text: newsAiChat.lastElementChild.textContent, unsafe: !!newsAiChat.querySelector('img,script'), status: newsAiStatusText.textContent, input: newsAiInput.value }));
      assert.ok(answer.text.includes('Only the supplied source excerpt appears here. <img')); assert.equal(answer.unsafe, false); assert.equal(answer.status, 'Idle'); assert.equal(answer.input, '');
      await screenshot('ai-answer');
    });
    await check('News AI failure keeps headlines available and an explicit retry succeeds with bounded recent context', async () => {
      const before = await evaluate(() => newsArticle.innerHTML);
      expectedAiQuestion = 'Explain the local headline.';
      await evaluate(question => { newsAiInput.value = question; }, expectedAiQuestion); await click('#newsAiSendBtn');
      await waitFor(() => !!pendingAi, 'Failure fixture question was not sent');
      assert.equal(report.aiRequests.length, 2);
      pendingAi({ ok: false, error: { message: 'Fixture provider unavailable', status: 429, code: 'fixture-unavailable' } });
      await waitFor(() => evaluate(() => !newsChatController && !newsAiSendBtn.disabled), 'Failed News reply remained busy');
      assert.match(await evaluate(() => newsAiChat.lastElementChild.textContent), /could not answer.*headlines are still available.*Try again/i);
      assert.equal(await evaluate(() => newsArticle.innerHTML), before); assert.equal(report.aiRequests.length, 2, 'Failure must not submit another question automatically');
      expectedAiQuestion = 'Try the local headline again.';
      await evaluate(question => { newsAiInput.value = question; }, expectedAiQuestion); await click('#newsAiSendBtn');
      await waitFor(() => !!pendingAi, 'Explicit News retry was not sent');
      assert.equal(report.aiRequests.length, 3);
      const request = report.aiRequests[2];
      assert.deepEqual(request.body.contents.map(item => item.role), ['user', 'model', 'user', 'model', 'user']);
      assert.deepEqual(request.body.contents.map(item => item.parts[0].text), [
        'What does the source excerpt say?', 'One reports: Only the supplied source excerpt appears here. <img src=x onerror=alert(1)>',
        'Explain the local headline.', 'The news assistant could not answer. Your headlines are still available. Try again.', 'Try the local headline again.'
      ]);
      assert.equal(request.body.system_instruction.parts[0].text, report.aiRequests[0].body.system_instruction.parts[0].text, 'Retry must keep the same checked source context');
      pendingAi({ ok: true, text: 'Three: Local service expanded. The feed supplied no further excerpt.', keyIndex: 0 });
      await waitFor(() => evaluate(() => !newsChatController && !newsAiSendBtn.disabled), 'Retried News reply remained busy');
      assert.match(await evaluate(() => newsAiChat.lastElementChild.textContent), /Three: Local service expanded/);
      assert.equal(await evaluate(() => newsArticle.innerHTML), before);
      await click('#newsAiCloseBtn'); await evaluate(() => { apiKey = ''; apiKeys = []; currentKeyIndex = 0; });
    });
    await check('The reader remains usable at the 400 pixel minimum window width', async () => {
      main.setContentSize(400, 700); await pause(200);
      const layout = await evaluate(() => [...document.querySelectorAll('.news-story, .news-header-copy, .news-subtitle, .news-reading-controls, .news-actions, .news-story h2, .news-story-meta')].filter(node => node.getClientRects().length).map(node => ({ selector: node.className || node.tagName, right: node.getBoundingClientRect().right, scroll: node.scrollWidth, width: node.clientWidth, viewport: innerWidth })));
      assert.ok(layout.every(item => item.right <= item.viewport + 1 && item.scroll <= item.width + 1), JSON.stringify(layout));
      const spacing = await evaluate(() => ({ statusBottom: newsStatus.getBoundingClientRect().bottom, paneTop: document.getElementById('newsArticlePane').getBoundingClientRect().top }));
      assert.ok(spacing.statusBottom <= spacing.paneTop, JSON.stringify(spacing));
      await screenshot('minimum-width');
      await evaluate(() => newsArticle.querySelector('.news-story').scrollIntoView({ block: 'start' }));
      const first = await evaluate(() => ({ top: newsArticle.querySelector('.news-story').getBoundingClientRect().top, bottom: newsArticle.querySelector('.news-story').getBoundingClientRect().bottom, height: innerHeight }));
      assert.ok(first.top >= 0 && first.top < first.height && first.bottom <= first.height, JSON.stringify(first));
      await screenshot('minimum-width-stories');
    });
    assert.deepEqual(report.forbiddenCalls, []); assert.deepEqual(await evaluate(() => newsTestErrors), []); report.passed = true; finish(0);
  } catch (error) { report.error = error.stack; finish(1); }
});
