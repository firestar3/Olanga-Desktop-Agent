const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const windows = { skip: process.platform !== 'win32' };
const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const helper = path.resolve(__dirname, '../../desktop/input-helper.ps1');
let results;

function verificationResults() {
  if (results) return results;
  const source = fs.readFileSync(helper, 'utf8');
  const checkpoint = source.match(/public class EditCheckpoint \{[^}]+\}/)?.[0];
  const start = source.indexOf('  static bool SameEditor(');
  const end = source.indexOf('  public static EditCheckpoint ReplaceEdit(', start);
  assert.ok(checkpoint && start >= 0 && end > start, 'Use the actual production C# verification routine');
  // Compile the production readback/identity checks with a deterministic reader
  // and clock. This fixture has no UIA, Win32, input, or value-write capability.
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
public static class ReplacementVerificationFixture {
  ${checkpoint}
  ${source.slice(start, end)}
  public class Result { public string scenario,error,text,title; public int reads,waits; public long elapsed; public bool ok,expectedUnchanged; }
  static EditCheckpoint Record(string text) {
    return new EditCheckpoint { handle="100", processId=1, processStart="123", runtimeId="edit1", automationId="text", controlType="ControlType.Edit", className="Edit", nativeHandle=200, parentRuntimeId="parent1", windowTitle="Document", text=text };
  }
  public static Result Run(string scenario) {
    var result=new Result { scenario=scenario };
    var expected=Record("Original");
    var replacement="New\\ncomplete value";
    Func<EditCheckpoint> read=delegate {
      result.reads++;
      if(scenario=="read-error" && result.reads==2) throw new Exception("Focus left the approved window");
      var after=Record(replacement);
      if(scenario=="delayed" && result.reads<4 || scenario=="unchanged" || scenario=="read-error") after.text=expected.text;
      if(scenario=="normalized") after.text="New\\r\\ncomplete value";
      if(scenario.StartsWith("identity:")) {
        if(result.reads<3) after.text=expected.text;
        else {
          var field=typeof(EditCheckpoint).GetField(scenario.Substring(9));
          field.SetValue(after,field.FieldType==typeof(int)?(object)999:(object)"changed");
        }
      }
      after.windowTitle="Document *";
      return after;
    };
    try {
      var verified=VerifyReplacement(expected,replacement,read,delegate { return result.elapsed; },delegate(int ms) { if(ms<=0 || ms>40) throw new Exception("Unbounded wait"); result.waits++; result.elapsed+=ms; });
      result.ok=true; result.text=verified.text; result.title=verified.windowTitle;
    } catch(Exception error) { result.error=error.Message; }
    result.expectedUnchanged=expected.text=="Original" && expected.windowTitle=="Document";
    return result;
  }
}
'@
$cases = @('immediate','delayed','normalized','unchanged','read-error','identity:handle','identity:processId','identity:processStart','identity:runtimeId','identity:automationId','identity:controlType','identity:className','identity:nativeHandle','identity:parentRuntimeId')
@($cases | ForEach-Object { [ReplacementVerificationFixture]::Run($_) }) | ConvertTo-Json -Compress
`;
  const output = execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  results = JSON.parse(output.trim());
  return results;
}

test('Windows desktop helper and UIA interop compile without issuing input', windows, () => {
  const output = execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], { input: '', encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(output.trim(), '');
});

test('native replacement waits for a delayed accessible value without changing its checkpoint', windows, () => {
  const immediate = verificationResults().find(item => item.scenario === 'immediate');
  const delayed = verificationResults().find(item => item.scenario === 'delayed');
  assert.equal(immediate.ok, true);
  assert.equal(immediate.reads, 1);
  assert.equal(immediate.waits, 0);
  assert.equal(delayed.ok, true);
  assert.equal(delayed.reads, 4);
  assert.equal(delayed.elapsed, 120);
  assert.equal(delayed.text, 'New\ncomplete value');
  assert.equal(delayed.title, 'Document *', 'The actual post-edit title becomes the undo guard');
  assert.ok(verificationResults().every(item => item.expectedUnchanged));
});

test('native replacement retains complete-text verification and a bounded stale-value failure', windows, () => {
  const stale = verificationResults().find(item => item.scenario === 'unchanged');
  assert.equal(stale.ok, false);
  assert.match(stale.error, /complete text could not be verified/);
  assert.equal(stale.elapsed, 1500);
  assert.ok(stale.reads <= 39);
  const normalized = verificationResults().find(item => item.scenario === 'normalized');
  assert.equal(normalized.ok, true);
  assert.equal(normalized.text, 'New\r\ncomplete value');
});

test('native replacement rejects each changed identity immediately even when text matches', windows, () => {
  const changes = verificationResults().filter(item => item.scenario.startsWith('identity:'));
  assert.equal(changes.length, 9);
  for (const result of changes) {
    assert.equal(result.ok, false, result.scenario);
    assert.match(result.error, /editor identity changed/);
    assert.equal(result.reads, 3);
    assert.equal(result.elapsed, 80, 'Identity conflicts must not be retried until timeout');
  }
});

test('native replacement propagates focus/read errors without retrying the reader', windows, () => {
  const result = verificationResults().find(item => item.scenario === 'read-error');
  assert.equal(result.ok, false);
  assert.match(result.error, /Focus left/);
  assert.equal(result.reads, 2);
  assert.equal(result.elapsed, 40);
});
