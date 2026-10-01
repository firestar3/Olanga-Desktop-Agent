const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaceService } = require('../../desktop/workspace-service');
const { sessionName, validBounds } = require('../../shared/work-sessions');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'olanga-work-sessions-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const state = { windows: [{ appId: 'notepad', title: 'Selected notes', windowHandle: '123', processId: 123, processStarted: '1000', bounds: { left: 0, top: 0, right: 800, bottom: 600 }, state: 'normal' }], restores: [], opens: [] };
  const helper = { async execute(request) {
    if (request.operation === 'capture') return { ok: true, message: 'Captured.', windows: structuredClone(state.windows) };
    state.restores.push(request); await options.onRestore?.(request);
    return { ok: true, verified: true, appId: request.app.id, processId: request.window.processId, windowHandle: request.window.windowHandle, bounds: request.bounds, state: request.state, message: 'Restored.' };
  }, cancel() {} };
  const appController = { async open(appId) {
    state.opens.push(appId); state.windows = [{ appId, title: '', windowHandle: '456', processId: 456, processStarted: '2000', bounds: { left: 0, top: 0, right: 800, bottom: 600 }, state: 'normal' }];
    return { ok: true, verified: true, appId, windowHandle: '456', processId: 456, windowCount: 1 };
  } };
  const service = createWorkspaceService({ filePath: path.join(directory, 'sessions.json'), helper, appController, now: options.now });
  t.after(() => service.dispose());
  async function save() { const capture = await service.capture(); return service.save({ captureId: capture.captureId, windowIds: capture.windows.map(w => w.id), name: 'Coursework' }); }
  return { service, state, save, directory, helper, appController };
}
test('session validation accepts negative monitor origins but rejects impossible geometry and names', () => {
  assert.equal(validBounds({ left: -1200, top: 0, right: 0, bottom: 900 }), true);
  assert.equal(validBounds({ left: 0, top: 0, right: 1, bottom: 1 }), false);
  assert.throws(() => sessionName('bad\nname'));
});
test('capture returns opaque window IDs; forged windows cannot be saved', async t => {
  const { service } = await fixture(t); const capture = await service.capture();
  assert.equal(capture.ok, true); assert.equal(capture.windows[0].processId, undefined);
  assert.equal((await service.save({ captureId: capture.captureId, name: 'Forged', windowIds: ['forged'] })).ok, false);
});
test('saved sessions survive service restart and duplicate names do not overwrite', async t => {
  const { service, directory, helper, appController, save } = await fixture(t);
  const saved = await save(); assert.equal(saved.ok, true);
  const duplicate = await save(); assert.equal(duplicate.ok, false);
  const reloaded = createWorkspaceService({ filePath: path.join(directory, 'sessions.json'), helper, appController });
  assert.deepEqual((await reloaded.list()).sessions, (await service.list()).sessions);
});
test('preview is read only, restore reuses the exact open window and consumes the preview', async t => {
  const { service, state, save } = await fixture(t); const saved = await save();
  const preview = await service.previewRestore(saved.session.id);
  assert.equal(preview.steps[0].status, 'existing'); assert.equal(state.restores.length, 0);
  const result = await service.restore(preview.previewId);
  assert.equal(result.ok, true); assert.equal(state.opens.length, 0); assert.equal(state.restores.length, 1);
  assert.equal((await service.restore(preview.previewId)).ok, false);
});
test('process ID and handle reuse cannot move an unrelated replacement window', async t => {
  const { service, state, save } = await fixture(t); const saved = await save();
  const preview = await service.previewRestore(saved.session.id);
  state.windows[0].processStarted = '9000';
  assert.equal((await service.restore(preview.previewId)).ok, false); assert.equal(state.restores.length, 0);
});
test('an unrelated same-app window blocks restore and is not launched or moved', async t => {
  const { service, state, save } = await fixture(t); const saved = await save();
  state.windows[0] = { ...state.windows[0], windowHandle: '999', processStarted: '9000', title: 'Unrelated notes' };
  const preview = await service.previewRestore(saved.session.id);
  assert.equal(preview.steps[0].status, 'blocked'); assert.equal((await service.restore(preview.previewId)).ok, false);
  assert.equal(state.restores.length, 0); assert.equal(state.opens.length, 0);
});
test('closed supported app opens exactly once and only its verified new window moves', async t => {
  const { service, state, save } = await fixture(t); const saved = await save(); state.windows = [];
  const preview = await service.previewRestore(saved.session.id); assert.equal(preview.steps[0].status, 'open');
  assert.equal((await service.restore(preview.previewId)).ok, true);
  assert.equal(state.opens.length, 1); assert.equal(state.restores[0].window.windowHandle, '456');
});
test('an app opened after preview requires a fresh preview', async t => {
  const { service, state, save } = await fixture(t); const saved = await save(); const original = state.windows; state.windows = [];
  const preview = await service.previewRestore(saved.session.id); state.windows = original;
  assert.equal((await service.restore(preview.previewId)).ok, false); assert.equal(state.restores.length, 0);
});
test('multiple missing windows of the same app are blocked rather than guessing document targets', async t => {
  const { service, state, save } = await fixture(t);
  state.windows.push({ ...state.windows[0], windowHandle: '124', title: 'Second notes' });
  const saved = await save(); state.windows = [];
  const preview = await service.previewRestore(saved.session.id); assert.ok(preview.steps.every(step => step.status === 'blocked'));
});
test('expired capture and preview IDs cannot perform actions', async t => {
  let clock = 0; const { service, save } = await fixture(t, { now: () => clock });
  const saved = await save(); const preview = await service.previewRestore(saved.session.id); clock = 1000000;
  assert.equal((await service.restore(preview.previewId)).ok, false);
});
test('cancellation retains receipts for completed windows and stops remaining steps', async t => {
  let service; const result = await fixture(t, { onRestore: () => service.cancel() }); service = result.service;
  result.state.windows.push({ ...result.state.windows[0], windowHandle: '124', title: 'Second notes' });
  const saved = await result.save(), preview = await service.previewRestore(saved.session.id);
  const restored = await service.restore(preview.previewId);
  assert.equal(restored.receipts[0].ok, true); assert.equal(restored.receipts[1].status, 'cancelled'); assert.equal(result.state.restores.length, 1);
});
