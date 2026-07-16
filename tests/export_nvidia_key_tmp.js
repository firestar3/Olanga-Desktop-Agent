const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
app.setName('olanga-control');
app.whenReady().then(() => {
  const store = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'secure-store.json'), 'utf8'));
  const apiKey = safeStorage.decryptString(Buffer.from(store.nvidia_api_key, 'base64')).trim();
  const tmp = path.join(os.tmpdir(), `olanga-nvidia-key-${process.pid}.env`);
  fs.writeFileSync(tmp, `NVIDIA_API_KEY=${apiKey}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log('ENV_TMP', tmp);
  app.exit(0);
});
