'use strict';

(() => {
  const api = window.olangaSideLight;
  const light = document.getElementById('light');
  const menu = document.getElementById('quickMenu');
  const actionList = document.getElementById('quickActions');
  const statusText = document.getElementById('statusText');
  const statusLabels = { idle: 'Ready', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', off: 'Off' };
  let wasOpen = false;
  let actionsKey = '';
  let pointerPending = false;

  function setGeometry(geometry) {
    if (!geometry?.orb || !geometry?.menu) return;
    const values = {
      '--orb-size': geometry.diameter, '--orb-left': geometry.orb.x, '--orb-top': geometry.orb.y,
      '--menu-left': geometry.menu.x, '--menu-top': geometry.menu.y,
      '--menu-width': geometry.menu.width, '--menu-height': geometry.menu.height
    };
    for (const [name, value] of Object.entries(values)) {
      if (Number.isFinite(value)) document.documentElement.style.setProperty(name, `${value}px`);
    }
  }

  function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const state = Object.hasOwn(statusLabels, snapshot.state) ? snapshot.state : 'off';
    const open = snapshot.menuOpen === true && state !== 'off';
    document.body.dataset.state = state;
    light.hidden = state === 'off';
    light.classList.toggle('hovered', snapshot.hovered === true);
    light.setAttribute('aria-expanded', String(open));
    light.setAttribute('aria-label', open ? 'Close Olanga shortcuts' : `Open Olanga shortcuts. ${statusLabels[state]}`);
    menu.hidden = !open;
    statusText.textContent = statusLabels[state];
    setGeometry(snapshot.geometry);
    const actions = Array.isArray(snapshot.actions) ? snapshot.actions.slice(0, 5) : [];
    const key = JSON.stringify(actions);
    if (actionsKey !== key) {
      actionsKey = key;
      actionList.replaceChildren(...actions.map((action, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.title = String(action.label);
        button.setAttribute('aria-keyshortcuts', String(index + 1));
        const number = document.createElement('span');
        number.className = 'slot-number';
        number.textContent = String(index + 1);
        number.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.className = 'action-label';
        label.textContent = String(action.label);
        button.append(label, number);
        button.addEventListener('click', () => api?.runQuickAction(action.id));
        return button;
      }));
    }
    if (open && !wasOpen) actionList.querySelector('button')?.focus({ preventScroll: true });
    wasOpen = open;
  }

  light.addEventListener('click', () => api?.toggleMenu());
  document.getElementById('hideLight').addEventListener('click', () => api?.hideLight('5-seconds'));
  document.getElementById('hideLightHour').addEventListener('click', () => api?.hideLight('1-hour'));
  document.getElementById('openApp').addEventListener('click', () => api?.openApp());
  document.addEventListener('pointermove', () => {
    if (pointerPending) return;
    pointerPending = true;
    requestAnimationFrame(() => { pointerPending = false; api?.refreshPointer(); });
  });
  document.addEventListener('pointerleave', () => api?.refreshPointer());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); api?.closeMenu(); return; }
    if (menu.hidden) return;
    if (/^[1-5]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && !event.repeat && !event.isComposing) {
      event.preventDefault();
      actionList.querySelectorAll('button')[Number(event.key) - 1]?.click();
      return;
    }
    const buttons = [...menu.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    if (event.key === 'Tab') next = (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
    if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
  });
  api?.onSnapshot(applySnapshot);
  api?.ready();
})();
