const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const MAX_FILES = 50, MAX_BYTES = 512 * 1024 * 1024, TTL = 15 * 60 * 1000;
const clone = value => JSON.parse(JSON.stringify(value));
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const fail = error => ({ ok: false, status: 'failed', message: error instanceof Error ? error.message : String(error) });
function fileName(name) {
  if (typeof name !== 'string' || !name || name.length > 180 || name !== name.trim() || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) || name === '.' || name === '..') throw new Error('Choose a valid Windows filename without a path.');
  return name;
}
function absolute(value) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value) || (process.platform === 'win32' && (/^\\\\/.test(value) || /:/.test(value.slice(2))))) throw new Error('Choose a local file or folder using the file picker.');
  return path.resolve(value);
}
async function parentIdentity(directory) {
  directory = absolute(directory);
  const chain = [], root = path.parse(directory).root;
  let cursor = directory;
  while (true) {
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked or redirected folders are not supported by file workflows.');
    chain.push({ path: cursor, dev: stat.dev, ino: stat.ino });
    if (cursor === root) break;
    cursor = path.dirname(cursor);
  }
  if (key(await fs.realpath(directory)) !== key(directory)) throw new Error('The chosen folder redirects to another location.');
  return chain;
}
async function checkParent(chain) {
  if (!Array.isArray(chain) || !chain.length || chain.length > 100) throw new Error('The file location could not be validated.');
  const current = await parentIdentity(chain[0].path);
  if (current.length !== chain.length || current.some((item, i) => key(item.path) !== key(chain[i].path) || item.dev !== chain[i].dev || item.ino !== chain[i].ino)) throw new Error('A file location changed. Choose the files again.');
}
async function absent(file) {
  try { await fs.lstat(file); throw new Error('A destination file already exists. Nothing will be overwritten.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function identity(file, expectedLinks = 1) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== expectedLinks || stat.size > MAX_BYTES) throw new Error('Choose regular, unlinked files no larger than 512 MB.');
  if (key(await fs.realpath(file)) !== key(file)) throw new Error('The file redirects to another location.');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs) throw new Error('A selected file changed while it was being checked.');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (!bytesRead) break; position += bytesRead; if (position > MAX_BYTES) throw new Error('A selected file grew beyond the supported size.'); hash.update(buffer.subarray(0, bytesRead)); }
    const final = await handle.stat();
    if (final.size !== stat.size || final.mtimeMs !== stat.mtimeMs || final.nlink !== expectedLinks) throw new Error('A selected file changed while it was being checked.');
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, digest: hash.digest('hex') };
  } finally { await handle.close(); }
}
function same(a, b) { return ['dev', 'ino', 'size', 'mtimeMs', 'digest'].every(field => a[field] === b[field]); }
async function unchanged(file, expected, links = 1) { if (!same(await identity(file, links), expected)) throw new Error('A selected file changed. Preview the operation again.'); }

function createFileWorkflows({ journalPath, now = Date.now } = {}) {
  if (!journalPath) throw new Error('File workflows require a private journal path.');
  const selections = new Map(), destinations = new Map(), previews = new Map();
  let receipts = [], loaded = false, loading = null, active = null, disposed = false;
  const publicReceipt = receipt => ({ id: receipt.id, at: receipt.at, mode: receipt.mode, status: receipt.status, steps: receipt.steps.map(step => ({ id: step.id, from: step.from, to: step.to, state: step.state, message: step.message || '' })), canUndo: receipt.steps.some(step => step.state === 'moved') });
  const guarded = fn => async (...args) => { if (disposed) return fail('File workflows are unavailable while Olanga is closing.'); try { return await fn(...args); } catch (error) { return fail(error); } };
  function prune(map) { for (const [id, item] of map) if (item.expiresAt < now()) map.delete(id); while (map.size > 20) map.delete(map.keys().next().value); }
  function load() {
    if (!loading) loading = loadData().catch(error => { loading = null; throw error; });
    return loading;
  }
  async function loadData() {
    if (loaded) return;
    try {
      const stat = await fs.lstat(journalPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('The file operation history could not be validated.');
      const data = JSON.parse(await fs.readFile(journalPath, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.receipts) || data.receipts.length > 30) throw new Error('The file operation history has an unsupported format.');
      receipts = data.receipts.map(receipt => {
        if (!receipt || typeof receipt.id !== 'string' || !Number.isFinite(receipt.at) || !['rename', 'move'].includes(receipt.mode) || !Array.isArray(receipt.steps) || receipt.steps.length > MAX_FILES) throw new Error('The file operation history is invalid.');
        for (const step of receipt.steps) {
          absolute(step.from); absolute(step.to);
          if (!step.before || !Number.isFinite(step.before.dev) || !Number.isFinite(step.before.ino) || !Number.isFinite(step.before.size) || !Number.isFinite(step.before.mtimeMs) || !/^[a-f0-9]{64}$/.test(step.before.digest) || !Array.isArray(step.fromParent) || !Array.isArray(step.toParent) || key(step.fromParent[0]?.path || '') !== key(path.dirname(step.from)) || key(step.toParent[0]?.path || '') !== key(path.dirname(step.to))) throw new Error('A file operation receipt is invalid.');
          if (['pending', 'linked', 'undo-pending'].includes(step.state)) { step.state = 'interrupted'; step.message = 'This operation was interrupted. Inspect both paths before making further changes.'; }
        }
        if (['running', 'undoing'].includes(receipt.status)) receipt.status = 'interrupted';
        return receipt;
      });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    loaded = true;
  }
  async function persist() {
    await fs.mkdir(path.dirname(journalPath), { recursive: true });
    const temporary = `${journalPath}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify({ version: 1, receipts }), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, journalPath); }
    finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async function transfer(step, undo, receipt) {
    const from = undo ? step.to : step.from, to = undo ? step.from : step.to;
    const fromParent = undo ? step.toParent : step.fromParent, toParent = undo ? step.fromParent : step.toParent;
    await checkParent(fromParent); await checkParent(toParent);
    await unchanged(from, step.before); await absent(to);
    if (fromParent[0].dev !== toParent[0].dev || step.before.dev !== fromParent[0].dev) throw new Error('Choose a destination on the same drive.');
    step.state = undo ? 'undo-pending' : 'pending'; await persist();
    // A hard link fails atomically if the destination exists. Unlike rename(),
    // this cannot silently overwrite a file created after the preview.
    try { await fs.link(from, to); }
    catch (error) { step.state = undo ? 'moved' : 'failed'; await persist(); throw error; }
    try {
      await checkParent(fromParent); await checkParent(toParent);
      await unchanged(from, step.before, 2); await unchanged(to, step.before, 2);
      step.state = 'linked'; await persist();
      await checkParent(fromParent); await checkParent(toParent); await unchanged(from, step.before, 2);
      await fs.unlink(from);
      await unchanged(to, step.before);
    } catch (error) {
      // Both names intentionally remain if identity became uncertain. Never
      // delete a path whose current ownership cannot be established.
      step.state = 'interrupted'; step.message = `Both paths may exist. ${error.message}`; await persist(); throw error;
    }
    step.state = undo ? 'undone' : 'moved'; step.message = undo ? 'Original location restored and verified.' : 'File moved and verified.';
    receipt.status = undo ? 'undoing' : 'running'; await persist();
  }
  return {
    // Main-process capabilities: call only with paths returned by native dialogs.
    // These methods must never be exposed through path-taking renderer IPC.
    selectFiles: guarded(async nativePaths => {
      if (!Array.isArray(nativePaths) || !nativePaths.length || nativePaths.length > MAX_FILES) throw new Error('Choose between 1 and 50 files.');
      const paths = nativePaths.map(absolute);
      if (new Set(paths.map(key)).size !== paths.length) throw new Error('Choose each file only once.');
      const files = [];
      for (const file of paths) files.push({ id: randomUUID(), path: file, parent: await parentIdentity(path.dirname(file)), identity: await identity(file) });
      prune(selections); const selectionId = randomUUID(); selections.set(selectionId, { files, expiresAt: now() + TTL });
      return { ok: true, selectionId, files: files.map(file => ({ id: file.id, name: path.basename(file.path), directory: path.dirname(file.path) })) };
    }),
    selectDestination: guarded(async nativeDirectory => {
      const directory = absolute(nativeDirectory), parent = await parentIdentity(directory);
      prune(destinations); const destinationId = randomUUID(); destinations.set(destinationId, { directory, parent, expiresAt: now() + TTL });
      return { ok: true, destinationId, directory };
    }),
    preview: guarded(async input => {
      prune(selections); prune(destinations); prune(previews);
      const selection = selections.get(input?.selectionId);
      if (!selection) throw new Error('Choose files again before previewing this operation.');
      if (!['rename', 'move'].includes(input.mode)) throw new Error('Choose rename or move.');
      const destination = input.mode === 'move' ? destinations.get(input.destinationId) : null;
      if (input.mode === 'move' && !destination) throw new Error('Choose the destination folder again.');
      if (input.mode === 'rename' && (!Array.isArray(input.names) || input.names.length !== selection.files.length || new Set(input.names.map(item => item?.id)).size !== input.names.length)) throw new Error('Provide one new filename for every selected file.');
      const steps = [], targets = new Set();
      for (const file of selection.files) {
        const name = input.mode === 'rename' ? fileName(input.names.find(item => item?.id === file.id)?.name) : path.basename(file.path);
        const to = path.join(destination?.directory || path.dirname(file.path), name), toParent = destination?.parent || file.parent;
        if (key(file.path) === key(to)) { if (file.path !== to) throw new Error('Case-only renames are not supported. Choose a different name.'); continue; }
        if (targets.has(key(to))) throw new Error('Two files would have the same destination. Choose unique names.');
        targets.add(key(to)); await checkParent(file.parent); await checkParent(toParent); await unchanged(file.path, file.identity); await absent(to);
        if (file.identity.dev !== toParent[0].dev) throw new Error('Choose a destination on the same drive.');
        steps.push({ id: file.id, from: file.path, to, fromParent: clone(file.parent), toParent: clone(toParent), before: clone(file.identity), state: 'planned' });
      }
      if (!steps.length) throw new Error('These files already have the requested names and locations.');
      const previewId = randomUUID(), expiresAt = now() + TTL;
      previews.set(previewId, { mode: input.mode, steps, expiresAt });
      return { ok: true, previewId, expiresAt, steps: steps.map(({ id, from, to }) => ({ id, from, to })) };
    }),
    execute: guarded(async previewId => {
      if (active) throw new Error('A file operation is already running.');
      prune(previews); const preview = previews.get(previewId);
      if (!preview) throw new Error('Preview this file operation again before running it.');
      previews.delete(previewId); const run = { cancelled: false }; active = run;
      try {
        await load(); const receipt = { id: randomUUID(), at: now(), mode: preview.mode, status: 'running', steps: clone(preview.steps) };
        if (receipts.length >= 30) {
          const replace = receipts.findIndex(item => !item.steps.some(step => ['moved', 'interrupted', 'linked', 'pending', 'undo-pending'].includes(step.state)));
          if (replace < 0) throw new Error('File history is full. Undo an older operation before running another.');
          receipts.splice(replace, 1);
        }
        receipts.push(receipt); await persist();
        for (const step of receipt.steps) {
          if (run.cancelled) { step.state = 'cancelled'; step.message = 'This file was not changed.'; continue; }
          try { await transfer(step, false, receipt); }
          catch (error) { if (step.state !== 'interrupted') step.state = 'failed'; step.message = error.message; }
        }
        receipt.status = run.cancelled ? 'cancelled' : receipt.steps.every(step => step.state === 'moved') ? 'completed' : 'partial';
        await persist(); return { ok: receipt.status === 'completed', receipt: publicReceipt(receipt), status: receipt.status };
      } finally { active = null; }
    }),
    undo: guarded(async receiptId => {
      if (active) throw new Error('A file operation is already running.');
      const run = { cancelled: false }; active = run;
      try {
        await load(); const receipt = receipts.find(item => item.id === receiptId);
        if (!receipt || !receipt.steps.some(step => step.state === 'moved')) throw new Error('No checked Undo is available for this operation.');
        receipt.status = 'undoing'; await persist();
        for (const step of [...receipt.steps].reverse()) {
          if (run.cancelled) break;
          if (step.state !== 'moved') continue;
          try { await transfer(step, true, receipt); }
          catch (error) { if (!['interrupted', 'undo-pending', 'linked'].includes(step.state)) step.state = 'moved'; step.message = error.message; }
        }
        const remaining = receipt.steps.some(step => ['moved', 'interrupted', 'undo-pending', 'linked'].includes(step.state));
        receipt.status = remaining ? 'partial-undo' : 'undone'; await persist();
        return { ok: !remaining, status: receipt.status, receipt: publicReceipt(receipt) };
      } finally { active = null; }
    }),
    listHistory: guarded(async () => { await load(); return { ok: true, receipts: receipts.map(publicReceipt).reverse() }; }),
    cancel() { if (active) active.cancelled = true; return { ok: true, message: 'Remaining file actions cancelled. The current file will finish safely.' }; },
    dispose() { disposed = true; if (active) active.cancelled = true; selections.clear(); destinations.clear(); previews.clear(); },
  };
}
module.exports = { createFileWorkflows, fileName };
