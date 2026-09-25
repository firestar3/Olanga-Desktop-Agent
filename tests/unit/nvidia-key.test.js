const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeNvidiaKey } = require('../../shared/nvidia-key');

test('NVIDIA keys accept raw tokens and common copied authorization wrappers', () => {
  for (const value of ['nvapi-test', ' nvapi-test\n', 'Bearer nvapi-test', '"nvapi-test"', "'Bearer nvapi-test'", 'Bearer "nvapi-test"']) {
    assert.equal(normalizeNvidiaKey(value), 'nvapi-test');
  }
  assert.equal(normalizeNvidiaKey('legacy.token/value=='), 'legacy.token/value==');
  assert.equal(normalizeNvidiaKey('  '), '');
});

test('invalid key input and wrong-provider keys fail without echoing secrets', () => {
  for (const value of ['AIza-private-google', 'nvapi-private key', 'nvapi-private\nkey', 'curl --key private', 'nvapi-🙂private', null, 'x'.repeat(4097)]) {
    assert.throws(() => normalizeNvidiaKey(value), error => {
      assert.doesNotMatch(error.message, /private|AIza|🙂/);
      return true;
    });
  }
});
