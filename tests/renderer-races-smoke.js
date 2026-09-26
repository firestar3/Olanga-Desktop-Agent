// Real renderer, isolated profile, controlled delayed provider responses.
// No network, microphone, real credentials or native application actions.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, '../build/qa');
fs.mkdirSync(output, { recursive: true });
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(output, 'renderer-races-profile-')));
const report = { passed: false, checks: [], forbiddenCalls: [], errors: [], gracefulQuit: false };
const forbidden = new Set(['provider-generate', 'nvidia-tts-synthesize', 'nvidia-tts-config', 'media-control', 'open-app', 'close-app', 'arrange-app', 'play-spotify', 'desktop-capture', 'desktop-run', 'desktop-undo', 'terminal-session-create']);
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, (event, ...args) => {
  if (forbidden.has(channel)) { report.forbiddenCalls.push(channel); throw new Error('Disabled in renderer race test: ' + channel); }
  if (channel === 'fetch-news-bundle') return { locationLabel: args[0]?.city || 'Fixture city', topics: ['technology'], generatedAt: new Date().toISOString(), articles: [{ title: 'Fixture headline', description: 'Fixture description', source: 'Fixture', link: 'https://example.com/story' }] };
  return callback(event, ...args);
});
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, _file, error) => report.errors.push(error.message));
  contents.on('render-process-gone', (_event, details) => report.errors.push(details.reason));
});
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => { report.forbiddenCalls.push(permission); callback(false); });
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
});
require('../main');
let main;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = fn => main.webContents.executeJavaScript(`(${fn.toString()})()`, true);
const save = () => fs.writeFileSync(path.join(output, 'renderer-races-smoke.json'), JSON.stringify(report, null, 2));
const deadline = setTimeout(() => { report.passed = false; report.error = 'Renderer regression check exceeded 45 seconds.'; save(); app.exit(1); }, 45000);
deadline.unref();
app.on('will-quit', () => { report.gracefulQuit = true; save(); });
process.on('uncaughtException', error => { report.error = error.stack; report.passed = false; save(); app.exit(1); });
async function check(label, fn) { await evaluate(fn); report.checks.push(label); }
app.whenReady().then(async () => {
  try {
    for (let i = 0; i < 160; i++) {
      main = BrowserWindow.getAllWindows().find(win => /index\.html/.test(win.webContents.getURL()));
      if (main && !main.webContents.isLoading()) break;
      await pause(50);
    }
    assert.ok(main);
    await evaluate(() => {
      window.raceErrors = [];
      window.addEventListener('error', event => raceErrors.push(event.message));
      window.addEventListener('unhandledrejection', event => raceErrors.push(String(event.reason?.message || event.reason)));
      window.assertRace = (condition, message) => { if (!condition) throw new Error(message); };
      window.alerts = []; window.alert = text => alerts.push(text); window.confirm = () => true;
      window.replies = [];
      callGeminiChat = (model, messages, options) => new Promise((resolve, reject) => replies.push({ model, messages, options, resolve: text => resolve({ choices: [{ message: { content: text } }] }), reject }));
      window.resetNotes = () => {
        notepadTabsData = [{ id: 100, name: 'Alpha', content: 'original alpha' }, { id: 101, name: 'Beta', content: 'original beta' }];
        currentTabId = 100; nextNotepadTabId = 102; notepadTextarea.innerHTML = 'original alpha';
        notepadAiChatHistory = []; notepadAiChatSummary = ''; notepadAiChat.replaceChildren(); replies.length = 0;
        notepadAiStatusDot.classList.remove('error'); renderNotepadTabs();
      };
      window.beginNote = message => { notepadAiInput.value = message; return sendNotepadAiMessage(); };
    });
    await check('safe note formatting preserves first lines, blank lines, tabs and literal HTML', () => {
      const response = 'UPDATED NOTE:\n```\nHello\n\nWorld\n```';
      assertRace(extractUpdatedNote(response) === 'Hello<br><br>World', 'First line or paragraph lost');
      const code = '\tif (a < b) {\n\t\treturn "&";\n\t}';
      const markup = extractUpdatedCode('UPDATED NOTE:\n```javascript\n' + code + '\n```');
      assertRace(htmlToPlainText(markup) === code, 'Code indentation/entities changed');
      assertRace(extractUpdatedNote('Example:\n```\nhello\n```') === null, 'Unmarked code changed note');
      assertRace(extractUpdatedPayload('UPDATED NOTE:\n```python\nprint("```")\nprint("done")\n```') === 'print("```")\nprint("done")', 'Inline backticks truncated code');
      assertRace(stripMarkdown('```javascript\nconst n = a * b * c;\n```') === 'const n = a * b * c;', 'Chat formatter corrupted code operators');
      const clean = sanitizeNoteHtml('<p onclick="bad()"><b>safe</b><img src="https://example.com/track"><script>bad()</script><a href="javascript:bad()">text</a></p>');
      assertRace(clean === '<p><b>safe</b>text</p>', 'Unsafe saved note markup restored: ' + clean);
      assertRace(!convertMarkdownToHtml('<img src=x> **safe**').includes('<img'), 'AI HTML executed');
      assertRace(htmlToPlainText('<div>One</div><div>Two &amp; &lt;three&gt;</div>') === 'One\nTwo & <three>', 'Paragraphs/entities lost');
    });
    await check('late note edits update their original tab without overwriting the active tab', async () => {
      resetNotes(); const first = beginNote('Rewrite this note');
      notepadAiInput.value = 'duplicate'; await sendNotepadAiMessage();
      assertRace(replies.length === 1, 'Repeated Enter dispatched another request');
      assertRace(replies[0].messages.filter(m => m.content === 'Rewrite this note').length === 1, 'User prompt duplicated');
      switchNotepadTab(101); replies.shift().resolve('UPDATED NOTE:\n```\nRevised alpha\n```'); await first;
      assertRace(notepadTabsData[0].content === 'Revised alpha', 'Original tab not updated');
      assertRace(currentTabId === 101 && notepadTextarea.innerHTML === 'original beta', 'Active tab overwritten or focus stolen');
    });
    await check('typing or deleting a note while AI works prevents stale replacement', async () => {
      resetNotes(); const pending = beginNote('Rewrite');
      notepadTextarea.textContent = 'new user edits'; notepadTextarea.dispatchEvent(new Event('input'));
      replies.shift().resolve('UPDATED NOTE:\n```\nlate revision\n```'); await pending;
      assertRace(notepadTextarea.textContent === 'new user edits', 'New typing overwritten');
      assertRace(notepadAiChat.textContent.includes('late revision'), 'Rejected proposal not visible');
      resetNotes(); const deleted = beginNote('Rewrite'); deleteNotepadTab(100); addNotepadTab();
      replies.shift().resolve('UPDATED NOTE:\n```\nstale deleted content\n```'); await deleted;
      assertRace(!notepadTabsData.some(tab => tab.content.includes('stale deleted')), 'Deleted tab response applied to replacement');
    });
    await check('unmarked examples do not overwrite notes and background tab deletion preserves the active draft', async () => {
      resetNotes(); const pending = beginNote('Explain this');
      replies.shift().resolve('Here is an example:\n```\nexample\n```'); await pending;
      assertRace(notepadTextarea.textContent === 'original alpha', 'Example replaced note');
      notepadTextarea.textContent = 'active draft'; deleteNotepadTab(101);
      assertRace(currentTabId === 100 && notepadTextarea.textContent === 'active draft', 'Deleting background tab lost draft');
      assertRace(JSON.parse(localStorage.getItem('olangaNotepadTabs'))[0].content === 'active draft', 'Draft was not persisted');
    });
    await check('failed note deletion preserves tabs and tells the user the save failed', () => {
      resetNotes(); const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) { if (key === 'olangaNotepadTabs') throw new Error('Fixture quota'); return original.call(this, key, value); };
      try { deleteNotepadTab(101); assertRace(notepadTabsData.length === 2, 'Failed deletion changed memory'); assertRace(alerts.some(text => text.includes('could not be saved')), 'Missing save warning'); }
      finally { Storage.prototype.setItem = original; }
    });
    await check('file imports cannot overwrite a different tab or intervening typing', () => {
      resetNotes(); const Reader = window.FileReader, click = HTMLInputElement.prototype.click;
      let reader;
      window.FileReader = class { constructor() { reader = this; } readAsText() {} };
      HTMLInputElement.prototype.click = function () { if (this.type === 'file') this.onchange({ target: { files: [{}] } }); else click.call(this); };
      try {
        notepadImportBtn.click(); switchNotepadTab(101); reader.onload({ target: { result: '<literal file>' } });
        assertRace(htmlToPlainText(notepadTabsData[0].content) === '<literal file>', 'Import missed original tab');
        assertRace(notepadTextarea.textContent === 'original beta', 'Import overwrote another tab');
        notepadImportBtn.click(); notepadTextarea.textContent = 'new typing'; notepadTextarea.dispatchEvent(new Event('input'));
        reader.onload({ target: { result: 'stale file' } });
        assertRace(notepadTextarea.textContent === 'new typing', 'Late import erased typing');
      } finally { window.FileReader = Reader; HTMLInputElement.prototype.click = click; }
    });
    await check('failed file imports restore the original note, preserve another active tab, and can retry', () => {
      const Reader = window.FileReader, click = HTMLInputElement.prototype.click, setItem = Storage.prototype.setItem;
      let reader, failSave = false;
      window.FileReader = class { constructor() { reader = this; } readAsText() {} };
      HTMLInputElement.prototype.click = function () { if (this.type === 'file') this.onchange({ target: { files: [{}] } }); else click.call(this); };
      Storage.prototype.setItem = function (key, value) { if (failSave && key === 'olangaNotepadTabs') throw new Error('Fixture quota'); return setItem.call(this, key, value); };
      try {
        for (const background of [false, true]) {
          resetNotes(); saveNotepadTabs();
          const durable = localStorage.getItem('olangaNotepadTabs'), alertCount = alerts.length;
          failSave = true;
          notepadImportBtn.click();
          if (background) switchNotepadTab(101);
          reader.onload({ target: { result: '<unsaved import>' } });
          assertRace(notepadTabsData[0].content === 'original alpha', 'Failed import replaced the original note in memory');
          assertRace(currentTabId === (background ? 101 : 100), 'Failed import changed the active tab');
          assertRace(notepadTextarea.textContent === (background ? 'original beta' : 'original alpha'), 'Failed import changed the visible note');
          assertRace(localStorage.getItem('olangaNotepadTabs') === durable, 'Failed import changed durable notes');
          assertRace(alerts.slice(alertCount).some(text => text.includes('could not be saved')), 'Failed import did not report the save failure');
          failSave = false;
          if (background) switchNotepadTab(100);
          notepadImportBtn.click(); reader.onload({ target: { result: '<retry succeeded>' } });
          assertRace(notepadTextarea.textContent === '<retry succeeded>', 'Retry did not import literal file content');
          assertRace(JSON.parse(localStorage.getItem('olangaNotepadTabs'))[0].content === '&lt;retry succeeded&gt;', 'Retry did not save the imported note');
        }
      } finally { window.FileReader = Reader; HTMLInputElement.prototype.click = click; Storage.prototype.setItem = setItem; }
    });
    await check('news refreshes ignore stale success and stale failure, and cache failures can retry', async () => {
      const wait = async count => { for (let i = 0; replies.length < count && i < 100; i++) await new Promise(r => setTimeout(r, 10)); assertRace(replies.length >= count, 'Missing news generation'); };
      replies.length = 0; const old = loadNewsBrief(true); await wait(1);
      const latest = loadNewsBrief(true); await wait(2);
      assertRace(replies[0].options.signal.aborted, 'Old provider request not cancelled');
      replies[1].resolve('{"title":"Latest brief"}'); await latest;
      replies[0].resolve('{"title":"Stale brief"}'); await old;
      assertRace(newsBriefData.title === 'Latest brief', 'Stale success won');
      replies.length = 0; const failed = loadNewsBrief(true); await wait(1);
      const newer = loadNewsBrief(true); await wait(2); replies[1].resolve('{"title":"New success"}'); await newer;
      replies[0].reject(new Error('Stale request failure')); await failed;
      assertRace(newsBriefData.title === 'New success', 'Stale failure replaced success');
      replies.length = 0; const currentFailure = loadNewsBrief(true); await wait(1); replies[0].reject(new Error('Fixture offline')); await currentFailure;
      const retry = loadNewsBrief(false); await wait(2); replies[1].resolve('{"title":"Recovered"}'); await retry;
      assertRace(newsBriefData.title === 'Recovered', 'Failure cached as a valid brief');
    });
    await check('news chat cannot double-send or append answers from a superseded brief', async () => {
      replies.length = 0; newsAiInput.value = 'Summarize'; const chat = sendNewsAiMessage();
      newsAiInput.value = 'duplicate'; await sendNewsAiMessage(); assertRace(replies.length === 1, 'Chat sent twice');
      assertRace(replies[0].messages.filter(m => m.content === 'Summarize').length === 1, 'Chat prompt duplicated');
      const refresh = loadNewsBrief(true);
      for (let i = 0; replies.length < 2 && i < 100; i++) await new Promise(r => setTimeout(r, 10));
      replies[0].resolve('Answer from old brief'); await chat; replies[1].resolve('{"title":"Fresh context"}'); await refresh;
      assertRace(!newsAiChat.textContent.includes('Answer from old brief'), 'Stale chat answer shown');
      assertRace(!buildNewsArticleHtml({ sourceArticles: [null, { title: 'Unsafe', link: 'javascript:alert(1)' }] }).includes('javascript:'), 'Unsafe exported news link');
    });
    assert.deepEqual(await evaluate(() => raceErrors), []);
    // Reload malformed saved data through the production startup path.
    await evaluate(() => { localStorage.setItem('olangaNotepadTabs', 'null'); });
    await main.webContents.reload(); await pause(600);
    assert.equal(await evaluate(() => Array.isArray(notepadTabsData) && notepadTabsData.length > 0 && typeof sendNotepadAiMessage === 'function'), true);
    report.checks.push('malformed saved notes do not break application startup');
    main.webContents.debugger.attach('1.3');
    await main.webContents.debugger.sendCommand('Page.enable');
    const injected = await main.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.storageStartupErrors = [];
      window.alert = message => storageStartupErrors.push('Unexpected startup alert: ' + message);
      window.addEventListener('error', event => storageStartupErrors.push(event.message));
      window.addEventListener('unhandledrejection', event => storageStartupErrors.push(String(event.reason?.message || event.reason)));
      for (const name of ['getItem', 'setItem', 'removeItem']) Storage.prototype[name] = function () { throw new Error('Fixture storage unavailable'); };
    ` });
    await main.webContents.reload(); await pause(700);
    const blocked = await evaluate(() => ({ errors: storageStartupErrors, notes: notepadTabsData.length, terminal: terminalTabsData.length, slots: document.querySelectorAll('#quickActionsEditor fieldset').length, setup: typeof handleSaveKey }));
    assert.deepEqual(blocked.errors, []);
    assert.ok(blocked.notes > 0 && blocked.terminal > 0 && blocked.slots === 5 && blocked.setup === 'function', 'Storage failure stopped startup: ' + JSON.stringify(blocked));
    report.checks.push('blocked browser storage still initializes notes, terminal, setup and quick actions without uncaught errors');
    await main.webContents.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier });
    main.webContents.debugger.detach();
    assert.deepEqual(report.forbiddenCalls, []); assert.deepEqual(report.errors, []);
    report.passed = true; save(); console.log(JSON.stringify({ passed: true, checks: report.checks.length }));
    app.quit();
  } catch (error) { report.error = error.stack; save(); console.error(error.stack); app.exit(1); }
});
