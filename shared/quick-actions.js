/* Shared by the settings renderer, the overlay controller and tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaQuickActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LABEL_MAX_LENGTH = 36;
  const PROMPT_MAX_LENGTH = 2000;
  const DEFAULT_QUICK_ACTIONS = Object.freeze([
    Object.freeze({ id: 'slot-1', label: 'Review my screen', prompt: 'What is wrong with the code or content on my screen? Explain it and suggest a fix.' }),
    Object.freeze({ id: 'slot-2', label: 'Edit selected text', prompt: 'Desktop task: Improve the selected text in the current editor. Ask me what change I want before planning.' }),
    Object.freeze({ id: 'slot-3', label: 'Files and folders', prompt: 'Desktop task: Help me organize files and folders. Ask which folder and what changes I want, then propose a plan for confirmation.' }),
    Object.freeze({ id: 'slot-4', label: 'Focus timer', prompt: 'Help me start a focus session. Ask how long I want to work, then help me set a timer using the Windows Clock app.' }),
    Object.freeze({ id: 'slot-5', label: 'Open browser', prompt: 'Open my default web browser.' })
  ]);

  function cleanText(value, fallback, limit) {
    if (typeof value !== 'string') return fallback;
    const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    return text ? Array.from(text).slice(0, limit).join('') : fallback;
  }

  // Slot IDs belong to the app. A saved label or prompt cannot change the action
  // identity, introduce a sixth slot, or turn an action into executable code.
  function normalizeQuickActions(value) {
    const slots = Array.isArray(value) ? value : [];
    return DEFAULT_QUICK_ACTIONS.map((fallback, index) => {
      const source = slots[index];
      const candidate = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
      return {
        id: fallback.id,
        label: cleanText(candidate.label, fallback.label, LABEL_MAX_LENGTH).replace(/\s+/g, ' '),
        prompt: cleanText(candidate.prompt, fallback.prompt, PROMPT_MAX_LENGTH)
      };
    });
  }

  function getQuickAction(value, id) {
    if (typeof id !== 'string') return null;
    return normalizeQuickActions(value).find((slot) => slot.id === id) || null;
  }

  return { DEFAULT_QUICK_ACTIONS, LABEL_MAX_LENGTH, PROMPT_MAX_LENGTH, normalizeQuickActions, getQuickAction };
});
