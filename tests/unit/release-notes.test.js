'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { rewriteReleaseNotes } = require('../../scripts/prepare-release-notes');

const options = { repository: 'example/Olanga', ref: 'v1.6.0', sourcePath: 'docs/releases/1.6.0.md' };
const base = 'https://github.com/example/Olanga/blob/v1.6.0/';

test('current release Privacy and Validation links resolve against the source directory', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../docs/releases/1.6.0.md'), 'utf8');
  const output = rewriteReleaseNotes(source, options);
  assert.ok(output.includes('[Privacy](' + base + 'PRIVACY.md)'));
  assert.ok(output.includes('[Validation](' + base + 'docs/VALIDATION.md)'));
  assert.ok(source.includes('[Privacy](../../PRIVACY.md)'));
  assert.ok(source.includes('[Validation](../VALIDATION.md)'));
});

test('absolute, protocol-relative, anchor and query-only links are unchanged', () => {
  const source = '[Web](https://example.com/a?q=1#b) [Email](mailto:hello@example.com) [CDN](//example.com/a) [Section](#news) [Query](?plain=1)';
  assert.equal(rewriteReleaseNotes(source, options), source);
});

test('relative, repository-root, titled, angle-wrapped and reference links retain suffixes and titles', () => {
  const source = '[Guide](../GUIDE.md#install "Guide") [Root](/README.md?plain=1#start)\n[Space](<../Visual guide.md> "Guide")\n[policy]: ../../PRIVACY.md "Privacy"\n![Icon](../../icon.png)';
  const expected = '[Guide](' + base + 'docs/GUIDE.md#install "Guide") [Root](' + base + 'README.md?plain=1#start)\n[Space](<' + base + 'docs/Visual%20guide.md> "Guide")\n[policy]: ' + base + 'PRIVACY.md "Privacy"\n![Icon](' + base + 'icon.png)';
  assert.equal(rewriteReleaseNotes(source, options), expected);
});

test('code examples and original newline style remain unchanged', () => {
  const tick = String.fromCharCode(96);
  const source = tick + '[Guide](../GUIDE.md)' + tick + '\r\n' + tick.repeat(3) + 'md\r\n[Guide](../GUIDE.md)\r\n' + tick.repeat(3) + '\r\n    [Guide](../GUIDE.md)\r\n[Real](../GUIDE.md)\r\n';
  assert.equal(rewriteReleaseNotes(source, options), source.replace('[Real](../GUIDE.md)', '[Real](' + base + 'docs/GUIDE.md)'));
});

test('tag refs and existing path escapes are encoded once', () => {
  const output = rewriteReleaseNotes('[Guide](../Visual%20guide.md)', { ...options, ref: 'release/v1.6.0' });
  assert.equal(output, '[Guide](https://github.com/example/Olanga/blob/release%2Fv1.6.0/docs/Visual%20guide.md)');
});

test('invalid repository context and paths escaping the repository fail publication', () => {
  assert.throws(() => rewriteReleaseNotes('[bad](../../../secret.md)', options), /escapes the repository/);
  assert.throws(() => rewriteReleaseNotes('', { ...options, repository: 'bad' }), /owner\/repository/);
  assert.throws(() => rewriteReleaseNotes('', { ...options, ref: '' }), /tag or commit/);
  assert.throws(() => rewriteReleaseNotes('', { ...options, sourcePath: '../notes.md' }), /repository-relative/);
  assert.throws(() => rewriteReleaseNotes('', { ...options, serverUrl: 'http://github.com' }), /HTTPS/);
});

test('workflow CLI writes the publishable output while preserving the original notes', () => {
  const root = path.resolve(__dirname, '../..');
  const sourcePath = path.join(root, options.sourcePath);
  const original = fs.readFileSync(sourcePath, 'utf8');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'olanga-release-notes-'));
  try {
    const outputPath = path.join(temporary, 'RELEASE-NOTES.md');
    execFileSync(process.execPath, ['scripts/prepare-release-notes.js', options.sourcePath, outputPath, options.repository, options.ref], { cwd: root, env: { ...process.env, GITHUB_SERVER_URL: 'https://github.com' } });
    assert.equal(fs.readFileSync(outputPath, 'utf8'), rewriteReleaseNotes(original, options));
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);
  } finally {
    fs.rmSync(path.join(temporary, 'RELEASE-NOTES.md'), { force: true });
    fs.rmdirSync(temporary);
  }
});