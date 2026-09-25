// Interactive Windows regression: clicks only this isolated app's test windows.
// Unlike renderer smoke, this exercises native activation, blur and hit testing.
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createStatusOverlay } = require(process.env.OLANGA_OVERLAY_CONTROLLER || '../desktop/status-overlay');
const output = path.resolve(__dirname, '../build/qa');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(output, 'lifecycle-profile-')));
app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let overlay;
let host;
const trace = [];
// One helper keeps the cursor in place between operations. Restoring it after
// each click would itself trigger the menu's pointer-leave dismissal timer.
function createNativeInput() {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'overlay-native-input.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending, buffer = '', errors = '';
  child.stdout.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line || !pending) continue;
      try { const result = JSON.parse(line); result.ok ? pending.resolve() : pending.reject(new Error(result.error)); }
      catch (error) { pending.reject(error); }
      pending = null;
    }
  });
  child.stderr.on('data', data => { errors += data; });
  child.on('error', error => pending?.reject(error));
  const exited = new Promise(resolve => child.on('exit', code => {
    pending?.reject(new Error(errors || `Native input helper exited (${code})`)); resolve();
  }));
  return {
    send: (window, action, point = {}) => new Promise((resolve, reject) => {
      pending = { resolve, reject };
      child.stdin.write(JSON.stringify({ pid: process.pid, handle: window.getNativeWindowHandle().readBigUInt64LE().toString(), action, ...point }) + '\n');
    }),
    close: async () => { child.stdin.end(); await exited; }
  };
}

app.whenReady().then(async () => {
  let input, exitCode = 0;
  try {
    if (process.platform !== 'win32') throw new Error('This native regression requires a Windows desktop session.');
    input = createNativeInput();
    const display = screen.getPrimaryDisplay();
    const testArea = { x: display.workArea.x + 80, y: display.workArea.y + 80, width: 360, height: 480 };
    host = new BrowserWindow({ ...testArea, show: false, frame: false, backgroundColor: '#24242a', webPreferences: { sandbox: true, contextIsolation: true } });
    await host.loadURL('data:text/html,<title>Olanga light test</title><body style="color:white;font:16px sans-serif;padding:12px">Olanga light regression test</body>');
    host.show();
    const testScreen = {
      getPrimaryDisplay: () => ({ ...display, workArea: testArea }),
      getCursorScreenPoint: () => screen.getCursorScreenPoint(),
      on: (...args) => screen.on(...args), removeListener: (...args) => screen.removeListener(...args)
    };
    overlay = createStatusOverlay({ BrowserWindow, ipcMain, screen: testScreen, basePath: path.resolve(__dirname, '..'), onOpenApp: () => host.focus(), onQuickAction: () => { throw new Error('This test must not execute shortcuts'); } });
    overlay.setMode('all');
    const window = overlay.create();
    for (const event of ['blur', 'focus', 'show', 'hide']) window.on(event, () => trace.push({ event, visible: window.isVisible(), focused: window.isFocused() }));
    for (let i = 0; i < 80 && (!window.isVisible() || window.webContents.isLoading()); i++) await pause(100);
    await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const state = () => window.webContents.executeJavaScript(`({open: !document.getElementById('quickMenu').hidden, expanded: document.getElementById('light').getAttribute('aria-expanded')})`);
    const clickOrb = async () => {
      const point = await window.webContents.executeJavaScript(`(() => {const rect=document.getElementById('light').getBoundingClientRect();return {x:(rect.x+rect.width/2)/innerWidth,y:(rect.y+rect.height/2)/innerHeight};})()`);
      await input.send(window, 'click', point);
      await pause(180);
    };
    for (let cycle = 0; cycle < 6; cycle++) {
      await clickOrb();
      assert.equal((await state()).open, true, `cycle ${cycle + 1}: native click opens menu`);
      assert.equal(window.isVisible(), true);
      assert.equal(window.isAlwaysOnTop(), true);
      assert.equal(window.isFocused(), true, 'menu accepts keyboard input');
      if (cycle % 3 === 0) await clickOrb();
      else if (cycle % 3 === 1) await input.send(window, 'escape');
      else await input.send(host, 'click', { x: .05, y: .05 });
      await pause(220);
      assert.equal((await state()).open, false, `cycle ${cycle + 1}: close hides menu`);
      assert.equal(window.isVisible(), true, 'closing the menu never hides its launcher');
      assert.equal(window.isFocused(), false, 'closing returns keyboard focus');
    }
    await clickOrb();
    await window.webContents.executeJavaScript(`document.getElementById('openApp').click()`);
    await pause(180);
    assert.equal((await state()).open, false);
    assert.equal(host.isFocused(), true, 'Open app transfers focus to the test host');
    await clickOrb();
    assert.equal((await state()).open, true, 'reopens after Open app');
    await window.webContents.executeJavaScript(`document.getElementById('hideLight').click()`);
    await pause(100);
    assert.equal(window.isVisible(), false);
    await pause(5050);
    assert.equal(window.isVisible(), true);
    await clickOrb();
    assert.equal((await state()).open, true, 'reopens after five-second hide');
    console.log('Native overlay lifecycle passed: six open/close cycles via orb, Escape and outside clicks; reopen after Open app and five-second hide.');
  } catch (error) {
    console.error('Native overlay lifecycle failed:', error.message, JSON.stringify(trace));
    exitCode = 1;
  } finally {
    await input?.close();
    overlay?.destroy(); host?.destroy(); app.exit(exitCode);
  }
});
setTimeout(() => { console.error('Native overlay lifecycle timed out'); overlay?.destroy(); app.exit(1); }, 55000).unref();
