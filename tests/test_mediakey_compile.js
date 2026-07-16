// Verifies the keybd_event PowerShell snippet used by main.js compiles.
// Does NOT press any keys.
const { execFile } = require('child_process');

const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OlangaMedia {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
Write-Output COMPILED
`;

execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], (err, stdout, stderr) => {
  console.log('stdout:', String(stdout || '').trim());
  if (stderr && String(stderr).trim()) console.log('stderr:', String(stderr).trim());
  if (err) console.log('error:', err.message);
});
