const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.js', '.ts', '.tsx', '.jsx', '.py', '.html', '.css', '.yaml', '.yml']);
const IGNORED = new Set(['node_modules', 'dist', 'build', 'vendor', 'coverage', 'cache']);
const SECRET = /(?:^|[-_.])(credentials?|secrets?|tokens?|passwords?|private[-_]?key)(?:[-_.]|$)/i;
const MAX_FILES = 400, MAX_FILE = 256 * 1024, MAX_TOTAL = 8 * 1024 * 1024;
const within = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const wordList = text => [...new Set(String(text).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])].filter(word => !new Set(['the', 'this', 'that', 'what', 'where', 'when', 'with', 'from', 'have', 'does', 'about', 'and', 'for', 'how', 'can', 'you', 'my']).has(word));

function createProjectKnowledge({ stateFile, chooseFolder, revealFile, fsImpl = fs } = {}) {
  let loaded = false, projects = [], serial = Promise.resolve();
  const indexes = new Map();
  async function readSource(filename, root) {
    if (!within(root, filename) || await fsImpl.realpath(filename) !== filename) return null;
    const before = await fsImpl.lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE) return null;
    const handle = await fsImpl.open(filename, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > MAX_FILE) return null;
      const buffer = Buffer.alloc(MAX_FILE + 1); let size = 0;
      while (size < buffer.length) { const result = await handle.read(buffer, size, buffer.length - size, size); if (!result.bytesRead) break; size += result.bytesRead; }
      const after = await handle.stat(), named = await fsImpl.lstat(filename);
      if (size > MAX_FILE || size !== opened.size || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || named.ino !== opened.ino || named.isSymbolicLink() || await fsImpl.realpath(filename) !== filename) return null;
      return buffer.subarray(0, size);
    } finally { await handle.close(); }
  }
  function exclusive(fn) { const next = serial.then(fn, fn); serial = next.catch(() => {}); return next; }
  async function load() {
    if (loaded) return;
    try {
      const bytes = await readSource(stateFile, path.dirname(stateFile));
      if (!bytes) throw new Error('Invalid project settings file.');
      const stored = JSON.parse(bytes.toString('utf8'));
      if (stored.version !== 1 || !Array.isArray(stored.projects) || stored.projects.length > 12 || stored.projects.some(item => !/^[a-f0-9-]{36}$/.test(item?.id) || typeof item.root !== 'string' || item.root.length > 4096 || !path.isAbsolute(item.root) || typeof item.name !== 'string' || item.name.length > 260) || new Set(stored.projects.map(item => item.id)).size !== stored.projects.length) throw new Error('Invalid project settings.');
      projects = stored.projects.map(({ id, root, name }) => ({ id, root, name }));
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Project settings could not be read. The original file was preserved.'); }
    loaded = true;
  }
  async function save(next) {
    await fsImpl.mkdir(path.dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.${crypto.randomUUID()}.tmp`;
    try { await fsImpl.writeFile(temporary, JSON.stringify({ version: 1, projects: next }), { mode: 0o600 }); await fsImpl.rename(temporary, stateFile); }
    catch (error) { await fsImpl.unlink(temporary).catch(() => {}); throw new Error('Project settings could not be saved.'); }
    projects = next;
  }
  async function project(id) { await load(); const item = projects.find(item => item.id === id); if (!item) throw new Error('Select a current project.'); return item; }
  async function checkedRoot(item) {
    const stat = await fsImpl.lstat(item.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fsImpl.realpath(item.root) !== item.root) throw new Error('The selected project folder changed. Choose it again.');
    return item.root;
  }
  async function index(id) {
    const item = await project(id), root = await checkedRoot(item), files = [];
    let total = 0, skipped = 0, truncated = false;
    async function visit(directory, depth = 0) {
      if (depth > 12 || files.length >= MAX_FILES || total >= MAX_TOTAL) { truncated = true; return; }
      const entries = await fsImpl.readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith('.') || IGNORED.has(entry.name.toLowerCase()) || SECRET.test(entry.name) || entry.isSymbolicLink()) { skipped++; continue; }
        if (files.length >= MAX_FILES || total >= MAX_TOTAL) { truncated = true; break; }
        const filename = path.join(directory, entry.name), real = await fsImpl.realpath(filename).catch(() => null);
        if (!real || !within(root, real) || real !== filename) { skipped++; continue; }
        if (entry.isDirectory()) { await visit(filename, depth + 1); continue; }
        if (!entry.isFile() || !EXTENSIONS.has(path.extname(filename).toLowerCase())) { skipped++; continue; }
        const stat = await fsImpl.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE || total + stat.size > MAX_TOTAL) { skipped++; continue; }
        const bytes = await readSource(filename, root).catch(() => null);
        if (!bytes || bytes.includes(0)) { skipped++; continue; }
        const after = await fsImpl.lstat(filename);
        if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || await fsImpl.realpath(filename) !== real) { skipped++; continue; }
        total += bytes.length;
        files.push({ id: crypto.randomUUID(), path: filename, relativePath: path.relative(root, filename), digest: hash(bytes), text: bytes.toString('utf8') });
      }
    }
    await visit(root);
    indexes.set(id, { files, indexedAt: Date.now(), total, skipped, truncated });
    return { id, name: item.name, files: files.length, bytes: total, skipped, truncated, indexedAt: indexes.get(id).indexedAt };
  }
  return {
    list: () => exclusive(async () => { await load(); return projects.map(item => ({ ...item, indexed: indexes.has(item.id), fileCount: indexes.get(item.id)?.files.length || 0 })); }),
    add: () => exclusive(async () => {
      await load(); if (projects.length >= 12) throw new Error('Remove a project before adding another.');
      const selected = await chooseFolder(); if (!selected) return { cancelled: true };
      const stat = await fsImpl.lstat(selected); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Choose a real folder, not a link.');
      const root = await fsImpl.realpath(selected), existing = projects.find(item => item.root === root);
      if (existing) return { project: { ...existing }, index: await index(existing.id) };
      const item = { id: crypto.randomUUID(), root, name: path.basename(root) || root };
      await save([...projects, item]); return { project: { ...item }, index: await index(item.id) };
    }),
    remove: id => exclusive(async () => { await project(id); await save(projects.filter(item => item.id !== id)); indexes.delete(id); return { removed: true }; }),
    refresh: id => exclusive(() => index(id)),
    search: (id, query) => exclusive(async () => {
      const item = await project(id); await checkedRoot(item);
      if (typeof query !== 'string' || !query.trim() || query.length > 1000) throw new Error('Enter a question or search of up to 1,000 characters.');
      const current = indexes.get(id); if (!current) throw new Error('Refresh this project index before searching.');
      const terms = wordList(query).slice(0, 32); if (!terms.length) return { projectId: id, name: item.name, indexedAt: current.indexedAt, truncated: current.truncated, results: [], staleFiles: 0 };
      const results = []; let staleFiles = 0;
      for (const file of current.files) {
        const real = await fsImpl.realpath(file.path).catch(() => null);
        const stat = real === file.path && within(item.root, real) ? await fsImpl.lstat(real).catch(() => null) : null;
        if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE) { staleFiles++; continue; }
        const bytes = await readSource(real, item.root).catch(() => null);
        if (!bytes || bytes.length > MAX_FILE || hash(bytes) !== file.digest) { staleFiles++; continue; }
        const lines = file.text.split(/\r?\n/);
        for (let start = 0; start < lines.length; start += 12) {
          const excerpt = lines.slice(start, start + 16).join('\n').slice(0, 2400), content = excerpt.toLowerCase();
          const matched = terms.filter(term => content.includes(term));
          if (!matched.length) continue;
          const score = matched.length * 10 + terms.filter(term => file.relativePath.toLowerCase().includes(term)).length * 3;
          results.push({ sourceId: file.id, relativePath: file.relativePath, startLine: start + 1, endLine: Math.min(lines.length, start + 16), excerpt, score });
        }
      }
      results.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath) || a.startLine - b.startLine);
      return { projectId: id, name: item.name, indexedAt: current.indexedAt, staleFiles, truncated: current.truncated, results: results.slice(0, 6).map((item, i) => ({ ...item, citation: `S${i + 1}` })) };
    }),
    reveal: (id, sourceId) => exclusive(async () => {
      const item = await project(id); await checkedRoot(item);
      const file = indexes.get(id)?.files.find(file => file.id === sourceId);
      if (!file || await fsImpl.realpath(file.path) !== file.path || !within(item.root, file.path)) throw new Error('This source is no longer available.');
      await revealFile(file.path); return { revealed: true };
    })
  };
}
module.exports = { createProjectKnowledge, within, wordList };
