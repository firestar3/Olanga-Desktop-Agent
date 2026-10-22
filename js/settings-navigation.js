/* Settings categories share the existing controls and their save handlers. */
(() => {
  'use strict';
  const screen = document.getElementById('settingsScreen');
  const scroller = screen?.querySelector('.settings-scroll');
  const tabs = [...document.querySelectorAll('[data-settings-tab]')];
  const setup = document.getElementById('setupScreen');
  const returnButton = document.getElementById('settingsReturnToSetupBtn');
  if (!screen || !scroller || !tabs.length) return;

  const positions = new Map();
  let selected = 'user';
  let setupOpener = null;
  const setupHiddenControls = new Map();
  const privacyActions = document.querySelector('#privacyNoticeContent .privacy-actions');
  const setupNote = document.createElement('p');
  setupNote.id = 'privacySetupNote';
  setupNote.className = 'settings-hint settings-hint-after';
  setupNote.textContent = 'Privacy controls and other settings are available after setup. You can get started with local commands without an API key.';
  setupNote.hidden = true;
  privacyActions?.before(setupNote);

  function setBeforeSetup(active) {
    screen.classList.toggle('settings-before-setup', active);
    setupNote.hidden = !active;
    if (active) {
      const controls = [...tabs.filter(tab => tab.dataset.settingsTab !== 'privacy'),
        ...document.querySelectorAll('#privacyNoticeContent [data-privacy-workspace], #privacyNoticeContent [data-open-settings-tab]')];
      if (privacyActions) controls.push(privacyActions);
      for (const control of controls) {
        if (!setupHiddenControls.has(control)) setupHiddenControls.set(control, { hidden: control.hidden, disabled: control.disabled });
        control.hidden = true;
        if ('disabled' in control) control.disabled = true;
      }
    } else {
      for (const [control, previous] of setupHiddenControls) {
        control.hidden = previous.hidden;
        if ('disabled' in control) control.disabled = previous.disabled;
      }
      setupHiddenControls.clear();
    }
  }

  function select(name, { focus = false } = {}) {
    if (setupOpener && name !== 'privacy') return false;
    const next = tabs.find(tab => tab.dataset.settingsTab === name);
    if (!next) return false;
    const changed = selected !== name;
    if (changed) positions.set(selected, scroller.scrollTop);
    selected = name;
    for (const tab of tabs) {
      const active = tab === next;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !active;
    }
    if (changed) scroller.scrollTop = positions.get(name) || 0;
    if (focus) next.focus({ preventScroll: true });
    return true;
  }

  function open(name, options = {}) {
    if (!tabs.some(tab => tab.dataset.settingsTab === name)) return false;
    const fromSetup = setup && !setup.classList.contains('hidden') && !setup.classList.contains('setup-intro-replay');
    if (fromSetup) {
      setupOpener = document.activeElement;
      setBeforeSetup(true);
      setup.classList.add('hidden');
      screen.classList.remove('hidden');
      if (returnButton) returnButton.hidden = false;
    } else if (screen.classList.contains('hidden')) {
      document.querySelector('.floating-icon[data-screen="settingsScreen"]')?.click();
    }
    return select(setupOpener ? 'privacy' : name, { focus: options.focus !== false });
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab.dataset.settingsTab));
    tab.addEventListener('keydown', event => {
      const available = tabs.filter(item => !item.hidden && !item.disabled);
      if (!available.length || !available.includes(tab)) return;
      let index = available.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % available.length;
      else if (event.key === 'ArrowLeft') index = (index - 1 + available.length) % available.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = available.length - 1;
      else return;
      event.preventDefault();
      select(available[index].dataset.settingsTab, { focus: true });
    });
  }

  document.addEventListener('click', event => {
    const trigger = event.target.closest?.('[data-open-settings-tab]');
    if (!trigger) return;
    event.preventDefault();
    open(trigger.dataset.openSettingsTab);
  });

  returnButton?.addEventListener('click', () => {
    if (!setupOpener || !setup) return;
    screen.classList.add('hidden');
    setup.classList.remove('hidden');
    returnButton.hidden = true;
    const restoreFocus = setupOpener;
    setupOpener = null;
    setBeforeSetup(false);
    select('user');
    if (restoreFocus.isConnected) restoreFocus.focus({ preventScroll: true });
  });

  select('user');
  window.OlangaSettingsNavigation = Object.freeze({ open, select });
})();
