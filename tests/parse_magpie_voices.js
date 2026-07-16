const fs = require('fs');
const t = fs.readFileSync('tests/magpie_voices_out.txt', 'utf8');
const m = t.match(/"subvoices": "([^"]+)"/);
if (!m) { console.error('no subvoices'); process.exit(1); }
const base = (t.match(/"voice_name": "([^"]+)"/) || [])[1] || 'Magpie-Multilingual';
const subs = m[1].split(',').map((s) => s.trim()).filter(Boolean);
const ids = new Set();
for (const sub of subs) {
  const suffix = sub.split(':')[0];
  ids.add(suffix.startsWith(base) ? suffix : `${base}.${suffix}`);
}
const sorted = [...ids].sort();
console.log('COUNT', sorted.length);
console.log('BASE', base);
for (const id of sorted) console.log(id);
