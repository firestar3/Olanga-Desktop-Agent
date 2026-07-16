const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
app.setName('olanga-control');
const TARGET = '877104f7-e885-42b9-8de8-f6e4c6303969';
app.whenReady().then(async () => {
  const store = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'secure-store.json'), 'utf8'));
  const apiKey = safeStorage.decryptString(Buffer.from(store.nvidia_api_key, 'base64')).trim();
  const r = await fetch('https://api.nvcf.nvidia.com/v2/nvcf/functions?visibility=authorized,private,public', {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
  });
  const data = await r.json();
  const fns = data.functions || [];
  const magpie = fns.filter(f => /magpie|tts|chatterbox|riva.*speech|speech.*synth/i.test(JSON.stringify(f)));
  console.log('TOTAL_FUNCTIONS', fns.length);
  console.log('TTS_RELATED', magpie.length);
  for (const f of magpie) {
    console.log(JSON.stringify({ id: f.id, name: f.name, status: f.status, health: f.health, apiBodyFormat: f.apiBodyFormat }));
  }
  const exact = fns.find(f => f.id === TARGET);
  console.log('EXACT_ID', exact ? JSON.stringify(exact) : 'NOT_IN_LIST');
  app.exit(0);
});
