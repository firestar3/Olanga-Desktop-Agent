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
  report('with-setName-olanga-control');
  app.exit(0);
});
