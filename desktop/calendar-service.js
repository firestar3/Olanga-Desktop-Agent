const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { parse } = require('../shared/calendar');
function createCalendarService({ chooseFile, now = Date.now } = {}) {
  let current = null, generation = 0;
  return {
    async importFile() {
      const run = ++generation, filename = await chooseFile(); if (!filename || run !== generation) return { cancelled: true };
      if (path.extname(filename).toLowerCase() !== '.ics') throw new Error('Choose an .ics calendar export.');
      const stat = await fs.lstat(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) throw new Error('Choose a regular calendar file no larger than 1 MB.');
      const handle = await fs.open(filename, 'r');
      try {
        const before = await handle.stat(); if (before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size || before.mtimeMs !== stat.mtimeMs) throw new Error('The calendar file changed. Choose it again.');
        const buffer = Buffer.alloc(1048577); let position = 0;
        while (position < buffer.length) { const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position); if (!bytesRead) break; position += bytesRead; }
        const after = await handle.stat(), named = await fs.lstat(filename); if (position > 1048576 || position !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || named.ino !== before.ino || named.dev !== before.dev || named.isSymbolicLink()) throw new Error('The calendar file changed while reading.');
        const result = parse(buffer.subarray(0, position).toString('utf8'), now());
        if (run !== generation) return { cancelled: true };
        current = { ...result, source: path.basename(filename), events: result.events.map(event => ({ ...event, id: crypto.randomUUID() })) };
        return structuredClone(current);
      } finally { await handle.close(); }
    },
    list: () => current ? structuredClone(current) : { events: [], importedAt: null },
    clear: () => { generation++; current = null; return { cleared: true }; }
  };
}
module.exports = { createCalendarService };
