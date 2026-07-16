const { app } = require('electron');
const pkg = require('../package.json');

function report(label) {
  console.log(JSON.stringify({
    label,
    appName: app.getName(),
    userData: app.getPath('userData'),
    packageJsonName: pkg.name
  }));
}

app.whenReady().then(() => {
  report('without-setName-default');
  app.exit(0);
});
