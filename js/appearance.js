/* Apply local appearance before first paint; the secure preferences reconcile at boot. */
(function () {
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const read = key => { try { return localStorage.getItem(key); } catch (_) { return null; } };
  const choices = {
    appearanceAccent: ['violet', 'blue', 'mint', 'rose', 'amber'],
    appearanceMotion: ['system', 'reduced'],
    appearanceContrast: ['standard', 'strong'],
    appearanceGlow: ['standard', 'subtle', 'off']
  };
  let current = Object.fromEntries(Object.entries(choices).map(([key, values]) => [key, values[0]]));
  let rendered = '';
  let lastReducedMotion = null;
  function refresh() {
    const effective = current.appearanceMotion === 'reduced' || media.matches;
    const next = JSON.stringify([current, effective]);
    if (next === rendered) return;
    rendered = next;
    root.dataset.accent = current.appearanceAccent;
    root.dataset.motion = current.appearanceMotion;
    root.dataset.contrast = current.appearanceContrast;
    root.dataset.glow = current.appearanceGlow;
    root.dataset.reduceMotion = String(effective);
    if (effective !== lastReducedMotion) {
      lastReducedMotion = effective;
      window.electronAPI?.setReducedMotion?.(effective);
    }
    window.dispatchEvent(new Event('olanga-appearance-changed'));
  }
  function apply(prefs) {
    current = Object.fromEntries(Object.entries(choices).map(([key, values]) => [key, values.includes(prefs[key]) ? prefs[key] : values[0]]));
    refresh();
  }
  window.OlangaAppearance = Object.freeze({ apply, snapshot: () => ({ ...current }), isReducedMotion: () => root.dataset.reduceMotion === 'true' });
  media.addEventListener('change', refresh);
  apply({
    appearanceAccent: read('olanga_appearance_accent'), appearanceMotion: read('olanga_appearance_motion'),
    appearanceContrast: read('olanga_appearance_contrast'), appearanceGlow: read('olanga_appearance_glow')
  });
})();
