'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { LIMITS, validatePlan, describeStep, supportedWindow } = require('../shared/action-plan');

const CHANNELS = ['desktop-capture', 'desktop-prepare', 'desktop-run', 'desktop-cancel'];
const KEY_CODES = Object.freeze({ CTRL: 17, SHIFT: 16, ALT: 18, ENTER: 13, TAB: 9, BACKSPACE: 8, DELETE: 46, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, HOME: 36, END: 35, PAGEUP: 33, PAGEDOWN: 34, F2: 113, F5: 116, F6: 117,
  ...Object.fromEntries('ACVXZYSFHLN'.split('').map(k => [k, k.charCodeAt(0)])) });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sameBounds = (a, b) => a && b && ['x', 'y', 'width', 'height'].every(k => a[k] === b[k]);

// This launches only a checked-in helper. Plan data travels over stdin as JSON,
// never through a shell, command string, interpolation, or generated source code.
function createWindowsDriver() {
  let helper = path.join(__dirname, 'input-helper.ps1');
  helper = helper.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0, pending = null, buffer = '', closed = false;
  function stop(error = new Error('Desktop input stopped.')) {
    if (closed) return;
    closed = true;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; }
    child.kill();
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 300000) return stop(new Error('Invalid desktop helper response.'));
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { return stop(new Error('Desktop helper could not initialize.')); }
      if (!pending || message.id !== pending.id) return stop(new Error('Unexpected desktop helper response.'));
      const request = pending; pending = null; clearTimeout(request.timer);
      if (message.ok) request.resolve(message.result);
      else request.reject(new Error(String(message.error || 'Desktop operation failed.').slice(0, 600)));
    }
  });
  // Do not retain logs containing window names or user content.
  child.stderr.resume();
  child.on('error', () => stop(new Error('Windows desktop helper could not start.')));
  child.on('exit', () => stop(new Error('Windows desktop helper stopped.')));
  child.stdin.on('error', () => stop(new Error('Windows desktop helper disconnected.')));
  return {
    request(data) {
      if (closed) return Promise.reject(new Error('Desktop input stopped.'));
      if (pending) return Promise.reject(new Error('A desktop operation is already pending.'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => stop(new Error('Desktop operation timed out.')), sequence === 1 ? 15000 : 5000);
        pending = { id, resolve, reject, timer };
        child.stdin.write(JSON.stringify({ ...data, id }) + '\n');
      });
    },
    dispose: stop
  };
}

/** Install only after app.whenReady(). All dependencies are injectable for guardrail tests. */
function registerDesktopAutomation({ ipcMain, dialog, desktopCapturer, screen, globalShortcut, getMainWindow, getOverlayWindow = () => null, setOverlaySuspended = () => {}, app,
  platform = process.platform, driverFactory = createWindowsDriver, now = Date.now, sleep = delay }) {
  let capture = null, prepared = null, active = null, driver = null, busy = false, disposed = false, generation = 0;
  const expectedURL = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
  function trusted(event) {
    const win = getMainWindow();
    if (disposed || !win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
        String(event.senderFrame?.url || '').split('#')[0] !== expectedURL) throw new Error('Desktop control is available only to the local Olanga app.');
    if (platform !== 'win32') throw new Error('Desktop actions currently require Windows.');
    return win;
  }
  function connection() { if (!driver) driver = driverFactory(); return driver; }
  function closeDriver() { if (driver) { driver.dispose(); driver = null; } }
  function progress(status, message) {
    if (!active) return;
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('desktop-progress', { status, planId: active.planId, completedSteps: active.completedSteps, totalSteps: active.totalSteps, message });
  }
  function cancel(reason = 'Stopped by you.') {
    generation++;
    capture = null; prepared = null;
    if (active) { active.cancelled = true; active.reason = reason; }
    closeDriver();
    return { cancelled: true };
  }
  function checkRun() {
    if (!active || active.cancelled || disposed) throw new Error(active?.reason || 'Desktop action cancelled.');
    if (active.deadline && now() > active.deadline) throw new Error('The 30-second desktop action limit was reached.');
  }
  async function prompt(win, options) {
    const result = await dialog.showMessageBox(win, { type: 'warning', defaultId: 0, cancelId: 0, noLink: true, ...options });
    return result.response === 1;
  }
  function hideWindows() {
    const windows = [getMainWindow(), getOverlayWindow()].filter(w => w && !w.isDestroyed() && w.isVisible());
    const focus = windows.find(w => w.isFocused());
    setOverlaySuspended(true);
    windows.forEach(w => w.hide());
    return () => {
      for (const win of windows) if (!win.isDestroyed()) {
        if (win === focus) { win.show(); win.focus(); }
        else win.showInactive();
      }
      setOverlaySuspended(false);
    };
  }
  function sanitizeSnapshot(snapshot) {
    const windows = (snapshot.windows || []).filter(win => supportedWindow(win) && win.processId !== process.pid).slice(0, 80);
    return { ...snapshot, windows };
  }
  function displayInfo(display, size, nativeBounds) {
    return { id: String(display.id), width: size.width, height: size.height, scaleFactor: display.scaleFactor, bounds: { ...display.bounds }, physicalBounds: { ...nativeBounds } };
  }
  async function screenshot(display) {
    let timer;
    const sources = await Promise.race([
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }, fetchWindowIcons: false }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Screen capture timed out.')), 15000); })
    ]).finally(() => clearTimeout(timer));
    const source = sources.find(s => s.display_id === String(display.id));
    if (!source || source.thumbnail.isEmpty()) throw new Error('Could not capture the primary display.');
    return source.thumbnail;
  }
  async function captureScreen(event) {
    const win = trusted(event);
    if (busy || active) throw new Error('Finish or cancel the current desktop action first.');
    busy = true; capture = null; prepared = null;
    const captureGeneration = ++generation;
    const checkCapture = () => { trusted(event); if (captureGeneration !== generation) throw new Error('Screen capture cancelled.'); };
    let restore = () => {};
    try {
      if (!await prompt(win, { title: 'Share your primary screen?', message: 'Allow one screenshot for a desktop action?', detail: 'Olanga will briefly hide, capture the primary display and show you a preview. When you request a plan, this screenshot is sent to Google Gemini for diagnosis, planning and result verification, along with the screen description and visible window names. Hide private content first. No clicks or typing are allowed by this permission.', buttons: ['Cancel', 'Capture primary screen'] })) throw new Error('Screen capture cancelled.');
      checkCapture();
      restore = hideWindows();
      await sleep(350);
      checkCapture();
      const before = sanitizeSnapshot(await connection().request({ kind: 'inspect' }));
      const display = screen.getPrimaryDisplay();
      const thumbnail = await screenshot(display);
      checkCapture();
      const after = sanitizeSnapshot(await connection().request({ kind: 'inspect' }));
      if (!before.foreground || !after.foreground || before.foreground.handle !== after.foreground.handle || !sameBounds(before.primaryBounds, after.primaryBounds) || !sameBounds(before.foreground.bounds, after.foreground.bounds)) throw new Error('The desktop changed during capture. Try observing again.');
      checkCapture();
      capture = { captureId: randomUUID(), capturedAt: now(), display: displayInfo(display, thumbnail.getSize(), before.primaryBounds), foreground: before.foreground, windows: before.windows, focusedControl: before.focusedControl || null };
      // Only metadata remains in the main process; never write screen images to disk.
      return { ...structuredClone(capture), imageDataUrl: thumbnail.toDataURL() };
    } finally { restore(); busy = false; closeDriver(); }
  }
  function prepare(event, input) {
    trusted(event);
    if (busy || active) throw new Error('Finish or cancel the current desktop action first.');
    if (!capture || now() - capture.capturedAt > LIMITS.ttlMs) throw new Error('Capture expired. Observe the screen again.');
    const plan = validatePlan(input, capture);
    const labels = plan.steps.map(step => describeStep(step, capture.windows));
    prepared = Object.freeze({ planId: randomUUID(), plan, capture: structuredClone(capture), labels: Object.freeze(labels), expiresAt: capture.capturedAt + LIMITS.ttlMs });
    return { planId: prepared.planId, summary: plan.summary, scope: structuredClone(plan.scope), steps: structuredClone(plan.steps), labels: [...labels], expiresAt: prepared.expiresAt };
  }
  async function run(event, planId) {
    const win = trusted(event);
    if (busy || active) throw new Error('A desktop action is already in progress.');
    if (typeof planId !== 'string' || !prepared || prepared.planId !== planId || now() > prepared.expiresAt) throw new Error('This plan expired or was replaced. Observe and prepare again.');
    const record = prepared; prepared = null; capture = null;
    const target = record.capture.windows.find(w => w.handle === record.plan.scope.handle);
    active = { planId, completedSteps: 0, totalSteps: record.plan.steps.length, cancelled: false, deadline: null };
    let restore = () => {}, escapeRegistered = false, timeout;
    const result = { ok: false, cancelled: false, completedSteps: 0, totalSteps: active.totalSteps };
    try {
      progress('awaiting-confirmation', 'Review the exact actions in the native confirmation.');
      const region = record.plan.scope.region;
      const scopeLabel = region ? `ONLY the approved editor region: x ${Math.round(region.x * 100)}%, y ${Math.round(region.y * 100)}%, width ${Math.round(region.width * 100)}%, height ${Math.round(region.height * 100)}%. Typing requires accessible control bounds inside that region.` : 'This window, including its menus, dialogs and shortcuts. Other windows need a new approved plan.';
      const detail = `Target: ${target.title} (${target.processName}, window ${target.handle})\nScope: ${scopeLabel}\n\n${record.labels.map((line, i) => `${i + 1}. ${line}`).join('\n')}\n\nPress Escape while running to stop. Input already delivered cannot be undone automatically.`;
      if (!await prompt(win, { title: 'Review desktop action — 1 of 2', message: record.plan.summary, detail, buttons: ['Cancel', 'Approve this exact plan'] })) { active.cancelled = true; throw new Error('Plan review cancelled.'); }
      checkRun(); trusted(event);
      if (now() > record.expiresAt) throw new Error('This plan expired during review. Observe again.');
      if (!await prompt(win, { title: 'Confirm screen edits — 2 of 2', message: 'Allow Olanga to control this target now?', detail: `The approved actions can change content in ${target.title}. ${scopeLabel}\n\nAfter the steps, Olanga captures the primary screen once and sends it to Google Gemini to verify the visible result. Stay at your computer, release keys and mouse buttons, and do not switch windows. Escape stops remaining input. This permission applies only to this one run.`, buttons: ['Cancel', 'Allow screen edits now'] })) { active.cancelled = true; throw new Error('Screen-edit permission cancelled.'); }
      checkRun(); trusted(event);
      if (now() > record.expiresAt) throw new Error('This plan expired during review. Observe again.');
      escapeRegistered = globalShortcut.register('Escape', () => cancel('Stopped with Escape.'));
      if (!escapeRegistered) throw new Error('The Escape stop shortcut is unavailable. No desktop input was sent.');
      active.deadline = now() + LIMITS.runMs;
      timeout = setTimeout(() => cancel('The 30-second desktop action limit was reached.'), LIMITS.runMs);
      restore = hideWindows(); await sleep(350); checkRun();
      const display = screen.getPrimaryDisplay();
      if (String(display.id) !== record.capture.display.id || display.scaleFactor !== record.capture.display.scaleFactor || !sameBounds(display.bounds, record.capture.display.bounds)) throw new Error('Display layout changed. Observe the screen again.');
      const native = await connection().request({ kind: 'inspect' }); checkRun();
      if (!sameBounds(native.primaryBounds, record.capture.display.physicalBounds)) throw new Error('Primary display changed. Observe the screen again.');
      const currentTarget = native.windows.find(w => w.handle === target.handle && w.processId === target.processId);
      if (!currentTarget || currentTarget.title !== target.title || !sameBounds(currentTarget.bounds, target.bounds)) throw new Error('The target window changed since capture. Observe again.');
      await connection().request({ kind: 'focus', handle: target.handle, processId: target.processId }); checkRun();
      const physical = record.capture.display.physicalBounds;
      const pixelRegion = region ? {
        x: physical.x + Math.ceil(region.x * physical.width), y: physical.y + Math.ceil(region.y * physical.height),
        width: Math.floor((region.x + region.width) * physical.width) - Math.ceil(region.x * physical.width),
        height: Math.floor((region.y + region.height) * physical.height) - Math.ceil(region.y * physical.height)
      } : undefined;
      const common = { handle: target.handle, processId: target.processId, ...(pixelRegion ? { region: pixelRegion } : {}) };
      progress('running', 'Executing the approved plan. Escape stops remaining input.');
      for (let index = 0; index < record.plan.steps.length; index++) {
        checkRun(); trusted(event);
        const step = record.plan.steps[index];
        if (step.type === 'wait') {
          await connection().request({ kind: 'check', ...common });
          for (let remaining = step.ms; remaining > 0; remaining -= 50) { checkRun(); await sleep(Math.min(50, remaining)); }
        } else if (step.type === 'click') {
          await connection().request({ kind: 'click', ...common, x: physical.x + Math.round(step.x * (physical.width - 1)), y: physical.y + Math.round(step.y * (physical.height - 1)), button: step.button, count: step.count, bounds: target.bounds });
        } else if (step.type === 'type') {
          // Separate short chunks keep cancellation useful, including for slow accessibility providers.
          const chars = Array.from(step.text.replace(/\r\n/g, '\n'));
          for (let offset = 0; offset < chars.length; offset += 16) {
            checkRun(); trusted(event);
            await connection().request({ kind: 'type', ...common, text: chars.slice(offset, offset + 16).join('') });
          }
        } else if (step.type === 'hotkey') await connection().request({ kind: 'hotkey', ...common, keys: step.keys.map(k => KEY_CODES[k]) });
        else if (step.type === 'scroll') await connection().request({ kind: 'scroll', ...common, amount: step.amount });
        else if (step.type === 'focus') await connection().request({ kind: 'focus', ...common });
        checkRun();
        active.completedSteps = index + 1;
        progress('running', `Finished step ${index + 1} of ${active.totalSteps}.`);
        await sleep(120);
      }
      result.ok = true;
      progress('verifying', 'Approved input completed. Capturing the visible result for verification.');
      try {
        await sleep(250); checkRun(); trusted(event);
        const before = sanitizeSnapshot(await connection().request({ kind: 'inspect' }));
        if (before.foreground?.handle !== target.handle || before.foreground?.processId !== target.processId || !sameBounds(before.primaryBounds, record.capture.display.physicalBounds)) throw new Error('The target changed before result capture.');
        const currentDisplay = screen.getPrimaryDisplay();
        if (String(currentDisplay.id) !== record.capture.display.id || currentDisplay.scaleFactor !== record.capture.display.scaleFactor || !sameBounds(currentDisplay.bounds, record.capture.display.bounds)) throw new Error('Display layout changed before verification.');
        const thumbnail = await screenshot(currentDisplay); checkRun();
        const after = sanitizeSnapshot(await connection().request({ kind: 'inspect' }));
        checkRun(); trusted(event);
        if (after.foreground?.handle !== target.handle || after.foreground?.processId !== target.processId || !sameBounds(before.foreground.bounds, after.foreground.bounds) || !sameBounds(before.primaryBounds, after.primaryBounds)) throw new Error('The target changed during verification capture.');
        result.verificationCapture = { capturedAt: now(), imageDataUrl: thumbnail.toDataURL(), display: displayInfo(currentDisplay, thumbnail.getSize(), before.primaryBounds), foreground: before.foreground, focusedControl: before.focusedControl || null };
      } catch (error) {
        result.verificationError = error.message || 'The result could not be captured.';
        if (active.cancelled) { result.cancelled = true; result.ok = false; }
      }
      progress('completed', result.verificationCapture ? 'Result captured. Gemini will check the visible outcome.' : 'Input was sent, but the result is not verified.');
    } catch (error) {
      result.cancelled = !!active.cancelled;
      result.error = active.reason || error.message || 'Desktop action failed.';
      progress(result.cancelled ? 'cancelled' : 'failed', result.error);
    } finally {
      result.completedSteps = active.completedSteps;
      clearTimeout(timeout);
      if (escapeRegistered) globalShortcut.unregister('Escape');
      closeDriver(); restore(); active = null;
    }
    return result;
  }
  const handlers = [captureScreen, prepare, run, event => { trusted(event); return cancel(); }];
  CHANNELS.forEach((channel, index) => ipcMain.handle(channel, handlers[index]));
  const displayChanged = () => cancel('Display layout changed. Observe the screen again.');
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, displayChanged);
  const beforeQuit = () => cancel('Olanga is closing.');
  app?.on('before-quit', beforeQuit);
  return { cancel, dispose() {
    disposed = true; cancel('Desktop control closed.');
    CHANNELS.forEach(channel => ipcMain.removeHandler(channel));
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, displayChanged);
    app?.removeListener('before-quit', beforeQuit);
  } };
}

module.exports = { registerDesktopAutomation, createWindowsDriver };
