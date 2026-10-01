const path = require('node:path');
const { createProjectKnowledge } = require('./project-knowledge');
const { createWorkspaceService } = require('./workspace-service');
const { createFileWorkflows } = require('./file-workflows');
const { createConversationBackends } = require('./conversation-backends');
const { createCalendarService } = require('./calendar-service');
const { createIntegrationClient } = require('./integration-client');
const { createCompanionBridge } = require('./companion-bridge');
const { createPhoneRemote } = require('./phone-remote');
const { createPhoneDispatch } = require('./phone-dispatch');

function registerWorkbench({ ipc, app, dialog, shell, getWindow, appController, fetchImpl, getGeminiKey }) {
  const choose = async properties => {
    const result = await dialog.showOpenDialog(getWindow(), { properties });
    return result.canceled ? [] : result.filePaths;
  };
  const knowledge = createProjectKnowledge({
    stateFile: path.join(app.getPath('userData'), 'projects.json'),
    chooseFolder: async () => (await choose(['openDirectory']))[0],
    revealFile: filename => shell.showItemInFolder(filename)
  });
  const workspaces = createWorkspaceService({ filePath: path.join(app.getPath('userData'), 'work-sessions.json'), appController });
  const calendar = createCalendarService({ chooseFile: async () => {
    const result = await dialog.showOpenDialog(getWindow(), { properties: ['openFile'], filters: [{ name: 'iCalendar', extensions: ['ics'] }] });
    return result.canceled ? null : result.filePaths[0];
  } });
  const files = createFileWorkflows({ journalPath: path.join(app.getPath('userData'), 'file-workflows.json') });
  const integrations = createIntegrationClient({ fetchImpl });
  const companions = createCompanionBridge({ onState: state => { const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send('companion-state', state); } });
  const phoneDispatch = createPhoneDispatch({ getWindow }), phone = createPhoneRemote({ execute: payload => phoneDispatch.execute(payload) });
  let phoneIdentity = null;
  const conversations = createConversationBackends({ fetchImpl, getGeminiKey, onLiveEvent: event => {
    const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send('conversation-live-event', event);
  } });
  const handlers = {
    'workbench-guide': async (_, name) => { const guides = { phone: '../docs/PHONE_REMOTE.md', companions: '../extensions/README.md' }; if (!Object.hasOwn(guides, name)) throw new Error('Unknown setup guide.'); return require('node:fs/promises').readFile(path.join(__dirname, guides[name]), 'utf8'); },
    'phone-addresses': () => phone.addresses(),
    'phone-identity': async () => {
      const certificate = await dialog.showOpenDialog(getWindow(), { title: 'Choose the phone HTTPS certificate', properties: ['openFile'], filters: [{ name: 'PEM certificate', extensions: ['pem', 'crt'] }] }); if (certificate.canceled) return { cancelled: true };
      const key = await dialog.showOpenDialog(getWindow(), { title: 'Choose its private key (stays on this computer)', properties: ['openFile'], filters: [{ name: 'PEM private key', extensions: ['pem', 'key'] }] }); if (key.canceled) return { cancelled: true };
      phoneIdentity = { certPath: certificate.filePaths[0], keyPath: key.filePaths[0] }; return { selected: true, certificate: path.basename(phoneIdentity.certPath) };
    },
    'phone-start': (_, payload) => { if (!phoneIdentity) throw new Error('Choose a local HTTPS certificate and key first.'); return phone.start({ host: payload?.host, port: payload?.port ?? 0, ...phoneIdentity }); },
    'phone-status': () => phone.status(),
    'phone-stop': () => phone.stop(),
    'phone-claim': (_, id) => phoneDispatch.claim(id),
    'phone-complete': (_, payload) => phoneDispatch.complete(payload),
    'integration-configure': (_, payload) => integrations.configure(payload),
    'integration-list': () => integrations.listTools(),
    'integration-preview': (_, payload) => integrations.preview(payload),
    'integration-call': (_, payload) => integrations.callApproved(payload),
    'integration-disconnect': () => integrations.disconnect(),
    'companion-pair': (_, kind) => companions.startPairing(kind),
    'companion-list': () => companions.list(),
    'companion-disconnect': (_, id) => companions.disconnect(id),
    'companion-cancel': () => companions.cancelAll(),
    'companion-folder': async () => { const error = await shell.openPath(app.isPackaged ? path.join(process.resourcesPath, 'extensions') : path.join(__dirname, '../extensions')); if (error) throw new Error('The companion folder could not be opened.'); return { ok: true }; },
    'companion-forget': (_, id) => companions.forget(id),
    'companion-request': (_, payload) => companions.request(payload),
    'calendar-import': () => calendar.importFile(),
    'calendar-list': () => calendar.list(),
    'calendar-clear': () => calendar.clear(),
    'project-list': () => knowledge.list(),
    'project-add': () => knowledge.add(),
    'project-remove': (_, id) => knowledge.remove(id),
    'project-refresh': (_, id) => knowledge.refresh(id),
    'project-search': (_, payload) => knowledge.search(payload?.id, payload?.query),
    'project-reveal': (_, payload) => knowledge.reveal(payload?.id, payload?.sourceId),
    'work-session-capture': () => workspaces.capture(),
    'work-session-save': (_, payload) => workspaces.save(payload),
    'work-session-list': () => workspaces.list(),
    'work-session-remove': (_, id) => workspaces.remove(id),
    'work-session-preview': (_, id) => workspaces.previewRestore(id),
    'work-session-restore': (_, id) => workspaces.restore(id),
    'work-session-cancel': () => workspaces.cancel(),
    'file-workflow-select': async () => { const selected = await choose(['openFile', 'multiSelections']); return selected.length ? files.selectFiles(selected) : { cancelled: true }; },
    'file-workflow-destination': async () => { const selected = await choose(['openDirectory']); return selected[0] ? files.selectDestination(selected[0]) : { cancelled: true }; },
    'file-workflow-preview': (_, payload) => files.preview(payload),
    'file-workflow-execute': (_, id) => files.execute(id),
    'file-workflow-undo': (_, id) => files.undo(id),
    'file-workflow-history': () => files.listHistory(),
    'file-workflow-cancel': () => files.cancel(),
    'conversation-local-reply': (_, payload) => conversations.localReply(payload),
    'conversation-local-speech': (_, payload) => conversations.synthesizeLocal(payload),
    'conversation-local-cancel': (_, id) => conversations.cancelLocal(id),
    'conversation-live-start': (_, payload) => conversations.startLive(payload),
    'conversation-live-audio': (_, payload) => conversations.sendLiveAudio(payload),
    'conversation-live-end-audio': (_, payload) => conversations.endLiveAudio(payload),
    'conversation-live-stop': (_, payload) => conversations.stopLive(payload)
  };
  for (const [channel, handler] of Object.entries(handlers)) ipc.handle(channel, handler);
  app.on('web-contents-created', (_, contents) => {
    let owned = false;
    const clear = () => { try { owned ||= getWindow()?.webContents === contents; } catch (_) {} if (owned) { workspaces.cancel(); files.cancel(); conversations.cancelAll?.(); integrations.disconnect(); companions.cancelAll?.(); phoneDispatch.cancelAll(); void phone.stop(); } };
    contents.on('render-process-gone', clear); contents.on('destroyed', clear);
    contents.on('did-start-navigation', (_, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) clear(); });
  });
  app.on('before-quit', () => { workspaces.dispose(); files.dispose(); conversations.dispose(); integrations.dispose(); companions.dispose(); phoneDispatch.cancelAll(); void phone.stop(); });
  return { knowledge, workspaces, files, conversations, integrations, companions, calendar };
}
module.exports = { registerWorkbench };
