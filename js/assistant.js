/* ============================================
   OLANGA — GEMINI ASSISTANT

   Restored to the proven Gemini 2.5 + bracket-command flow
   (google_search only). The Gemini 3 function-calling path was
   burning rate limits and stalling in THINKING.
   ============================================ */

const GEMINI_AUDIO_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_TEXT_MODEL = 'gemini-2.5-flash';

function buildOlangaSystemInstruction(inputMode) {
  let locationContext = '';
  if (userCity || userState || userCountry) {
    locationContext = `\nThe user is currently located in: ${[userCity, userState, userCountry].filter(Boolean).join(', ')}.`;
  }

  const currentTime = new Date().toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short'
  });
  const timeContext = `\nThe current local time for the user is: ${currentTime}. Use this exact time and location for all temporal or local queries.`;

  const inputContext = inputMode === 'audio'
    ? `The user will provide an audio clip of them speaking. Transcribe what they said, and respond to their request.
If the audio is completely silent, or contains no decipherable speech, you MUST respond exactly with "RESPONSE: [SILENCE]" and do nothing else.`
    : `The user will provide a text message. Respond to their request.`;

  const userSaidHint = inputMode === 'audio'
    ? 'transcribe exactly what the user said in the audio'
    : "the user's text message here";

  return `You are Olanga, a simple, chill, and obedient AI voice assistant.
The user is your boss. Refer to them as "Boss". Keep your answers concise, direct, and conversational.
Use a relaxed, natural speaking style. Don't sound like a robot. Use conversational fillers naturally, BUT do NOT say "Let me check" or "I'll look that up". Just give the grounded answer immediately.
You have FULL ACCESS to Google Search via the google_search tool. You MUST use your search tool to provide accurate, real-time answers for weather, news, sports, and current events. IMPORTANT: When reporting weather or temperature, ALWAYS use Fahrenheit unless the user specifically asks for Celsius.${locationContext}${timeContext}
${inputContext}

IMPORTANT VISION INSTRUCTIONS:
If the user asks you to look at something on their screen, or mentions an error, image, or anything visual that you would need to see to answer, AND there is no image attached to the prompt, output EXACTLY the command [REQUEST_SCREENSHOT] and nothing else.
HOWEVER, if there is ALREADY an image attached to the prompt, you MUST NOT output [REQUEST_SCREENSHOT]. Instead, you must look at the attached image and answer the user's question directly!

IMPORTANT SPOTIFY INSTRUCTIONS:
You HAVE FULL CAPABILITY to play music, songs, artists, playlists, and albums on Spotify. Whenever the user asks you to play any of these, you MUST comply and output the command [SPOTIFY_TYPE: Search Term] in your RESPONSE. NEVER say you cannot play music or control Spotify, because you can. Do not use quotes inside the command.
For "TYPE", use SONG, ALBUM, PLAYLIST, or ARTIST.
Example for a song: "I'll play that for you right now. [SPOTIFY_SONG: Shape of You by Ed Sheeran]"
Example for an album: "Playing the album right now. [SPOTIFY_ALBUM: The Dark Side of the Moon by Pink Floyd]"
Example for an artist: "Here is some music by Drake. [SPOTIFY_ARTIST: Drake]"
Example for a playlist: "Playing your playlist now. [SPOTIFY_PLAYLIST: Liked Songs]"
If the user asks to reload Spotify, restart Spotify and resume the current song by outputting [SPOTIFY_RELOAD].

IMPORTANT MEDIA AND SYSTEM CONTROLS:
You can control the system's volume and media playback. Whenever the user asks you to pause, play, skip, or change the volume, output the exact corresponding command in your RESPONSE:
- Pause or Resume playback: [MEDIA_PLAY_PAUSE]
- Next Track or Skip: [MEDIA_NEXT]
- Previous Track: [MEDIA_PREV]
- Reload Spotify and resume the current song: [SPOTIFY_RELOAD]
- Volume Up: [VOLUME_UP]
- Volume Down: [VOLUME_DOWN]
- Mute or Unmute Volume: [VOLUME_MUTE]
Example: "I'll turn that down for you. [VOLUME_DOWN]"
Example: "Skipping to the next song. [MEDIA_NEXT]"

IMPORTANT MIC & TTS CONTROLS:
You can control both your microphone and your text-to-speech voice. Use these commands exactly:
- Mute microphone: [MUTE_MIC]
- Unmute microphone: [UNMUTE_MIC]
- Silence yourself (disable TTS / speak no more): [MUTE_TTS]
- Unsilence yourself (re-enable TTS): [UNMUTE_TTS]
Example: "I'll mute myself now. [MUTE_MIC]"
Example: "Going silent. [MUTE_TTS]"
Example: "I'm back. [UNMUTE_TTS]"

IMPORTANT TIMER CONTROLS:
You can set, cancel, or stop timers. When the user asks you to set a timer, determine the duration in seconds and the name/label they specified (default to "Timer" if none specified), and output the exact command [SET_TIMER: duration, label] in your RESPONSE. If the user asks to cancel or delete a timer, output [CANCEL_TIMER: label] in your RESPONSE.
Example: "Setting a timer for 3 minutes named brush. [SET_TIMER: 180, brush]"
Example: "Timer set for 10 seconds. [SET_TIMER: 10, Timer]"
Example: "Cancelling your brush timer. [CANCEL_TIMER: brush]"

IMPORTANT TASK / CHECKLIST CONTROLS:
You can manage the user's checklist/tasks. When the user asks you to add, remove, complete, or update a task, output the exact corresponding command in your RESPONSE.
CRITICAL RULES:
1. If the user says "mark as complete", "check off", "done", "finish" or similar WITHOUT specifying which task by name, you MUST ask which task via [FOLLOW_UP]. NEVER guess.
2. If the user says "remove" or "cancel" a task WITHOUT specifying which task, you MUST ask which one via [FOLLOW_UP].
3. NEVER say you completed or removed a task unless you are outputting the actual command to do so.

- Add a task: [ADD_TASK: text, optional_due_date]
- Remove/delete a task: [REMOVE_TASK: text_or_id]
- Mark a task as complete/done: [COMPLETE_TASK: text_or_id]
- Unmark / mark incomplete: [UNCOMPLETE_TASK: text_or_id]
- Clear all tasks: [CLEAR_ALL_TASKS]
- Set task due date: [SET_TASK_DUE: text_or_id, due_date]
Example: "Adding buy milk to your checklist. [ADD_TASK: buy milk]"
Example: "Removing the buy milk task. [REMOVE_TASK: buy milk]"
Example: "Marked buy milk as done. [COMPLETE_TASK: buy milk]"
Example: "Clearing all tasks for you. [CLEAR_ALL_TASKS]"
Example: "Which task would you like me to mark as complete? [FOLLOW_UP]"

IMPORTANT SYSTEM LAUNCH CONTROLS:
You HAVE FULL CAPABILITY to open or launch applications on the user's computer. Whenever the user asks you to open an app (e.g. Discord, Chrome, Word, etc.), you MUST output the command [OPEN_APP: AppName] in your RESPONSE. NEVER say you cannot open apps.
Example: "Opening Discord for you now. [OPEN_APP: Discord]"
Example: "I'll launch Chrome right away. [OPEN_APP: Google Chrome]"

You can also CLOSE or QUIT applications. Whenever the user asks you to close, quit, exit, or shut down an app, you MUST output the command [CLOSE_APP: AppName] in your RESPONSE. NEVER say you cannot close apps. Use the app's normal name, not its executable. Only real applications can be closed — never Olanga itself, File Explorer, or parts of Windows.
Example: "Closing Discord now. [CLOSE_APP: Discord]"
Example: "Shutting down Chrome for you. [CLOSE_APP: Google Chrome]"

IMPORTANT FOLLOW-UP:
If you need more information from the user to complete their request (e.g. you need to know which timer, which task, a clarification, a name, etc.), you MUST output the command [FOLLOW_UP] at the END of your RESPONSE. This will open a 5-second microphone window for them to answer. Only use this when genuinely needed.
Example: "Which timer would you like me to cancel? [FOLLOW_UP]"
Example: "Got it, what should I name the task? [FOLLOW_UP]"

Your response will be spoken aloud, so do NOT use markdown, bullet points, code blocks, or any visual formatting.

Format your response EXACTLY like this:
USER_SAID: [${userSaidHint}]
RESPONSE: [your conversational response]`;
}

async function callGeminiGenerate(model, body) {
  let keysTriedThisCall = 0;
  const maxKeyAttempts = apiKeyRotation ? apiKeys.length : 1;

  for (let attempt = 0; attempt < 3; attempt++) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (response.status === 429) {
      if (apiKeyRotation && keysTriedThisCall < maxKeyAttempts - 1) {
        currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
        apiKey = apiKeys[currentKeyIndex];
        keysTriedThisCall++;
        console.log(`[Olanga] Rate limited! Rotating to Key ${currentKeyIndex + 1}...`);
        continue;
      }
      const waitTime = (attempt + 1) * 15;
      console.log(`[Olanga] Rate limited. Waiting ${waitTime}s...`);
      await new Promise(r => setTimeout(r, waitTime * 1000));
      keysTriedThisCall = 0;
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      let errMsg;
      try {
        const errData = JSON.parse(errText);
        errMsg = `Google API Error ${errData?.error?.code}: ${errData?.error?.message}`;
      } catch {
        errMsg = `HTTP ${response.status}: ${errText.substring(0, 200)}`;
      }
      throw new Error(errMsg);
    }

    const data = await response.json();
    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text.trim();
    }
    throw new Error('No response from Gemini');
  }

  throw new Error('Rate limited across all keys. Please try again later.');
}

async function sendAudioToGemini(base64Audio, base64Image = null, userSaidContext = null) {
  const requestParts = [];

  if (base64Audio) {
    requestParts.push({ inline_data: { mime_type: 'audio/wav', data: base64Audio } });
  }

  if (base64Image) {
    const justData = base64Image.split(',')[1];
    requestParts.push({ inline_data: { mime_type: 'image/png', data: justData } });
  }

  let textPrompt = `Context: ${buildHistoryContext()}\nPlease process the attached audio.`;
  if (base64Image && userSaidContext) {
    textPrompt = `Context: ${buildHistoryContext()}\nThe user previously asked: "${userSaidContext}". Here is the screenshot they just provided for you to look at. Answer their original question.`;
  }
  requestParts.push({ text: textPrompt });

  return callGeminiGenerate(GEMINI_AUDIO_MODEL, {
    system_instruction: { parts: [{ text: buildOlangaSystemInstruction('audio') }] },
    tools: [{ google_search: {} }],
    contents: [{ parts: requestParts }],
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 400
    }
  });
}

async function sendTextToGemini(textInput, base64Image = null) {
  const requestParts = [];

  if (base64Image) {
    const justData = base64Image.split(',')[1];
    requestParts.push({ inline_data: { mime_type: 'image/png', data: justData } });
  }

  let textPrompt = `Context: ${buildHistoryContext()}\nThe user typed: "${textInput}". Please respond.`;
  if (base64Image) {
    textPrompt = `Context: ${buildHistoryContext()}\nThe user typed: "${textInput}". Here is the screenshot they just provided for you to look at. Answer their request.`;
  }
  requestParts.push({ text: textPrompt });

  return callGeminiGenerate(GEMINI_TEXT_MODEL, {
    system_instruction: { parts: [{ text: buildOlangaSystemInstruction('text') }] },
    tools: [{ google_search: {} }],
    contents: [{ parts: requestParts }],
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 400
    }
  });
}

function buildHistoryContext() {
  let context = '';

  if (activeTasks && activeTasks.length > 0) {
    const taskNames = activeTasks.map(t => `- "${t.text}" (Completed: ${t.completed})`).join('\n');
    context += `CURRENT TASKS:\n${taskNames}\n\n`;
  }

  if (conversationHistory.length > 0) {
    const recent = conversationHistory.slice(-6);
    const lines = recent.map(m => `${m.role === 'user' ? 'User' : 'Olanga'}: ${m.text}`);
    context += `Recent conversation:\n${lines.join('\n')}`;
  }

  return context;
}

function parseResponse(raw) {
  let userSaid = '';
  let response = raw;

  const userMatch = raw.match(/USER_SAID:\s*(.+?)(?:\n|RESPONSE:)/is);
  const responseMatch = raw.match(/RESPONSE:\s*(.+)/is);

  if (userMatch) {
    userSaid = userMatch[1].trim();
  }

  if (responseMatch) {
    response = responseMatch[1].trim();
  } else if (userMatch) {
    response = raw.substring(raw.indexOf(userMatch[0]) + userMatch[0].length).trim();
  }

  return { userSaid, response };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Strip bracket commands and execute side effects. Returns { spokenResponse, wantsFollowUp }.
function applyAssistantCommands(spokenResponse) {
  const openAppMatch = spokenResponse.match(/\[OPEN_APP:\s*([^\]]+)\]/i);
  if (openAppMatch) {
    const appName = openAppMatch[1].trim();
    console.log(`[Olanga] 🖥️ Opening App: ${appName}`);
    window.electronAPI.openApp(appName);
    spokenResponse = spokenResponse.replace(openAppMatch[0], '').trim();
    if (!spokenResponse) spokenResponse = `Opening ${appName} for you now.`;
  }

  const closeAppMatch = spokenResponse.match(/\[CLOSE_APP:\s*([^\]]+)\]/i);
  if (closeAppMatch) {
    const appName = closeAppMatch[1].trim();
    console.log(`[Olanga] 🛑 Closing App: ${appName}`);
    window.electronAPI.closeApp(appName)
      .then((result) => {
        if (result?.ok) {
          console.log(`[Olanga] Closed ${result.closed}${result.forced ? ' (forced)' : ''}`);
        } else {
          console.warn(`[Olanga] Nothing open matched "${appName}"`);
          if (typeof showError === 'function') showError(`No open ${appName} window to close`);
        }
      })
      .catch((error) => console.error('[Olanga] Close app failed:', error));
    spokenResponse = spokenResponse.replace(closeAppMatch[0], '').trim();
    if (!spokenResponse) spokenResponse = `Closing ${appName} now.`;
  }

  const spotifyMatch = spokenResponse.match(/\[SPOTIFY_(SONG|ALBUM|PLAYLIST|ARTIST):\s*([^\]]+)\]/i);
  if (spotifyMatch) {
    const type = spotifyMatch[1].toUpperCase();
    const searchTerm = spotifyMatch[2].trim().replace(/^"|"$/g, '');
    console.log(`[Olanga] 🎵 Requesting Spotify play for ${type}: ${searchTerm}`);
    window.electronAPI.playSpotify(type, searchTerm);
    spokenResponse = spokenResponse.replace(spotifyMatch[0], '').trim();
    if (!spokenResponse) spokenResponse = `Playing your request on Spotify.`;
  }

  const spotifyReloadMatch = spokenResponse.match(/\[SPOTIFY_RELOAD\]/i);
  if (spotifyReloadMatch) {
    console.log('[Olanga] 🔄 Reloading Spotify and resuming playback');
    window.electronAPI.reloadSpotify();
    spokenResponse = spokenResponse.replace(spotifyReloadMatch[0], '').trim();
    if (!spokenResponse) spokenResponse = 'Reloading Spotify and resuming playback.';
  }

  const mediaRegex = /\[(MEDIA_PLAY_PAUSE|MEDIA_NEXT|MEDIA_PREV|VOLUME_UP|VOLUME_DOWN|VOLUME_MUTE)\]/ig;
  let mediaMatch;
  while ((mediaMatch = mediaRegex.exec(spokenResponse)) !== null) {
    const command = mediaMatch[1].toUpperCase();
    console.log(`[Olanga] 🎛️ Media control requested: ${command}`);
    window.electronAPI.mediaControl(command);
  }
  spokenResponse = spokenResponse.replace(mediaRegex, '').trim();

  const micMuteRegex = /\[(MUTE_MIC|UNMUTE_MIC|MUTE_TTS|UNMUTE_TTS)\]/ig;
  let micMuteMatch;
  while ((micMuteMatch = micMuteRegex.exec(spokenResponse)) !== null) {
    const command = micMuteMatch[1].toUpperCase();
    console.log(`[Olanga] 🎙️ Audio control requested: ${command}`);
    if (command === 'MUTE_MIC') muteMic();
    else if (command === 'UNMUTE_MIC') unmuteMic();
    else if (command === 'MUTE_TTS') muteTts();
    else if (command === 'UNMUTE_TTS') unmuteTts();
  }
  spokenResponse = spokenResponse.replace(micMuteRegex, '').trim();

  const setTimerMatch = spokenResponse.match(/\[SET_TIMER:\s*(\d+),\s*([^\]]+)\]/i);
  if (setTimerMatch) {
    const duration = parseInt(setTimerMatch[1]);
    const label = setTimerMatch[2].trim();
    console.log(`[Olanga] ⏱️ Timer requested: ${duration}s, labeled: ${label}`);
    createTimer(duration, label);
    spokenResponse = spokenResponse.replace(setTimerMatch[0], '').trim();
  }

  const cancelTimerMatch = spokenResponse.match(/\[CANCEL_TIMER:\s*([^\]]+)\]/i);
  if (cancelTimerMatch) {
    const label = cancelTimerMatch[1].trim();
    console.log(`[Olanga] ⏱️ Cancel timer requested: ${label}`);
    cancelTimerByLabel(label);
    spokenResponse = spokenResponse.replace(cancelTimerMatch[0], '').trim();
  }

  const addTaskMatch = spokenResponse.match(/\[ADD_TASK:\s*([^,\]]+)(?:,\s*([^\]]+))?\]/i);
  if (addTaskMatch) {
    const text = addTaskMatch[1].trim();
    const dueDate = addTaskMatch[2] ? addTaskMatch[2].trim() : null;
    console.log(`[Olanga] 📋 Task add requested: "${text}", due: ${dueDate}`);
    addTask(text, dueDate);
    spokenResponse = spokenResponse.replace(addTaskMatch[0], '').trim();
  }

  const removeTaskMatch = spokenResponse.match(/\[REMOVE_TASK:\s*([^\]]+)\]/i);
  if (removeTaskMatch) {
    const target = removeTaskMatch[1].trim();
    console.log(`[Olanga] 📋 Task remove requested for: "${target}"`);
    removeTask(target);
    spokenResponse = spokenResponse.replace(removeTaskMatch[0], '').trim();
  }

  const clearTasksMatch = spokenResponse.match(/\[CLEAR_ALL_TASKS\]/i);
  if (clearTasksMatch) {
    console.log(`[Olanga] 📋 Task clear all requested`);
    clearAllTasks();
    spokenResponse = spokenResponse.replace(clearTasksMatch[0], '').trim();
  }

  const setTaskDueMatch = spokenResponse.match(/\[SET_TASK_DUE:\s*([^,\]]+),\s*([^\]]+)\]/i);
  if (setTaskDueMatch) {
    const target = setTaskDueMatch[1].trim();
    const dueDate = setTaskDueMatch[2].trim();
    console.log(`[Olanga] 📋 Task due date update requested for: "${target}" to "${dueDate}"`);
    setTaskDue(target, dueDate);
    spokenResponse = spokenResponse.replace(setTaskDueMatch[0], '').trim();
  }

  const completeTaskMatch = spokenResponse.match(/\[COMPLETE_TASK:\s*([^\]]+)\]/i);
  if (completeTaskMatch) {
    const target = completeTaskMatch[1].trim();
    console.log(`[Olanga] 📋 Task complete requested for: "${target}"`);
    completeTask(target, true);
    spokenResponse = spokenResponse.replace(completeTaskMatch[0], '').trim();
  }

  const uncompleteTaskMatch = spokenResponse.match(/\[UNCOMPLETE_TASK:\s*([^\]]+)\]/i);
  if (uncompleteTaskMatch) {
    const target = uncompleteTaskMatch[1].trim();
    console.log(`[Olanga] 📋 Task uncomplete requested for: "${target}"`);
    completeTask(target, false);
    spokenResponse = spokenResponse.replace(uncompleteTaskMatch[0], '').trim();
  }

  const followUpRegex = /\[FOLLOW[_ ]?UP\]/gi;
  const wantsFollowUp = followUpRegex.test(spokenResponse) || spokenResponse.trim().endsWith('?');
  spokenResponse = spokenResponse.replace(/\[FOLLOW[_ ]?UP\]/gi, '').trim();

  return { spokenResponse, wantsFollowUp };
}

async function finishAssistantTurn(spokenResponse, wantsFollowUp) {
  conversationHistory.push({ role: 'model', text: spokenResponse });
  if (conversationHistory.length > 20) {
    conversationHistory = conversationHistory.slice(-16);
  }

  aiText.textContent = spokenResponse;
  transcriptAi.classList.remove('hidden');

  if (wantsFollowUp) {
    console.log('[Olanga] 🔁 AI requested a follow-up from the user');
    await speakResponseAndThen(spokenResponse, () => enterAiFollowUpMode());
  } else {
    speakResponse(spokenResponse);
  }
}

async function processAudioBlobWithGemini(blob) {
  try {
    const base64Audio = await blobToBase64(blob);
    console.log(`[Olanga] 🚀 Dispatching exactly ONE request to Gemini API (Payload size: ${Math.round(base64Audio.length / 1024)} KB)...`);

    let response = await sendAudioToGemini(base64Audio);
    console.log('[Olanga DEBUG] Raw Gemini response:', JSON.stringify(response));

    let parsed = parseResponse(response);
    console.log('[Olanga DEBUG] Parsed response:', JSON.stringify(parsed.response));

    if (parsed.response.trim() === '[SILENCE]') {
      console.log('[Olanga] 🤐 Model heard nothing but silence/noise. Returning to IDLE.');
      setState(State.IDLE);
      return;
    }

    userText.textContent = parsed.userSaid || 'Audio received';
    transcriptUser.classList.remove('hidden');
    if (parsed.userSaid) {
      conversationHistory.push({ role: 'user', text: parsed.userSaid });
    }

    let spokenResponse = parsed.response;

    if (spokenResponse.includes('[REQUEST_SCREENSHOT]')) {
      console.log(`[Olanga] 📸 Screenshot requested by AI`);
      aiText.textContent = 'Please select an area on your screen...';
      transcriptAi.classList.remove('hidden');
      const base64Image = await window.electronAPI.requestScreenshot();
      if (!base64Image) {
        console.log(`[Olanga] 📸 Screenshot cancelled by user or timed out`);
        aiText.textContent = 'Screenshot cancelled.';
        setState(State.IDLE);
        return;
      }
      aiText.textContent = 'Processing image...';
      const secondResponseRaw = await sendAudioToGemini(base64Audio, base64Image, parsed.userSaid);
      parsed = parseResponse(secondResponseRaw);
      spokenResponse = parsed.response;
    }

    const applied = applyAssistantCommands(spokenResponse);
    await finishAssistantTurn(applied.spokenResponse, applied.wantsFollowUp);
  } catch (error) {
    console.error('[Olanga] ❌ Processing error:', error);
    showError(error.message || 'Failed to process audio');
    setState(State.IDLE);
  }
}

async function processTextCommandWithGemini(userTextInput) {
  if (!apiKey) {
    showError('Please configure your Gemini API key in settings');
    return;
  }
  if (!userTextInput.trim()) return;

  if (isRecording) {
    cancelRecording();
  }

  if (followUpTimer) {
    clearTimeout(followUpTimer);
    followUpTimer = null;
  }

  setState(State.THINKING);
  hint.classList.add('hidden');

  try {
    console.log('[Olanga] 🚀 Dispatching TEXT request to Gemini API...');

    let response = await sendTextToGemini(userTextInput);
    console.log('[Olanga DEBUG] Raw Gemini response (text):', JSON.stringify(response));

    let parsed = parseResponse(response);

    userText.textContent = userTextInput;
    transcriptUser.classList.remove('hidden');
    conversationHistory.push({ role: 'user', text: userTextInput });

    let spokenResponse = parsed.response;

    if (spokenResponse.includes('[REQUEST_SCREENSHOT]')) {
      console.log(`[Olanga] 📸 Screenshot requested by AI`);
      aiText.textContent = 'Please select an area on your screen...';
      transcriptAi.classList.remove('hidden');
      const base64Image = await window.electronAPI.requestScreenshot();
      if (!base64Image) {
        console.log(`[Olanga] 📸 Screenshot cancelled by user or timed out`);
        aiText.textContent = 'Screenshot cancelled.';
        setState(State.IDLE);
        return;
      }
      aiText.textContent = 'Processing image...';
      const secondResponseRaw = await sendTextToGemini(userTextInput, base64Image);
      parsed = parseResponse(secondResponseRaw);
      spokenResponse = parsed.response;
    }

    const applied = applyAssistantCommands(spokenResponse);
    await finishAssistantTurn(applied.spokenResponse, applied.wantsFollowUp);
  } catch (error) {
    console.error('[Olanga] ❌ Processing error:', error);
    showError(error.message || 'Failed to process text');
    setState(State.IDLE);
  }
}
