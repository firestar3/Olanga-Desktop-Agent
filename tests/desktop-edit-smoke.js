// Real Win32/UIA input, restricted to a separate disposable editor process.
// Approval dialogs are injected here only; production requires both confirmations.
const { app, screen, nativeImage, globalShortcut } = require('electron');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const { registerDesktopAutomation, createWindowsDriver } = require('../desktop/automation');
const { inferEditorRegion } = require('../js/desktop-workflows');
app.disableHardwareAcceleration();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const startedAt = new Date().toISOString();
  let host, api, info, sequence = 0;
  const pending = new Map();
  try {
    host = spawn(process.execPath, [path.join(__dirname, 'desktop-edit-host.js')], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Disposable editor did not start.')), 20000);
      host.once('error', reject);
      host.on('message', message => {
        if (message.ready) { clearTimeout(timer); info = message; resolve(); }
        else { const handler = pending.get(message.id); if (handler) { pending.delete(message.id); clearTimeout(handler.timer); message.error ? handler.reject(new Error(message.error)) : handler.resolve(message.value); } }
      });
    });
    const request = (kind, text) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('Fixture request timed out.')); }, 10000); pending.set(id, { resolve, reject, timer }); host.send({ id, kind, text }); });
    await ready; await delay(500);
    // A real fixture-only click establishes foreground permission on Windows.
    // The existing test helper checks native hit testing and restores the pointer.
    await new Promise((resolve, reject) => {
      const click = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'overlay-native-input.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      const timer = setTimeout(() => { click.kill(); reject(new Error('Fixture click timed out.')); }, 15000);
      click.stdout.on('data', data => { output += data; });
      click.once('error', reject);
      click.once('exit', () => { clearTimeout(timer); try { const result = JSON.parse(output.trim()); result.ok ? resolve() : reject(new Error(result.error)); } catch (error) { reject(error); } });
      click.stdin.end(JSON.stringify({ pid: info.pid, handle: info.handle, action: 'click', x: 0.25, y: 0.25 }) + '\n');
    });
    const frame = { url: pathToFileURL(path.resolve(__dirname, '../index.html')).href };
    const webContents = { mainFrame: frame, send() {} };
    const win = { webContents, isDestroyed: () => false, isVisible: () => false, isFocused: () => false };
    const handlers = {}, prompts = [];
    api = registerDesktopAutomation({ ipcMain: { handle: (name, handler) => { handlers[name] = handler; }, removeHandler() {} },
      dialog: { showMessageBox: async (_, prompt) => { prompts.push(prompt.title); return { response: 1 }; } },
      desktopCapturer: { getSources: async () => [{ display_id: String(screen.getPrimaryDisplay().id), thumbnail: nativeImage.createFromDataURL(await request('capture')) }] },
      screen, globalShortcut, getMainWindow: () => win, app: new EventEmitter(),
      driverFactory: () => {
        const driver = createWindowsDriver();
        return { dispose: () => driver.dispose(), request: async input => {
          if (input.kind !== 'inspect') assert.ok(input.handle === info.handle && input.processId === info.pid, 'Native input must target only the fixture');
          const result = await driver.request(input);
          if (input.kind === 'inspect') {
            assert.equal(result.foreground?.handle, info.handle, 'Test cancelled: another window has focus');
            result.windows = result.windows.filter(w => w.handle === info.handle && w.processId === info.pid);
          }
          return result;
        } };
      }
    });
    const event = { sender: webContents, senderFrame: frame };
    const capture = await handlers['desktop-capture'](event);
    if (!inferEditorRegion(capture)) require('node:fs').writeFileSync(path.resolve(__dirname, '../build/qa/disposable-editor.png'), nativeImage.createFromDataURL(capture.imageDataUrl).toPNG());
    const region = inferEditorRegion(capture);
    if (!region) console.log(JSON.stringify({ focusedControl: capture.focusedControl, targetProcessId: capture.foreground.processId, targetBounds: capture.foreground.bounds, displayBounds: capture.display.physicalBounds }));
    assert.ok(region, 'Native accessibility must expose the disposable editor region');
    const expected = 'function add(a, b) {\n  return a + b;\n}';
    const original = await request('value');
    const plan = { captureId: capture.captureId, summary: 'Correct subtraction to addition in the disposable code editor', scope: { mode: 'region', handle: info.handle, region }, steps: [{ type: 'hotkey', keys: ['CTRL', 'A'] }, { type: 'type', text: expected }] };
    // Optional local-only provider harness; CI and normal smoke use no credentials.
    const provider = process.env.OLANGA_TEST_PROVIDER ? require(path.resolve(process.env.OLANGA_TEST_PROVIDER)) : null;
    if (provider) {
      const proposed = await provider.plan(capture, plan.scope);
      assert.ok(proposed.steps.some(step => step.type === 'type' && [expected, '+'].includes(step.text)), 'The live fixture plan must contain only the expected replacement text');
      assert.ok(proposed.steps.every(step => (step.type === 'type' && [expected, '+'].includes(step.text)) || (step.type === 'hotkey' && ['CTRL+A','CTRL+HOME','CTRL+END','DOWN','UP','HOME','END','LEFT','RIGHT','SHIFT+LEFT','SHIFT+RIGHT','DELETE','BACKSPACE'].includes(step.keys.join('+'))) || (step.type === 'focus' && step.handle === info.handle) || (step.type === 'click' && step.button === 'left' && [1,2].includes(step.count) && step.x >= region.x && step.x <= region.x + region.width && step.y >= region.y && step.y <= region.y + region.height)), 'Live test accepts only this fixture replacement');
      plan.steps = proposed.steps; plan.summary = proposed.summary;
    }
    const prepared = handlers['desktop-prepare'](event, plan);
    const result = await handlers['desktop-run'](event, prepared.planId);
    assert.equal(result.ok, true, result.error);
    assert.equal(await request('value'), expected, 'Read back the actual native edit');
    assert.ok(result.verificationCapture?.imageDataUrl, result.verificationError);
    assert.notEqual(result.verificationCapture.imageDataUrl, capture.imageDataUrl, 'Fresh evidence must show the changed text');
    assert.equal(prompts.length, 3);
    const verification = provider ? await provider.verify(plan, result) : null;
    let undoChecks = 'not exercised for alternate provider plans';
    if (!provider) {
      assert.equal(result.undo?.available, true, result.undo?.message);
      assert.equal(result.undo.before, original);
      assert.equal(result.undo.after, expected);
      const restored = await handlers['desktop-undo'](event, result.undo.undoId);
      assert.equal(restored.ok, true, restored.message);
      assert.equal(restored.verified, true);
      assert.equal(await request('value'), original, 'Native undo must restore the complete original text');
      for (const conflict of ['text', 'control']) {
        const nextCapture = await handlers['desktop-capture'](event);
        const nextPlan = { ...plan, captureId: nextCapture.captureId, scope: { mode: 'region', handle: info.handle, region: inferEditorRegion(nextCapture) } };
        const nextPrepared = handlers['desktop-prepare'](event, nextPlan);
        const nextResult = await handlers['desktop-run'](event, nextPrepared.planId);
        assert.equal(nextResult.undo?.available, true, nextResult.error || nextResult.undo?.message);
        const currentText = conflict === 'text' ? 'User changed this disposable fixture after the edit.' : expected;
        if (conflict === 'text') await request('set-value', currentText);
        else await request('replace-control');
        const rejected = await handlers['desktop-undo'](event, nextResult.undo.undoId);
        assert.equal(rejected.ok, false, 'Undo must refuse an intervening change');
        assert.match(rejected.message, /conflict|changed/i);
        assert.equal(await request('value'), currentText, 'A rejected undo must leave the current text untouched');
      }
      undoChecks = 'complete original restored; intervening text and replaced-control conflicts rejected';
    }
    const report = { passed: true, startedAt, finishedAt: new Date().toISOString(), nativeInput: 'Verified UIA full-field replacement within approved editor bounds', completedSteps: result.completedSteps, exactTextReadback: true, freshVerificationImage: true, undo: undoChecks, approvals: 'injected in fixture only', provider: verification || 'none' };
    fs.writeFileSync(path.resolve(__dirname, '../build/qa/desktop-edit-smoke.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    api.dispose(); host.send({ kind: 'close' }); await delay(250); app.exit(0);
  } catch (error) { console.error('Desktop edit smoke failed:', error.message); api?.dispose(); host?.kill(); app.exit(1); }
});
