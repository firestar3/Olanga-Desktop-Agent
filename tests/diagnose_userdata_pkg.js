const { app } = require('electron');
const path = require('path');
// simulate electron . loading main from package
app.whenReady().then(() => {
  console.log('getName:', app.getName());
  console.log('userData:', app.getPath('userData'));
  app.exit(0);
});
