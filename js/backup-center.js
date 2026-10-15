/* Explicit personal exports and reviewed restores; no background backup/upload. */
(function () {
  if (!window.OlangaPersonalBackup) return;
  const api = OlangaPersonalBackup;
  const labels = { notes: 'Current notes', checklist: 'Checklist', timers: 'Timers, reminders & alarms', schedules: 'Schedules', preferences: 'Appearance & conversation preferences', workspace: 'Memories, saved names & routines' };
  const parse = (text, options) => OlangaIntents.parse(text, options);
  const workspacePortable = () => { const value = OlangaWorkspace.exportPersonal(); value.createdAt = 0; return value; };
  const applyWorkspace = value => { const preview = OlangaWorkspace.previewImport(JSON.stringify(value), parse); OlangaWorkspace.importPersonal(preview.token, parse); };
  const rawCount = raw => { try { return JSON.parse(raw || '[]').length; } catch (_) { return 0; } };
  const timerPortable = (raw, at = Date.now()) => {
    const saved = JSON.parse(raw || '[]'); if (!Array.isArray(saved)) throw new Error('The saved timer record is unreadable.');
    return saved.map(item => ({ label: item.label, kind: item.kind || 'timer', remainingMs: item.paused ? item.remainingMs : Math.max(0, Math.round(item.endTime - at)) }));
  };
  const schedulePortable = raw => {
    const saved = JSON.parse(raw || '{"version":1,"items":[],"deliveries":[]}'); if (saved?.version !== 1 || !Array.isArray(saved.items)) throw new Error('The saved schedule record is unreadable.');
    return saved.items.map(item => { const { kind, title, repeat, online, onceAt, time, days } = item; return { kind, title, repeat, online, ...(repeat === 'once' ? { onceAt } : { time }), ...(repeat === 'weekly' ? { days } : {}) }; });
  };
  const adapters = {
    notes: {
      read: () => OlangaNotesController.original(), count: value => value.notesRaw === null ? 1 : rawCount(value.notesRaw),
      write: value => OlangaNotesController.replace(value), rollback: value => OlangaNotesController.rollback(value),
      portableRecovery: value => JSON.parse(value.notesRaw || '[{"id":0,"name":"Note 1","content":""}]')
    },
    checklist: { read: () => OlangaChecklistAdapter.original(), count: rawCount, write: value => OlangaChecklistAdapter.replace(value), rollback: value => OlangaChecklistAdapter.rollback(value), portableRecovery: value => JSON.parse(value || '[]') },
    timers: { read: () => OlangaTimersAdapter.original(), count: rawCount, write: value => OlangaTimersAdapter.replacePaused(value), rollback: value => OlangaTimersAdapter.rollback(value), portableRecovery: timerPortable },
    schedules: { read: () => OlangaSchedulesAdapter.original(), count: value => schedulePortable(value).length, write: value => OlangaSchedulesAdapter.replacePaused(value), rollback: value => OlangaSchedulesAdapter.rollback(value), portableRecovery: schedulePortable },
    preferences: { read: () => OlangaPortablePreferences.snapshot(), write: value => OlangaPortablePreferences.apply(value), portableRecovery: value => value },
    workspace: { read: workspacePortable, write: applyWorkspace, portableRecovery: value => value }
  };
  const restorer = api.createRestorer(localStorage, adapters, { parse, sanitizeNotes: sanitizeNoteHtml });
  const portable = {
    notes: () => OlangaNotesController.portable(), checklist: () => OlangaChecklistAdapter.portable(), timers: () => OlangaTimersAdapter.portable(),
    schedules: () => OlangaSchedulesAdapter.portable(), preferences: () => OlangaPortablePreferences.snapshot(), workspace: () => OlangaWorkspace.exportPersonal()
  };
  let currentDialog, importSequence = 0, restoring = false;
  const isBusy = () => restoring || restorer.isBusy();
  function node(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
  function download(text, filename) { const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })), link = node('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  function open() {
    if (currentDialog?.open) { currentDialog.focus(); return; }
    if (currentDialog) { ++importSequence; currentDialog.remove(); currentDialog = null; }
    const previous = document.activeElement, dialog = node('dialog', undefined, 'workspace-dialog backup-center-dialog'); dialog.id = 'backupCenterDialog'; currentDialog = dialog;
    dialog.setAttribute('aria-labelledby', 'backupCenterHeading'); const heading = node('h2', 'Personal backup & restore'); heading.id = 'backupCenterHeading';
    const status = node('p'); status.id = 'backupCenterStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const detail = node('p', 'Choose what to export. Backups are files you control and are never uploaded by Olanga. They can contain private note text and memories. Keys, device settings, local project paths, activity and run receipts are excluded.', 'workspace-help');
    const scope = node('fieldset', undefined, 'backup-scope'); scope.append(node('legend', 'Include in this backup'));
    for (const name of api.COLLECTIONS) { const label = node('label', undefined, 'workspace-check'), input = node('input'); input.type = 'checkbox'; input.checked = true; input.dataset.backupCollection = name; label.append(input, document.createTextNode(labels[name])); scope.append(label); }
    const preview = node('section'); preview.id = 'backupCenterPreview'; preview.hidden = true; let previewToken = null;
    function message(error) { status.textContent = error?.message || String(error); status.className = 'workspace-error'; }
    function control(label, action, id) { const button = node('button', label); button.type = 'button'; if (id) button.id = id; button.addEventListener('click', () => { Promise.resolve().then(action).catch(message); }); return button; }
    function showPreview(value) {
      previewToken = value.token; preview.replaceChildren(node('h3', 'Review replacement')); preview.hidden = false;
      preview.append(node('p', 'Checked collections replace the current collection. Unchecked collections stay as they are. Timers arrive paused and schedules disabled; restore never runs a routine or notification. Notes are cleaned of active HTML. Local note versions/trash are not exported.', 'workspace-help'));
      for (const collection of value.collections) {
        const label = node('label', undefined, 'workspace-check'), input = node('input'); input.type = 'checkbox'; input.checked = true; input.dataset.restoreCollection = collection.name;
        label.append(input, document.createTextNode(`${labels[collection.name]} · ${collection.current} current → ${collection.incoming} incoming`)); preview.append(label);
      }
      const confirm = control('Replace selected collections', async () => {
        if (isBusy()) return;
        if (window.OlangaTurns?.isActive?.() || typeof currentState !== 'undefined' && currentState !== State.IDLE) throw new Error('Finish or stop the current request before restoring a backup.');
        const selected = [...preview.querySelectorAll('[data-restore-collection]:checked')].map(input => input.dataset.restoreCollection);
        confirm.disabled = true; restoring = true;
        window.dispatchEvent(new CustomEvent('olanga:personal-restore-start'));
        try {
          await window.OlangaSchedulesAdapter?.suspend();
          const result = await restorer.apply(previewToken, selected); preview.hidden = true; previewToken = null;
          status.className = ''; status.textContent = 'Restored ' + result.restored.map(name => labels[name].toLowerCase()).join(', ') + '. ' + (result.paused.length ? 'Imported timers remain paused and schedules disabled until you resume them.' : '');
        } finally { restoring = false; window.OlangaSchedulesAdapter?.resumePolling(); window.dispatchEvent(new CustomEvent('olanga:personal-restore-end')); confirm.disabled = false; refreshRecovery(); }
      }, 'backupCenterRestore'); confirm.className = 'workspace-primary'; preview.append(confirm); preview.firstElementChild.tabIndex = -1; preview.firstElementChild.focus({ preventScroll: true }); preview.scrollIntoView({ block: 'start' });
    }
    const file = node('input'); file.type = 'file'; file.accept = '.json,application/json'; file.id = 'backupCenterFile'; file.hidden = true;
    file.addEventListener('change', async () => {
      const sequence = ++importSequence, selected = file.files?.[0]; if (!selected) return;
      preview.hidden = true; previewToken = null;
      try { if (selected.size > api.MAX_BYTES) throw new Error('Choose a personal backup smaller than 4 MB of text.'); const text = await selected.text(); if (sequence !== importSequence) return; const value = await restorer.preview(text); if (sequence !== importSequence) return; showPreview(value); status.className = ''; status.textContent = 'Backup read and validated. Review every selected collection before replacing.'; }
      catch (error) { if (sequence === importSequence) message(error); }
    });
    const actions = node('div', undefined, 'workspace-actions');
    actions.append(control('Export selected collections', async () => {
      const names = [...scope.querySelectorAll('[data-backup-collection]:checked')].map(input => input.dataset.backupCollection), collections = {};
      if (!names.length) throw new Error('Choose at least one collection to export.');
      for (const name of names) collections[name] = await portable[name]();
      const backup = api.create(collections, { parse, sanitizeNotes: sanitizeNoteHtml }); download(JSON.stringify(backup, null, 2), 'olanga-personal-backup.json'); status.className = ''; status.textContent = 'Backup download requested. Keep this file private; Olanga does not upload it.';
    }, 'backupCenterExport'), control('Choose backup to restore', () => { file.value = ''; file.click(); }, 'backupCenterImport'));
    const recovery = node('section'); recovery.id = 'backupCenterRecovery';
    function refreshRecovery() {
      recovery.replaceChildren(); const raw = restorer.recoveryText(); if (raw === null) return;
      recovery.append(node('h3', 'Latest pre-restore recovery copy'), node('p', 'Original selected data is kept on this device before replacement. This copy can contain older private content. Download or delete it here; the next restore replaces this copy.', 'workspace-help'));
      recovery.append(control('Download recovery copy', () => download(raw, 'olanga-personal-recovery.json'), 'backupCenterRecoveryDownload'), control('Review original collections', async () => showPreview(await restorer.previewRecovery()), 'backupCenterRecoveryReview'), control('Delete recovery copy', () => { if (confirm('Permanently delete this pre-restore copy? Current personal data is unchanged.')) { restorer.deleteRecovery(); refreshRecovery(); } }, 'backupCenterRecoveryDelete'));
    }
    const close = control('Close', () => { if (isBusy()) throw new Error('Wait for the restore to finish before closing.'); dialog.close(); }, 'backupCenterClose');
    dialog.addEventListener('cancel', event => { if (isBusy()) event.preventDefault(); });
    dialog.addEventListener('close', () => { dialog.remove(); if (currentDialog === dialog) { ++importSequence; currentDialog = null; if (previous?.isConnected) previous.focus(); } }, { once: true });
    const header = node('header'); header.append(heading, close); dialog.append(header, detail, scope, actions, file, status, preview, recovery); document.body.append(dialog); refreshRecovery(); dialog.showModal(); heading.tabIndex = -1; heading.focus({ preventScroll: true }); dialog.scrollTop = 0;
  }
  window.OlangaBackupCenter = { open, isBusy, export: async names => { const collections = {}; for (const name of names) { if (!portable[name]) throw new Error('Unknown backup collection.'); collections[name] = await portable[name](); } return api.create(collections, { parse, sanitizeNotes: sanitizeNoteHtml }); }, preview: text => restorer.preview(text) };
  window.openOlangaBackups = open;
})();
