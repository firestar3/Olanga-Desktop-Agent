const test = require('node:test');
const assert = require('node:assert/strict');

const statusLight = require('../../shared/status-light.js');

test('unknown modes and sizes fall back to the defaults', () => {
  assert.equal(statusLight.normalizeMode('nonsense'), 'active');
  assert.equal(statusLight.normalizeMode(undefined), 'active');
  assert.equal(statusLight.normalizeSize('huge'), 'small');
  assert.equal(statusLight.normalizeSize(null), 'small');
  assert.equal(statusLight.normalizeState('bogus'), 'idle');
});

test('off mode hides the glow for every state', () => {
  for (const state of statusLight.STATES) {
    assert.equal(statusLight.resolveVisualState(state, 'off'), 'off');
  }
});

test('active mode shows every state except idle', () => {
  assert.equal(statusLight.resolveVisualState('idle', 'active'), 'off');
  assert.equal(statusLight.resolveVisualState('listening', 'active'), 'listening');
  assert.equal(statusLight.resolveVisualState('thinking', 'active'), 'thinking');
  assert.equal(statusLight.resolveVisualState('speaking', 'active'), 'speaking');
});

test('all mode also shows idle', () => {
  assert.equal(statusLight.resolveVisualState('idle', 'all'), 'idle');
  assert.equal(statusLight.resolveVisualState('speaking', 'all'), 'speaking');
});

test('an unknown mode is treated as active rather than showing idle', () => {
  assert.equal(statusLight.resolveVisualState('idle', 'garbage'), 'off');
});

test('normal is 20% over small and large is 25% over normal', () => {
  const small = statusLight.sizeToPixels('small');
  const normal = statusLight.sizeToPixels('normal');
  const large = statusLight.sizeToPixels('large');

  assert.equal(small, statusLight.SMALL_SIZE_PX);
  assert.equal(normal, Math.round(small * 1.2));
  assert.equal(large, Math.round(normal * 1.25));
  assert.ok(small < normal && normal < large);
});

test('cycles wrap around in order', () => {
  assert.deepEqual(
    ['off', 'active', 'all'].map((mode) => statusLight.nextMode(mode)),
    ['active', 'all', 'off']
  );
  assert.deepEqual(
    ['small', 'normal', 'large'].map((size) => statusLight.nextSize(size)),
    ['normal', 'large', 'small']
  );
  assert.equal(statusLight.nextSize('bogus'), 'normal');
});
