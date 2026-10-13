# Improving Olanga

Reviewed against the current source on October 12, 2026. The appearance controls below are implemented; the numbered priorities are proposed work, not completed fixes. [Validation](VALIDATION.md) records what has actually been tested, and [Next-level features](NEXT-LEVEL.md) describes capabilities already present.

## Appearance added in this source

- Five accents: the original violet, blue, mint, rose and amber.
- Optional stronger text and borders for the main window and Workspace.
- Standard, subtle or disabled glow around the main orb, preserving its status colors.
- Reduced motion that respects Windows, plus an explicit reduced-motion option.
- A static preview and an appearance-only reset. Location, voice, keys and enabled features retain their settings.

The original appearance remains the default. These controls reuse CSS and the existing preference save path; they add no polling or animation loop. This source has not been published in a new installer.

## What to improve next

### 1. Protect saved data before adding more storage features

**Finding — reproduced bug.** In [the productivity store](../shared/productivity.js), malformed JSON or an unsupported version falls back to defaults in memory. The next ordinary command calls `begin()`, which saves those defaults over the original stored record. An in-memory fixture reproduced the overwrite for malformed JSON and a future-version record. This review did not access a personal profile.

**Change:** preserve the original bytes, distinguish an empty store from an unreadable one, and suspend writes to the affected record until recovery is resolved. Show a clear recovery notice. An isolated recovery copy must succeed before anything replaces the original.

**Acceptance:**
- Invalid JSON, future versions, failed reads and failed recovery writes leave the original record intact after commands and restart.
- Other working features remain available; a storage problem does not silently pretend a change was saved.
- Restoring a validated backup is transactional and never runs a restored routine.
- Expired timers and reminders have explicit restoration behavior.

Once this guard is proven, add versioned export/import for personal content. Exclude credentials by default, explain what a backup contains, and preview conflicts before restoration. This needs migration and privacy tests, not just an export button.

### 2. Show verified results as soon as actions finish

**Finding — concrete delay path.** [`finishAssistantTurn`](../js/assistant.js) waits for the acknowledgment promise before displaying the final answer or marking actions finished. [Windows acknowledgment speech](../js/tts.js) can wait for its 5–12-second watchdog if its completion event is lost. An action can already be finished while Home still shows its working message.

**Change:** publish result text and verified step outcomes immediately. Keep acknowledgment and final speech in the correct order, but separate visual completion from audio completion. Use the existing turn lifecycle and receipts rather than introducing another state machine. Show useful phases such as opening Spotify, waiting for its player and setting volume.

**Acceptance:**
- A deliberately stalled acknowledgment cannot hold back a completed result.
- Every turn visibly finishes, fails, cancels or asks for input; no silent return to idle.
- Cancellation cannot reveal a stale result or replay completed actions.
- Measure acknowledgment dispatch, audible start, action completion and final speech separately. The current acknowledgment timing measures completion.
- Preserve the existing rule that an explicitly requested volume change can complete even if Spotify playback fails.

The corrected “Play Spotify and raise the volume to 75%” path still needs real playback acceptance. Continue fixtures until live testing is authorized, then cover cold/warm launch, missing or signed-out Spotify, no media session, competing players, cancellation and playback failure. Check actual playback and Windows volume; spoken confirmation alone is insufficient.

### 3. Prove the complete manual update and usable restart

**Finding — deployment gap.** Installer checks and updater fixtures exist, but [validation](VALIDATION.md) distinguishes those from the complete in-app journey. The [update supervisor](../desktop/update-supervisor.ps1) checks for an existing window when its launched process exits quickly; a surviving but unusable process can still be treated as a completed restart.

**Change:** require a readiness acknowledgment from the expected installed version after its renderer initializes. Bind it to the update attempt. Keep updates explicitly user initiated.

**Acceptance:**
- In an isolated Windows installation, exercise Check → Download → Verify → Install → Shutdown → Reopen using the real NSIS package.
- Confirm the expected version is interactive and the fixture profile survives.
- Cover interrupted downloads, cancellation, locked files, installer failure, slow startup and a process that starts without becoming usable.
- Provide a clear recovery result when reopening fails; investigate rollback separately before promising it.
- Keep publisher status accurate. Signing support is prepared, but a signing certificate has not been supplied.

This is a release gate, not a reason to add automatic background installation.

### 4. Make conversation memory understandable and controllable

**Opportunity.** Recent conversation expires after inactivity, while enabled saved memories and checklist information can accompany requests. Deleting a saved memory does not remove its earlier appearance from current conversation context.

**Change:** add a visible **New conversation** action and a compact context view explaining which categories can accompany an online request. When deleting a memory, offer to clear the current conversation that may still contain it. Add a preferred form of address and concise/natural response choices; the assistant currently hardcodes “Boss” in its prompts.

**Acceptance:**
- After clearing context, the next fixture request excludes old sentinel content.
- Define how clearing affects an in-flight request and pending clarifications.
- Saved memories remain separate from transient conversation.
- Wording never implies deletion from a provider's systems.
- Tone settings cannot change action permissions or the standard for claiming success.

### 5. Bring existing capabilities closer to the user

**Opportunity.** Projects, sessions, schedules and other work tools are nested behind Workspace → Apps & updates → Work tools. Health testing also lives away from the API-key field where connection problems first matter.

**Change:** keep Workspace as the main button, add direct destinations for common tools and offer useful command examples. Place connection status and an explicit test beside Core settings. Examples should fill the command box and remain editable before submission.

**Acceptance:**
- Projects, Schedules and Updates are reachable within two actions from Workspace.
- Preserve existing routes while introducing clearer entry points.
- Keyboard navigation, narrow windows and enlarged text remain usable.
- Opening navigation starts no microphone capture, provider request or external connection.
- Clearly distinguish available locally, needs setup, connected and failed. A connection test states that it sends a short request.

This exposes capabilities already implemented; it does not require another tool system.

### 6. Set performance budgets for real use

**Opportunity.** Previous optimization evidence shows large savings in specific idle/tray states; it does not establish a 50% reduction in every mode. Active recognition and microphone reactivation deserve separate measurements.

**Change:** benchmark startup, idle Home, Settings, hidden tray, voice-ready idle, active recognition, unmute, local commands and cloud requests independently. Use the same machine, profile, power conditions and command fixtures for comparisons. Record working set, CPU, wake latency and request latency distributions.

**Acceptance:**
- Establish reproducible baselines before setting regression thresholds.
- Keep the original command corpus at least as accurate while improving latency.
- Check background work after closing each surface and repeated mute/unmute.
- Measure p50 and p95; a single fast run does not establish a speed improvement.
- Isolate any speech-engine or Electron migration in a separate change with the full acceptance matrix.

[Electron's performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance) supports profiling actual bottlenecks and avoiding unnecessary work. Also evaluate a move from the current Electron 36.9.5 runtime to a supported release line; [Electron's support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines) covers the latest three stable major versions. Select the actual target and check native integration compatibility at implementation time.

## Larger improvements after these gates

- **Document-specific editing with dependable undo.** Track the exact document and changed range, preview a diff, and verify that undo still targets the same content. Existing full-field checkpoints are useful but are not universal document history.
- **Reviewed shortcuts from successful commands.** Offer to save a proven phrase as a local shortcut, with an editable plan and validation. Suggestions must not silently learn permissions or run themselves.
- **Better natural speech as an optional package.** Compare candidate offline voices and turn detection on physical microphones, varied accents and noisy rooms. Keep the current engine and timing available; budget download size, memory and wake latency before selecting a replacement.
- **More verified app adapters.** Add integrations only where app identity and the resulting state can be checked. Document version, language, display-scaling and session assumptions.

Local conversation, streaming replies, document questions, schedules, MCP tools, routines and diagnostics already exist in source. They need clearer access and broader evidence before more overlapping systems are added.

## Rules for each increment

Keep local commands usable during provider failure. Preserve complete compound parsing, independent explicitly requested effects, cancellation and receipt accuracy. No unknown wording may partially execute through the local route. Reviewed routines and desktop changes retain their approval boundaries; context is data, never authorization.

Make one behavioral change at a time, compare its acceptance cases with the existing behavior, and record the remaining limits. The reference cases are Spotify plus volume, a cancelled compound, an ambiguous checklist edit, a timer across restart, a provider outage, a stalled speech acknowledgment, damaged storage, an interrupted routine, a conflicted undo and a failed update restart. Fixtures and live tests answer different questions; neither should be presented as proof of universal compatibility.
