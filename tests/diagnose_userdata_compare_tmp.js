const { app } = require('electron');
const pkg = require('../package.json');
app.setName('olanga-control');
app.whenReady().then(() => {
  console.log(JSON.stringify({
    label: 'with-setName-olanga-control',
    appName: app.getName(),
    userData: app.getPath('userData'),
    packageJsonName: pkg.name
  }));
  app.exit(0);
});
