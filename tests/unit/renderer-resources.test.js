const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  let now = 12500, sequence = 0, nativeListener, initialReply, observer;
  const frames = new Map(), timers = new Map(), listeners = new Map(), elements = new Map();
  const classes = () => {
    const values = new Set();
    return { add: (...items) => items.forEach(item => values.add(item)), remove: (...items) => items.forEach(item => values.delete(item)), contains: item => values.has(item), toggle(item, enabled) { if (enabled) values.add(item); else values.delete(item); } };
  };
  const node = id => {
    if (!elements.has(id)) elements.set(id, { classList: classes(), textContent: '', width: 160, height: 160 });
    return elements.get(id);
  };
  const drawing = { frames: 0, clearRect() { this.frames++; }, beginPath() {}, arc() {}, fill() {}, stroke() {} };
  const media = { matches: false, addEventListener(_name, fn) { this.change = fn; }, removeEventListener() {} };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, Date: Clock, performance: { now: () => now },
    OlangaPrefs: { DEFAULT_NVIDIA_VOICE: 'default', END_OF_SPEECH_MS: {}, load: () => ({}), writeToStorage() {} },
    localStorage: { getItem: () => null },
    document: { hidden: false, body: { classList: classes() }, getElementById: node, querySelectorAll: () => [], querySelector: () => null, addEventListener: (name, fn) => listeners.set(`document:${name}`, fn) },
    window: {
      speechSynthesis: { cancel() {} }, matchMedia: () => media,
      addEventListener: (name, fn) => listeners.set(`window:${name}`, fn),
      electronAPI: { onAppVisibilityChanged: fn => { nativeListener = fn; }, getAppVisibility: () => new Promise(resolve => { initialReply = resolve; }) }
    },
    IntersectionObserver: class { constructor(fn) { observer = this; this.notify = fn; } observe() {} disconnect() { this.disconnected = true; } },
    requestAnimationFrame: fn => { const id = ++sequence; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/core.js'), 'utf8'), context);
  context.drawing = drawing;
  vm.runInContext('orbCanvasCtx = drawing;', context);
  return { context, drawing, frames, timers, listeners, media, node,
    run: source => vm.runInContext(source, context),
    native: visible => nativeListener({ visible }), reply: value => initialReply(value),
    intersect: visible => observer.notify([{ isIntersecting: visible }]),
    setTime: value => { now = value; }
  };
}

test('orb draws only visible listening/speaking frames and resumes after native show and intersection changes', () => {
  const f = fixture();
  f.run('startOrbAnimation()');
  assert.equal(f.drawing.frames, 0, 'the idle canvas is transparent');
  assert.equal(f.frames.size, 0);
  f.run('setState(State.LISTENING)');
  assert.equal(f.frames.size, 1);
  f.native(false);
  assert.equal(f.frames.size, 0, 'tray mode stops drawing without changing voice state');
  assert.equal(f.run('currentState'), 'listening');
  assert.equal(f.context.document.body.classList.contains('app-visuals-paused'), true);
  f.native(true);
  assert.equal(f.frames.size, 1);
  f.intersect(false);
  assert.equal(f.frames.size, 0, 'offscreen canvas sleeps');
  f.intersect(true);
  assert.equal(f.frames.size, 1);
  f.run('setState(State.THINKING)');
  assert.equal(f.frames.size, 0, 'thinking also has a transparent canvas');
  f.run('setState(State.SPEAKING); startOrbAnimation(); startOrbAnimation()');
  assert.equal(f.frames.size, 1, 'reinitialization cannot accumulate loops');
  f.listeners.get('window:beforeunload')();
  assert.equal(f.frames.size, 0);
});

test('orb respects live reduced-motion changes without removing its static visible texture', () => {
  const f = fixture();
  f.media.matches = true;
  f.run('startOrbAnimation(); setState(State.LISTENING)');
  assert.equal(f.drawing.frames, 1);
  assert.equal(f.frames.size, 0);
  f.media.matches = false;
  f.media.change();
  assert.equal(f.frames.size, 1);
  f.media.matches = true;
  f.media.change();
  assert.equal(f.frames.size, 0);
});

test('late initial visibility replies cannot restart hidden rendering', async () => {
  const f = fixture();
  f.native(false);
  f.reply({ visible: true });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.context.window.OlangaVisibility.isVisible(), false);
  f.native(true);
  assert.equal(f.context.window.OlangaVisibility.isVisible(), true);
  f.context.document.hidden = true;
  f.listeners.get('document:visibilitychange')();
  assert.equal(f.context.window.OlangaVisibility.isVisible(), false);
});

test('clock sleeps until the next minute and refreshes immediately after a native restore', () => {
  const f = fixture();
  f.run('startClock(); startClock()');
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 47525);
  const before = f.node('clockDisplay').textContent;
  f.native(false);
  assert.equal(f.timers.size, 0);
  f.setTime(72500);
  f.native(true);
  assert.notEqual(f.node('clockDisplay').textContent, before);
  assert.equal(f.timers.size, 1);
  f.listeners.get('window:beforeunload')();
  assert.equal(f.timers.size, 0);
});
