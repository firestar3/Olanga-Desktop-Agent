const { app, BrowserWindow } = require('electron');
const path = require('path');

app.setName('olanga-control');

function createWindow() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(`(() => {
        const settingsScreen = document.getElementById('settingsScreen');
        const btn = document.getElementById('viewIntroBtn');
        // Simulate opening Settings
        document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
        if (settingsScreen) settingsScreen.classList.remove('hidden');

        const cs = btn ? getComputedStyle(btn) : null;
        const rect = btn ? btn.getBoundingClientRect() : null;
        const parent = btn ? btn.closest('.settings-section') : null;
        return {
          viewIntroBtnExists: !!btn,
          text: btn ? btn.textContent : null,
          settingsHidden: settingsScreen ? settingsScreen.classList.contains('hidden') : null,
          sectionHTML: parent ? parent.outerHTML.slice(0, 400) : null,
          rect,
          computed: cs ? {
            display: cs.display,
            visibility: cs.visibility,
            opacity: cs.opacity,
            width: cs.width,
            height: cs.height,
            backgroundColor: cs.backgroundColor,
            color: cs.color,
            position: cs.position,
            zIndex: cs.zIndex,
          } : null,
        };
      })()`);
      console.log(JSON.stringify(result, null, 2));
      if (!result.viewIntroBtnExists || !result.rect || result.rect.width < 1) {
        process.exitCode = 1;
      }
    } catch (err) {
      console.error('executeJavaScript failed:', err);
      process.exitCode = 1;
    } finally {
      app.exit(process.exitCode || 0);
    }
  });

  win.loadFile(path.join(__dirname, '..', 'index.html'));
}

app.whenReady().then(createWindow);
