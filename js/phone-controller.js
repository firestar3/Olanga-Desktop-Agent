/* A paired phone can request only the main-process validated local command. */
(function () {
  const api = window.electronAPI; if (!api?.onPhoneCommand) return;
  let active = null;
  const deliveries = new Map();
  const failed = message => ({ ok: false, verified: false, message });
  api.onPhoneCommand(async payload => {
    if (!payload || typeof payload.requestId !== 'string' || deliveries.has(payload.requestId)) return;
    const delivery = { cancelled: false }; deliveries.set(payload.requestId, delivery);
    let request;
    try {
      if (!await api.phoneClaim(payload.requestId)) return;
      if (delivery.cancelled) { await api.phoneComplete({ requestId: payload.requestId, result: failed('Phone control stopped before this command began.') }); return; }
      if (active || currentState !== State.IDLE || window.OlangaDesktop?.isBusy?.() || document.querySelector('dialog[open]') || window.OlangaLiveConversation?.isActive?.()) { await api.phoneComplete({ requestId: payload.requestId, result: failed('Olanga is busy or waiting for a review. Finish it on the desktop first.') }); return; }
      const actions = typeof payload.text === 'string' && payload.text.length <= 300 && !/[\[\]\x00-\x1f]/.test(payload.text) && typeof OlangaIntents !== 'undefined' ? OlangaIntents.parse(payload.text) : null;
      if (!actions || actions.length !== 1 || actions[0].command !== payload.command) throw new Error('This phone command does not match the reviewed request.');
      if (!/^\[(?:OPEN_APP: [^\]\r\n]+|VOLUME_SET: \d+(?:\.\d+)?|VOLUME_(?:UP|DOWN|MUTE_ON|MUTE_OFF)|SET_TIMER: \d+, [^\]\r\n]+)\]$/.test(payload.command)) throw new Error('This phone command is unsupported.');
      request = beginAssistantRequest(); active = { id: payload.requestId, request };
      userText.textContent = `Phone: ${payload.text}`; transcriptUser.classList.remove('hidden');
      acknowledgeAssistantRequest(request, { speak: false }); setAssistantPlan(request, [payload.command]); updateAssistantStep(request, 0, 'working');
      const beforeTimers = new Set(typeof activeTimers !== 'undefined' ? activeTimers.map(timer => timer.id) : []);
      const timerStartedAt = Date.now();
      const outcome = await applyAssistantCommands(payload.command, request); assertAssistantRequest(request);
      const result = outcome.results[0]; let verified = result?.verified === true;
      if (payload.command.startsWith('[SET_TIMER:') && result?.ok) {
        verified = false;
        const match = /^\[SET_TIMER: (\d+), (.+)\]$/.exec(payload.command);
        try {
          const saved = JSON.parse(localStorage.getItem(TIMERS_STORAGE_KEY) || '[]');
          verified = !!match && activeTimers.some(timer => !beforeTimers.has(timer.id) && timer.label === match[2] && timer.endTime >= timerStartedAt + Number(match[1]) * 1000 && timer.endTime <= Date.now() + Number(match[1]) * 1000 && Array.isArray(saved) && saved.some(record => record.id === timer.id && record.label === timer.label && record.endTime === timer.endTime));
        } catch (_) { /* In-memory timers still work; persistence is not verified. */ }
      }
      const receipt = { ok: result?.ok === true, verified, message: (result?.message || outcome.spokenResponse || 'No result was confirmed.').slice(0, 2000) };
      updateAssistantStep(request, 0, !receipt.ok ? 'failed' : verified ? 'completed' : 'unverified'); assistantTurns?.actionsFinished(request.turnId);
      aiText.textContent = receipt.message; transcriptAi.classList.remove('hidden'); completeAssistantRequest(request, receipt.ok ? 'completed' : 'failed'); setState(State.IDLE);
      await api.phoneComplete({ requestId: payload.requestId, result: receipt });
    } catch (error) {
      if (request && assistantCurrentRequest === request) { completeAssistantRequest(request, error.name === 'AbortError' ? 'cancelled' : 'failed'); setState(State.IDLE); }
      await api.phoneComplete({ requestId: payload.requestId, result: failed(error.name === 'AbortError' ? 'The command stopped. Check any action already sent before retrying.' : error.message || 'The command failed.') }).catch(() => {});
    } finally { if (request && active?.request === request) active = null; if (deliveries.get(payload.requestId) === delivery) deliveries.delete(payload.requestId); }
  });
  api.onPhoneCancel(id => { const delivery = deliveries.get(id); if (delivery) delivery.cancelled = true; if (active?.id === id && assistantCurrentRequest === active.request) { cancelAssistantRequest(); setState(State.IDLE); } });
})();
