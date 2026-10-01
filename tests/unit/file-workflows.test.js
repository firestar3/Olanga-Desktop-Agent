const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFileWorkflows, fileName } = require('../../desktop/file-workflows');

async function fixture(t, options = {}) {
  // Windows runners may expose TEMP through a short path or directory alias.
  // These fixtures represent ordinary native-picked paths; keep alias/link
  // rejection in production and give the fixture its actual canonical root.
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'olanga-file-workflows-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source'), destination = path.join(directory, 'destination');
  await fs.mkdir(source); await fs.mkdir(destination);
  const file = path.join(source, 'notes.txt'); await fs.writeFile(file, 'Original selected content.');
  const journalPath = path.join(directory, 'history.json');
  const service = createFileWorkflows({ journalPath, now: options.now });
  t.after(() => service.dispose());
  async function rename(name = 'renamed.txt') {
    const selected = await service.selectFiles([file]);
    assert.equal(selected.ok, true, selected.message);
    return service.preview({ selectionId: selected.selectionId, mode: 'rename', names: [{ id: selected.files[0].id, name }] });
  }
  return { service, directory, source, destination, file, journalPath, rename };
}
test('filename validation rejects paths, device names and hidden suffix ambiguity', () => {
  for (const name of ['../bad', 'C:\\file', 'CON.txt', 'com1', 'nul', 'hello.', ' name', 'file:stream', 'a/b']) assert.throws(() => fileName(name));
  assert.equal(fileName('Course notes 2.txt'), 'Course notes 2.txt');
});
test('a rename requires an opaque preview, changes only the selected file and has checked Undo', async t => {
  const { service, file, source, rename } = await fixture(t);
  assert.equal((await service.execute('forged')).ok, false);
  const preview = await rename(); assert.equal(preview.ok, true, preview.message); assert.equal(await fs.readFile(file, 'utf8'), 'Original selected content.');
  const result = await service.execute(preview.previewId); assert.equal(result.ok, true, JSON.stringify(result));
  await assert.rejects(fs.stat(file), { code: 'ENOENT' }); assert.equal(await fs.readFile(path.join(source, 'renamed.txt'), 'utf8'), 'Original selected content.');
  const undo = await service.undo(result.receipt.id); assert.equal(undo.ok, true, JSON.stringify(undo));
  assert.equal(await fs.readFile(file, 'utf8'), 'Original selected content.');
  assert.equal((await service.undo(result.receipt.id)).ok, false);
});
test('move uses only a native-selected directory and receipt survives restart', async t => {
  const { service, file, destination, journalPath } = await fixture(t);
  const selection = await service.selectFiles([file]), target = await service.selectDestination(destination);
  assert.equal((await service.preview({ selectionId: selection.selectionId, mode: 'move', destinationId: destination })).ok, false);
  const preview = await service.preview({ selectionId: selection.selectionId, mode: 'move', destinationId: target.destinationId });
  const result = await service.execute(preview.previewId); assert.equal(result.ok, true, JSON.stringify(result));
  const restarted = createFileWorkflows({ journalPath });
  assert.equal((await restarted.listHistory()).receipts[0].canUndo, true);
  assert.equal((await restarted.undo(result.receipt.id)).ok, true);
});
test('collision during preview or after preview never overwrites the other file', async t => {
  const { service, source, file, rename } = await fixture(t);
  const target = path.join(source, 'renamed.txt'), preview = await rename(); await fs.writeFile(target, 'Unrelated');
  const result = await service.execute(preview.previewId); assert.equal(result.ok, false);
  assert.equal(await fs.readFile(target, 'utf8'), 'Unrelated'); assert.equal(await fs.readFile(file, 'utf8'), 'Original selected content.');
  assert.equal((await rename()).ok, false);
});
test('changed contents after preview block a move, even when name and size match', async t => {
  const { service, source, file, rename } = await fixture(t);
  const preview = await rename(); await fs.writeFile(file, 'Changed selected content..');
  assert.equal((await service.execute(preview.previewId)).ok, false);
  await assert.rejects(fs.stat(path.join(source, 'renamed.txt')), { code: 'ENOENT' });
});
test('checked Undo refuses changed contents and occupied original paths', async t => {
  const { service, source, file, rename } = await fixture(t);
  const result = await service.execute((await rename()).previewId);
  await fs.writeFile(file, 'Unrelated original replacement');
  assert.equal((await service.undo(result.receipt.id)).ok, false); assert.equal(await fs.readFile(file, 'utf8'), 'Unrelated original replacement');
  await fs.unlink(file); await fs.writeFile(path.join(source, 'renamed.txt'), 'User edited this later');
  assert.equal((await service.undo(result.receipt.id)).ok, false); assert.equal(await fs.readFile(path.join(source, 'renamed.txt'), 'utf8'), 'User edited this later');
});
test('hard-linked files and symbolic links cannot enter a workflow', async t => {
  const { service, source, file } = await fixture(t);
  const link = path.join(source, 'link.txt'); await fs.link(file, link);
  assert.equal((await service.selectFiles([file])).ok, false); await fs.unlink(link);
  try { await fs.symlink(file, link); } catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.equal((await service.selectFiles([link])).ok, false);
});
test('linked parent folders cannot be selected as file sources or destinations', async t => {
  const { service, directory, source, file } = await fixture(t);
  const linked = path.join(directory, 'linked-source');
  await fs.symlink(source, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const selected = await service.selectFiles([path.join(linked, path.basename(file))]);
  const destination = await service.selectDestination(linked);
  assert.equal(selected.ok, false); assert.match(selected.message, /Linked or redirected folders/);
  assert.equal(destination.ok, false); assert.match(destination.message, /Linked or redirected folders/);
  assert.equal(await fs.readFile(file, 'utf8'), 'Original selected content.');
});
test('replaced directory or file identities invalidate the preview', async t => {
  const { service, source, directory, rename } = await fixture(t);
  const preview = await rename(); await fs.rename(source, path.join(directory, 'old-source')); await fs.mkdir(source); await fs.writeFile(path.join(source, 'notes.txt'), 'Replacement');
  assert.equal((await service.execute(preview.previewId)).ok, false); assert.equal(await fs.readFile(path.join(source, 'notes.txt'), 'utf8'), 'Replacement');
});
test('expired selections and consumed previews cannot dispatch', async t => {
  let clock = 0; const { service, rename } = await fixture(t, { now: () => clock });
  const preview = await rename(); clock = 1000000; assert.equal((await service.execute(preview.previewId)).ok, false);
});
test('batch operations retain successful receipts when a later file changed', async t => {
  const { service, file, source } = await fixture(t); const second = path.join(source, 'second.txt'); await fs.writeFile(second, 'Second');
  const selected = await service.selectFiles([file, second]);
  const preview = await service.preview({ selectionId: selected.selectionId, mode: 'rename', names: selected.files.map((item, index) => ({ id: item.id, name: `renamed-${index}.txt` })) });
  await fs.writeFile(second, 'Changed after preview');
  const result = await service.execute(preview.previewId); assert.equal(result.status, 'partial'); assert.deepEqual(result.receipt.steps.map(step => step.state), ['moved', 'failed']);
  assert.equal((await service.undo(result.receipt.id)).ok, true); assert.equal(await fs.readFile(second, 'utf8'), 'Changed after preview');
});
