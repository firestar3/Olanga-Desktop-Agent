// A disposable editor for native input regression tests. No user files or network.
const { app, BrowserWindow, screen, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-renderer-accessibility');
app.commandLine.appendSwitch('enable-features', 'UiaProvider');
const output = path.resolve(__dirname, '../build/qa');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(output, 'editor-fixture-')));
let win;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }));
  win = new BrowserWindow({ ...screen.getPrimaryDisplay().bounds, frame: false, title: 'Olanga disposable edit test', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><title>Olanga disposable edit test</title><style>body{margin:0;background:#161920;color:#eee;font:24px sans-serif;padding:40px}textarea{display:block;width:calc(100% - 24px);height:360px;font:28px monospace;padding:10px;color:#fff;background:#222936}p{font-size:18px}</style><h1>Disposable editor · Olanga regression test</h1><p>Only this temporary editor receives test input. No file is opened or saved.</p><textarea aria-label="Disposable code editor" spellcheck="false">function add(a, b) {
  return a - b;
}</textarea><p id="result">Expected: add(2, 3) should equal 5. The visible function incorrectly subtracts.</p><script>document.querySelector('textarea').focus();</script>`));
  win.setAlwaysOnTop(true); win.show(); win.focus(); win.webContents.focus();
  await new Promise(resolve => setTimeout(resolve, 300));
  await win.webContents.executeJavaScript("document.querySelector('textarea').focus()", true);
  const point = await win.webContents.executeJavaScript("(() => {const r=document.querySelector('textarea').getBoundingClientRect();return {x:Math.round(r.x+30),y:Math.round(r.y+30)}})()");
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  process.send({ ready: true, pid: process.pid, handle: win.getNativeWindowHandle().readBigUInt64LE().toString() });
});
process.on('message', async message => {
  try {
    if (message.kind === 'close') return app.exit(0);
    const value = message.kind === 'capture' ? (await win.webContents.capturePage()).toDataURL()
      : message.kind === 'value' ? await win.webContents.executeJavaScript("document.querySelector('textarea').value") : null;
    process.send({ id: message.id, value });
  } catch (error) { process.send({ id: message.id, error: error.message }); }
});
process.on('disconnect', () => app.exit(0));
