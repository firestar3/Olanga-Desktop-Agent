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
    desktopPrepare: async plan => { calls.prepared.push(plan); return { planId: 'accepted', steps: plan.steps }; }, desktopCancel: async () => {}
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

