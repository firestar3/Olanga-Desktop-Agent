const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
app.setName('olanga-control');
const FID = '877104f7-e885-42b9-8de8-f6e4c6303969';
app.whenReady().then(async () => {
  const store = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'secure-store.json'), 'utf8'));
  const apiKey = safeStorage.decryptString(Buffer.from(store.nvidia_api_key, 'base64')).trim();
  console.log('KEY_PREFIX:', apiKey.slice(0, 8) + '...');
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  for (const url of [
    `https://api.nvcf.nvidia.com/v2/nvcf/functions/${FID}`,
    `https://api.nvcf.nvidia.com/v2/nvcf/functions?visibility=authorized,private,public`
  ]) {
    console.log('\nGET', url);
    const r = await fetch(url, { headers });
    console.log('STATUS', r.status);
    const text = await r.text();
    console.log(text.slice(0, 12000));
  }
  app.exit(0);
});
