const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  expandWindow: () => ipcRenderer.send('window-expand'),
  setStatusState: (state) => ipcRenderer.send('status-indicator-set', state),
  setStatusLightMode: (mode) => ipcRenderer.send('status-indicator-set-mode', mode),
  setStatusLightSize: (size) => ipcRenderer.send('status-indicator-set-size', size),
  setQuickActions: (actions) => ipcRenderer.send('status-overlay-set-quick-actions', actions),
  onQuickAction: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on('quick-action-run', handler);
    return () => ipcRenderer.removeListener('quick-action-run', handler);
  },
  desktopCapture: () => ipcRenderer.invoke('desktop-capture'),
  desktopPrepare: (plan) => ipcRenderer.invoke('desktop-prepare', plan),
  desktopRun: (planId) => ipcRenderer.invoke('desktop-run', planId),
  undoDesktopEdit: (undoId) => ipcRenderer.invoke('desktop-undo', undoId),
  desktopCancel: () => ipcRenderer.invoke('desktop-cancel'),
  onDesktopProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('desktop-progress', handler);
    return () => ipcRenderer.removeListener('desktop-progress', handler);
  },
  getOpenAtLogin: () => ipcRenderer.invoke('get-open-at-login'),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke('set-open-at-login', enabled),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  projectList: () => ipcRenderer.invoke('project-list'),
  workbenchGuide: name => ipcRenderer.invoke('workbench-guide', name),
  phoneAddresses: () => ipcRenderer.invoke('phone-addresses'),
  phoneIdentity: () => ipcRenderer.invoke('phone-identity'),
  phoneStart: payload => ipcRenderer.invoke('phone-start', payload),
  phoneStatus: () => ipcRenderer.invoke('phone-status'),
  phoneStop: () => ipcRenderer.invoke('phone-stop'),
  phoneClaim: id => ipcRenderer.invoke('phone-claim', id),
  phoneComplete: payload => ipcRenderer.invoke('phone-complete', payload),
  onPhoneCommand: callback => { const handler = (_, value) => callback(value); ipcRenderer.on('phone-command', handler); return () => ipcRenderer.removeListener('phone-command', handler); },
  onPhoneCancel: callback => { const handler = (_, value) => callback(value); ipcRenderer.on('phone-command-cancel', handler); return () => ipcRenderer.removeListener('phone-command-cancel', handler); },
  integrationConfigure: payload => ipcRenderer.invoke('integration-configure', payload),
  integrationList: () => ipcRenderer.invoke('integration-list'),
  integrationPreview: payload => ipcRenderer.invoke('integration-preview', payload),
  integrationCall: payload => ipcRenderer.invoke('integration-call', payload),
  integrationDisconnect: () => ipcRenderer.invoke('integration-disconnect'),
  companionPair: kind => ipcRenderer.invoke('companion-pair', kind),
  companionList: () => ipcRenderer.invoke('companion-list'),
  companionDisconnect: id => ipcRenderer.invoke('companion-disconnect', id),
  companionCancel: () => ipcRenderer.invoke('companion-cancel'),
  openCompanionFiles: () => ipcRenderer.invoke('companion-folder'),
  companionForget: id => ipcRenderer.invoke('companion-forget', id),
  companionRequest: payload => ipcRenderer.invoke('companion-request', payload),
  onCompanionState: callback => { const handler = (_, state) => callback(state); ipcRenderer.on('companion-state', handler); return () => ipcRenderer.removeListener('companion-state', handler); },
  calendarImport: () => ipcRenderer.invoke('calendar-import'),
  calendarList: () => ipcRenderer.invoke('calendar-list'),
  calendarClear: () => ipcRenderer.invoke('calendar-clear'),
  projectAdd: () => ipcRenderer.invoke('project-add'),
  projectRemove: id => ipcRenderer.invoke('project-remove', id),
  projectRefresh: id => ipcRenderer.invoke('project-refresh', id),
  projectSearch: payload => ipcRenderer.invoke('project-search', payload),
  projectReveal: payload => ipcRenderer.invoke('project-reveal', payload),
  workSessionCapture: () => ipcRenderer.invoke('work-session-capture'),
  workSessionSave: payload => ipcRenderer.invoke('work-session-save', payload),
  workSessionList: () => ipcRenderer.invoke('work-session-list'),
  workSessionRemove: id => ipcRenderer.invoke('work-session-remove', id),
  workSessionPreview: id => ipcRenderer.invoke('work-session-preview', id),
  workSessionRestore: id => ipcRenderer.invoke('work-session-restore', id),
  workSessionCancel: () => ipcRenderer.invoke('work-session-cancel'),
  fileWorkflowSelect: () => ipcRenderer.invoke('file-workflow-select'),
  fileWorkflowDestination: () => ipcRenderer.invoke('file-workflow-destination'),
  fileWorkflowPreview: payload => ipcRenderer.invoke('file-workflow-preview', payload),
  fileWorkflowExecute: id => ipcRenderer.invoke('file-workflow-execute', id),
  fileWorkflowUndo: id => ipcRenderer.invoke('file-workflow-undo', id),
  fileWorkflowHistory: () => ipcRenderer.invoke('file-workflow-history'),
  fileWorkflowCancel: () => ipcRenderer.invoke('file-workflow-cancel'),
  conversationLocalReply: payload => ipcRenderer.invoke('conversation-local-reply', payload),
  conversationLocalSpeech: payload => ipcRenderer.invoke('conversation-local-speech', payload),
  conversationLocalCancel: id => ipcRenderer.invoke('conversation-local-cancel', id),
  conversationLiveStart: payload => ipcRenderer.invoke('conversation-live-start', payload),
  conversationLiveAudio: payload => ipcRenderer.invoke('conversation-live-audio', payload),
  conversationLiveEndAudio: payload => ipcRenderer.invoke('conversation-live-end-audio', payload),
  conversationLiveStop: payload => ipcRenderer.invoke('conversation-live-stop', payload),
  onConversationLiveEvent: callback => {
    const handler = (_, event) => callback(event); ipcRenderer.on('conversation-live-event', handler);
    return () => ipcRenderer.removeListener('conversation-live-event', handler);
  },
  setPushToTalk: (value) => ipcRenderer.invoke('set-push-to-talk', value),
  onPushToTalk: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('push-to-talk', handler);
    return () => ipcRenderer.removeListener('push-to-talk', handler);
  },
  notify: (payload) => ipcRenderer.send('notify', payload),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  playSpotify: (type, term) => ipcRenderer.invoke('play-spotify', { type, term }),
  reloadSpotify: () => ipcRenderer.invoke('reload-spotify'),
  mediaControl: (cmd, spotifyOnly, level) => ipcRenderer.invoke('media-control', cmd, spotifyOnly, level),
  cancelMedia: () => ipcRenderer.send('media-cancel'),
  openApp: (appName) => ipcRenderer.invoke('open-app', appName),
  listAppCapabilities: () => ipcRenderer.invoke('list-app-capabilities'),
  checkRelease: () => ipcRenderer.invoke('check-release'),
  getUpdateState: () => ipcRenderer.invoke('update-state'),
  downloadUpdate: () => ipcRenderer.invoke('update-download'),
  cancelUpdate: () => ipcRenderer.invoke('update-cancel'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  onUpdateState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('update-state-changed', handler);
    return () => ipcRenderer.removeListener('update-state-changed', handler);
  },
  arrangeApp: (payload) => ipcRenderer.invoke('arrange-app', payload),
  closeApp: (appName) => ipcRenderer.invoke('close-app', appName),
  requestScreenshot: () => ipcRenderer.invoke('request-screenshot'),
  executeCommand: (payload) => ipcRenderer.invoke('execute-command', payload),
  createTerminalSession: (payload) => ipcRenderer.invoke('terminal-session-create', payload),
  executeTerminalSessionCommand: (payload) => ipcRenderer.invoke('terminal-session-execute', payload),
  closeTerminalSession: (payload) => ipcRenderer.invoke('terminal-session-close', payload),
  fetchNewsBundle: (payload) => ipcRenderer.invoke('fetch-news-bundle', payload),
  nvidiaTtsConfig: (payload) => ipcRenderer.invoke('nvidia-tts-config', payload),
  nvidiaTtsSynthesize: (payload) => ipcRenderer.invoke('nvidia-tts-synthesize', payload),
  providerGenerate: (payload) => ipcRenderer.invoke('provider-generate', payload),
  // Partial text arrives as events; the invoke result is the authoritative full reply.
  providerStream: (payload, onText) => {
    const handler = (_event, chunk) => {
      if (chunk?.requestId === payload?.requestId && typeof chunk.text === 'string') onText(chunk.text);
    };
    ipcRenderer.on('provider-stream-chunk', handler);
    return ipcRenderer.invoke('provider-stream', payload).finally(() => ipcRenderer.removeListener('provider-stream-chunk', handler));
  },
  warmProvider: () => ipcRenderer.send('provider-warm'),
  providerCancel: (requestId) => ipcRenderer.invoke('provider-cancel', requestId),
  providerStatus: () => ipcRenderer.invoke('provider-status'),
  secureStoreGet: (key) => ipcRenderer.invoke('secure-store-get', key),
  secureStoreSet: (key, value) => ipcRenderer.invoke('secure-store-set', { key, value })
});
