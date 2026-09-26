/* Push-to-talk shortcut choices shared by Settings, the preference schema
   and the main process. Only these accelerators can be registered. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaShortcuts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PUSH_TO_TALK = Object.freeze([
    Object.freeze({ value: 'off', label: 'Off' }),
    Object.freeze({ value: 'Control+Alt+Space', label: 'Ctrl + Alt + Space' }),
    Object.freeze({ value: 'Control+Shift+Space', label: 'Ctrl + Shift + Space' }),
    Object.freeze({ value: 'Alt+Space', label: 'Alt + Space' })
  ]);
  const VALUES = Object.freeze(PUSH_TO_TALK.map(option => option.value));
  function label(value) {
    return (PUSH_TO_TALK.find(option => option.value === value) || PUSH_TO_TALK[0]).label;
  }
  return { PUSH_TO_TALK, VALUES, DEFAULT: 'off', label };
});
