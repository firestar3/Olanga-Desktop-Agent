const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

app.setName('olanga-control');

app.whenReady().then(() => {
  const storePath = path.join(app.getPath('userData'), 'secure-store.json');
  console.log('userData:', app.getPath('userData'));
  console.log('storePath:', storePath);
  console.log('safeStorage.isEncryptionAvailable():', safeStorage.isEncryptionAvailable());

  if (!fs.existsSync(storePath)) {
    console.log('ERROR: secure-store.json missing at path');
    app.exit(1);
    return;
  }

  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  console.log('topLevelKeys:', Object.keys(store).join(', '));

  for (const key of Object.keys(store)) {
    const encrypted = store[key];
    if (typeof encrypted !== 'string') {
      console.log(`[${key}] not a string, type=${typeof encrypted}`);
      continue;
    }
    try {
      const plain = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      if (key === 'gemini_api_keys') {
        let arr = null;
        let parseOk = false;
        try {
          arr = JSON.parse(plain);
          parseOk = Array.isArray(arr);
        } catch (e) {
          console.log(`[${key}] JSON.parse error:`, e.message);
        }
        console.log(`[${key}] decrypt: OK, parseIsArray: ${parseOk}, arrayLength: ${parseOk ? arr.length : 'N/A'}`);
      } else if (key === 'nvidia_api_key') {
        console.log(`[${key}] decrypt: OK, stringLength: ${plain.length}`);
      } else {
        console.log(`[${key}] decrypt: OK, plainLength: ${plain.length}`);
      }
    } catch (e) {
      console.log(`[${key}] decrypt: FAILED`, e.message);
    }
  }

  app.exit(0);
});
