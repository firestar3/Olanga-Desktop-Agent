# Improving Olanga

Reviewed against the 1.6.0 source on October 12, 2026. This document separates implemented changes from further work. [Validation](VALIDATION.md) records the evidence and remaining limits; [release notes](releases/1.6.0.md) describe this version.

## Implemented in 1.6.0

- **Protected Workspace storage.** Malformed records, unsupported versions and failed reads preserve the original data and block persistent edits to the affected record. Session-only work remains available. Recovery requires a verified copy before reset or replacement; copies remain available for download or deletion.
- **Personal backups.** Versioned exports include explicit memories, saved app and playlist names, and routine definitions. Imports are bounded, validated and previewed before the user confirms replacement. They never execute routines. This is not a full-profile backup: keys, settings, timers, notes, checklist entries, schedules, activity and run receipts are excluded.
- **Results before speech finishes.** Completed action results appear immediately without waiting for an acknowledgment to finish speaking. Speech remains ordered. Diagnostics distinguish acknowledgment dispatch, playback start, action completion and final-reply playback start.
- **Verified update readiness.** The updater requires the expected installed version to acknowledge initialized rendering and a visible window with usable controls. Readiness is bound to the particular update attempt; starting a process alone is insufficient. Updates remain manual, and rollback is not automatic.
- **Clearer memory and conversation controls.** Explicit memories have search and sorting. Deleting, disabling or replacing them prunes dependent local context and cancels a pending reply using them. Recent conversation is bounded and expires automatically; there is no new-conversation step to manage. Natural or concise response style and an optional preferred form of address are separate preferences. These controls do not erase provider copies or retained backups.
- **Shorter routes through Workspace.** Projects, Schedules and Updates have direct destinations. Examples prefill an editable command without running it. Core settings has an explicit Gemini connection test beside the key; reading connection status does not make a model request.
- **Direct News reading.** Saved topics, story count, source labels, dates, feed excerpts, duplicate filtering and read/unread controls make headlines useful without an automatic Gemini summary. The user can explicitly ask AI about the loaded headline information. Read markers and feed reuse are bounded as described in [Privacy](../PRIVACY.md).
- **Consistent visual preferences.** Five accents, stronger window contrast, three orb-glow levels, Windows-aware reduced motion, a preview and an appearance-only reset reuse the existing theme. The Outfit font is bundled locally. Status colors retain their meaning.

## Evidence and deployment work still to extend

### 1. Exercise Spotify and voice on real devices

**Why:** command and renderer fixtures can prove parsing, sequencing, cancellation and truthful receipts. They cannot establish Spotify playback, physical microphone accuracy or perceived response time on every computer. The corrected “Play Spotify and raise the volume to 75%” flow still needs authorized live playback acceptance.

**Next:** cover cold and warm Spotify startup, signed-out or missing Spotify, no active media session, competing players, English accessibility labels, playback failure and cancellation. Verify actual playback and Windows volume independently. Preserve the explicit volume adjustment when Spotify fails. Then test physical microphones, varied accents, noise, interrupted speech and repeated mute/unmute.

**Acceptance:** publish failures as well as successes, retain the complete command corpus, and measure first acknowledgment, verified action completion and final speech separately. Keep synthetic audio, native controls and physical voice results distinguishable. No spoken confirmation counts as proof of playback.

### 2. Broaden installer and restart coverage

**Why:** readiness checking closes the process-start gap, but Windows installation still depends on permissions, locks, startup behavior and the previously installed updater. An update into 1.6.0 uses the updater shipped in that earlier version.

**Next:** extend the isolated Windows matrix for Check → Download → Verify → Install → Shutdown → Reopen using real NSIS packages and fixture profiles. Include interrupted downloads, cancellation, locked files, failed installation, slow or unusable rendering and a previous instance that does not quit. Use [validation](VALIDATION.md) for the exact paths already exercised.

**Acceptance:** the expected version is usable, profile content survives, and failure leaves a clear recovery result. A release checksum verifies bytes, not publisher identity. Signing support is prepared, but a publisher certificate is still needed. Evaluate rollback separately before promising it.

### 3. Keep performance gains measurable

**Why:** large savings in a particular idle or tray state do not establish a 50% reduction in every mode. Voice readiness, unmute and active recognition have different costs.

**Next:** maintain paired measurements for startup, idle Home, Settings, hidden tray, voice-ready idle, active recognition, unmute, local commands and cloud requests. Hold machine, profile, power conditions and fixtures constant. Check that panels release background work after closing.

**Acceptance:** record CPU, memory, wake latency and request latency distributions, including p50 and p95. Keep accuracy and cancellation behavior at least as strong as the baseline. Isolate runtime or speech-engine changes and compare them against the same corpus before including them. Runtime maintenance remains a compatibility decision, not an assumed speed improvement. [Electron performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance).

### 4. Extend backup scope only with safe restoration rules

**Why:** the new personal backup has a deliberately narrow, visible scope. A complete profile restore would also need to reconcile settings, schedules, timer deadlines, notes, checklist entries and device-specific credentials.

**Next:** design separate opt-in exports for those collections, with schema migrations, scope previews and conflict handling. Define overdue timer and schedule behavior before importing them. Keep credentials excluded unless a separately designed, protected transfer is explicitly requested.

**Acceptance:** damaged or newer formats preserve source bytes, failed writes cannot claim success, stale previews are rejected, and importing never runs an action or routine. Test recovery from interrupted writes and repeated restores. Make the retention and deletion of every recovery copy visible.

## Larger improvements after those checks

These are proposals, not features included in 1.6.0:

- **Document-specific editing with dependable undo.** Track the exact document and changed range, preview a diff, and verify that undo still targets the same content. Existing full-field checkpoints are useful but are not universal document history.
- **Reviewed shortcuts from successful commands.** Offer to save a proven phrase as a local shortcut, with an editable plan and validation. Build on existing routines; never silently learn permissions or run a suggestion.
- **Optional natural offline speech.** Compare candidate voices and turn detection on physical microphones before selecting a package. Budget download size, memory and wake latency, and retain the current engine and timing options.
- **More verified app adapters.** Add integrations where app identity and the resulting state can be checked. Document version, language, display-scaling and session assumptions.

Local conversation, streaming replies, project questions, schedules, MCP tools, routines and diagnostics already exist. Prefer improving their reliability and discoverability over adding overlapping systems.

## Rules for each increment

Keep local commands usable during provider failure. Preserve complete compound parsing, independent explicitly requested effects, cancellation and accurate action receipts. Unknown wording must not partially execute through the local route. Reviewed routines and desktop changes retain their approval boundaries; context is data, never authorization.

Compare each change with the existing acceptance cases and record remaining limits. The reference cases are Spotify plus volume, a cancelled compound, an ambiguous checklist edit, a timer across restart, a provider outage, a stalled acknowledgment, damaged storage, a deleted memory during a reply, an interrupted routine, a conflicted undo and a failed update restart. Fixtures and live tests answer different questions; neither proves universal compatibility.
