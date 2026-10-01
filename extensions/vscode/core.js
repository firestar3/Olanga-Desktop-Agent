const { randomUUID, createHash } = require('node:crypto');
function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use the exact local endpoint shown in Olanga.');
  return url.origin;
}
const digest = text => createHash('sha256').update(text).digest('hex');
function taskFingerprint(task) {
  const execution = task.execution || {};
  return digest(JSON.stringify({ name: task.name, source: task.source, definition: task.definition, scope: task.scope?.uri?.toString?.() || task.scope, process: execution.process, command: execution.command, commandLine: execution.commandLine, args: execution.args, options: execution.options }));
}
function createVscodeAdapter(vscode, { now = Date.now, taskTimeoutMs = 300000, rememberDocuments = async () => {}, knownDocuments = [] } = {}) {
  const selections = new Map(), tasks = new Map(), documents = new Set(knownDocuments), reviewContents = new Map(), pendingRuns = new Set();
  const provider = vscode.workspace.registerTextDocumentContentProvider('olanga-review', { provideTextDocumentContent: uri => reviewContents.get(uri.toString()) || '' });
  const trusted = () => { if (!vscode.workspace.isTrusted) throw new Error('Trust this VS Code workspace before applying edits or running tasks.'); };
  async function approved(message, button = 'Share') { if (await vscode.window.showInformationMessage(message, { modal: true }, button) !== button) throw new Error('The VS Code request was declined.'); }
  const docTitle = doc => doc.uri.path.split('/').at(-1) || 'Selected document';
  async function captureSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !['file', 'untitled'].includes(editor.document.uri.scheme) || editor.selection.isEmpty) throw new Error('Select text in a local document first.');
    const document = editor.document, text = document.getText(editor.selection), whole = document.getText();
    if (text.length > 100000 || whole.length > 1000000) throw new Error('Choose a selection of at most 100,000 characters in a document under 1 million characters.');
    const documentId = randomUUID();
    const snapshot = { document, range: new vscode.Range(editor.selection.start, editor.selection.end), version: document.version, text, before: whole, expiresAt: now() + 1800000 };
    selections.set(documentId, snapshot); while (selections.size > 30) selections.delete(selections.keys().next().value);
    if (document.uri.scheme === 'file') { documents.add(document.uri.toString()); await rememberDocuments([...documents].slice(-100)); }
    const diagnostics = vscode.languages.getDiagnostics(document.uri).filter(item => !!item.range.intersection(editor.selection)).slice(0, 30).map(item => ({ message: item.message.slice(0, 2000), severity: item.severity, line: item.range.start.line + 1 }));
    return { ok: true, verified: true, message: 'Selected text and diagnostics shared.', kind: 'selection', title: docTitle(document), url: document.uri.toString(), version: document.version, documentId, text, items: diagnostics };
  }
  async function listDocuments(confirm = true, authorize = async () => {}) {
    if (confirm) await approved('Share the paths and versions of open local documents with Olanga?');
    await authorize();
    const items = vscode.workspace.textDocuments.filter(doc => !doc.isClosed && doc.uri.scheme === 'file').slice(0, 100).map(doc => ({ uri: doc.uri.toString(), title: docTitle(doc), name: docTitle(doc), version: doc.version, dirty: doc.isDirty }));
    for (const item of items) documents.add(item.uri);
    await rememberDocuments([...documents].slice(-100));
    return { ok: true, verified: true, message: `${items.length} open document references shared. Contents were not shared.`, kind: 'documents', title: 'Shared VS Code documents', items };
  }
  async function listTasks(confirm = true, authorize = async () => {}) {
    trusted(); if (confirm) await approved('Share names of existing workspace tasks with Olanga? No task will run.');
    await authorize(); tasks.clear();
    const items = (await vscode.tasks.fetchTasks()).filter(task => task.execution && !(vscode.CustomExecution && task.execution instanceof vscode.CustomExecution)).slice(0, 100).map(task => {
      const taskId = randomUUID(); tasks.set(taskId, { task, fingerprint: taskFingerprint(task), expiresAt: now() + 600000 });
      return { id: taskId, taskId, name: task.name, source: task.source, detail: String(task.detail || '').slice(0, 1000) };
    });
    return { ok: true, verified: true, message: `${items.length} existing workspace tasks shared.`, kind: 'tasks', title: 'Shared VS Code tasks', items };
  }
  async function previewEdit(payload, authorize) {
    trusted();
    const selected = selections.get(payload.documentId);
    if (!selected || selected.expiresAt < now() || payload.version !== selected.version || typeof payload.text !== 'string' || payload.text.length > 100000) throw new Error('Share the current selection again before proposing a change.');
    const doc = selected.document;
    const current = () => !doc.isClosed && doc.version === selected.version && doc.getText() === selected.before;
    if (!current()) throw new Error('This document changed after sharing. Share a new selection; the stale proposal was not applied.');
    const start = doc.offsetAt(selected.range.start), end = doc.offsetAt(selected.range.end), after = selected.before.slice(0, start) + payload.text + selected.before.slice(end);
    const uri = vscode.Uri.parse(`olanga-review:/${randomUUID()}/${encodeURIComponent(docTitle(doc))}`);
    reviewContents.set(uri.toString(), after);
    try {
      await vscode.commands.executeCommand('vscode.diff', doc.uri, uri, `Olanga: review ${docTitle(doc)}`);
      await approved(`Apply this reviewed change to the shared selection in ${docTitle(doc)}? The document will remain unsaved so you can inspect or undo it.`, 'Apply');
      trusted(); await authorize();
      if (!current()) throw new Error('The document changed while the diff was open. Nothing was applied; share a new selection.');
      const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, selected.range, payload.text);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code did not apply the reviewed edit.');
      selections.delete(payload.documentId);
      const verified = doc.getText() === after;
      return { ok: verified, verified, message: verified ? 'The reviewed selection change was applied. The document remains unsaved; normal VS Code Undo is available.' : 'The document changed during application. Inspect the current document before continuing.', version: doc.version };
    } finally { reviewContents.delete(uri.toString()); }
  }
  async function runTask(payload, authorize) {
    trusted(); const selected = tasks.get(payload.taskId);
    if (!selected || selected.expiresAt < now()) throw new Error('Share available tasks again before running one.');
    const find = async () => (await vscode.tasks.fetchTasks()).find(task => taskFingerprint(task) === selected.fingerprint);
    let task = await find(); if (!task) throw new Error('The selected task definition changed. Share tasks again.');
    await approved(`Run existing workspace task “${task.name}” from ${task.source}?\n${String(task.detail || '').slice(0, 1000)}\nThis uses your saved VS Code task definition and may change project files.`, 'Run task');
    trusted(); task = await find(); if (!task) throw new Error('The task definition changed during review. Nothing was started.'); await authorize();
    return new Promise((resolve, reject) => {
      let execution = null, done = false, timer, endSubscription, taskEndSubscription;
      const earlyEnds = [];
      const finish = result => { if (done) return; done = true; clearTimeout(timer); endSubscription?.dispose(); taskEndSubscription?.dispose(); pendingRuns.delete(cancel); resolve(result); };
      const cancel = () => { execution?.terminate(); finish({ ok: false, verified: false, message: 'The companion task was cancelled.' }); };
      pendingRuns.add(cancel);
      const processEnded = event => finish({ ok: event.exitCode === 0, verified: Number.isInteger(event.exitCode), exitCode: event.exitCode, message: Number.isInteger(event.exitCode) ? `Task “${task.name}” exited with code ${event.exitCode}.` : `Task “${task.name}” ended without a verified exit code.` });
      endSubscription = vscode.tasks.onDidEndTaskProcess(event => {
        if (!execution) { if (earlyEnds.length < 20) earlyEnds.push(event); return; }
        if (event.execution === execution) processEnded(event);
      });
      // Tasks without process-exit events must still end with an honest receipt.
      taskEndSubscription = vscode.tasks.onDidEndTask(event => { if (event.execution === execution) setTimeout(() => finish({ ok: false, verified: false, message: `Task “${task.name}” ended without a process exit receipt.` }), 100); });
      vscode.tasks.executeTask(task).then(value => {
        execution = value;
        if (done) { execution.terminate(); return; }
        const early = earlyEnds.find(event => event.execution === execution);
        if (early) { processEnded(early); return; }
        timer = setTimeout(() => { execution.terminate(); finish({ ok: false, verified: false, message: 'The companion task exceeded five minutes and was stopped.' }); }, taskTimeoutMs);
      }, error => { pendingRuns.delete(cancel); endSubscription.dispose(); taskEndSubscription.dispose(); reject(error); });
    });
  }
  async function run(operation, payload = {}, { authorize = async () => {} } = {}) {
    if (operation === 'vscode.listDocuments') return listDocuments(true, authorize);
    if (operation === 'vscode.listTasks') return listTasks(true, authorize);
    if (operation === 'vscode.previewEdit') return previewEdit(payload, authorize);
    if (operation === 'vscode.runTask') return runTask(payload, authorize);
    if (operation === 'vscode.resumeDocuments') {
      if (!Array.isArray(payload.uris) || !payload.uris.length || payload.uris.length > 20 || payload.uris.some(uri => !documents.has(uri) || vscode.Uri.parse(uri).scheme !== 'file')) throw new Error('Resume only local documents previously shared through this companion.');
      await approved('Open these previously shared documents?\n' + payload.uris.join('\n'), 'Open documents');
      for (const uri of [...new Set(payload.uris)]) { await authorize(); const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri)); await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true }); }
      return { ok: true, verified: true, message: 'Previously shared documents opened in VS Code.' };
    }
    throw new Error('Unsupported VS Code companion operation.');
  }
  return { captureSelection, listDocuments, listTasks, run, cancelAll() { for (const cancel of [...pendingRuns]) cancel(); }, dispose() { for (const cancel of [...pendingRuns]) cancel(); provider.dispose(); selections.clear(); tasks.clear(); reviewContents.clear(); } };
}
module.exports = { createVscodeAdapter, endpoint, taskFingerprint };
