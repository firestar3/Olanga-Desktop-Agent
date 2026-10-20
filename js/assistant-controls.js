/* Direct-user conversation controls. No model output or document text enters here. */
let assistantMemoryReplacement = null;
let lastAssistantResult = null;

function assistantMemoryState() {
  const store = window.OlangaWorkspace;
  return store?.memorySnapshot?.() || store?.snapshot?.() || { facts: [], factsEnabled: true };
}

function hasAssistantReview() {
  return !!(window.OlangaRoutineControl?.hasReview() || window.OlangaWorkspaces?.hasReview() || assistantMemoryReplacement?.prompted);
}

function interruptAssistantForFollowUp() {
  // Stop work immediately, retain only the existing bounded conversational target.
  // New input still passes ordinary validation and never replays completed steps.
  cancelAssistantRequest({ preserveContext: true, preserveReviews: true });
}

function selectedAssistantMemories(query) {
  const store = window.OlangaWorkspace;
  if (!store) return [];
  const goal = query ?? assistantCurrentRequest?.goal ?? conversationHistory.findLast(item => item.role === 'user')?.text ?? '';
  const selected = store.relevantContext
    ? store.relevantContext(goal, { maxFacts: 8, maxChars: 1800 })
    : assistantMemoryState().factsEnabled === false ? [] : assistantMemoryState().facts.map(({ id, text }) => ({ id, text }));
  const excluded = new Set(assistantCurrentRequest?.excludedMemoryIds || []);
  const facts = selected.filter(item => !excluded.has(item.id));
  // The action specialist also selects context directly, without going through
  // buildHistoryContext. Every selected identity must participate in revocation.
  markMemoryContextUsed(facts.map(item => item.id));
  window.OlangaMemoryView?.used(facts);
  return facts;
}

function learnAssistantInput(text, request) {
  if (request?.learnedInputText === text) return request.learnedInput;
  if (!request || request.signal.aborted || typeof text !== 'string') return null;
  request.goal = text;
  request.learnedInputText = text;
  request.updatingMemory = true;
  try {
    const learned = window.OlangaWorkspace?.learnFromUserText?.(text);
    request.learnedInput = learned;
    if (learned?.learned?.length || learned?.updated?.length) {
      markMemoryContextUsed([...learned.learned, ...learned.updated].map(item => item.id));
      window.OlangaMemoryView?.learned(learned);
    }
    // A directly saved fact needs an explicit replacement choice, entirely by voice.
    const protectedSlot = learned?.skipped?.find(item => item.reason === 'manual-memory-exists');
    if (protectedSlot) {
      const candidates = typeof OlangaMemoryLearning !== 'undefined' ? OlangaMemoryLearning.extract(text) : [];
      const candidate = candidates.find(item => item.slot === protectedSlot.slot);
      const matches = assistantMemoryState().facts.filter(item => item.slot === protectedSlot.slot || !item.slot && OlangaMemoryLearning.mentionsSlot(item.text, protectedSlot.slot));
      request.excludedMemoryIds = [...new Set([...(request.excludedMemoryIds || []), ...matches.map(item => item.id)])];
      if (candidate && matches.length === 1 && OlangaMemoryLearning.classifyFact(matches[0].text)?.slot === protectedSlot.slot) {
        assistantMemoryReplacement = { id: matches[0].id, previous: matches[0].text, text: candidate.text, requestId: request.turnId, goal: text, at: Date.now(), prompted: false };
      } else if (candidate && matches.length) request.memoryConflictMessage = matches.length > 1
        ? 'Several saved memories describe that detail, so I kept them intact. Identify the exact complete memory to update by voice or in Memories.'
        : 'That saved memory also contains other details, so I kept it intact. You can update the complete memory by voice or in Memories.';
    }
    return learned;
  } finally { request.updatingMemory = false; }
}

function assistantMemoryReplacementQuestion(replacement) {
  return 'You previously saved “' + replacement.previous + '”. Should I replace it with “' + replacement.text + '”?';
}

// A mixed statement/request must receive its answer before memory housekeeping.
// Root calls this before recording the finished text; ordinary follow-up flags
// are preserved by OR-ing the returned wantsFollowUp with the existing flag.
function finalizeAssistantMemoryReplacement(text, request) {
  const result = { text, wantsFollowUp: false }, replacement = request?.deferredMemoryReplacement;
  if (!replacement) return result;
  request.deferredMemoryReplacement = null;
  const current = assistantMemoryState().facts.find(item => item.id === replacement.id);
  if (request.failed || request.signal.aborted || assistantMemoryReplacement !== replacement || replacement.requestId !== request.turnId || Date.now() - replacement.at > 60000 || current?.text !== replacement.previous) {
    if (assistantMemoryReplacement === replacement) assistantMemoryReplacement = null;
    return result;
  }
  replacement.prompted = true;
  markMemoryContextUsed([replacement.id]);
  return { text: String(text || '').trim() + '\n\n' + assistantMemoryReplacementQuestion(replacement), wantsFollowUp: true };
}

function decorateAssistantSnapshot(snapshot) {
  if (!snapshot) return null;
  const request = assistantCurrentRequest?.turnId === snapshot.id ? assistantCurrentRequest : null;
  const record = request || (lastAssistantResult?.turnId === snapshot.id ? lastAssistantResult : null);
  return { ...snapshot, resultText: record?.resultText || '', canRepeatResult: !!snapshot.outcome && !!record?.resultText,
    canReviewUnfinished: !!snapshot.outcome && !!record?.steps?.some(step => ['failed', 'skipped'].includes(step.state)) && Date.now() - (record.finishedAt || record.startedAt || 0) < 5 * 60000 };
}

function recordAssistantResult(request, text) {
  if (request) request.resultText = String(text || '').slice(0, 12000);
}

function retainAssistantResult(request) {
  if (!request?.resultText || request.repeatingResult || request.forgettingMemory || request.memoryInvalidated) return;
  const memoryIds = [...(request.contextMemoryIds || [])], used = new Set(memoryIds);
  const memoryFacts = (assistantMemoryState().facts || []).filter(item => used.has(item.id)).map(({ id, text }) => ({ id, text }));
  lastAssistantResult = { turnId: request.turnId, resultText: request.resultText, steps: (request.steps || []).map(step => ({ ...step })), memoryIds, memoryFacts, startedAt: request.startedAt, finishedAt: Date.now() };
  window.OlangaMemoryView?.used(memoryFacts);
}

async function repeatAssistantResult(request) {
  const record = lastAssistantResult, text = record?.resultText;
  if (!text) throw new Error('There is no previous result to read yet.');
  const turn = request || beginAssistantRequest();
  turn.repeatingResult = true;
  markMemoryContextUsed(record.memoryIds || []);
  await finishAssistantTurn(text, false, turn);
}

async function reviewAssistantUnfinished(request) {
  const record = lastAssistantResult;
  if (!record || Date.now() - record.finishedAt > 5 * 60000) throw new Error('That request is too old to resume. Please say the command again.');
  const eligible = record.steps.filter(step => ['failed', 'skipped'].includes(step.state));
  if (!eligible.length) throw new Error('There are no confirmed unfinished steps to review. Check any uncertain action before making a fresh request.');
  if (!window.reviewOlangaUnfinished) throw new Error('The review controls are still loading. Try again.');
  return window.reviewOlangaUnfinished({ steps: eligible.map(step => ({ ...step })), resultText: record.resultText }, request);
}

async function handleAssistantControl(goal, request) {
  if (window.OlangaBackupCenter?.isBusy()) throw new Error('Wait for the current backup restore to finish.');
  const reviewGoal = typeof OlangaConversationalControls !== 'undefined' ? OlangaConversationalControls.normalize?.(goal) ?? goal : goal;
  const clean = String(reviewGoal || '').trim().replace(/[.!?]+$/, '').toLowerCase();
  let message, followUp = false;
  if (assistantMemoryReplacement) {
    const replacement = assistantMemoryReplacement;
    if (Date.now() - replacement.at > 60000) assistantMemoryReplacement = null;
    else if (replacement.prompted && /^(?:yes|replace it|update it|yes[,]? update (?:it|my memory)|confirm)$/.test(clean)) {
      assistantMemoryReplacement = null;
      const fact = assistantMemoryState().facts.find(item => item.id === replacement.id);
      if (!fact || fact.text !== replacement.previous) throw new Error('That memory changed. Tell me the updated detail again.');
      request.updatingMemory = true;
      try { window.OlangaWorkspace.updateFact(fact.id, replacement.text); } finally { request.updatingMemory = false; }
      markMemoryContextUsed([fact.id]);
      message = 'Updated. ' + replacement.text + '.';
    } else if (replacement.prompted && /^(?:no|cancel|keep (?:it|the old memory))$/.test(clean)) { assistantMemoryReplacement = null; message = 'I kept the existing memory.'; }
    else if (replacement.requestId !== request.turnId || replacement.goal !== goal) assistantMemoryReplacement = null;
  }
  if (message) { await finishAssistantTurn(message, false, request); return true; }
  if (window.OlangaRoutineControl?.hasReview()) {
    const answer = await window.OlangaRoutineControl.answerReview(reviewGoal, request);
    if (answer.handled) { if (!answer.finished) await finishAssistantTurn(answer.message, !!window.OlangaRoutineControl.hasReview(), request); return true; }
    window.cancelRoutineReviews?.();
  }
  if (window.OlangaWorkspaces?.hasReview()) {
    const answer = await window.OlangaWorkspaces.answerReview(reviewGoal);
    if (answer.handled) { await finishAssistantTurn(answer.message || 'The workspace selection is updated.', !!window.OlangaWorkspaces.hasReview(), request); return true; }
    await window.OlangaWorkspaces.cancel();
  }
  const command = typeof OlangaConversationalControls !== 'undefined' ? OlangaConversationalControls.parse(goal) : null;
  const store = window.OlangaWorkspace;
  if (command) {
    switch (command.kind) {
      case 'stale-review-confirm': message = 'There is no open review to confirm. Say run routine followed by its name, or resume workspace followed by its name.'; break;
      case 'cancel-request': message = 'Cancelled. Completed actions stay completed.'; break;
      case 'routine-create': case 'routine-edit': {
        if (!window.openOlangaRoutineEditor) throw new Error('The routine editor is still loading.');
        message = window.openOlangaRoutineEditor(command.name, command.kind === 'routine-edit').message; break;
      }
      case 'routine-list': {
        const names = store.snapshot().routines.map(item => item.name); window.openOlangaWorkspace?.('1');
        message = names.length ? 'Your routines are ' + names.join(', ') + '. Say run routine followed by its name.' : 'You have no saved routines yet. Say create a routine to open the editor.'; break;
      }
      case 'routine-run': {
        const review = await window.reviewOlangaRoutine(command.name, request); request.awaitingInput = true;
        message = review?.message || 'Review the routine, then say run selected steps or cancel.'; followUp = true; break;
      }
      case 'learning-off': case 'learning-on':
        store.setLearningEnabled(command.kind === 'learning-on'); message = command.kind === 'learning-on' ? 'Learning is on. I will pick up clear preferences and everyday details from what you tell me.' : 'Learning is paused. Your existing saved memories are still available until you disable or delete them.'; break;
      case 'learning-undo':
        request.forgettingMemory = true; request.deletingMemory = true;
        try { store.undoLearnedMemory(); } finally { request.deletingMemory = false; }
        message = 'I undid the last memory I learned.'; break;
      case 'memory-list': message = describeUserFacts().message; window.openOlangaWorkspace?.('5'); break;
      case 'memory-used': {
        const current = assistantMemoryState().facts;
        const facts = (lastAssistantResult?.memoryFacts || []).filter(item => current.some(fact => fact.id === item.id && fact.text === item.text));
        markMemoryContextUsed(facts.map(item => item.id)); message = facts.length ? 'I used these saved details: ' + facts.map(item => item.text).join('; ') + '.' : 'No saved memories were used in the last answer.'; break;
      }
      case 'memory-update': {
        const facts = store.findFacts(command.previous);
        if (facts.length !== 1) throw new Error(facts.length ? 'More than one memory matches. Tell me the exact detail to update.' : 'I could not find that memory. Tell me the exact saved detail.');
        request.updatingMemory = true; try { store.updateFact(facts[0].id, command.text); } finally { request.updatingMemory = false; }
        markMemoryContextUsed([facts[0].id]); message = 'Memory updated: ' + command.text + '.'; break;
      }
      case 'workspace-save': case 'workspace-resume':
        if (!window.OlangaWorkspaces) throw new Error('Workspaces are still loading. Try again.');
        await window.OlangaWorkspaces[command.kind === 'workspace-save' ? 'save' : 'review'](command.name);
        message = command.kind === 'workspace-save' ? 'Choose the saved components for ' + command.name + '. You can say include window layout followed by its name, then save workspace.' : 'The fresh review for ' + command.name + ' is open. Say resume workspace or cancel.'; followUp = true; break;
      case 'workspace-list': window.openOlangaWorkbench?.('workspaces'); message = 'Your workspaces are open. Say resume workspace followed by its name.'; break;
      case 'backups': window.openOlangaBackups?.(); message = 'The personal backup and restore center is open.'; break;
      case 'health': window.OlangaAudioSetup?.open(); message = 'Voice setup and health controls are open. Choose your microphone or run a local phrase check.'; break;
      case 'repeat-result': await repeatAssistantResult(request); return true;
      case 'unfinished-review': {
        const review = await reviewAssistantUnfinished(request); message = review?.message || 'The unfinished steps are ready for review. Say run selected steps or cancel.'; followUp = true; break;
      }
    }
  } else {
    // A direct question about one unambiguous saved detail is already known.
    // Read current state here, never a cached answer, and retain revocation.
    const recalled = store?.recallFact?.(goal);
    if (recalled) {
      markMemoryContextUsed([recalled.id]);
      window.OlangaMemoryView?.used([{ id: recalled.id, text: recalled.text }]);
      await finishAssistantTurn(recalled.answer, false, request);
      return true;
    }
    if (!request.learnedInputText) learnAssistantInput(goal, request);
    if (assistantMemoryReplacement && assistantMemoryReplacement.requestId === request.turnId && assistantMemoryReplacement.goal === goal) {
      if (OlangaMemoryLearning.isFactOnly(goal)) {
        assistantMemoryReplacement.prompted = true; markMemoryContextUsed([assistantMemoryReplacement.id]);
        message = assistantMemoryReplacementQuestion(assistantMemoryReplacement); followUp = true;
      } else request.deferredMemoryReplacement = assistantMemoryReplacement;
    } else if (request.memoryConflictMessage && OlangaMemoryLearning.isFactOnly(goal)) {
      message = request.memoryConflictMessage;
    } else {
      const changed = [...(request.learnedInput?.learned || []), ...(request.learnedInput?.updated || [])];
      if (changed.length && (typeof OlangaMemoryLearning === 'undefined' || OlangaMemoryLearning.isFactOnly(goal))) message = (request.learnedInput.updated.length ? 'Updated my memory. ' : 'I will keep that in mind. ') + changed.map(item => item.text).join('; ') + '.';
    }
  }
  if (!message) return false;
  await finishAssistantTurn(message, followUp, request); return true;
}

function clearAssistantMemoryReplacement() { assistantMemoryReplacement = null; }
function invalidateRetainedAssistantMemory(removedIds) {
  if (lastAssistantResult?.memoryIds?.some(id => removedIds.has(id))) lastAssistantResult = null;
  const request = assistantCurrentRequest;
  if (request?.contextMemoryIds?.some(id => removedIds.has(id)) && !request.updatingMemory && !request.deletingMemory) {
    request.memoryInvalidated = true; request.resultText = '';
    if (request.terminalOutcome) {
      aiText.textContent = 'Memory updated. The previous reply has been cleared.';
      for (const listener of assistantTurnListeners) { try { listener(decorateAssistantSnapshot(assistantTurns?.snapshot())); } catch (_) {} }
    }
  }
  if (assistantMemoryReplacement && removedIds.has(assistantMemoryReplacement.id)) assistantMemoryReplacement = null;
}
window.addEventListener?.('olanga:personal-restore-start', () => {
  cancelAssistantRequest(); conversationHistory = []; lastAssistantResult = null;
});
