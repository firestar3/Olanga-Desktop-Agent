const { app } = require('electron');
const fs = require('fs');
const path = require('path');
// Loaded as main from package via: electron tests/diag_pkg_main.js won't work
// Use same as npm start: package in cwd
app.whenReady().then(() => {
  console.log('getName:', app.getName());
  console.log('userData:', app.getPath('userData'));
  const p = path.join(app.getPath('userData'), 'secure-store.json');
  console.log('secure-store exists:', fs.existsSync(p));
  app.exit(0);
});
