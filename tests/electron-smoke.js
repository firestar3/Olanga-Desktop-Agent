// Isolated UI smoke check: no real credentials, microphone, network, or OS input.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, '../build/qa');
app.disableHardwareAcceleration();
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(output, 'profile-')));
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event, ...legacy) => {
    const details = event?.message ? event : { level: legacy[0], message: legacy[1] };
    if (['error', 3].includes(details.level) && !/ERR_INTERNET_DISCONNECTED|ERR_BLOCKED_BY_CLIENT/.test(details.message)) errors.push(details.message);
  });
  contents.on('preload-error', (_event, _path, error) => errors.push(error.message));
  contents.on('render-process-gone', (_event, details) => errors.push('Renderer stopped: ' + details.reason));
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_details, callback) => callback({ cancel: true }));
});
try { require('../main'); } catch (error) {
  console.error('Electron smoke failed at startup:', error.message);
  app.exit(1);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  try {
    let main;
    for (let i = 0; i < 80; i++) {
      main = BrowserWindow.getAllWindows().find(win => /[\\/]index\.html$/.test(win.webContents.getURL()));
      if (main && !main.webContents.isLoading()) break;
      await pause(100);
    }
    if (!main) throw new Error('Main renderer did not load');
    await pause(700);
    const boot = await main.webContents.executeJavaScript(`({ desktop: typeof window.OlangaDesktop?.open, slots: document.querySelectorAll('#quickActionsEditor fieldset').length, model: typeof callGeminiSpecialist, nimRemoved: typeof window.electronAPI.nvidiaChat === 'undefined' })`);
    if (boot.desktop !== 'function' || boot.slots !== 5 || boot.model !== 'function' || !boot.nimRemoved) throw new Error('New controls did not initialize: ' + JSON.stringify(boot));
    await main.webContents.executeJavaScript(`document.getElementById('setupScreen').classList.add('hidden'); document.getElementById('mainScreen').classList.remove('hidden'); window.OlangaDesktop.open('Explain and fix the selected code in IntelliJ, inside its editor only.');`);
    await pause(650);
    fs.writeFileSync(path.join(output, 'desktop-task.png'), (await main.webContents.capturePage()).toPNG());
    const dialog = await main.webContents.executeJavaScript(`({open: document.querySelector('.desktop-task-dialog').open, text: document.querySelector('.desktop-task-dialog').innerText})`);
    if (!dialog.open || !dialog.text.includes('Olanga')) throw new Error('Desktop task dialog did not open');
    await main.webContents.executeJavaScript(`window.OlangaDesktop.cancel(); document.querySelector('.desktop-task-dialog').close(); document.querySelector('.floating-icon[data-screen="settingsScreen"]').click(); document.querySelector('.quick-actions-settings').open = true; document.querySelector('.quick-actions-settings').scrollIntoView({block:'center'});`);
    await pause(650);
    const settings = await main.webContents.executeJavaScript(`({hidden: document.getElementById('settingsScreen').classList.contains('hidden'), count: document.querySelectorAll('#quickActionsEditor input, #quickActionsEditor textarea').length})`);
    if (settings.hidden || settings.count !== 10) throw new Error('Shortcut settings did not render');
    await main.webContents.capturePage();
    await pause(100);
    fs.writeFileSync(path.join(output, 'shortcuts-settings.png'), (await main.webContents.capturePage()).toPNG());
    const credentials = await main.webContents.executeJavaScript(`(async () => {
      const input = document.getElementById('nvidiaSettingsKeyInput');
      input.value = 'AIza-not-a-real-key';
      await saveAndTestNvidiaKey();
      input.scrollIntoView({block:'center'});
      return {status:document.getElementById('nvidiaConnectionStatus').textContent,
        saved:await window.electronAPI.secureStoreGet('nvidia_api_key'),
        disabled:document.getElementById('addNvidiaKeyBtn').disabled};
    })()`);
    if (!credentials.status.includes('Google key') || credentials.saved || credentials.disabled) throw new Error('NVIDIA key validation did not block a wrong-provider key');
    await pause(250);
    fs.writeFileSync(path.join(output, 'nvidia-settings.png'), (await main.webContents.capturePage()).toPNG());
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('Electron smoke passed: isolated app boot, five shortcuts, model settings, wrong-provider key rejection, desktop dialog and screenshots.');
    app.exit(0);
  } catch (error) {
    console.error('Electron smoke failed:', error.message);
    app.exit(1);
  }
});
setTimeout(() => { console.error('Electron smoke timed out'); app.exit(1); }, 20000).unref();
