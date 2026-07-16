const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const logs = [];
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    logs.push({ level, message, line, sourceId });
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    logs.push({ fail: true, code, desc, url });
  });

  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));

  const result = await win.webContents.executeJavaScript(`(() => {
    const scripts = Array.from(document.scripts).map(s => s.src);
    return {
      scripts,
      optionCount: document.getElementById('nvidiaVoiceSelect')?.options?.length,
      globals: {
        refreshVoiceCatalog: typeof refreshVoiceCatalog,
        initVoiceSettings: typeof initVoiceSettings,
        BEST_ENGLISH_VOICES: typeof BEST_ENGLISH_VOICES,
        speak: typeof speak,
        init: typeof init,
        setTtsEngine: typeof setTtsEngine,
        populateVoiceSelect: typeof populateVoiceSelect,
      }
    };
  })()`);

  console.log(JSON.stringify({ result, logs: logs.slice(0, 40) }, null, 2));
  app.exit(0);
});
