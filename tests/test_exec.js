const { exec } = require('child_process');
exec('powershell -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys(\'{ENTER}\')"', (err, stdout, stderr) => {
  console.log("ERR", err);
  console.log("OUT", stdout);
  console.log("STDERR", stderr);
});
