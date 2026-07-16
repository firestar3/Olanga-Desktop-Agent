const { app } = require("electron");
const pkg = require("../package.json");
app.setName("olanga-control");
app.whenReady().then(() => {
  console.log("userData:", app.getPath("userData"));
  console.log("package.json name:", pkg.name);
  app.exit(0);
});
