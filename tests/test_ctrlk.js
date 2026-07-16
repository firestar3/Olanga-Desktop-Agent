const { exec } = require('child_process');
const searchTerm = "Shape of You";
const safeTerm = searchTerm.replace(/[{}^%+~()]/g, '{$&}'); // Escape for SendKeys
const script = `
$wshell = New-Object -ComObject wscript.shell;
$wshell.SendKeys('^k');
Start-Sleep -Milliseconds 500;
$wshell.SendKeys('${safeTerm}');
Start-Sleep -Milliseconds 500;
$wshell.SendKeys('{ENTER}');
`;
exec(`powershell -Command "${script}"`);
