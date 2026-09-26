# How Olanga works

Olanga is an Electron Windows app. The main process owns windows, tray, encrypted storage, Gemini requests, native desktop input, app/media adapters, release checks and Magpie TTS. A sandboxed renderer calls narrow preload APIs. Privileged IPC accepts only the local main frame. The GitHub tag workflow builds an x64 NSIS installer including the Vosk model and unpacked native helpers.

## Gemini-only intelligence

- Cloud speech starts with a local Windows acknowledgment concurrent with a bounded transcription-only Gemini request. Its transcript enters the same action routing as typed text; ordinary questions then use Gemini for their answer. Live-information requests use a separate Google Search call.
- Optional on-device speech uses the bundled English Vosk model. Command and experimental general-dictation modes both require editable transcript review before routing. They never switch to cloud transcription after a local error. Recognition itself makes no provider calls; reviewed text outside local commands may still need Gemini.
- Familiar explicit music, volume, timer, reminder, alarm, memory, briefing, checklist and app commands, plus time and date questions: local intent matching → native/local execution → spoken result. Typed and reviewed offline commands need no model on this path; cloud speech needs transcription without additional planning or response calls.
- Ambiguous actions: Gemini routing → Gemini bounded command proposal → validation → dispatch once. Grounded low-risk router proposals skip the second model call (see [Conversational latency](#conversational-latency)).
- Questions and live information, with Streamed replies on: a streamed answer or Google Search lane speaks sentence by sentence and can only talk. Native execution receipts are spoken directly; other requests retain the separate response writer. Pending clarifications and desktop workflows retain their existing routing.
- Screen diagnosis: permission to capture → Gemini perception → Gemini reasoning → separate Gemini response writer.
- Desktop edits: capture permission → observed window/editor scope → Gemini diagnosis and structured plan → immutable native preparation → spoken/typed yes opens review → two native confirmations → bounded Windows input → fresh result capture → Gemini evidence check → separate final response.

The router and response model is gemini-3.5-flash-lite. Reasoning uses gemini-3.5-flash, falling back to gemini-3.5-flash-lite on unavailable/missing-model responses, never to bypass authentication or quota errors. The shared Gemini adapter converts system instructions, conversation roles and bounded inline images, and requests JSON schemas for plans and verification. Requests have cancellation and timeouts; truncated output cannot dispatch actions. No production NVIDIA chat endpoint or NIM reasoning IPC remains. NVIDIA credentials are only for optional Magpie audio synthesis.

The response writer has no tools. Search results, screenshots, comments and window titles are data, not authority. Only the user goal and explicit clarifications authorize a proposal. A voice summary failure does not replay a completed action. Conversation is bounded to 24 messages / 24,000 characters and expires after 30 minutes of inactivity. Desktop answers preserve the pending question but need a fresh capture for a new plan.

`desktop/provider-service.js` owns Gemini HTTP requests. Renderer calls carry a request ID, allowlisted model and validated body; they cannot choose arbitrary endpoints or supply credentials. Main retrieves saved keys, bounds concurrency to four, sets deadlines of at most 90 seconds and limits response size. Transient retries and optional key rotation are bounded; failure statuses preserve the renderer's existing model-fallback contract. The service has no desktop execution capability. Cancellation aborts the corresponding request. Session usage contains counters, reported token totals, model, status, attempts and duration, never prompts or credential values. Trusted settings retain their existing encrypted-store interface; this migration does not claim keys are absent from every renderer settings path.

## Desktop boundary and verification

Spotify uses a warm, fixed PowerShell helper with JSON stdin. Personal Liked Songs navigates directly to `spotify:collection:tracks`; library playlists stay in Spotify's library. Playback uses accessible Spotify controls and [Windows media-session state](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssession) to verify the result before announcing success. Public web search, clipboard replacement and blind keypress sequences are no longer part of music playback. Unknown, ambiguous or inaccessible controls produce an honest failure message. Spotify's English accessible labels are required for collection selection; media transport uses Windows session APIs.

Native requests are bounded, cancellation terminates the active helper, and stale results cannot speak or dispatch another action. Pausing and resuming are separate, state-aware operations. Short Magpie confirmations are cached in memory per voice/language; the Liked Songs confirmation can synthesize while Spotify starts, but plays only after a verified success.

Simple compound requests split at unquoted "and", "then", or "and then" only when every clause is supported; unsupported clauses cause the entire fast route to fall back. Mixed-duration timer grammar retains duration components as one action. Spotify launch IPC awaits an observed window. Exact volume uses Windows Core Audio and a separate readback, with numeric targets bounded to 0–100 at both the renderer proposal and native IPC boundaries. Final speech waits for the acknowledgment and all dispatched actions; an action failure stops remaining steps and preserves completed outcomes.

`shared/app-catalog.js` defines known application targets. The app helper resolves fixed install paths, App Paths registration or known package identities, then verifies process identity and a visible app window. Opening an existing instance does not arbitrarily pick among multiple windows. `listAppCapabilities` reports availability and supported operations on demand. `arrangeApp` accepts only left, right or maximize, requires exactly one verified window, uses that window's monitor work area and checks native position/maximized state. Missing/custom installations and denied foreground focus produce explicit receipts. Spotify launch retains its media adapter. Unknown app names use a constrained Windows Search fallback with an unverified receipt; no user-supplied executable path, argument list or script is run. Cancelling a helper does not close the user's app or claim a dispatched launch was reversed.

Explicit system mute and unmute use separate desired-state commands; only an explicit toggle uses the legacy toggle operation. Each native result checks the final mute state and volume. Directional numeric phrases without an explicit absolute target fall back to interpretation rather than changing volume to the wrong percentage.

Timer deadlines and checklist records are stored locally with record validation on load. Timers restore their absolute deadline and ring on reopening if overdue; the app must be running to sound an alarm. Timer/checklist operations produce direct receipts, including missing targets and failed saves. Task selection prefers IDs and exact names, retaining unique partial matching. Ambiguous targets carry only the unresolved operation into clarification, preventing completed compound steps from replaying. Windows speech settles once on completion or cancellation; alarm contexts have a bounded lifetime and are closed on dismissal.

The closed action vocabulary lives in shared/action-plan.js. Main-process plans use immutable copies, single-use IDs and a five-minute lifetime. A plan has at most 12 steps and 2,000 typed characters; execution lasts at most 30 seconds. Scope is one observed native window, optionally narrowed to a rectangle. A model cannot widen scope through its proposed steps. The fixed PowerShell helper accepts JSON data and invokes Win32/UI Automation; it never evaluates model-generated scripts.

The native runner verifies window/process identity, display geometry and focus, and registers Escape before input. Editor typing additionally requires a non-password editable accessible control entirely inside the approved region, with stable runtime identity. Approved newlines use Return key pairs because Chromium ignores Unicode carriage-return packets. Known terminals and privileged targets are blocked. This is conservative input containment, not an OS sandbox or a guarantee about every app’s interpretation of a shortcut.

The second edit confirmation includes permission for one post-edit primary-screen capture. The runner checks target/display identity before and after this image. If capture fails, input delivery remains distinct from verification. The Gemini verifier returns verified, incomplete or uncertain, backed by concrete visible observations. Remaining work prevents a verified status. A source-code correction cannot establish compilation or runtime correctness without visible test evidence. New edits or another target need a fresh proposal and confirmations.

Captures, plans and supported text checkpoints stay in memory. Native helper diagnostics do not retain user content. Regression fixtures can save synthetic images under ignored build/qa; no real user screenshot is included in automated provider checks.

## Guarded text restoration

For an editor-only plan ending in Ctrl+A followed by a full-field replacement, the runner can capture the original complete value through UI Automation. A checkpoint requires a visible, writable, non-password `Edit` control with `ValuePattern`, at most 20,000 existing characters, and stable accessibility identity. The helper sends one `SetValue`, then allows up to 1.5 seconds for complete readback while rechecking identity on every read. It never resends the edit, and an undo record is offered only after verification. Other input keeps its existing execution path without claiming undo support.

The main process retains one checkpoint for five minutes; the result UI shows local Before/After text. Original text and editor identity are excluded from the Gemini verification payload. Undo checks window handle, process and start time, control/parent runtime IDs, title and current text before restoring the original value, then verifies the full result. Expiry, changed content or changed identity prevents restoration. Failed/interrupted restoration consumes the checkpoint. This protects supported accessible fields; it is not a document adapter, persistent version history or an automatic rollback of arbitrary input.

## Workspace state and reviewed routines

`shared/productivity.js` validates local state for saved names, routines, run receipts, optional history and optional diagnostics. Timers and checklist storage retain their own validated records. Saved app aliases and private playlist names only affect local matching when enabled; they never widen action authority.

Activity records show step outcomes, including an uncertain state when cancellation races an external effect. Details stay in the current session. Opt-in history persists only operation types and statuses with timestamps, capped at 40 entries. Routines and their last ten runs are separately persisted with the chosen commands so unfinished work can be reviewed after restart. These records may contain user-entered names and are not represented as redacted history.

A routine expands to at most 12 validated local actions. Each run opens a per-step selection review; one explicit approval runs those selected steps in order. Completed/skipped steps cannot be selected again. Failed, cancelled or uncertain steps are unchecked by default. Failure stops the sequence, cancellation invalidates stale results, and reload changes a running step to uncertain without dispatching anything. Routines do not call the model to invent new actions.

Opt-in diagnostics keep at most 200 phase/duration/outcome measurements with local export and deletion. Disabling collection clears them. Provider usage is a separate main-process, session-only counter. Neither feature automatically uploads telemetry.

Keyless setup opens the UI without starting microphone capture. Adding the first Gemini key waits for encrypted storage before activating cloud input; recognition-mode initialization rechecks the latest selection after model loading. Idle hints distinguish an absent or muted microphone from active wake-word listening.

The optional Terminal remains explicitly user-operated. Saved tabs restore UI/history only, and a native session starts on the first command. Concurrent initialization shares one promise; close and reply handling are tied to the tab object so reused IDs cannot receive stale results. Main validates the initial working directory and settles pending commands on spawn, pipe or close failures. Stored terminal headers render only the built-in markup.

## Conversational latency

`desktop/provider-service.js` can stream `streamGenerateContent` server-sent events. It applies the same validation, credentials, concurrency, deadlines, size limit and cancellation as ordinary requests, retries only before any text arrives, and never forwards thought parts. Partial text reaches the renderer over `provider-stream-chunk` events; the invoke result is the authoritative full reply. Streams feed spoken answers only and never action dispatch, so a length stop is reported as truncated rather than failed. Provider HTTP uses Electron's `net.fetch`, without cookies, so connections stay warm across idle gaps and follow system proxy settings. A credential-free `HEAD` request warms the connection at most every 15 seconds when the wake word fires, push-to-talk starts or the command box gains focus.

When **Streamed replies** is on and a key is saved, `shared/conversation.js` chooses a lane:
- **Answers.** Questions and small talk without tool, screen or pending-context words use a compact, minimal-thinking prompt that can only talk. Its reply either streams, or starts with `[SEARCH]` or `[ROUTE]` to leave the lane before anything is spoken.
- **Search.** Weather, news, scores and prices go straight to the streamed Google Search path.
- **Router.** Everything else uses the existing router, and a router `[WEB_SEARCH]` answer also streams.

Streamed text is split into sentences (`createSentenceSplitter`) and spoken by `createSpeechStream`. That queues Windows speech sentence by sentence, or pre-synthesizes Magpie sentences and falls back to Windows for the rest. Escape, mute, the wake word or a newer reply stops it. Bracket markers inside a streamed answer are dropped and never executed. Turns in the answer lane skip the spoken "On it."; a turn that escapes to a slower path speaks it then.

For cloud speech, the wake-word recognizer keeps a rough on-device transcript while recording. A complete local command in that transcript shortens the end-of-speech pause to 60% of the chosen setting (at least 600 ms). When recording ends, the rough transcript chooses a path:
- **Local commands** keep the transcription-first path.
- **Questions** send the audio to the answer lane, which must write `USER_SAID:` first. That transcript is checked before any words play: a local command, a tool request or a live question leaves the lane with the transcript, and silence ends the turn.
- **Other requests** send the audio to the router in one call; a local command in its `USER_SAID` still runs locally.

The router system prompt places time, location and input mode at the end, so its long static prefix is identical across requests and eligible for Gemini's implicit caching.

Router proposals skip the action specialist only when every command is read-only (status checks and the briefing), or when each argument comes from the user's words. That means a Spotify title or artist they said (a song or album may carry an added artist), a catalog app they named, or a volume number they spoke. Such plans still pass `parseSimpleActionProposal` and the normal dispatch receipts. Paraphrased, unknown, destructive, follow-up and parameterless control proposals still go to the specialist.

## Reminders, memories and briefings

Reminders and alarms reuse timer records with an optional `kind`; plain timers keep their original stored shape. `SET_REMINDER` takes a duration of up to one day. `SET_ALARM` takes `h:mm`, optionally with AM/PM and `tomorrow`; without AM/PM, the sooner future time is chosen when the alarm is created. A due reminder or alarm speaks only when the assistant is idle and its voice is not muted, then starts the alarm sound. Restored overdue records ring without speaking. `STOP_TIMER` dismisses ringing records, cancels a single active record, or asks which one; a bare “stop” becomes `STOP_TIMER` only while something rings. Alarm beeps pause while the user's voice is recorded so end-of-speech detection can finish.

Memories live in the local Workspace store: at most 50 statements of 300 characters, created by the fast path, Workspace, or a Gemini proposal for an explicit “remember” request. While enabled, they appear in router context and the action specialist payload as labeled data, never as instructions. `FORGET` resolves exact wording, a unique phrase, then all meaningful words, and asks when several memories match.

`DAILY_BRIEFING` composes local tasks, timers and reminders with `shared/briefing.js`. Headlines come from the existing main-process news bundle within five seconds. Weather uses the separate Google Search path only with a key and location, within six seconds. Either source is omitted on failure. The briefing performs no actions.

## Reach and health

The main process registers at most one push-to-talk accelerator from `shared/shortcuts.js` and unregisters only that accelerator, leaving Escape registration for desktop input untouched. A press starts listening like the wake word, cancels a reply or pending request, or sends a recording already in progress. When voice input is unavailable, it opens the typed command box.

While Olanga speaks, the wake-word recognizer keeps listening if voice interruption is enabled. Only greeting presets (“hey …”) and multi-word custom phrases interrupt, because Windows speech reaches the microphone without echo cancellation. Timer notifications are shown by the main process only when Olanga is hidden or unfocused. They are silent, because Olanga plays its own alarm.

`shared/health.js` turns a read-only snapshot (devices, recognizer state, speech mode, provider status, voice engine, storage, shortcut and version) into checks with fixes. The Workspace connection test is the only provider request, and it runs only on request.

## Release checks and artifacts

`checkRelease` runs only on explicit UI request, fetches the fixed public repository's latest stable-release metadata, validates the response and repository URL, compares semantic versions and caches results. It has an eight-second timeout, a 256 KiB response limit and no background poller. Failure is reported as unavailable, not up-to-date. The app opens the release page without downloading or validating installer bytes.

The release workflow emits `SHA256SUMS` and observed Authenticode status beside the installer. Optional signing requires both configured Windows signing secrets and valid signatures on the final installer and packaged executable. Without them, artifacts are explicitly unsigned. No automatic updater, signed update feed or tested rollback is enabled. See [releasing](RELEASING.md) for maintainer procedures.

## Corner light

The separate topmost window retains one native focusability style and uses native cursor hit testing for transparent margins. Five stored shortcut IDs cross its IPC boundary. The compact orb, app-themed menu, five-second/one-hour hides and reopening fix are preserved.

## Further engineering work

1. Add IntelliJ/VS Code document adapters with reviewed diffs, exact changed ranges, undo checkpoints and separately approved test execution. Screenshot verification cannot replace compiler/test evidence.
2. Maintain Electron/dependency upgrades with Windows integration coverage across scaling and accessibility providers.
3. Configure signing credentials, validate real signed artifacts and test recovery before introducing an automatic update channel.
4. Split remaining global renderer scripts into modules while preserving the provider and action boundaries.
5. Broaden offline speech, app/version and display testing. The synthetic command benchmark does not establish real microphone accuracy.

These are maintenance and product investments; the current build does not claim universal app compatibility or flawless autonomous execution.

See the [improvement plan](IMPROVEMENTS.md) for implemented capabilities, remaining work and the behavior each must preserve.
