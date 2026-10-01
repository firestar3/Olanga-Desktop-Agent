const test = require('node:test');
const assert = require('node:assert/strict');
const { createVscodeAdapter, endpoint } = require('../../extensions/vscode/core');
function fixture(t, options = {}) {
  const state = { text: 'Chosen text and remaining text', confirms: [], diffCalls: 0, applyCalls: 0, executionCalls: 0, terminated: 0, exitCode: 0, onConfirm: null, tasks: [{ name: 'test', source: 'Workspace', definition: { type: 'npm', script: 'test' }, scope: 2, execution: { command: 'npm', args: ['test'], options: { cwd: 'C:/fixture' } } }] };
  const uri = value => ({ scheme: value.split(':')[0], path: value.replace(/^file:\/\//, ''), toString: () => value });
  class Range { constructor(start, end) { this.start = start; this.end = end; } intersection() { return this; } }
  const selection = new Range({ line: 0, character: 0 }, { line: 0, character: 11 }); selection.isEmpty = false;
  const doc = { uri: uri('file:///C:/fixture/notes.txt'), version: 1, isClosed: false, isDirty: false, getText: range => range ? state.text.slice(range.start.character, range.end.character) : state.text, offsetAt: pos => pos.character };
  const processListeners = new Set(), endListeners = new Set();
  const vscode = { Range, Uri: { parse: uri }, WorkspaceEdit: class { replace(file, range, text) { this.change = { file, range, text }; } },
    window: { activeTextEditor: { document: doc, selection }, showInformationMessage: async (message, config, button) => { state.confirms.push(message); await state.onConfirm?.(message); return state.decline ? undefined : button; }, showTextDocument: async () => {} },
    workspace: { isTrusted: true, textDocuments: [doc], registerTextDocumentContentProvider: () => ({ dispose() {} }), openTextDocument: async () => doc,
      applyEdit: async edit => { state.applyCalls++; const { range, text } = edit.change; state.text = state.text.slice(0, range.start.character) + text + state.text.slice(range.end.character); doc.version++; doc.isDirty = true; return true; } },
    languages: { getDiagnostics: () => [{ message: 'Example error', severity: 0, range: selection }] },
    commands: { executeCommand: async () => { state.diffCalls++; } },
    tasks: { fetchTasks: async () => state.tasks, onDidEndTaskProcess: fn => { processListeners.add(fn); return { dispose: () => processListeners.delete(fn) }; }, onDidEndTask: fn => { endListeners.add(fn); return { dispose: () => endListeners.delete(fn) }; },
      executeTask: async task => { state.executionCalls++; const execution = { task, terminate: () => state.terminated++ }; if (!state.hang) setTimeout(() => { for (const fn of processListeners) fn({ execution, exitCode: state.exitCode }); }, 5); return execution; } },
  };
  const adapter = createVscodeAdapter(vscode, { taskTimeoutMs: 25, ...options }); t.after(() => adapter.dispose());
  return { adapter, state, vscode, doc };
}
test('selected text shares only its range with version and scoped diagnostics', async t => {
  const { adapter } = fixture(t); const shared = await adapter.captureSelection();
  assert.equal(shared.text, 'Chosen text'); assert.equal(shared.version, 1); assert.equal(shared.items.length, 1);
});
test('reviewed selection edit uses native diff, checks version and remains unsaved', async t => {
  const { adapter, state, doc } = fixture(t); const shared = await adapter.captureSelection();
  const result = await adapter.run('vscode.previewEdit', { documentId: shared.documentId, version: shared.version, text: 'Reviewed change' });
  assert.equal(result.verified, true); assert.equal(state.diffCalls, 1); assert.equal(state.applyCalls, 1); assert.equal(doc.isDirty, true); assert.equal(state.text, 'Reviewed change and remaining text');
});
test('stale shared version and editing while diff is open cannot apply a proposal', async t => {
  const { adapter, state, doc } = fixture(t); const shared = await adapter.captureSelection();
  doc.version++; await assert.rejects(adapter.run('vscode.previewEdit', { documentId: shared.documentId, version: shared.version, text: 'Stale' }), /changed/); assert.equal(state.diffCalls, 0);
  const next = await adapter.captureSelection(); state.onConfirm = async () => { state.text += ' typed'; doc.version++; };
  await assert.rejects(adapter.run('vscode.previewEdit', { documentId: next.documentId, version: next.version, text: 'Stale during review' }), /changed while/); assert.equal(state.applyCalls, 0);
});
test('declined edits and approval after bridge cancellation leave the document untouched', async t => {
  const { adapter, state } = fixture(t); const shared = await adapter.captureSelection();
  const payload = { documentId: shared.documentId, version: shared.version, text: 'Rejected' };
  state.decline = true; await assert.rejects(adapter.run('vscode.previewEdit', payload), /declined/);
  state.decline = false; await assert.rejects(adapter.run('vscode.previewEdit', payload, { authorize: async () => { throw new Error('Cancelled by Olanga'); } }), /Cancelled/);
  assert.equal(state.applyCalls, 0);
});
test('task execution uses a shared unchanged existing definition and reports the actual exit code', async t => {
  const { adapter, state } = fixture(t); const tasks = await adapter.listTasks();
  state.exitCode = 2; const result = await adapter.run('vscode.runTask', { taskId: tasks.items[0].taskId });
  assert.equal(result.ok, false); assert.equal(result.verified, true); assert.equal(result.exitCode, 2); assert.equal(state.executionCalls, 1);
});
test('task definition mutation before or during approval prevents execution', async t => {
  const { adapter, state } = fixture(t); let tasks = await adapter.listTasks();
  state.tasks[0].execution.args = ['different']; await assert.rejects(adapter.run('vscode.runTask', { taskId: tasks.items[0].taskId }), /definition changed/);
  tasks = await adapter.listTasks(); state.onConfirm = async () => { state.tasks[0].execution.args = ['changed-during-review']; };
  await assert.rejects(adapter.run('vscode.runTask', { taskId: tasks.items[0].taskId }), /definition changed/); assert.equal(state.executionCalls, 0);
});
test('arbitrary task commands, untrusted-workspace writes and unshared document URIs are rejected', async t => {
  const { adapter, vscode } = fixture(t);
  await assert.rejects(adapter.run('vscode.runTask', { command: 'powershell evil' }), /Share available tasks/);
  await assert.rejects(adapter.run('vscode.resumeDocuments', { uris: ['file:///C:/unshared.txt'] }), /previously shared/);
  vscode.workspace.isTrusted = false; await assert.rejects(adapter.listTasks(), /Trust/);
});
test('companion-owned tasks time out and cancel without targeting unrelated executions', async t => {
  const { adapter, state } = fixture(t); state.hang = true; const tasks = await adapter.listTasks();
  const result = await adapter.run('vscode.runTask', { taskId: tasks.items[0].taskId }); assert.equal(result.ok, false); assert.equal(state.terminated, 1);
  const second = adapter.run('vscode.runTask', { taskId: tasks.items[0].taskId }); await new Promise(resolve => setTimeout(resolve, 5)); adapter.cancelAll();
  assert.match((await second).message, /cancelled/); assert.equal(state.terminated, 2);
});
test('document references persist through explicit allowlist callback and can resume on reconnect', async t => {
  let remembered = []; const first = fixture(t, { rememberDocuments: async items => { remembered = items; } });
  await first.adapter.listDocuments(); assert.equal(remembered.length, 1);
  const second = fixture(t, { knownDocuments: remembered });
  assert.equal((await second.adapter.run('vscode.resumeDocuments', { uris: remembered })).ok, true);
});
test('VS Code pairing cannot use external hosts or credential-bearing URLs', () => {
  assert.throws(() => endpoint('http://evil.example:1234')); assert.throws(() => endpoint('http://user:pass@127.0.0.1:1234')); assert.equal(endpoint('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
});
