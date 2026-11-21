// Renderer smoke test in a hidden, isolated Electron window. No screen control.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { overlayGeometry } = require('../desktop/status-overlay');
const { DEFAULT_QUICK_ACTIONS } = require('../shared/quick-actions');
app.disableHardwareAcceleration();
const output = path.resolve(__dirname, '../build/qa');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(output, 'overlay-profile-')));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  try {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_details, callback) => callback({ cancel: true }));
    const window = new BrowserWindow({
      width: 292, height: 406, show: false, frame: false, transparent: true,
      webPreferences: { preload: path.resolve(__dirname, '../status-indicator-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: 'olanga-side-light', zoomFactor: 1 }
    });
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_details, callback) => callback({ cancel: true }));
    assert.notEqual(window.webContents.session, session.defaultSession, 'overlay has a separate session');
    const errors = [];
    window.webContents.on('console-message', (_event, details) => {
      if (details?.level === 'error') errors.push(details.message);
    });
    window.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
    const actions = [];
    let sportsGestureFixture = null;
    const trustedSenders = [];
    const expectedURL = pathToFileURL(path.resolve(__dirname, '../status-indicator.html')).href;
    let snapshot = { state: 'idle', menuOpen: false, hovered: false, geometry: overlayGeometry(292, 406, 'small'), actions: DEFAULT_QUICK_ACTIONS.map(({ id, label }) => ({ id, label })) };
    ipcMain.on('status-overlay-action', (event, action) => {
      trustedSenders.push(event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === expectedURL);
      actions.push(action);
      if (action.type === 'ready') window.webContents.send('status-overlay-snapshot', snapshot);
      else sportsGestureFixture?.(action);
    });
    await window.loadFile(path.resolve(__dirname, '../status-indicator.html'));
    await pause(250);
    assert.ok(actions.some((action) => action.type === 'ready'), 'preload ready handshake');
    for (const [name, fields] of [
      ['side-light', { hovered: false, menuOpen: false }],
      ['side-light-hover', { hovered: true, menuOpen: false }],
      ['side-light-menu', { hovered: false, menuOpen: true }]
    ]) {
      snapshot = { ...snapshot, ...fields };
      window.webContents.send('status-overlay-snapshot', snapshot);
      window.webContents.invalidate();
      await pause(400);
      const diameter = await window.webContents.executeJavaScript(`document.getElementById('light').getBoundingClientRect().width`);
      assert.ok(Math.abs(diameter - 32 * (fields.hovered || fields.menuOpen ? 1.12 : 1)) < .1, 'native hit geometry matches the painted orb');
      fs.writeFileSync(path.join(output, name + '.png'), (await window.webContents.capturePage()).toPNG());
    }
    const layout = await window.webContents.executeJavaScript(`({
      menuButtons: document.querySelectorAll('#quickMenu button').length,
      menuHeight: document.getElementById('quickMenu').clientHeight,
      scrollHeight: document.getElementById('quickMenu').scrollHeight,
      orb: { x: document.getElementById('light').offsetLeft, y: document.getElementById('light').offsetTop, width: document.getElementById('light').offsetWidth },
      focused: document.activeElement?.textContent,
      hidden: document.getElementById('quickMenu').hidden
    })`);
    assert.equal(layout.menuButtons, 8);
    assert.equal(layout.hidden, false);
    assert.deepEqual(layout.orb, { x: 254, y: 368, width: 32 });
    assert.ok(layout.scrollHeight <= layout.menuHeight, 'menu fits without clipping or scrolling: ' + JSON.stringify(layout));
    assert.ok(layout.focused.includes('Review my screen'), 'keyboard focus starts at first shortcut');
    const keyboardStart = actions.length;
    await window.webContents.executeJavaScript(`for (const key of ['1', '3', '5']) document.dispatchEvent(new KeyboardEvent('keydown', { key }));`);
    await pause(30);
    assert.deepEqual(actions.slice(keyboardStart).filter((action) => action.type === 'quick-action').map((action) => action.id), ['slot-1', 'slot-3', 'slot-5'], 'number keys run their configured slots');
    const ignoredStart = actions.length;
    await window.webContents.executeJavaScript(`for (const options of [{ key: '1', ctrlKey: true }, { key: '2', altKey: true }, { key: '3', metaKey: true }, { key: '4', shiftKey: true }, { key: '5', repeat: true }, { key: '1', isComposing: true }, { key: '0' }, { key: '6' }]) document.dispatchEvent(new KeyboardEvent('keydown', options));`);
    await pause(30);
    assert.equal(actions.length, ignoredStart, 'modifiers, repeats, composition and other numbers never dispatch shortcuts');
    window.webContents.send('status-overlay-snapshot', { ...snapshot, menuOpen: false });
    await pause(30);
    await window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));`);
    await pause(30);
    assert.equal(actions.length, ignoredStart, 'number keys cannot run shortcuts while the menu is closed');
    window.webContents.send('status-overlay-snapshot', snapshot);
    await pause(30);
    const focus = await window.webContents.executeJavaScript(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
      const second = document.activeElement?.getAttribute('aria-keyshortcuts');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
      const first = document.activeElement?.getAttribute('aria-keyshortcuts');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
      return { first, second, last: document.activeElement?.id };
    })()`);
    assert.deepEqual(focus, { first: '1', second: '2', last: 'openApp' }, 'Tab and Shift+Tab traverse and wrap the menu');
    await window.webContents.executeJavaScript(`document.querySelector('#quickActions button').click(); document.getElementById('hideLight').click(); document.getElementById('hideLightHour').click(); document.getElementById('openApp').click(); window.olangaSideLight.hideLight('forever'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));`);
    await pause(50);
    assert.ok(actions.some((action) => action.type === 'quick-action' && action.id === 'slot-1'));
    assert.deepEqual(actions.filter((action) => action.type === 'hide'), [{ type: 'hide', duration: '5-seconds' }, { type: 'hide', duration: '1-hour' }]);
    assert.ok(actions.some((action) => action.type === 'open-app'));
    assert.ok(actions.some((action) => action.type === 'close'));
    assert.ok(trustedSenders.length && trustedSenders.every(Boolean), 'isolated session keeps the real IPC sender, main frame, and exact trusted file URL');
    const loadedFont = await window.webContents.executeJavaScript(`(async () => {
      await document.fonts.load('500 12px Outfit');
      await document.fonts.ready;
      return [...document.fonts].some(face => face.family.replace(/['"]/g, '') === 'Outfit' && face.status === 'loaded');
    })()`);
    assert.equal(loadedFont, true, 'The overlay loads bundled Outfit without a remote request');
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    const motionStyle = () => window.webContents.executeJavaScript(`({
      animation: getComputedStyle(document.querySelector('.light-surface')).animationName,
      menuAnimation: getComputedStyle(document.getElementById('quickMenu')).animationName,
      transition: getComputedStyle(document.getElementById('light')).transitionDuration,
      accent: getComputedStyle(document.body).getPropertyValue('--accent').trim(),
      state: document.body.dataset.state,
      reduced: document.body.classList.contains('reduced-motion')
    })`);
    for (const [state, animation] of [['thinking', 'thinking'], ['listening', 'breathe'], ['speaking', 'breathe']]) {
      window.webContents.send('status-overlay-snapshot', { ...snapshot, state, reducedMotion: false }); await pause(30);
      const animated = await motionStyle(); assert.equal(animated.animation, animation);
      window.webContents.send('status-overlay-snapshot', { ...snapshot, state, reducedMotion: true }); await pause(30);
      const reduced = await motionStyle();
      assert.equal(reduced.animation, 'none'); assert.equal(reduced.menuAnimation, 'none'); assert.equal(reduced.transition, '0s');
      assert.equal(reduced.reduced, true); assert.equal(reduced.state, state); assert.equal(reduced.accent, animated.accent, 'Reduced motion preserves status colors');
      window.webContents.send('status-overlay-snapshot', { ...snapshot, state, reducedMotion: false }); await pause(30);
      assert.equal((await motionStyle()).animation, animation, 'Motion resumes when the explicit preference is disabled');
    }
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await pause(30); assert.equal((await motionStyle()).animation, 'none', 'Windows reduced motion remains authoritative');
    window.webContents.debugger.detach();

    // All score data below is authored fixture content. The isolated session
    // blocks network access and never starts the application's live poller.
    const sportsProbe = overlayGeometry(292, 1000, 'small', true);
    const sportsViewportHeight = sportsProbe.menu.height + sportsProbe.sports.height + 20;
    window.setSize(292, sportsViewportHeight);
    const sportsGeometry = overlayGeometry(292, sportsViewportHeight, 'small', true);
    assert.equal(sportsGeometry.sports.width, 190, 'floating scores keep their compact product width');
    assert.equal(sportsGeometry.sports.height, 96, 'floating scores keep their compact product height');
    assert.equal(sportsGeometry.sportsHandle.width, 52, 'compact internal grip matches its hit target');
    const sportsMaxOffset = sportsGeometry.sportsMaxOffset ?? sportsGeometry.sports.height - sportsGeometry.sportsHandle.height;
    assert.equal(sportsMaxOffset, 72, 'tucking retains the card top strip and its internal grip');
    assert.equal(sportsGeometry.sportsHandle.y, sportsGeometry.sports.y, 'grip occupies the top of the card without an extra tab');
    const game = { id: 'fixture-game', state: 'live', detail: 'Q1 12:00', startAt: '2026-11-01T02:00:00Z',
      away: { abbr: 'GSW', name: 'Golden State Warriors', score: 0 },
      home: { abbr: 'LAL', name: 'Los Angeles Lakers', score: 0 } };
    const sports = { enabled: true, team: 'GSW', teamName: 'Golden State Warriors', game,
      state: 'ready', updatedAt: '2026-10-28T02:00:00Z', stale: false, error: '', refreshing: false };
    const showSports = async (fields = {}, outer = {}) => {
      snapshot = { ...snapshot, state: 'idle', visible: true, menuOpen: false, hovered: false,
        geometry: sportsGeometry, sportsPresentation: { collapsed: false, dragging: false, offset: 0 }, sports: { ...sports, ...fields }, ...outer };
      window.webContents.send('status-overlay-snapshot', snapshot);
      await pause(40);
    };
    const scoreView = () => window.webContents.executeJavaScript(`(() => {
      const card = document.getElementById('sportsCard'), rect = card.getBoundingClientRect();
      return { hidden: card.hidden, orbHidden: document.getElementById('light').hidden,
        menuHidden: document.getElementById('quickMenu').hidden,
        state: document.getElementById('sportsState').textContent,
        away: document.getElementById('sportsAway').textContent, home: document.getElementById('sportsHome').textContent,
        awayScore: document.getElementById('sportsAwayScore').textContent, homeScore: document.getElementById('sportsHomeScore').textContent,
        updated: document.getElementById('sportsUpdated').textContent,
        tooltip: document.getElementById('sportsUpdated').title,
        empty: document.getElementById('sportsEmpty').textContent,
        matchHidden: document.getElementById('sportsMatch').hidden,
        refreshing: document.getElementById('refreshSports').getAttribute('aria-disabled'),
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        clientHeight: card.clientHeight, scrollHeight: card.scrollHeight,
        clientWidth: card.clientWidth, scrollWidth: card.scrollWidth };
    })()`);
    const saveSports = async name => {
      window.webContents.invalidate(); await pause(100);
      fs.writeFileSync(path.join(output, name + '.png'), (await window.webContents.capturePage()).toPNG());
    };
    await showSports();
    const liveView = await scoreView();
    assert.equal(liveView.hidden, false);
    assert.equal(liveView.state, 'Q1 12:00');
    assert.equal(liveView.away, 'GSW'); assert.equal(liveView.home, 'LAL');
    assert.equal(liveView.awayScore, '0'); assert.equal(liveView.homeScore, '0', 'zero is a valid live score');
    assert.match(liveView.updated, /^ESPN · updated /);
    assert.deepEqual({ x: liveView.x, y: liveView.y, width: liveView.width, height: liveView.height }, sportsGeometry.sports);
    assert.ok(liveView.scrollHeight <= liveView.clientHeight && liveView.scrollWidth <= liveView.clientWidth, 'normal score card content fits');
    const headerControls = await window.webContents.executeJavaScript(`(() => {
      const card = document.getElementById('sportsCard').getBoundingClientRect();
      return [...document.querySelectorAll('.sports-controls button')].map(button => {
        const box = button.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { id: button.id, inside: box.left >= card.left && box.right <= card.right && box.top >= card.top && box.bottom <= card.bottom, reachable: hit === button || button.contains(hit) };
      });
    })()`);
    assert.equal(headerControls.length, 2, 'compact floating header retains only settings and refresh controls');
    assert.ok(headerControls.every(button => button.inside && button.reachable), 'both compact floating controls stay inside their usable hit rectangle');
    assert.equal(await window.webContents.executeJavaScript(`document.getElementById('sportsHide') === null && typeof window.olangaSideLight.openSportsHideMenu === 'undefined'`), true, 'temporary score hiding has no UI or preload bridge');
    await pause(1100);
    assert.equal((await scoreView()).state, 'Q1 12:00', 'game clock stays at the provider value instead of fabricating a countdown');
    await saveSports('side-light-sports-live-fixture');
    await window.webContents.executeJavaScript(`window.__scoreMutations = 0;
      window.__scoreObserver = new MutationObserver(records => { window.__scoreMutations += records.length; });
      window.__scoreObserver.observe(document.getElementById('sportsMatch'), { childList: true, subtree: true, characterData: true });`);
    await showSports({}, { hovered: true });
    await showSports({}, { hovered: false });
    assert.equal(await window.webContents.executeJavaScript('window.__scoreMutations'), 0, 'identical scores do not repeat live-region mutations on orb hover');
    await showSports({ game: { ...game, away: { ...game.away, score: 3 } } });
    assert.ok(await window.webContents.executeJavaScript('window.__scoreMutations > 0'), 'a changed score still updates the live region');
    await window.webContents.executeJavaScript('window.__scoreObserver.disconnect(); delete window.__scoreObserver; delete window.__scoreMutations;');
    await showSports({ game: { ...game, detail: '', period: 5, clock: '0:45' } });
    assert.equal((await scoreView()).state, 'OT 0:45', 'missing detail falls back to source overtime period and clock');
    await showSports({ game: { ...game, detail: 'Q4 2:14', away: { ...game.away, score: 108 }, home: { ...game.home, score: 105 } } });
    window.webContents.invalidate(); await pause(100);
    const [previewWidth, previewHeight] = window.getSize();
    const previewCropHeight = sportsGeometry.sports.height + 20;
    fs.writeFileSync(path.join(output, 'side-light-sports-preview-fixture.png'),
      (await window.webContents.capturePage({ x: 0, y: previewHeight - previewCropHeight, width: previewWidth, height: previewCropHeight })).toPNG());
    await showSports({ game: { ...game, state: 'pre' } });
    let view = await scoreView();
    assert.equal(view.state, 'Next game'); assert.equal(view.awayScore, '—'); assert.equal(view.homeScore, '—');
    assert.ok(view.updated && !view.updated.startsWith('ESPN'), 'scheduled start is formatted instead of a fake score');
    await showSports({ game: { ...game, state: 'final', detail: 'Final', away: { ...game.away, score: 113 }, home: { ...game.home, score: 108 } } });
    view = await scoreView(); assert.equal(view.state, 'Final'); assert.equal(view.awayScore, '113'); assert.equal(view.homeScore, '108');
    await showSports({ game: { ...game, state: 'postponed', detail: 'Postponed' } });
    view = await scoreView(); assert.equal(view.state, 'Postponed'); assert.equal(view.awayScore, '—');
    await showSports({ stale: true, error: 'Temporary connection failure' });
    view = await scoreView(); assert.match(view.updated, /^Updates delayed · /); assert.match(view.tooltip, /Last successful check/);
    assert.equal(view.awayScore, '0', 'last known score survives a temporary outage');
    await saveSports('side-light-sports-delayed-fixture');
    await showSports({ game: null, updatedAt: null, error: 'Offline' });
    view = await scoreView(); assert.equal(view.state, 'Unavailable'); assert.equal(view.matchHidden, true);
    assert.equal(view.empty, 'Golden State Warriors'); assert.equal(view.updated, 'Unable to connect · retrying');
    await showSports({ game: null, refreshing: true, updatedAt: null });
    view = await scoreView(); assert.equal(view.state, 'Checking scores'); assert.equal(view.refreshing, 'true');
    await showSports({ game: null });
    view = await scoreView(); assert.equal(view.state, 'No game scheduled');
    await showSports({}, { state: 'off' });
    view = await scoreView(); assert.equal(view.hidden, false); assert.equal(view.orbHidden, true, 'card stays usable while idle lights are off');
    await showSports({}, { state: 'off', visible: false });
    assert.equal((await scoreView()).hidden, true, 'screenshot suspension hides the sports card');
    await showSports({ enabled: false });
    assert.equal((await scoreView()).hidden, true);

    await showSports({}, { menuOpen: true });
    await window.webContents.executeJavaScript(`document.querySelectorAll('#quickActions button')[2].focus();`);
    await showSports({ game: { ...game, away: { ...game.away, score: 2 } } }, { menuOpen: true });
    assert.equal(await window.webContents.executeJavaScript(`document.activeElement.getAttribute('aria-keyshortcuts')`), '3', 'new score does not steal keyboard focus from an open menu');
    await pause(180); // Wait for the existing menu entrance translation to settle.
    const combined = await window.webContents.executeJavaScript(`(() => {
      const menu = document.getElementById('quickMenu').getBoundingClientRect(), card = document.getElementById('sportsCard').getBoundingClientRect();
      return { menuBottom: menu.bottom, cardTop: card.top };
    })()`);
    assert.ok(combined.menuBottom + 8 <= combined.cardTop, 'menu and card never overlap');
    await saveSports('side-light-sports-menu-fixture');
    await showSports();
    const refreshBefore = actions.filter(action => action.type === 'sports-refresh').length;
    await window.webContents.executeJavaScript(`document.getElementById('refreshSports').click();`); await pause(30);
    assert.equal(actions.filter(action => action.type === 'sports-refresh').length, refreshBefore + 1);
    await showSports({ refreshing: true });
    await window.webContents.executeJavaScript(`document.getElementById('refreshSports').click();`); await pause(30);
    assert.equal(actions.filter(action => action.type === 'sports-refresh').length, refreshBefore + 1, 'pending request prevents duplicate refresh clicks');
    await showSports({ teamName: '<img src=x onerror=alert(1)>', game: null, error: '<b>unavailable</b>' });
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('#sportsCard img, #sportsCard b').length`), 0, 'provider text never becomes markup');

    // Chromium's actual input path exercises pointer capture and synthesized
    // clicks. This fixture acknowledges explicit controller outcomes; native
    // cursor geometry and snap decisions are tested separately in unit tests.
    await showSports();
    let fixtureOffset = 0, fixtureCollapsed = false, fixtureStartCollapsed = false;
    let fixtureMoveOffset = 0, fixtureEndCollapsed = false;
    let fixtureWidth = 292, fixtureHeight = sportsViewportHeight;
    const sendPresentation = (collapsed, offset, dragging) => {
      fixtureCollapsed = collapsed;
      fixtureOffset = offset;
      snapshot = { ...snapshot,
        geometry: overlayGeometry(fixtureWidth, fixtureHeight, 'small', true, offset),
        sportsPresentation: { collapsed, offset, dragging } };
      window.webContents.send('status-overlay-snapshot', snapshot);
    };
    sportsGestureFixture = action => {
      if (action.type === 'sports-drag-start') {
        fixtureStartCollapsed = fixtureCollapsed;
        sendPresentation(fixtureCollapsed, fixtureOffset, true);
      } else if (action.type === 'sports-drag-move') {
        sendPresentation(fixtureCollapsed, fixtureMoveOffset, true);
      } else if (action.type === 'sports-drag-end') {
        sendPresentation(fixtureEndCollapsed, fixtureEndCollapsed ? sportsMaxOffset : 0, false);
      } else if (action.type === 'sports-drag-cancel') {
        sendPresentation(fixtureStartCollapsed, fixtureStartCollapsed ? sportsMaxOffset : 0, false);
      } else if (action.type === 'sports-toggle') {
        sendPresentation(!fixtureCollapsed, fixtureCollapsed ? 0 : sportsMaxOffset, false);
      } else if (action.type === 'sports-set-collapsed') {
        sendPresentation(action.collapsed, action.collapsed ? sportsMaxOffset : 0, false);
      }
    };
    const input = async event => { window.webContents.sendInputEvent(event); await pause(40); };
    const inputKey = async (keyCode, modifiers = []) => {
      await input({ type: 'keyDown', keyCode, modifiers });
      if (keyCode === 'Enter' || keyCode === 'Space') await input({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : ' ', modifiers });
      await input({ type: 'keyUp', keyCode, modifiers });
    };
    const handleState = () => window.webContents.executeJavaScript(`(() => {
      const handle = document.getElementById('sportsHandle'), card = document.getElementById('sportsCard'), content = document.getElementById('sportsContent');
      const rect = handle.getBoundingClientRect(), cardRect = card.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { expanded: handle.getAttribute('aria-expanded'), hidden: handle.hidden, cardHidden: card.hidden,
        cardInert: card.inert, contentHidden: content.hidden, contentInert: content.inert, focused: document.activeElement?.id,
        nested: card.contains(handle), insideCard: rect.left >= cardRect.left && rect.right <= cardRect.right && rect.top >= cardRect.top && rect.bottom <= cardRect.bottom,
        reachable: hit === handle || handle.contains(hit),
        x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`);
    const counts = () => Object.fromEntries(['sports-toggle', 'sports-set-collapsed', 'sports-drag-start', 'sports-drag-move', 'sports-drag-end', 'sports-drag-cancel', 'close'].map(type => [type, actions.filter(action => action.type === type).length]));
    const handlePoint = async () => {
      const view = await handleState();
      return { x: Math.round(view.x + view.width / 2), y: Math.round(view.y + view.height / 2) };
    };
    const pointerDown = async () => {
      const point = await handlePoint();
      await input({ type: 'mouseMove', ...point });
      await input({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      return point;
    };
    const pointerUp = point => input({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    const movePointer = point => input({ type: 'mouseMove', modifiers: ['leftButtonDown'], ...point });
    const resetHandle = async (collapsed = false) => {
      await showSports();
      sendPresentation(collapsed, collapsed ? sportsMaxOffset : 0, false);
      fixtureEndCollapsed = collapsed;
      fixtureMoveOffset = collapsed ? sportsMaxOffset : 0;
      await pause(50);
    };

    await resetHandle();
    const expandedHandle = await handleState();
    assert.ok(expandedHandle.nested && expandedHandle.insideCard && expandedHandle.reachable, 'the grip is a reachable part of the card, with no detached tab: ' + JSON.stringify(expandedHandle));
    assert.equal(expandedHandle.contentHidden, false); assert.equal(expandedHandle.contentInert, false);
    let beforeGesture = counts();
    let point = await pointerDown(); await pointerUp(point);
    assert.equal(counts()['sports-toggle'], beforeGesture['sports-toggle'] + 1, 'one pointer click tucks the card exactly once');
    assert.equal((await handleState()).expanded, 'false');
    assert.equal((await handleState()).hidden, false, 'tucked handle remains available');
    const tucked = await handleState();
    assert.equal(tucked.cardHidden, false, 'the top strip of the tucked card remains visible');
    assert.equal(tucked.cardInert, false, 'the internal grip stays interactive while tucked');
    assert.equal(tucked.contentHidden, true, 'tucked score content is hidden');
    assert.equal(tucked.contentInert, true, 'offscreen score controls cannot receive keyboard focus');
    assert.ok(tucked.insideCard && tucked.reachable, 'the tucked internal grip remains usable');
    assert.equal(snapshot.geometry.sportsVisible.height, sportsGeometry.sportsHandle.height, 'tucking leaves exactly the card top strip visible');
    await saveSports('side-light-sports-tucked-fixture');
    beforeGesture = counts();
    await inputKey('Enter');
    assert.equal(counts()['sports-toggle'], beforeGesture['sports-toggle'] + 1, 'Enter restores the focused handle once');
    assert.equal((await handleState()).expanded, 'true');
    await inputKey('Down'); assert.equal((await handleState()).expanded, 'false', 'ArrowDown tucks scores');
    await inputKey('Up'); assert.equal((await handleState()).expanded, 'true', 'ArrowUp reveals scores');
    beforeGesture = counts(); await inputKey('Space');
    assert.equal(counts()['sports-toggle'], beforeGesture['sports-toggle'] + 1, 'Space toggles the focused handle once');
    assert.equal((await handleState()).expanded, 'false');
    await inputKey('Tab');
    assert.ok(!['sportsSettings', 'refreshSports'].includes((await handleState()).focused), 'Tab never enters tucked score content');
    await window.webContents.executeJavaScript(`document.getElementById('sportsHandle').focus();`);
    await inputKey('Up'); await inputKey('Tab');
    assert.ok(['sportsSettings', 'refreshSports'].includes((await handleState()).focused), 'expanded score controls return to the tab order');

    for (const [startCollapsed, delta, endCollapsed] of [[false, 60, true], [true, -60, false], [false, 8, false]]) {
      await resetHandle(startCollapsed);
      beforeGesture = counts();
      point = await pointerDown();
      fixtureMoveOffset = startCollapsed ? sportsMaxOffset + delta : delta;
      fixtureEndCollapsed = endCollapsed;
      const end = { x: point.x, y: point.y + delta };
      await movePointer(end);
      const movingHandle = await handleState();
      assert.ok(movingHandle.y > 0 && movingHandle.y + movingHandle.height <= fixtureHeight, 'dragged handle stays inside the overlay');
      await pointerUp(end);
      assert.equal(counts()['sports-drag-start'], beforeGesture['sports-drag-start'] + 1);
      assert.ok(counts()['sports-drag-move'] > beforeGesture['sports-drag-move']);
      assert.equal(counts()['sports-drag-end'], beforeGesture['sports-drag-end'] + 1);
      assert.equal(counts()['sports-toggle'], beforeGesture['sports-toggle'], 'the browser click after a drag must not toggle the settled result');
      assert.equal((await handleState()).expanded, String(!endCollapsed));
    }

    await window.webContents.executeJavaScript(`document.getElementById('sportsHandle').addEventListener('pointerdown', event => { window.__handlePointerId = event.pointerId; });`);
    for (const reason of ['Escape', 'blur', 'lost-capture', 'hidden', 'disabled', 'resize']) {
      await resetHandle();
      beforeGesture = counts(); point = await pointerDown();
      fixtureMoveOffset = 36;
      const end = { x: point.x, y: point.y + 36 };
      await movePointer(end);
      if (reason === 'Escape') await inputKey('Escape');
      else if (reason === 'blur') await window.webContents.executeJavaScript(`window.dispatchEvent(new Event('blur'));`);
      else if (reason === 'lost-capture') await window.webContents.executeJavaScript(`document.getElementById('sportsHandle').releasePointerCapture(window.__handlePointerId);`);
      else {
        snapshot = { ...snapshot, sportsPresentation: { collapsed: false, dragging: false, offset: 0 } };
        if (reason === 'hidden') snapshot = { ...snapshot, visible: false };
        if (reason === 'disabled') snapshot = { ...snapshot, sports: { ...snapshot.sports, enabled: false } };
        if (reason === 'resize') {
          fixtureWidth = 280;
          window.setSize(fixtureWidth, fixtureHeight);
          snapshot = { ...snapshot, geometry: overlayGeometry(fixtureWidth, fixtureHeight, 'small', true) };
        }
        window.webContents.send('status-overlay-snapshot', snapshot);
      }
      await pause(60); await pointerUp(end);
      if (['Escape', 'blur', 'lost-capture'].includes(reason)) assert.ok(counts()['sports-drag-cancel'] > beforeGesture['sports-drag-cancel'], reason + ' notifies the controller to cancel the pending gesture');
      assert.equal(await window.webContents.executeJavaScript(`document.getElementById('sportsHandle').hasPointerCapture(window.__handlePointerId)`), false, reason + ' releases pointer capture');
      assert.equal(counts()['sports-drag-end'], beforeGesture['sports-drag-end'], reason + ' rejects the late pointer-up rather than settling an obsolete gesture');
      assert.equal(counts()['sports-toggle'], beforeGesture['sports-toggle'], reason + ' cannot leave a delayed click that changes the tucked state');
      if (reason === 'Escape') assert.equal(counts().close, beforeGesture.close, 'gesture Escape is consumed before menu dismissal');
      fixtureWidth = 292; window.setSize(fixtureWidth, fixtureHeight);
    }

    await resetHandle();
    beforeGesture = counts(); point = await pointerDown();
    fixtureMoveOffset = 40; fixtureEndCollapsed = true;
    await movePointer({ x: point.x, y: point.y + 40 });
    snapshot = { ...snapshot, sports: { ...snapshot.sports, game: { ...game, away: { ...game.away, score: 8 } } } };
    window.webContents.send('status-overlay-snapshot', snapshot); await pause(40);
    assert.equal(counts()['sports-drag-cancel'], beforeGesture['sports-drag-cancel'], 'a live score update does not interrupt dragging');
    await pointerUp({ x: point.x, y: point.y + 40 });
    await resetHandle();
    await showSports({}, { reducedMotion: true });
    const handleMotion = await window.webContents.executeJavaScript(`({ handle: getComputedStyle(document.getElementById('sportsHandle')).transitionDuration, card: getComputedStyle(document.getElementById('sportsCard')).transitionDuration })`);
    assert.deepEqual(handleMotion, { handle: '0s', card: '0s' }, 'reduced motion keeps the drag handle and card free from motion transitions');
    const settingsBefore = actions.filter(action => action.type === 'sports-settings').length;
    await window.webContents.executeJavaScript(`document.getElementById('sportsSettings').click();`); await pause(40);
    assert.equal(actions.filter(action => action.type === 'sports-settings').length, settingsBefore + 1, 'the gear opens the exact scores settings through the restricted preload');
    sportsGestureFixture = null;
    await showSports({}, { geometry: overlayGeometry(292, sportsViewportHeight, 'small', false) });
    assert.equal((await handleState()).hidden, true, 'live-only non-game state hides the handle as well as the card');
    assert.equal((await scoreView()).hidden, true);

    for (const [width, height] of [[180, 260], [128, 128]]) {
      window.setSize(width, height);
      const geometry = overlayGeometry(width, height, 'small', true);
      await showSports({}, { geometry });
      view = await scoreView();
      assert.ok(view.x >= 0 && view.y >= 0 && view.x + view.width <= width && view.y + view.height <= height, 'narrow-screen score card stays in its native hit rectangle');
      const contained = await window.webContents.executeJavaScript(`(() => {
        const card = document.getElementById('sportsCard').getBoundingClientRect();
        return { clipped: getComputedStyle(document.getElementById('sportsCard')).overflow === 'hidden', buttons: [...document.querySelectorAll('.sports-controls button')].map(button => {
          const box = button.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return { id: button.id, left: box.left, right: box.right, cardLeft: card.left, cardRight: card.right, inside: box.left >= card.left && box.right <= card.right, reachable: hit === button || button.contains(hit) };
        }) };
      })()`);
      assert.ok(contained.clipped && contained.buttons.length === 2 && contained.buttons.every(button => button.inside && button.reachable), 'narrow card keeps both controls reachable and clips text within the hit target: ' + JSON.stringify(contained));
      const narrowHandle = await handleState();
      assert.ok(narrowHandle.x >= 0 && narrowHandle.y >= 0 && narrowHandle.x + narrowHandle.width <= width && narrowHandle.y + narrowHandle.height <= height, 'narrow-screen drag handle stays inside the native work area');
      assert.ok(narrowHandle.nested && narrowHandle.insideCard && narrowHandle.reachable, 'narrow-screen grip stays within the card and reachable');
      const narrowMaxOffset = geometry.sportsMaxOffset ?? geometry.sports.height - geometry.sportsHandle.height;
      const tuckedGeometry = overlayGeometry(width, height, 'small', true, narrowMaxOffset);
      await showSports({}, { geometry: tuckedGeometry, sportsPresentation: { collapsed: true, dragging: false, offset: narrowMaxOffset } });
      const tuckedHandle = await handleState();
      assert.equal(tuckedHandle.hidden, false);
      assert.equal(tuckedHandle.expanded, 'false');
      assert.equal(tuckedHandle.cardHidden, false); assert.equal(tuckedHandle.cardInert, false);
      assert.equal(tuckedHandle.contentHidden, true); assert.equal(tuckedHandle.contentInert, true);
      assert.ok(tuckedHandle.insideCard && tuckedHandle.reachable);
      assert.equal(tuckedGeometry.sportsVisible.height, geometry.sportsHandle.height);
      assert.equal(tuckedHandle.y + tuckedHandle.height, height - 6, 'a small screen always retains a usable pull-up handle at its edge');
    }
    assert.ok(trustedSenders.every(Boolean), 'sports refresh uses the isolated trusted preload too');
    // The production timer renderer reads static deadline snapshots locally.
    // A disposable clock and timeout observer verify it sleeps when not shown.
    window.setSize(292, 662);
    await window.webContents.executeJavaScript(`window.__originalTimerClock = Date.now;
      window.__timerNow = Date.now(); Date.now = () => window.__timerNow;
      window.__originalSetTimeout = window.setTimeout; window.__originalClearTimeout = window.clearTimeout;
      window.__pendingTimerTimeouts = new Set();
      window.setTimeout = (callback, delay, ...args) => {
        const id = window.__originalSetTimeout(() => { window.__pendingTimerTimeouts.delete(id); callback(...args); }, delay);
        window.__pendingTimerTimeouts.add(id); return id;
      };
      window.clearTimeout = id => { window.__pendingTimerTimeouts.delete(id); window.__originalClearTimeout(id); }; void 0;`);
    const timerNow = await window.webContents.executeJavaScript('Date.now()');
    const timers = { enabled: true, total: 7, timers: [
      { id: 'focus', label: 'Focus', kind: 'timer', endTime: timerNow + 25000, ringing: false, paused: false },
      { id: 'tea', label: 'Tea', kind: 'timer', endTime: timerNow + 61000, ringing: false, paused: false },
      { id: 'reminder', label: 'Send the project notes before the meeting', kind: 'reminder', endTime: timerNow + 302000, ringing: false, paused: false },
      { id: 'alarm', label: 'Afternoon break', kind: 'alarm', endTime: timerNow + 3603000, ringing: false, paused: false },
      { id: 'paused', label: '<img src=x onerror=alert(1)>', kind: 'timer', endTime: timerNow - 10000, ringing: false, paused: true, remainingMs: 124000 }
    ] };
    const showTimers = async (mode = 'compact', fields = {}) => {
      snapshot = { ...snapshot, state: 'idle', visible: true, menuOpen: false,
        companion: { selected: 'timers', hasSports: true, hasTimers: true }, timers,
        geometry: overlayGeometry(292, 662, 'small', false, 0, { mode, count: 5 }),
        timerPresentation: { mode, dragging: false, offset: 0 }, ...fields };
      window.webContents.send('status-overlay-snapshot', snapshot); await pause(40);
    };
    const timerView = () => window.webContents.executeJavaScript(`(() => {
      const card = document.getElementById('timerCard'), content = document.getElementById('timerContent'), grip = document.getElementById('timerHandle');
      const rect = card.getBoundingClientRect(), handle = grip.getBoundingClientRect();
      return { hidden: card.hidden, sportsHidden: document.getElementById('sportsCard').hidden,
        contentHidden: content.hidden, contentInert: content.inert, gripHidden: grip.hidden,
        geometry: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        gripInside: handle.x >= rect.x && handle.right <= rect.right && handle.y >= rect.y && handle.bottom <= rect.bottom,
        grip: { x: handle.x, y: handle.y, width: handle.width, height: handle.height },
        rows: [...document.querySelectorAll('.overlay-timer')].map(row => ({ label: row.querySelector('.overlay-timer-label').textContent, time: row.querySelector('.overlay-timer-time').textContent, status: row.querySelector('.overlay-timer-status').textContent })),
        timeouts: window.__pendingTimerTimeouts.size, title: document.getElementById('timerHeading').getAttribute('aria-label'),
        listOverflow: document.getElementById('overlayTimers').scrollHeight > document.getElementById('overlayTimers').clientHeight,
        unwantedMarkup: card.querySelectorAll('img').length };
    })()`);
    await showTimers();
    let timerState = await timerView();
    assert.equal(timerState.hidden, false); assert.equal(timerState.sportsHidden, true, 'one companion card is painted at a time');
    assert.deepEqual(timerState.geometry, snapshot.geometry.timers);
    assert.equal(timerState.geometry.height, 96); assert.equal(timerState.rows.length, 1);
    assert.equal(timerState.rows[0].time, '00:25'); assert.equal(timerState.timeouts, 1);
    await window.webContents.executeJavaScript('window.__timerNow += 1100;'); await pause(1100);
    assert.equal((await timerView()).rows[0].time, '00:24', 'visible timer counts down without another IPC snapshot');
    await showTimers('expanded'); timerState = await timerView();
    assert.deepEqual(timerState.geometry, snapshot.geometry.timers);
    assert.equal(timerState.rows.length, 5); assert.equal(timerState.listOverflow, false, 'all five timer rows fit the expanded card');
    assert.equal(timerState.rows[4].time, '02:04'); assert.equal(timerState.rows[4].status, 'Paused', 'stale paused deadlines never appear finished');
    assert.equal(timerState.unwantedMarkup, 0); assert.match(timerState.title, /all 7 timers/);
    assert.equal(timerState.timeouts, 1, 'all five displayed timers use one timeout');
    await window.webContents.executeJavaScript(`document.getElementById('timerSettings').click(); document.getElementById('timerHeading').click(); document.getElementById('showSportsCard').click(); window.olangaSideLight.selectCompanion('invalid'); window.olangaSideLight.setTimerMode('invalid');`);
    await pause(40);
    assert.ok(actions.some(action => action.type === 'timers-settings'));
    assert.ok(actions.some(action => action.type === 'timers-open'));
    assert.ok(actions.some(action => action.type === 'companion-select' && action.card === 'sports'));
    assert.ok(!actions.some(action => action.card === 'invalid' || action.mode === 'invalid'));
    const cleanTimers = { ...timers, total: 5, timers: timers.timers.map(timer => timer.id === 'paused' ? { ...timer, label: 'Stretch break' } : timer) };
    await showTimers('expanded', { timers: cleanTimers });
    fs.writeFileSync(path.join(output, 'side-light-timers-expanded-fixture.png'), (await window.webContents.capturePage({ x: 0, y: 350, width: 292, height: 312 })).toPNG());
    await showTimers('compact');
    fs.writeFileSync(path.join(output, 'side-light-timers-compact-fixture.png'), (await window.webContents.capturePage({ x: 0, y: 546, width: 292, height: 116 })).toPNG());
    await showTimers('tucked'); timerState = await timerView();
    assert.deepEqual(timerState.geometry, snapshot.geometry.timers, 'tucked padding never expands the native hit rectangle');
    assert.ok(!timerState.hidden && timerState.contentHidden && timerState.contentInert && !timerState.gripHidden && timerState.gripInside);
    assert.equal(timerState.timeouts, 0, 'tucked timers sleep');
    fs.writeFileSync(path.join(output, 'side-light-timers-tucked-fixture.png'), (await window.webContents.capturePage({ x: 0, y: 610, width: 292, height: 52 })).toPNG());
    await window.webContents.executeJavaScript(`document.getElementById('timerHandle').click(); document.getElementById('timerHandle').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowUp', bubbles:true}));`); await pause(30);
    assert.ok(actions.some(action => action.type === 'timers-toggle-mode'));
    assert.ok(actions.some(action => action.type === 'timers-set-mode' && action.mode === 'compact'));
    await showTimers('expanded');
    const timerTogglesBefore = actions.filter(action => action.type === 'timers-toggle-mode').length;
    let timerFixtureMode = 'expanded';
    const sendTimerMode = (mode, dragging = false, dragHeight) => {
      timerFixtureMode = mode;
      snapshot = { ...snapshot, geometry: overlayGeometry(292, 662, 'small', false, 0, { mode, count: 5, dragHeight }), timerPresentation: { mode, dragging, offset: 0 } };
      window.webContents.send('status-overlay-snapshot', snapshot);
    };
    sportsGestureFixture = action => {
      if (action.type === 'timers-drag-start') sendTimerMode(timerFixtureMode, true);
      if (action.type === 'timers-drag-move') sendTimerMode(timerFixtureMode, true, 248);
      if (action.type === 'timers-drag-end') sendTimerMode('compact');
      if (action.type === 'timers-toggle-mode') sendTimerMode(({ expanded: 'compact', compact: 'tucked', tucked: 'expanded' })[timerFixtureMode]);
      if (action.type === 'timers-set-mode') sendTimerMode(action.mode);
    };
    const timerGrip = (await timerView()).grip;
    const timerPoint = { x: Math.round(timerGrip.x + timerGrip.width / 2), y: Math.round(timerGrip.y + timerGrip.height / 2) };
    await input({ type: 'mouseMove', ...timerPoint });
    await input({ type: 'mouseDown', button: 'left', clickCount: 1, ...timerPoint });
    await movePointer({ x: timerPoint.x, y: timerPoint.y + 40 });
    await input({ type: 'mouseUp', button: 'left', clickCount: 1, x: timerPoint.x, y: timerPoint.y + 40 });
    assert.equal(timerFixtureMode, 'compact');
    assert.equal(actions.filter(action => action.type === 'timers-toggle-mode').length, timerTogglesBefore, 'a drag settles one mode without an extra click');
    assert.ok(actions.some(action => action.type === 'timers-drag-start') && actions.some(action => action.type === 'timers-drag-move') && actions.some(action => action.type === 'timers-drag-end'));
    await inputKey('Down'); assert.equal(timerFixtureMode, 'tucked');
    await inputKey('Enter'); assert.equal(timerFixtureMode, 'expanded', 'the tucked grip expands with Enter');
    await inputKey('Space'); assert.equal(timerFixtureMode, 'compact', 'Space cycles the focused grip once');
    sportsGestureFixture = null;
    await showTimers('compact', { visible: false });
    assert.equal((await timerView()).timeouts, 0); assert.equal((await timerView()).hidden, true);
    await showTimers('compact', { timers: { enabled: true, timers: [], total: 0 } });
    assert.equal((await timerView()).hidden, true); assert.equal((await timerView()).gripHidden, true);
    await showTimers('compact', { timers: { ...timers, enabled: false } });
    assert.equal((await timerView()).hidden, true);
    await showTimers();
    await window.webContents.executeJavaScript(`document.getElementById('showSportsCard').focus();`);
    await showSports({}, { geometry: overlayGeometry(292, 662, 'small', true), companion: { selected: 'sports', hasSports: true, hasTimers: true } });
    assert.equal((await timerView()).hidden, true); assert.equal((await timerView()).timeouts, 0);
    assert.equal(await window.webContents.executeJavaScript(`document.getElementById('showTimerCard').hidden`), false);
    assert.equal(await window.webContents.executeJavaScript(`document.activeElement.id`), 'showTimerCard', 'switching preserves keyboard focus in the replacement card');
    await window.webContents.executeJavaScript(`document.getElementById('showTimerCard').click();`); await pause(30);
    assert.ok(actions.some(action => action.type === 'companion-select' && action.card === 'timers'));
    await showTimers('compact', { timers: { enabled: true, total: 1, timers: [{ ...timers.timers[0], ringing: true }] } });
    timerState = await timerView(); assert.equal(timerState.rows[0].time, '00:00'); assert.equal(timerState.rows[0].status, 'Finished'); assert.equal(timerState.timeouts, 0);
    for (const [width, height] of [[292, 662], [128, 128]]) {
      window.setSize(width, height);
      await showTimers('compact', { timers: { enabled: true, total: 1, timers: [{ ...timers.timers[0], endTime: 8.64e15 }] }, geometry: overlayGeometry(width, height, 'small', false, 0, { mode: 'compact', count: 1 }) });
      const longTime = await window.webContents.executeJavaScript(`(() => { const time = document.querySelector('.overlay-timer-time'), row = document.querySelector('.overlay-timer-reading'); return { long: time.classList.contains('long-duration'), fullTitle: time.title === time.textContent, fits: row.scrollWidth <= row.clientWidth }; })()`);
      assert.ok(longTime.long && longTime.fullTitle && longTime.fits, 'maximum supported duration stays within the card with the full value in its title');
      await showTimers('tucked', { geometry: overlayGeometry(width, height, 'small', false, 0, { mode: 'tucked', count: 5 }) });
      timerState = await timerView();
      assert.deepEqual(timerState.geometry, snapshot.geometry.timers); assert.ok(timerState.gripInside);
    }
    window.setSize(292, 662);
    await showTimers('compact', { visible: false });
    await window.webContents.executeJavaScript(`Date.now = window.__originalTimerClock; window.setTimeout = window.__originalSetTimeout; window.clearTimeout = window.__originalClearTimeout; void 0;`);
    assert.deepEqual(errors, []);
    console.log('Overlay smoke passed: isolated session, trusted actions, existing orb hide choices, sports states and real pointer gestures; timers expanded/compact/tucked, one visible card, local countdown, one visible-only timeout, paused/finished states, empty/disabled handling, escaped labels, maximum duration, switching focus, settings/open IPC, pointer drag and keyboard mode changes; fixture screenshots.');
    app.exit(0);
  } catch (error) {
    console.error('Overlay smoke failed:', error.stack || error.message);
    app.exit(1);
  }
});
setTimeout(() => { console.error('Overlay smoke timed out'); app.exit(1); }, 60000).unref();
