// Renderer smoke test in a hidden, isolated Electron window. No screen control.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { overlayGeometry } = require('../desktop/status-overlay');
const { DEFAULT_QUICK_ACTIONS } = require('../shared/quick-actions');
app.disableHardwareAcceleration();
const output = path.resolve(__dirname, '../build/qa');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(output, 'overlay-profile-')));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  try {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_details, callback) => callback({ cancel: true }));
    const window = new BrowserWindow({
      width: 292, height: 406, show: false, frame: false, transparent: true,
      webPreferences: { preload: path.resolve(__dirname, '../status-indicator-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: 'olanga-side-light', zoomFactor: 1 }
    });
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_details, callback) => callback({ cancel: true }));
    assert.notEqual(window.webContents.session, session.defaultSession, 'overlay has a separate session');
    const errors = [];
    window.webContents.on('console-message', (_event, details) => {
      if (details?.level === 'error') errors.push(details.message);
    });
    window.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
    const actions = [];
    const trustedSenders = [];
    const expectedURL = pathToFileURL(path.resolve(__dirname, '../status-indicator.html')).href;
    let snapshot = { state: 'idle', menuOpen: false, hovered: false, geometry: overlayGeometry(292, 406, 'small'), actions: DEFAULT_QUICK_ACTIONS.map(({ id, label }) => ({ id, label })) };
    ipcMain.on('status-overlay-action', (event, action) => {
      trustedSenders.push(event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === expectedURL);
      actions.push(action);
      if (action.type === 'ready') window.webContents.send('status-overlay-snapshot', snapshot);
    });
    await window.loadFile(path.resolve(__dirname, '../status-indicator.html'));
    await pause(250);
    assert.ok(actions.some((action) => action.type === 'ready'), 'preload ready handshake');
    for (const [name, fields] of [
      ['side-light', { hovered: false, menuOpen: false }],
      ['side-light-hover', { hovered: true, menuOpen: false }],
      ['side-light-menu', { hovered: false, menuOpen: true }]
    ]) {
      snapshot = { ...snapshot, ...fields };
      window.webContents.send('status-overlay-snapshot', snapshot);
      window.webContents.invalidate();
      await pause(400);
      const diameter = await window.webContents.executeJavaScript(`document.getElementById('light').getBoundingClientRect().width`);
      assert.ok(Math.abs(diameter - 32 * (fields.hovered || fields.menuOpen ? 1.12 : 1)) < .1, 'native hit geometry matches the painted orb');
      fs.writeFileSync(path.join(output, name + '.png'), (await window.webContents.capturePage()).toPNG());
    }
    const layout = await window.webContents.executeJavaScript(`({
      menuButtons: document.querySelectorAll('#quickMenu button').length,
      menuHeight: document.getElementById('quickMenu').clientHeight,
      scrollHeight: document.getElementById('quickMenu').scrollHeight,
      orb: { x: document.getElementById('light').offsetLeft, y: document.getElementById('light').offsetTop, width: document.getElementById('light').offsetWidth },
      focused: document.activeElement?.textContent,
      hidden: document.getElementById('quickMenu').hidden
    })`);
    assert.equal(layout.menuButtons, 8);
    assert.equal(layout.hidden, false);
    assert.deepEqual(layout.orb, { x: 254, y: 368, width: 32 });
    assert.ok(layout.scrollHeight <= layout.menuHeight, 'menu fits without clipping or scrolling: ' + JSON.stringify(layout));
    assert.ok(layout.focused.includes('Review my screen'), 'keyboard focus starts at first shortcut');
    const keyboardStart = actions.length;
    await window.webContents.executeJavaScript(`for (const key of ['1', '3', '5']) document.dispatchEvent(new KeyboardEvent('keydown', { key }));`);
    await pause(30);
    assert.deepEqual(actions.slice(keyboardStart).filter((action) => action.type === 'quick-action').map((action) => action.id), ['slot-1', 'slot-3', 'slot-5'], 'number keys run their configured slots');
    const ignoredStart = actions.length;
    await window.webContents.executeJavaScript(`for (const options of [{ key: '1', ctrlKey: true }, { key: '2', altKey: true }, { key: '3', metaKey: true }, { key: '4', shiftKey: true }, { key: '5', repeat: true }, { key: '1', isComposing: true }, { key: '0' }, { key: '6' }]) document.dispatchEvent(new KeyboardEvent('keydown', options));`);
    await pause(30);
    assert.equal(actions.length, ignoredStart, 'modifiers, repeats, composition and other numbers never dispatch shortcuts');
    window.webContents.send('status-overlay-snapshot', { ...snapshot, menuOpen: false });
    await pause(30);
    await window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));`);
    await pause(30);
    assert.equal(actions.length, ignoredStart, 'number keys cannot run shortcuts while the menu is closed');
    window.webContents.send('status-overlay-snapshot', snapshot);
    await pause(30);
    const focus = await window.webContents.executeJavaScript(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
      const second = document.activeElement?.getAttribute('aria-keyshortcuts');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
      const first = document.activeElement?.getAttribute('aria-keyshortcuts');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
      return { first, second, last: document.activeElement?.id };
    })()`);
    assert.deepEqual(focus, { first: '1', second: '2', last: 'openApp' }, 'Tab and Shift+Tab traverse and wrap the menu');
    await window.webContents.executeJavaScript(`document.querySelector('#quickActions button').click(); document.getElementById('hideLight').click(); document.getElementById('hideLightHour').click(); document.getElementById('openApp').click(); window.olangaSideLight.hideLight('forever'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));`);
    await pause(50);
    assert.ok(actions.some((action) => action.type === 'quick-action' && action.id === 'slot-1'));
    assert.deepEqual(actions.filter((action) => action.type === 'hide'), [{ type: 'hide', duration: '5-seconds' }, { type: 'hide', duration: '1-hour' }]);
    assert.ok(actions.some((action) => action.type === 'open-app'));
    assert.ok(actions.some((action) => action.type === 'close'));
    assert.ok(trustedSenders.length && trustedSenders.every(Boolean), 'isolated session keeps the real IPC sender, main frame, and exact trusted file URL');
    assert.deepEqual(errors, []);
    console.log('Overlay smoke passed: isolated session and trusted sender, eight options, compact layout, hover geometry, number shortcuts and Tab focus, bounded hide IPC, three screenshots.');
    app.exit(0);
  } catch (error) {
    console.error('Overlay smoke failed:', error.stack || error.message);
    app.exit(1);
  }
});
setTimeout(() => { console.error('Overlay smoke timed out'); app.exit(1); }, 20000).unref();
