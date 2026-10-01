const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { normalizeThumbprint, validateSigningReport, validateInstallerSignature, verifyInstallerSignature, configuredPublisher } = require('../../desktop/signing-policy');
const pin = 'A'.repeat(40), signed = { status: 'Valid', thumbprint: pin }, unsigned = { status: 'NotSigned', thumbprint: null };
test('publisher pins are exact certificate thumbprints and the checked-in policy is disabled', () => {
  assert.equal(configuredPublisher(), null); assert.equal(normalizeThumbprint('aa:'.repeat(19) + 'aa'), pin);
  for (const value of ['abc', 'g'.repeat(40), true, 'A'.repeat(64)]) assert.throws(() => normalizeThumbprint(value));
  assert.equal(validateInstallerSignature(signed, pin), true);
  assert.throws(() => validateInstallerSignature(unsigned, pin));
});
test('unsigned builds must really be unsigned and cannot silently accept a configured pin', () => {
  assert.equal(validateSigningReport({ expectedSigned: false, installer: unsigned, application: unsigned }).signing, 'unsigned');
  for (const options of [{ expectedThumbprint: pin }, { installer: signed }, { application: signed }]) assert.throws(() => validateSigningReport({ expectedSigned: false, installer: unsigned, application: unsigned, ...options }));
});
test('signed builds require two valid matching certificates and honor an optional exact pin', () => {
  const input = { expectedSigned: true, expectedThumbprint: pin, installer: signed, application: signed };
  assert.equal(validateSigningReport(input).publisherPinned, true);
  for (const application of [unsigned, { status: 'HashMismatch', thumbprint: pin }, { status: 'Valid', thumbprint: 'B'.repeat(40) }]) assert.throws(() => validateSigningReport({ ...input, application }));
  assert.throws(() => validateSigningReport({ ...input, expectedThumbprint: 'B'.repeat(40) }));
});
test('signature inspection uses a fixed hidden PowerShell helper and never interpolates a path', async () => {
  let seen;
  const result = await verifyInstallerSignature(require('node:path').resolve('fixture file.exe'), { platform: 'win32', spawnImpl: (exe, args, options) => {
    seen = { exe, args, options }; const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.end(JSON.stringify(signed)); child.emit('close', 0); }); return child;
  } });
  assert.equal(result.thumbprint, pin); assert.equal(seen.options.shell, false); assert.equal(seen.options.windowsHide, true);
  assert.ok(seen.args.includes('-File')); assert.equal(seen.args.at(-1), require('node:path').resolve('fixture file.exe'));
});
