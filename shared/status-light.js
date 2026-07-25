/* ============================================
   OLANGA — CORNER STATUS LIGHT (SHARED)

   Loaded by the main process (require), the renderer
   (classic script -> globalThis.OlangaStatusLight) and
   the unit tests, so mode/size rules live in one place.
   ============================================ */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.OlangaStatusLight = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MODES = ['off', 'active', 'all'];
  const SIZES = ['small', 'normal', 'large'];
  const STATES = ['idle', 'listening', 'thinking', 'speaking'];

  const MODE_LABELS = {
    off: 'No Lights',
    active: 'No Constant Light',
    all: 'All Lights'
  };

  const SIZE_LABELS = {
    small: 'Small',
    normal: 'Normal',
    large: 'Large'
  };

  const DEFAULT_MODE = 'active';
  const DEFAULT_SIZE = 'small';

  const SMALL_SIZE_PX = 72;
  const NORMAL_SCALE = 1.2;
  const LARGE_SCALE = 1.25;

  function normalizeMode(mode) {
    return MODES.includes(mode) ? mode : DEFAULT_MODE;
  }

  function normalizeSize(size) {
    return SIZES.includes(size) ? size : DEFAULT_SIZE;
  }

  function normalizeState(state) {
    return STATES.includes(state) ? state : 'idle';
  }

  function sizeToPixels(size) {
    const normal = Math.round(SMALL_SIZE_PX * NORMAL_SCALE);
    switch (normalizeSize(size)) {
      case 'large':
        return Math.round(normal * LARGE_SCALE);
      case 'normal':
        return normal;
      default:
        return SMALL_SIZE_PX;
    }
  }

  // Which glow the overlay should paint for an assistant state, or 'off'.
  function resolveVisualState(state, mode) {
    const next = normalizeState(state);
    const lightMode = normalizeMode(mode);
    if (lightMode === 'off') return 'off';
    if (lightMode === 'active' && next === 'idle') return 'off';
    return next;
  }

  function nextInCycle(list, current, fallback) {
    const index = list.indexOf(list.includes(current) ? current : fallback);
    return list[(index + 1) % list.length];
  }

  function nextMode(current) {
    return nextInCycle(MODES, current, DEFAULT_MODE);
  }

  function nextSize(current) {
    return nextInCycle(SIZES, current, DEFAULT_SIZE);
  }

  return {
    MODES,
    SIZES,
    STATES,
    MODE_LABELS,
    SIZE_LABELS,
    DEFAULT_MODE,
    DEFAULT_SIZE,
    SMALL_SIZE_PX,
    normalizeMode,
    normalizeSize,
    normalizeState,
    sizeToPixels,
    resolveVisualState,
    nextMode,
    nextSize
  };
});
