const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProjectKnowledge } = require('../../desktop/project-knowledge');
async function fixture(t) {
  // Windows runners may expose TEMP through a short name or junction. The
  // service requires canonical paths so links cannot expand the selected scope.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'olanga-project-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'notes'); await fs.mkdir(root);
  const service = createProjectKnowledge({ stateFile: path.join(dir, 'state.json'), chooseFolder: async () => root, revealFile: async () => {} });
  return { dir, root, service };
}
test('project knowledge indexes only selected supported files and cites exact source lines', async t => {
  const { root, service } = await fixture(t);
  await fs.writeFile(path.join(root, 'decisions.md'), 'Project decision\nUse SQLite for offline storage.\n');
  await fs.writeFile(path.join(root, '.env'), 'SQLite private');
  await fs.writeFile(path.join(root, 'credentials.json'), 'SQLite private');
  await fs.mkdir(path.join(root, 'node_modules')); await fs.writeFile(path.join(root, 'node_modules', 'a.md'), 'SQLite private');
  const added = await service.add(); assert.equal(added.index.files, 1);
  const result = await service.search(added.project.id, 'What storage decision did I make?');
  assert.equal(result.results.length, 1); assert.equal(result.results[0].citation, 'S1');
  assert.match(result.results[0].excerpt, /SQLite/); assert.equal(result.results[0].startLine, 1);
});
test('changed and removed sources are excluded until explicit refresh', async t => {
  const { root, service } = await fixture(t), file = path.join(root, 'notes.md');
  await fs.writeFile(file, 'old project decision'); const { project } = await service.add();
  await fs.writeFile(file, 'new project decision');
  let result = await service.search(project.id, 'decision'); assert.equal(result.results.length, 0); assert.equal(result.staleFiles, 1);
  await service.refresh(project.id); result = await service.search(project.id, 'decision'); assert.match(result.results[0].excerpt, /new/);
  await fs.unlink(file); assert.equal((await service.search(project.id, 'decision')).staleFiles, 1);
});
test('startup loads project metadata without indexing or silently reading source contents', async t => {
  const { dir, root, service } = await fixture(t); await fs.writeFile(path.join(root, 'a.txt'), 'hello world'); const { project } = await service.add();
  const restarted = createProjectKnowledge({ stateFile: path.join(dir, 'state.json') });
  assert.equal((await restarted.list())[0].indexed, false);
  await assert.rejects(restarted.search(project.id, 'hello'), /Refresh/);
  await restarted.remove(project.id); assert.deepEqual(await restarted.list(), []);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'hello world');
});
test('corrupt settings are preserved and block writes', async t => {
  const { dir, root } = await fixture(t), stateFile = path.join(dir, 'broken.json'); await fs.writeFile(stateFile, '{broken');
  const service = createProjectKnowledge({ stateFile, chooseFolder: async () => root });
  await assert.rejects(service.add(), /preserved/); assert.equal(await fs.readFile(stateFile, 'utf8'), '{broken');
});
test('unknown settings versions and oversized metadata are preserved, never silently replaced', async t => {
  const { dir, root } = await fixture(t), stateFile = path.join(dir, 'state.json');
  for (const raw of [JSON.stringify({ version: 2, projects: [] }), ' '.repeat(256 * 1024 + 1)]) {
    await fs.writeFile(stateFile, raw); const service = createProjectKnowledge({ stateFile, chooseFolder: async () => root });
    await assert.rejects(service.add(), /preserved/); assert.equal(await fs.readFile(stateFile, 'utf8'), raw);
  }
});
test('linked outside folders, binary content and oversized sources are excluded', async t => {
  const { dir, root, service } = await fixture(t), outside = path.join(dir, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.md'), 'private decision'); await fs.symlink(outside, path.join(root, 'linked'), 'junction');
  await fs.writeFile(path.join(root, 'binary.txt'), Buffer.from([100, 0, 100])); await fs.writeFile(path.join(root, 'large.md'), 'x'.repeat(256 * 1024 + 1));
  const result = await service.add(); assert.equal(result.index.files, 0); assert.ok(result.index.skipped >= 3);
});
test('a delayed first list cannot overwrite a project added concurrently or drop it from a later save', async t => {
  const { dir, root } = await fixture(t), stateFile = path.join(dir, 'concurrent-state.json');
  await fs.writeFile(stateFile, JSON.stringify({ version: 1, projects: [] }));
  let releaseRead, enterClose, stateReads = 0, selections = 0, selectedRoot = root;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const closing = new Promise(resolve => { enterClose = resolve; });
  const fsImpl = { ...fs, async open(filename, ...args) {
    const handle = await fs.open(filename, ...args);
    if (filename !== stateFile || ++stateReads !== 1) return handle;
    return { stat: handle.stat.bind(handle), read: handle.read.bind(handle), async close() { enterClose(); await readGate; await handle.close(); } };
  } };
  const service = createProjectKnowledge({ stateFile, fsImpl, chooseFolder: async () => { selections++; return selectedRoot; } });
  const firstList = service.list(); await closing;
  const firstAdd = service.add();
  // The add must wait behind the initial verified read, including handle close.
  await new Promise(resolve => setImmediate(resolve));
  try { assert.equal(selections, 0); } finally { releaseRead(); }
  assert.deepEqual(await firstList, []);
  const first = await firstAdd;
  assert.equal((await service.list())[0].id, first.project.id);
  selectedRoot = path.join(dir, 'second-project'); await fs.mkdir(selectedRoot);
  const second = await service.add();
  const listed = await service.list(), stored = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.deepEqual(listed.map(item => item.id), [first.project.id, second.project.id]);
  assert.deepEqual(stored.projects.map(item => item.id), [first.project.id, second.project.id]);
  assert.equal(stateReads, 1);
});
test('an initial settings read failure does not poison later queued operations after the file is repaired', async t => {
  const { dir, root } = await fixture(t), stateFile = path.join(dir, 'retry-state.json');
  await fs.writeFile(stateFile, '{broken');
  const service = createProjectKnowledge({ stateFile, chooseFolder: async () => root });
  await assert.rejects(service.list(), /preserved/);
  assert.equal(await fs.readFile(stateFile, 'utf8'), '{broken');
  await fs.writeFile(stateFile, JSON.stringify({ version: 1, projects: [] }));
  const added = await service.add();
  assert.equal((await service.list())[0].id, added.project.id);
  assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).projects[0].id, added.project.id);
});
