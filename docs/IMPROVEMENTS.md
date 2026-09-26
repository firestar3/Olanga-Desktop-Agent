# Improvements

This document describes the current source and the work still needed. An implemented feature is not a claim of compatibility with every Windows app. [Validation](VALIDATION.md) separates automated checks, native fixture tests, live provider checks and remaining coverage.

## Toward 2.0.0

### Where Olanga stands

[OpenJarvis](https://github.com/open-jarvis/OpenJarvis) (Stanford) frames personal AI as five layers: local models, an inference engine, agents, tools with memory, and a learning loop driven by local traces. Windows assistants such as [UFO²](https://github.com/microsoft/UFO), Ari and JarvisAi add persistent memory, MCP tools and natural local voices. Olanga already leads on verified action receipts, reviewed desktop edits and a zero-model local command path. It trails on local intelligence, personal context, proactive help, extensibility and conversational voice.

| Area | OpenJarvis and similar projects | Olanga now | 2.0 direction |
| --- | --- | --- | --- |
| Intelligence | Local models first; cloud optional | Local command matcher, then Gemini | Optional local engine for conversation; Gemini for vision and search |
| Personal context | Memory, document indexing | Explicit memories, saved names, 30-minute conversation | Local notes and document questions with citations |
| Proactive help | Scheduled agents, morning digest | Reminders, alarms, on-demand briefing | Opt-in scheduled briefing |
| Tools | MCP, agent-to-agent, skill catalogs | Closed, validated action vocabulary | MCP tools behind per-tool approval and receipts |
| Voice | Streaming, natural local speech, turn detection | Wake word, voice interruption, push-to-talk, adjustable end of speech | Streamed replies, a natural offline voice, semantic end of turn |
| Health and cost | `jarvis doctor`, cost per query | Health check, local timings, Gemini token counts | Cost per request and local-versus-cloud share |
| Distribution | One-line installers | Unsigned installer, manual update check | Signing, verified updates with rollback |

### First wave in this source

| Capability | What the user gains | Boundaries |
| --- | --- | --- |
| Instant local answers | Time, date, “what can you do” and “never mind” answer with no model call. “Never mind” also cancels a pending clarification. | Only exact phrasings; other questions still reach Gemini. Plain “cancel” keeps its previous meaning. |
| Reminders and alarms | “Remind me to stretch in 20 minutes”, “remind me at 5 PM to leave”, “set an alarm for 7 AM tomorrow”. “Stop” dismisses a ringing alarm. | At most one day ahead. Stored as timer records, so they survive a restart but cannot ring while Olanga is closed. Speech only while idle; overdue records ring without speaking. Plain “stop” still pauses music when nothing rings. |
| Explicit memories | “Remember that…”, “what do you remember”, “forget…” and a Workspace Memories tab. | Created only on request. At most 50 memories of 300 characters. Sent to Gemini as labeled data only while enabled; never authority to act. Model-routed saving is allowed only for an explicit request. |
| Daily briefing | “Brief me” speaks the time, open tasks, upcoming timers, reminders and headlines. | Read-only. Weather needs a key and location and uses one separate Search request. Slow or failed sources are left out. |
| Health check | Workspace → Health explains microphone, wake-word, speech, voice, Gemini, storage and shortcut problems with fixes. | Read-only. The optional connection test sends one short Gemini request. |
| Push-to-talk | A shortcut starts listening from any app, interrupts a reply, and sends on a second press. | Off by default. Only listed shortcuts register; conflicts are reported. Escape handling during desktop input is untouched. |
| Voice interruption | Saying “Hey Olanga” during a reply stops it and listens. | Greeting presets and multi-word custom phrases only, because Olanga's own voice reaches the microphone. Can be turned off. Not yet tested with a physical microphone. |
| End of speech | Quick (1 s) or Fast (0.7 s) pauses send spoken requests sooner. | Standard 1.5 s remains the default. |
| Duration grammar | “An hour and a half” and “two and a half hours” work locally. | A merged clause must still parse completely. |

Related fixes: “stop the timer” and “cancel the timer” previously became a request for a timer named “the”; they now dismiss what is ringing, cancel the only timer, or ask which one. Alarm beeps pause while Olanga records the user's voice, so end-of-speech detection can finish a spoken “stop”. The on-device command vocabulary is unchanged: extending it with alarm phrases made “and” transcribe as “an” and dropped the command benchmark from 7/7 to 3/7, so that change was reverted.

### Conversational latency

Before this change, a spoken question waited for:
- a fixed 1.5-second pause;
- a separate transcription call;
- a complete router reply before any speech.

A model-routed action added a second specialist call, and a weather question added a router call before the search call. The first request after idle also paid about 400 ms to open a connection.

| Change | Effect | Boundaries |
| --- | --- | --- |
| Streamed replies | Answers display and speak sentence by sentence instead of after the last word. | Streams serve answers only; markers in them are dropped, never executed. A setting turns this off. |
| Answer lane | Questions and small talk use one compact, minimal-thinking call instead of the full router. | It can only talk. `[ROUTE]` and `[SEARCH]` leave the lane before anything is spoken. Pending clarifications, screen follow-ups and tool words keep the router. |
| Direct live search | Weather, news, scores and prices skip the router call. | The existing Search path and its data-not-instructions rules are unchanged. |
| Spoken questions without transcription | A question's audio goes straight to the answer lane, which returns the transcript first. | The transcript is checked before speech: local commands, tool requests and live questions leave the lane. Local commands keep transcription first. |
| One router call for spoken tool requests | Audio goes to the router once instead of transcription plus a router call. | A local command in the returned transcript still runs locally. |
| Smart end of speech | A complete local command in the on-device transcript ends recording after 60% of the pause (900 ms by default). | Questions keep the chosen pause. A trailing “and” or an incomplete command keeps the full pause. |
| Grounded direct dispatch | Low-risk router actions whose arguments the user said skip the specialist call. | Read-only checks, catalog apps, spoken volume numbers and Spotify titles or artists only; everything else still consults the specialist. |
| Warm connection | The Gemini connection opens while the user speaks or starts typing. | Credential-free `HEAD` request, at most every 15 seconds. |
| Cacheable router prompt | Time, location and input mode moved to the end of the router prompt. | Instructions unchanged; only their order moved. |
| Adaptive acknowledgment | Answer-lane turns skip the spoken “On it.”, which otherwise delays the first word. | Search, commands and escaped turns keep it. |

Diagnostics now record **first audio**, the time from submission to the start of Olanga's reply speech, so these changes can be measured on real hardware.

**Latency next steps**

1. **Gemini Live mode.** For open conversation, stream microphone audio over the Live API (16 kHz PCM in, native audio out, server and client VAD) for sub-second voice-to-voice replies. Actions would still map to the closed, validated vocabulary.
2. **Wake pre-roll and semantic end of turn.** Keep a short audio buffer from before the wake word. Evaluate a small turn detector with physical microphones before changing any default pause.
3. **Local weather.** Answer weather from a keyless forecast service using the saved location, in a few hundred milliseconds instead of a Search call. This adds a provider, so it needs a privacy decision.
4. **Continued conversation.** Optionally listen for a few seconds after every reply, not only after questions.
5. **Earcon acknowledgment.** An optional short sound instead of spoken “On it.” for instant, wordless feedback.
6. **Live on-device command recognizer.** In offline command mode, run the command-grammar recognizer during recording so the review opens without a second decoding pass.

### Next waves

**Conversation and reach**

1. **Streamed replies.** Stream Gemini text and speak it sentence by sentence to cut time to first word. Action markers must never be spoken, and receipts remain the final word on actions.
2. **Natural offline voice.** Offer Kokoro-82M through kokoro-js as an opt-in download of roughly 80–300 MB. The Windows voice remains the fallback, and no audio leaves the device.
3. **Semantic end of turn and wake pre-roll.** Evaluate a small turn detector (such as Smart Turn v3) with voice-activity detection, and keep audio from just before the wake word. Validate with physical microphones before changing defaults.
4. **Quick-ask bar and command protocol.** A small input bar and an `olanga://` link for Stream Deck or scripts, limited to the local command set.
5. **Scheduled briefing.** An opt-in daily briefing at a chosen time or on the first wake of the day.

**Intelligence and extensibility**

6. **Optional local engine.** Connect an OpenAI-compatible endpoint (Ollama or LM Studio) for conversation, with Gemini kept for vision and search. The same validators and receipts apply.
7. **MCP tools with permissions.** Read-only tools may run after one approval; tools that change anything need per-call approval and produce receipts.
8. **Notes and documents.** Index folders the user chooses and answer with citations, kept on the device.
9. **Learned shortcuts.** After a Gemini-routed request succeeds, offer to save the phrase as a local command the user can review, reusing the existing parser.
10. **Signed distribution.** Signing, a verified update feed and tested rollback before any automatic update.
11. **Maintainability.** Renderer modules with type checks, plus Windows CI running the smoke tests.

### Decisions for 2.0.0

- Adopt an optional local model engine, which needs Ollama or LM Studio and a 3–8 GB model?
- Offer a natural offline voice as an opt-in download?
- Allow MCP tools, and under which approval policy?
- Allow proactive speech, such as a scheduled briefing?
- Obtain a Windows code-signing certificate?

## Implemented in 1.4.0

| Capability | What the user gains | Boundaries |
| --- | --- | --- |
| Local commands | Common app, music, volume, mixed-duration timer and checklist requests run without model planning. Queries and named cancellation also work locally. | Every clause of a compound must be recognized before using the local route. Ambiguous wording falls back; completed steps are not replayed during clarification. |
| Persistent timers and tasks | Timers retain absolute deadlines across restart; checklist operations select exact names before partial matches and ask about ambiguity. | Overdue timers ring on reopening. Olanga cannot sound an alarm while closed. Load validation preserves valid records; save failures are reported. |
| Verified app adapters | Known Windows launch targets replace blind search for the supported catalog. Workspace shows installed-app availability and operations. Single windows can be placed left, right or maximized. | Process/window identity and resulting geometry are checked. Missing or multiple windows prevent arrangement. Unknown names retain an explicitly unverified Windows Search fallback; unregistered custom installs may not be found. |
| Activity with receipts | The user sees working, completed, failed, cancelled and unverified steps, including what completed before a failure. | Detailed receipts are session-only. Optional retained history stores operation types and statuses, not prompts, names or document content. A cancelled dispatch can remain uncertain because an external effect may already have occurred. |
| Reviewed routines | Save up to 12 local actions for a workspace, music or focus session. Select the approved steps before each run and inspect earlier runs. | Nothing runs on save or restart. Failure stops later steps. Completed steps cannot repeat; interrupted or uncertain steps need renewed review. Routine commands and recovery records are stored locally. |
| Explicit saved names | Save, edit, delete and enable aliases for supported apps and private Spotify playlists. | Memory is user-entered and opt-in for use. It cannot authorize actions or learn preferences silently from conversations. |
| Optional offline speech | The bundled English Vosk model can transcribe a command without sending audio to a provider. A constrained vocabulary improves the tested command cases. | Mandatory transcript review precedes dispatch in both offline modes. The 7/7 command result uses synthetic recordings, not a physical microphone. General dictation remains experimental; submitted text may still require Gemini. |
| Guarded text undo | Supported full-field replacements show Before/After text and can restore the prior value for five minutes. | Requires a writable accessible full-text field and unchanged window, process, editor and text. A failed or interrupted undo cannot be blindly retried. Other input and general document history are not covered. |
| Local diagnostics | Optional timings show acknowledgment, transcription, planning, execution, speech and total duration, with clear/export controls. | No automatic upload; only phase, duration and outcome are retained. Opt-out deletes measurements. Separate Gemini usage counts reset with the app. |
| Main-process Gemini service | Provider requests use one validated boundary with saved credentials, cancellation, bounded retry, response limits and redacted errors. | The provider service has no desktop tools, so retrying generation cannot replay an app action. Existing trusted settings credential controls remain available. |
| Manual release checks | Workspace compares the installed version with the latest stable GitHub release and opens the release page. | No download, installation or asset verification occurs in the app. The release workflow emits real installer hashes and signing-status metadata; signing is conditional on configured credentials. Automatic updates and rollback remain disabled. |

The reliability changes also make mute and unmute idempotent, retain an explicit toggle, and reject ambiguous relative percentages on the absolute-volume route. Windows speech settles on cancellation even without a native completion event; duplicate events cannot start extra follow-ups. Alarm resources are released on dismissal, completion or startup failure.

Adding the first Gemini key after local setup now activates cloud input only after the secure save succeeds; failure leaves local commands available and the entered key ready to retry. Rapid recognition-mode changes cannot start the microphone for an obsolete selection. Optional Terminal tabs restore their history without starting hidden shells. Session initialization is shared, invalid working directories fail before spawning, pipe errors settle pending work, and replies from closed tabs cannot affect replacement tabs. Saved header text cannot inject markup.

## Behavior that must remain stable

- Acknowledgment starts before slow work. Final speech waits for acknowledgment and execution receipts, and does not claim success without the operation's evidence.
- Unknown wording cannot partially execute a compound local command. Quoted names containing “and” remain a single target.
- Cancellation stops future dispatch and ignores stale replies. It does not claim that already delivered actions were reversed.
- Routines, captures and editor plans require their own current review. Saved preferences, web content and screenshots do not grant authority.
- Native helpers receive JSON data through fixed scripts; user and model text never becomes a shell command.
- Optional memory, offline recognition, diagnostics and update checks do not silently change default behavior.
- Memories, reminder text and briefing content are data. They never authorize an action, and only an explicit request creates a memory.
- A bare “stop” pauses playback unless a timer, alarm or reminder is ringing. Plain “cancel” is not treated as a dismissal.
- Push-to-talk stays off until chosen, and voice interruption reacts only to greeting-style or multi-word wake phrases.

## Remaining work

1. **Broader speech evaluation.** Test physical microphones, speakers, accents, noise, wake words and end-of-speech timing. Measure recognition errors and full task latency on the same recordings before recommending offline dictation more broadly.
2. **Document-aware adapters.** Add explicit document identity, reviewed diffs, exact changed ranges and durable undo for selected editors. The current accessible-field checkpoint cannot protect every document switch or app-specific shortcut. Code correctness requires separately approved compiler/test execution and evidence.
3. **More app and display coverage.** Exercise additional installed versions, custom paths, packaged apps, accessibility providers, scaling and focus restrictions. Add operations only when a result can be checked.
4. **Signed distribution and recovery.** Configure Windows signing credentials, validate publisher identity on real artifacts, and test interrupted installation, migration and rollback before enabling any automatic update channel. Hashes alone do not establish publisher identity.
5. **Maintainable renderer modules.** Continue splitting large renderer scripts along the provider, activity and workflow boundaries, backed by behavior tests. Keep local controls usable during provider outages.

The reference tasks remain the Spotify/75% compound, a cancelled compound, an ambiguous checklist change, a timer across restart, a provider outage, an interrupted routine and a conflicted editor undo. Deterministic checks cover failures; disposable Windows fixtures verify native effects without operating on user documents.
