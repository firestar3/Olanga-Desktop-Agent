const test = require('node:test');
const assert = require('node:assert/strict');
const workflows = require('../../js/desktop-workflows');

const proposal = (overrides = {}) => ({
  status: 'ready', summary: 'Replace selected editor text', observation: 'The paragraph is selected.',
  expectedOutcome: 'The editor contains the new paragraph.', followUp: '',
  steps: [{ type: 'type', text: 'A clearer paragraph.' }], ...overrides
});
const parse = data => workflows.parsePlan(JSON.stringify(data));

test('accepts bounded typed plans and preserves source code as literal text', () => {
  const code = 'function add(a, b) {\n  return a + b;\n}';
  const parsed = parse(proposal({ steps: [{ type: 'type', text: code }] }));
  assert.equal(parsed.steps[0].text, code);
  assert.equal(parsed.status, 'ready');
});

test('accepts a single JSON fence, but not prose or multiple plans', () => {
  assert.equal(workflows.parsePlan('```json\n' + JSON.stringify(proposal()) + '\n```').status, 'ready');
  assert.throws(() => workflows.parsePlan('Here is a plan: ' + JSON.stringify(proposal())), /could not read/);
  assert.throws(() => workflows.parsePlan(JSON.stringify(proposal()) + JSON.stringify(proposal())), /could not read/);
});

test('normalizes click defaults and joined shortcut names before review without widening actions', () => {
  const result = parse(proposal({steps:[{type:'click',x:0.5,y:0.5},{type:'hotkey',keys:['CTRL+HOME']}]}));
  assert.deepEqual(result.steps,[{type:'click',x:0.5,y:0.5,button:'left',count:1},{type:'hotkey',keys:['CTRL','HOME']}]);
  assert.throws(()=>parse(proposal({steps:[{type:'click',x:0.5,y:0.5,button:'middle'}]})));
  assert.throws(()=>parse(proposal({steps:[{type:'hotkey',keys:['CTRL++A']}]})));
});

test('rejects unsupported executable actions and hidden action fields', () => {
  assert.throws(() => parse(proposal({ steps: [{ type: 'shell', command: 'anything' }] })), /unsupported/);
  assert.throws(() => parse(proposal({ steps: [{ type: 'type', text: 'Hi', script: 'hidden' }] })), /unexpected fields/);
});

test('questions and completion can never carry executable steps', () => {
  assert.throws(() => parse(proposal({ status: 'needs_input' })), /no steps/);
  assert.throws(() => parse(proposal({ status: 'done' })), /no steps/);
  assert.equal(parse(proposal({ status: 'needs_input', followUp: 'Which folder?', steps: [] })).steps.length, 0);
  assert.throws(() => parse(proposal({ steps: [] })), /1–12/);
});

test('bounds count, total inserted text, coordinates, shortcuts and waits', () => {
  for (const steps of [
    Array.from({ length: 13 }, () => ({ type: 'wait', ms: 100 })),
    [{ type: 'type', text: 'x'.repeat(1001) }, { type: 'type', text: 'y'.repeat(1000) }],
    [{ type: 'click', x: 1.1, y: .3, count: 1, button: 'left' }],
    [{ type: 'hotkey', keys: ['CTRL', 'A; anything'] }],
    [{ type: 'wait', ms: 999999 }]
  ]) assert.throws(() => parse(proposal({ steps })));
});

test('planner is explicitly bounded by user-selected scope and untrusted screen data', () => {
  const instruction = workflows.makePlanningInstruction([['CTRL', 'A'], ['ENTER']]);
  assert.match(instruction, /user-selected editor region/);
  assert.match(instruction, /untrusted DATA/);
  assert.match(instruction, /TWO native confirmations/);
  assert.match(instruction, /CTRL\+A, ENTER/);
});

function workflowHarness() {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const nodes = [], ids = new Map(), calls = { captures: [], plans: [], prepared: [], spoken: [], listening: 0 };
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.style = {}; this.classList = { toggle() {} }; this.value = ''; this.textContent = ''; nodes.push(this); }
    set id(value) { this._id = value; ids.set(value, this); }
    get id() { return this._id; }
    setAttribute() {}
    removeAttribute() {}
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    insertAdjacentElement() {}
    addEventListener(name, fn) { this.listeners[name] = fn; }
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const wrapper = new Element('div'); wrapper.id = 'textCommandWrapper';
  const context = {
    AbortController, DOMException, console,
    document: { readyState: 'loading', addEventListener() {}, getElementById: id => ids.get(id), createElement: tag => new Element(tag), body: new Element('body') },
    apiKey: 'test', nvidiaApiKey: 'test', State: { THINKING: 'thinking', IDLE: 'idle' }, setState() {}, cancelAssistantRequest() {},
    speakResponseAndThen: (text, callback) => { calls.spoken.push(text); callback(); }, enterAiFollowUpMode: () => { calls.listening++; },
    recentConversation: () => [{ role: 'user', text: 'Create a folder' }], rememberConversationMessage() {},
    describeScreenWithGemini: async () => 'File Explorer showing Downloads.',
    callGeminiSpecialist: async (_purpose, messages) => { calls.plans.push(JSON.parse(messages[1].content[0].text)); return JSON.stringify(calls.plans.length === 1 ? proposal({ status: 'needs_input', followUp: 'What should the folder be named?', steps: [] }) : proposal({ steps: [{ type: 'hotkey', keys: ['CTRL', 'SHIFT', 'N'] }] })); }
  };
  context.window = { document: context.document, electronAPI: {
    desktopCapture: async () => { const capture = { captureId: `capture-${calls.captures.length + 1}`, imageDataUrl: 'data:image/png;base64,abc', display: { width: 1200, height: 800 }, foreground: { handle: '1' }, windows: [{ handle: '1', title: 'Downloads', processName: 'explorer' }] }; calls.captures.push(capture); return capture; },
    desktopPrepare: async plan => { calls.prepared.push(plan); return { planId: 'accepted', steps: plan.steps }; }, desktopCancel: async () => {},
    onDesktopProgress: callback => { calls.progress = callback; }
  } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/desktop-workflows.js'), 'utf8'), context);
  context.window.OlangaDesktop.open('Create a folder');
  return { api: context.window.OlangaDesktop, calls, ids, nodes, context };
}

function editHarness(verificationStatus = 'verified') {
  const h = workflowHarness(), {context,calls}=h;
  context.nvidiaApiKey = '';
  const bounds={x:0,y:0,width:1200,height:800};
  const target={handle:'1',processId:44,processName:'editor',title:'Disposable code',bounds};
  const capture={captureId:'before',imageDataUrl:'data:image/png;base64,YmVmb3Jl',display:{width:1200,height:800,physicalBounds:bounds},foreground:target,windows:[target],focusedControl:{processId:44,isEditable:true,isPassword:false,bounds:{x:100,y:100,width:800,height:500}}};
  calls.runs=[];calls.verifications=[];calls.receipts=[];
  context.window.electronAPI.desktopCapture=async()=>{calls.captures.push(capture);return capture;};
  context.window.electronAPI.desktopRun=async id=>{calls.runs.push(id);return {ok:true,completedSteps:1,totalSteps:1,verificationCapture:{...capture,capturedAt:2000,imageDataUrl:'data:image/png;base64,YWZ0ZXI='}};};
  context.callGeminiSpecialist=async (_purpose,messages)=>{
    if(messages[0].content.startsWith('Verify a Windows')) {
      calls.verifications.push(messages);
      return JSON.stringify({status:verificationStatus,observation:verificationStatus==='verified'?'The requested text is visible.':'The correction is visible, but tests were not run.',remaining:verificationStatus==='verified'?'':'Run the project tests to check runtime behavior.'});
    }
    calls.plans.push(messages);
    return JSON.stringify(proposal({observation:'The operator subtracts instead of adding.',steps:[{type:'type',text:'return a + b;'}]}));
  };
  context.composeSpecialistResponse=async (_goal,receipt)=>{calls.receipts.push(receipt);return receipt.verified?'The visible edit is verified.':'The edit is visible, but runtime correctness is not verified.';};
  context.speakResponse=text=>calls.spoken.push(text);
  return h;
}

test('screen fix diagnoses, waits for yes, runs native review and verifies a fresh image before final speech', async()=>{
  const h=editHarness();await h.api.start('Fix the bug in the editor');
  assert.equal(h.calls.prepared.length,1);
  assert.equal(h.calls.prepared[0].scope.mode,'region');
  assert.equal(h.calls.runs.length,0);
  assert.match(h.calls.spoken[0],/operator subtracts.*May I/);
  await h.api.answerQuestion('yes please');
  assert.deepEqual(h.calls.runs,['accepted']);
  assert.equal(h.calls.verifications[0][1].content[1].image_url.url,'data:image/png;base64,YWZ0ZXI=');
  assert.equal(h.calls.receipts[0].verified,true);
  assert.equal(h.calls.spoken.at(-1),'The visible edit is verified.');
});

test('uncertain verification never becomes a success receipt', async()=>{
  const h=editHarness('uncertain');await h.api.start('Fix the bug in the editor');await h.api.answerQuestion('yes');
  assert.equal(h.calls.receipts[0].verified,false);
  assert.match(h.calls.spoken.at(-1),/not verified/);
});

test('ambiguous approval and a cancelled proposal cannot execute', async()=>{
  const h=editHarness();await h.api.start('Fix the bug in the editor');
  await h.api.answerQuestion('yes and also delete everything');
  assert.equal(h.calls.runs.length,0);
  await h.api.answerQuestion('no');
  assert.equal(await h.api.answerQuestion('yes'),false);
  assert.equal(h.calls.runs.length,0);
});

test('result capture failure produces an unverified final response without invented evidence', async()=>{
  const h=editHarness();
  h.context.window.electronAPI.desktopRun=async()=>({ok:true,completedSteps:1,totalSteps:1,verificationError:'Screen changed.'});
  await h.api.start('Fix the bug in the editor');await h.api.answerQuestion('yes');
  assert.equal(h.calls.verifications.length,0);
  assert.equal(h.calls.receipts[0].verified,false);
  assert.match(h.calls.receipts[0].verification.observation,/Screen changed/);
});

test('editor inference rejects password fields, another process and clipped controls',()=>{
  const capture={display:{physicalBounds:{x:0,y:0,width:1000,height:800}},foreground:{processId:4,bounds:{x:0,y:0,width:1000,height:800}},focusedControl:{processId:4,isEditable:true,isPassword:false,bounds:{x:100,y:100,width:600,height:400}}};
  assert.deepEqual(workflows.inferEditorRegion(capture),{x:.1,y:.125,width:.6,height:.5});
  for(const override of [{isPassword:true},{isEditable:false},{processId:5},{bounds:{x:-10,y:0,width:600,height:400}}])assert.equal(workflows.inferEditorRegion({...capture,focusedControl:{...capture.focusedControl,...override}}),null);
});

test('verification cannot claim success with remaining work or empty evidence',()=>{
  assert.throws(()=>workflows.parseVerification(JSON.stringify({status:'verified',observation:'Looks edited',remaining:'Tests still needed'})),/remaining work/);
  assert.throws(()=>workflows.parseVerification(JSON.stringify({status:'verified',observation:'',remaining:''})),/evidence/);
});

test('desktop question has an answer control, keeps the answer, recaptures and requires a new plan', async () => {
  const { api, calls, ids, nodes } = workflowHarness();
  const capture = nodes.find(node => node.textContent === 'Capture screen');
  const plan = nodes.find(node => node.textContent === 'Plan within this scope');
  await capture.listeners.click();
  ids.get('desktopTaskWindow').value = '1'; ids.get('desktopTaskScope').value = 'window';
  await plan.listeners.click();
  assert.equal(api.hasPendingQuestion(), true);
  assert.deepEqual(calls.spoken, ['What should the folder be named?']);
  assert.equal(calls.listening, 1);
  assert.equal(calls.prepared.length, 0);
  const answer = ids.get('desktopTaskAnswer');
  assert.ok(answer);
  await api.answerQuestion('Receipts');
  assert.equal(api.hasPendingQuestion(), false);
  assert.equal(calls.captures.length, 2);
  assert.equal(calls.prepared.length, 0, 'answer cannot execute or prepare the previous scope');
  ids.get('desktopTaskWindow').value = '1'; ids.get('desktopTaskScope').value = 'window';
  await plan.listeners.click();
  assert.deepEqual(calls.plans[1].clarifications, [{ question: 'What should the folder be named?', answer: 'Receipts' }]);
  assert.equal(calls.prepared[0].captureId, 'capture-2');
  assert.equal(calls.prepared[0].scope.handle, '1');
});

test('cancelled desktop question does not accept a late answer or preserve its capture', async () => {
  const { api, calls, ids, nodes } = workflowHarness();
  await nodes.find(node => node.textContent === 'Capture screen').listeners.click();
  ids.get('desktopTaskWindow').value = '1'; ids.get('desktopTaskScope').value = 'window';
  await nodes.find(node => node.textContent === 'Plan within this scope').listeners.click();
  api.cancel();
  assert.equal(api.hasPendingQuestion(), false);
  assert.equal(await api.answerQuestion('Receipts'), false);
  assert.equal(calls.captures.length, 1);
  assert.equal(api.isBusy(), false);
});

test('one invalid desktop proposal can be repaired before native preparation', async () => {
  const h = editHarness(); let calls = 0;
  h.context.callGeminiSpecialist = async (_, messages) => {
    if (++calls === 1) return JSON.stringify(proposal({steps:[{type:'hotkey',keys:['CTRL','']}]}));
    assert.match(messages.at(-1).content, /SAME user goal and scope/);
    return JSON.stringify(proposal());
  };
  await h.api.start('Fix the editor bug');
  assert.equal(calls, 2); assert.equal(h.calls.prepared.length, 1); assert.equal(h.calls.runs.length, 0);
});

test('repeated invalid plans and provider failures never reach native preparation', async () => {
  for (const networkError of [false, true]) {
    const h = editHarness(); let calls = 0;
    h.context.callGeminiSpecialist = async () => { calls++; if (networkError) throw new Error('Provider unavailable'); return 'invalid JSON'; };
    await h.api.start('Fix the editor bug');
    assert.equal(calls, networkError ? 1 : 2); assert.equal(h.calls.prepared.length, 0); assert.equal(h.calls.runs.length, 0);
  }
});

test('cancellation prevents repairing a late desktop model response', async () => {
  const h = editHarness(); const controller = new AbortController(); let calls = 0;
  h.context.callGeminiSpecialist = async () => { calls++; controller.abort(); return 'invalid'; };
  await assert.rejects(h.api.requestPlan([{role:'user',content:'Fix'}], controller.signal), {name:'AbortError'});
  assert.equal(calls, 1); assert.equal(h.calls.prepared.length, 0);
});

test('local text diff identifies inserted and removed text without interpreting markup', () => {
  const diff = workflows.textDiff('A <old> paragraph.', 'A <new> paragraph.');
  assert.deepEqual(diff.before, { prefix: 'A <', changed: 'old', suffix: '> paragraph.' });
  assert.deepEqual(diff.after, { prefix: 'A <', changed: 'new', suffix: '> paragraph.' });
  assert.deepEqual(workflows.textDiff('', 'Hello').after, { prefix: '', changed: 'Hello', suffix: '' });
});

test('completed edit shows local before/after and undo without sending the checkpoint to a provider', async () => {
  const h = editHarness();
  const undo = { available: true, undoId: 'local-only', expiresAt: Date.now() + 300000, before: 'PRIVATE ORIGINAL', after: 'Delivered text', message: 'Undo available.' };
  const existing = h.context.window.electronAPI.desktopRun;
  h.context.window.electronAPI.desktopRun = async id => ({ ...await existing(id), undo });
  const undos = [];
  h.context.window.electronAPI.undoDesktopEdit = async id => { undos.push(id); return { ok: true, verified: true, message: 'The original text was restored and verified.' }; };
  await h.api.start('Fix the bug in the editor'); await h.api.answerQuestion('yes');
  assert.ok(!JSON.stringify(h.calls.receipts).includes('PRIVATE ORIGINAL'));
  assert.ok(!JSON.stringify(h.calls.verifications).includes('PRIVATE ORIGINAL'));
  const button = h.nodes.find(node => node.textContent === 'Undo text edit');
  assert.equal(button.hidden, false); assert.equal(button.disabled, false);
  await button.listeners.click();
  assert.deepEqual(undos, ['local-only']); assert.equal(button.hidden, true);
  assert.ok(h.nodes.some(node => node.textContent === 'The original text was restored and verified.'));
});

function withActivity(h, persist = true) {
  const { createStore, KEY } = require('../../shared/productivity');
  const saved = new Map();
  h.store = createStore({ getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) });
  if (persist) h.store.preference('saveActivity', true);
  h.context.window.OlangaActivity = h.store;
  h.activity = () => h.store.snapshot().activity;
  h.persisted = () => JSON.parse(saved.get(KEY));
  return h;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
test('desktop activity starts on capture, waits for approval, and completes only after post-edit verification', async () => {
  const h = withActivity(editHarness());
  assert.deepEqual(h.activity(), [], 'merely opening the workspace starts no task');
  await h.api.start('PRIVATE GOAL: fix the editor');
  let entry = h.activity()[0];
  const id = entry.id;
  assert.equal(entry.state, 'awaiting-input');
  assert.deepEqual(entry.steps.map(step => [step.operation, step.state]), [['DESKTOP_CAPTURE', 'completed'], ['DESKTOP_PLAN', 'completed']]);
  const native = deferred(), evidence = deferred(), checking = deferred();
  const baseRun = h.context.window.electronAPI.desktopRun;
  h.context.window.electronAPI.desktopRun = () => native.promise;
  const baseModel = h.context.callGeminiSpecialist;
  h.context.callGeminiSpecialist = async (...args) => {
    if (args[1][0].content.startsWith('Verify a Windows')) { checking.resolve(); return evidence.promise; }
    return baseModel(...args);
  };
  const run = h.api.answerQuestion('yes');
  assert.equal(h.activity()[0].state, 'working');
  assert.equal(h.activity()[0].steps.at(-1).operation, 'DESKTOP_APPROVAL');
  h.calls.progress({ status: 'running', planId: 'accepted', completedSteps: 0, totalSteps: 1 });
  h.calls.progress({ status: 'completed', planId: 'accepted', completedSteps: 1, totalSteps: 1 });
  assert.equal(h.activity()[0].state, 'working', 'native input completion is not task completion');
  assert.equal(h.activity()[0].steps.at(-1).operation, 'DESKTOP_INPUT');
  native.resolve({ ...await baseRun('accepted'), undo: { available: true, undoId: 'PRIVATE CHECKPOINT', before: 'PRIVATE ORIGINAL', after: 'PRIVATE REPLACEMENT', expiresAt: Date.now() + 300000 } });
  await checking.promise;
  entry = h.activity()[0];
  assert.equal(entry.state, 'working');
  assert.equal(entry.steps.at(-1).operation, 'DESKTOP_VERIFY');
  assert.equal(entry.steps.at(-2).state, 'completed');
  evidence.resolve(JSON.stringify({ status: 'verified', observation: 'PRIVATE RESULT TEXT is now visible.', remaining: '' }));
  await run;
  entry = h.activity()[0];
  assert.equal(entry.id, id);
  assert.equal(entry.state, 'completed');
  assert.equal(entry.steps.at(-1).state, 'completed');
  assert.match(entry.steps.at(-1).details, /PRIVATE RESULT TEXT/);
  const saved = JSON.stringify(h.persisted().activity);
  for (const secret of ['PRIVATE', 'data:image', 'YmVmb3Jl', 'YWZ0ZXI=', 'return a + b;']) assert.ok(!saved.includes(secret));
  assert.ok(!JSON.stringify(h.activity()).includes('PRIVATE ORIGINAL'));
  assert.ok(!JSON.stringify(h.calls.receipts).includes('PRIVATE CHECKPOINT'));
  assert.ok(h.persisted().activity[0].steps.every(step => Object.keys(step).sort().join(',') === 'operation,state'));
});

test('uncertain, incomplete and missing post-edit evidence leave desktop activity unverified', async () => {
  for (const mode of ['uncertain', 'incomplete', 'missing', 'failure']) {
    const h = withActivity(editHarness(mode === 'incomplete' ? 'incomplete' : 'uncertain'));
    if (mode === 'missing') h.context.window.electronAPI.desktopRun = async () => ({ ok: true, completedSteps: 1, totalSteps: 1, verificationError: 'No after image.' });
    if (mode === 'failure') {
      const base = h.context.callGeminiSpecialist;
      h.context.callGeminiSpecialist = (...args) => args[1][0].content.startsWith('Verify a Windows') ? Promise.reject(new Error('Verification unavailable')) : base(...args);
    }
    await h.api.start('Fix the editor'); await h.api.answerQuestion('yes');
    const entry = h.activity()[0];
    assert.equal(entry.state, 'unverified', mode);
    assert.equal(entry.steps.at(-2).state, 'completed', 'delivered input is recorded independently');
    assert.equal(entry.steps.at(-1).state, 'unverified');
  }
});

test('desktop planning and native execution failures record the phase that failed', async () => {
  for (const phase of ['capture', 'planning', 'preparation', 'input']) {
    const h = withActivity(editHarness());
    if (phase === 'capture') h.context.window.electronAPI.desktopCapture = async () => { throw new Error('Capture unavailable'); };
    if (phase === 'planning') h.context.callGeminiSpecialist = async () => { throw new Error('Provider unavailable'); };
    if (phase === 'preparation') h.context.window.electronAPI.desktopPrepare = async () => { throw new Error('Invalid scope'); };
    if (phase === 'input') h.context.window.electronAPI.desktopRun = async () => {
      h.calls.progress({ status: 'running', planId: 'accepted', completedSteps: 0 });
      return { ok: false, completedSteps: 1, totalSteps: 2, error: 'Target changed' };
    };
    await h.api.start('Fix the editor'); if (phase === 'input') await h.api.answerQuestion('yes');
    const entry = h.activity()[0];
    assert.equal(entry.state, 'failed', phase);
    assert.equal(entry.steps.at(-1).state, 'failed');
    assert.equal(entry.steps.at(-1).operation, phase === 'capture' ? 'DESKTOP_CAPTURE' : phase === 'input' ? 'DESKTOP_INPUT' : 'DESKTOP_PLAN');
    assert.equal(h.calls.verifications.length, 0);
  }
});

test('screen sharing denial, pending proposal rejection and native cancellation never complete desktop activity', async () => {
  for (const phase of ['capture', 'proposal', 'approval', 'partial']) {
    const h = withActivity(editHarness());
    if (phase === 'capture') h.context.window.electronAPI.desktopCapture = async () => { throw new Error('Screen capture cancelled.'); };
    if (['approval', 'partial'].includes(phase)) h.context.window.electronAPI.desktopRun = async () => ({ ok: false, cancelled: true, completedSteps: phase === 'partial' ? 1 : 0, totalSteps: 2 });
    await h.api.start('Fix the editor');
    if (phase === 'proposal') await h.api.answerQuestion('no');
    if (['approval', 'partial'].includes(phase)) await h.api.answerQuestion('yes');
    const entry = h.activity()[0];
    assert.equal(entry.state, 'cancelled', phase);
    assert.equal(h.calls.verifications.length, 0);
    if (phase === 'partial') { assert.equal(entry.steps.at(-1).operation, 'DESKTOP_INPUT'); assert.equal(entry.steps.at(-1).state, 'uncertain'); assert.match(entry.steps.at(-1).details, /1 reported input steps/); }
    if (phase === 'approval') assert.ok(!entry.steps.some(step => step.operation === 'DESKTOP_INPUT'));
  }
});

test('a cancelled desktop run cannot overwrite its receipt or the next task with a late result', async () => {
  const h = withActivity(editHarness());
  await h.api.start('Fix the editor');
  const result = deferred(), originalRun = h.context.window.electronAPI.desktopRun;
  h.context.window.electronAPI.desktopRun = () => result.promise;
  const run = h.api.answerQuestion('yes');
  h.calls.progress({ status: 'running', planId: 'accepted', completedSteps: 1, totalSteps: 2 });
  h.api.cancel();
  const cancelled = h.activity()[0];
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.steps.at(-1).state, 'uncertain');
  assert.match(cancelled.steps.at(-1).details, /1 reported input steps/);
  await h.api.start('Fix another editor bug');
  const beforeLate = h.activity();
  result.resolve(await originalRun('accepted')); await run;
  assert.deepEqual(h.activity(), beforeLate);
  assert.equal(h.activity()[1].state, 'awaiting-input');
});

test('cancelling post-edit verification keeps delivered input but marks outcome uncertain', async () => {
  const h = withActivity(editHarness());
  const original = h.context.callGeminiSpecialist, checking = deferred(), evidence = deferred();
  h.context.callGeminiSpecialist = (...args) => {
    if (args[1][0].content.startsWith('Verify a Windows')) { checking.resolve(); return evidence.promise; }
    return original(...args);
  };
  await h.api.start('Fix the editor'); const run = h.api.answerQuestion('yes');
  await checking.promise; h.api.cancel();
  const entry = h.activity()[0];
  assert.equal(entry.state, 'cancelled');
  assert.equal(entry.steps.at(-2).state, 'completed');
  assert.equal(entry.steps.at(-1).operation, 'DESKTOP_VERIFY');
  assert.equal(entry.steps.at(-1).state, 'uncertain');
  evidence.resolve(JSON.stringify({ status: 'verified', observation: 'Late verification', remaining: '' })); await run;
  assert.deepEqual(h.activity()[0], entry);
});

test('clarification and scope review resume the same desktop activity without retaining the question or answer', async () => {
  const h = withActivity(workflowHarness(), false);
  await h.nodes.find(node => node.textContent === 'Capture screen').listeners.click();
  const id = h.activity()[0].id;
  assert.equal(h.activity()[0].state, 'awaiting-input');
  h.ids.get('desktopTaskWindow').value = '1'; h.ids.get('desktopTaskScope').value = 'window';
  const plan = h.nodes.find(node => node.textContent === 'Plan within this scope');
  await plan.listeners.click();
  assert.equal(h.activity()[0].state, 'awaiting-input');
  await h.api.answerQuestion('PRIVATE FOLDER NAME');
  h.ids.get('desktopTaskWindow').value = '1'; h.ids.get('desktopTaskScope').value = 'window';
  await plan.listeners.click();
  assert.equal(h.activity().length, 1); assert.equal(h.activity()[0].id, id);
  assert.equal(h.activity()[0].state, 'awaiting-input');
  assert.ok(!JSON.stringify(h.activity()).includes('PRIVATE FOLDER NAME'));
  assert.deepEqual(h.persisted().activity, []);
  h.api.cancel(); assert.equal(h.activity()[0].state, 'cancelled');
});

test('verified undo has its own activity receipt without copied editor text', async () => {
  const h = withActivity(editHarness());
  const originalRun = h.context.window.electronAPI.desktopRun;
  h.context.window.electronAPI.desktopRun = async id => ({ ...await originalRun(id), undo: { available: true, undoId: 'PRIVATE ID', before: 'PRIVATE ORIGINAL', after: 'PRIVATE REPLACEMENT', expiresAt: Date.now() + 300000 } });
  h.context.window.electronAPI.undoDesktopEdit = async () => ({ ok: true, verified: true, message: 'Original text restored and verified.' });
  await h.api.start('Fix the editor'); await h.api.answerQuestion('yes');
  await h.nodes.find(node => node.textContent === 'Undo text edit').listeners.click();
  assert.equal(h.activity().length, 2);
  assert.equal(h.activity()[1].state, 'completed');
  assert.equal(h.activity()[1].steps[0].operation, 'DESKTOP_UNDO');
  assert.ok(!JSON.stringify(h.activity()).includes('PRIVATE'));
  assert.ok(!JSON.stringify(h.persisted().activity).includes('Original text'));
});

test('a failed spoken summary cannot erase a verified desktop result', async () => {
  const h = withActivity(editHarness());
  h.context.composeSpecialistResponse = async () => { throw new Error('Response provider unavailable'); };
  await h.api.start('Fix the editor'); await h.api.answerQuestion('yes');
  assert.equal(h.activity()[0].state, 'completed');
  assert.equal(h.activity()[0].steps.at(-1).operation, 'DESKTOP_VERIFY');
  assert.equal(h.activity()[0].steps.at(-1).state, 'completed');
  assert.match(h.calls.spoken.at(-1), /requested text is visible/);
});

test('read-only diagnosis waits for scope and replacing the goal cancels that activity', async () => {
  const h = withActivity(editHarness());
  const originalCapture = h.context.window.electronAPI.desktopCapture;
  h.context.window.electronAPI.desktopCapture = async () => ({ ...await originalCapture(), focusedControl: null });
  h.context.callGeminiSpecialist = async () => 'The visible operator appears incorrect.';
  await h.api.start('Fix the editor');
  assert.equal(h.activity()[0].state, 'awaiting-input');
  assert.equal(h.activity()[0].steps.at(-1).operation, 'DESKTOP_DIAGNOSE');
  assert.equal(h.calls.prepared.length, 0);
  h.api.open('A different goal');
  assert.equal(h.activity()[0].state, 'cancelled');
  assert.equal(h.activity().length, 1, 'opening the replacement goal alone creates no activity');
});

test('an unavailable activity store does not block approved desktop work', async () => {
  const h = editHarness();
  h.context.window.OlangaActivity = { begin() { throw new Error('Activity unavailable'); } };
  await h.api.start('Fix the editor'); await h.api.answerQuestion('yes');
  assert.equal(h.calls.runs.length, 1);
  assert.equal(h.calls.receipts[0].verified, true);
});

