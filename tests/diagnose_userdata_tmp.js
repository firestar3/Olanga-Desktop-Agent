const { app } = require('electron');
app.whenReady().then(() => {
  console.log('defaultName:', app.getName());
  console.log('userData:', app.getPath('userData'));
  app.exit(0);
});
