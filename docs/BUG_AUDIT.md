# Bug audit — September 25, 2026

This audit follows the failure report for “Open Spotify and raise the volume to 75%” and the request to look for additional bugs. Changes target reproduced failures and specific lifecycle or persistence errors. They preserve existing cloud input and optional local input, and do not claim that all possible bugs have been found. Current measured results are in [VALIDATION.md](VALIDATION.md).

The final frozen-source run passed **405 unit tests with zero failures** and syntax/assets/version checks for **35 application JavaScript files** at version **1.4.0**. The current real-renderer race smoke passed 10 checks, Workspace passed 16, and the disposable native app fixture passed 16. Unless a full path is given below, unit-test filenames refer to `tests/unit/`.

## Request execution and native app control

- Complete supported compound commands keep their order. Unsupported clauses cannot silently disappear while only the recognized portion runs. Quoted media names retain conjunctions, and explicit percentages do not become relative volume changes.
- Action receipts determine the final result. A completed first step survives a later failure; an unverified launch or pending save prompt cannot become a success message. Follow-up clarification resumes the affected step without replaying earlier effects.
- App closing uses validated, exact process names and native window identity checks. Browser titles and process-name substrings cannot select a close target. The helper requests graceful closing, does not force termination, and distinguishes confirmed closure, remaining windows, pending save prompts and cancellation after dispatch.
- Helper spawn, pipe, malformed-response, timeout and cancellation failures settle with explicit outcomes. A playback action verifies the session it targeted, rather than accepting a different player becoming current as proof of success.

Coverage: `tests/unit/fast-intents.test.js`, `assistant-routing.test.js`, `media-controller.test.js`, `close-controller.test.js` and `app-controller.test.js`. The real Windows fixture in `tests/app-adapter-smoke.js` passed 16 checks using private disposable windows, including exact close selection and zero-window readback. This does not validate every catalog app or installation.

## Speech, microphone and offline recognition

- A short local acknowledgment starts before encoding, provider work or native actions. Final speech waits for that acknowledgment and the action results. Late callbacks from cancelled or superseded speech cannot reset a newer request or start an obsolete follow-up.
- Muting immediately settles Windows playback and pending Magpie generation, even when native cancellation produces no event or preference storage fails. The request's working state is preserved when muting an acknowledgment.
- Later Magpie chunk failures fall back to Windows speech for the remaining content. A real playback interruption announces that the affected part will be repeated; deliberate cancellation does not restart speech. Object URLs and playback owners are released on initialization failures as well as normal completion.
- Microphone initialization is deduplicated. Late permission results respect mute; replaced recognizers cannot inject stale input; disconnects discard buffered audio and release their graph. Continuous recording is bounded to 60 seconds, and invalid or muted capture cannot submit retained audio.
- Wake-word enrollment cancels an existing request, ignores ordinary wake triggers during its typing step and rolls back an unsaved custom phrase after a storage failure.
- Offline input validates recording size, duration and WAV structure before decoding. Cancellation, decoder close failures and recognizer failures release resources. Fatal Vosk worker errors now reject promptly, evict the dead model and allow explicit recovery without creating another microphone graph.

Coverage: `tests/unit/tts-response.test.js`, `audio-controls.test.js` and `offline-speech.test.js` passed 59 focused tests. Cloud recognition remains the default; both optional offline modes require editable transcript review. No physical microphone, noisy-room accuracy, wake-word quality or live Magpie service availability is established by these tests.

The current bundled-model smoke also passed with eight generated WAV fixtures and real decoding, without network, microphone, speech playback or desktop dispatch. Command vocabulary matched all seven expected command action lists at a mean 815.5 ms; general recognition matched three at 2,060.4 ms. Model loading took 2,689 ms separately. Neither mode produced an action list for the out-of-scope weather question, which command vocabulary transcribed incorrectly. This small synthetic test supports the explicit command mode and required review, not general dictation accuracy. Evidence: `build/qa/offline-speech-grammar-comparison.json`, recorded September 26, 04:40:19–04:41:05 UTC.

## Cancellation and desktop workflow receipts

- Cancelling a request also invalidates pending transcript review, follow-up recording and deferred desktop questions. Late provider results or approval callbacks cannot dispatch a cancelled task.
- Screenshot cancellation covers pending permission and clipboard waits, settles promptly and releases the next request. Clipboard failures restore the UI instead of escaping from a timer callback.
- Desktop activity records capture, planning, approval, execution and verification separately. Input already delivered remains visible as possibly applied when verification is cancelled. Missing or uncertain post-edit evidence stays unverified; a failed spoken summary cannot erase a verified edit result.
- Undo has its own receipt. Persisted activity contains operation/status metadata rather than copied editor text, screenshots, questions or answers. Failure of the optional activity store does not block otherwise approved work.

Coverage: `tests/unit/screenshot-cancel.test.js`, `desktop-workflows.test.js`, `desktop-automation.test.js`, `productivity.test.js` and `assistant-routing.test.js`. Controlled tests inject delayed results and cancellation at different phases; they do not replace native confirmation or prove arbitrary document editing works.

## Local data, settings and Terminal

- Corrupt timer, checklist and Terminal records no longer prevent valid neighboring records or the rest of startup from loading. Record identifiers remain distinct across repeated creation and reload.
- Checklist writes roll back on persistence failure. The manual UI retains the submitted text, restores a failed checkbox change and reports the failure. Timer receipts distinguish a working session timer from a failed durable save; deadline, dismissal and alarm resources are tested across restart and audio initialization failures.
- Runtime audio controls and startup remain usable when browser storage is blocked. Cleanup operations are isolated so one failure cannot skip the remaining resource releases.
- Terminal tabs create their native session lazily on the first command. The command runs in the actual validated initial directory, and concurrent first commands share initialization. Spawn/pipe errors settle pending commands; closing a tab prevents late initialization or replies from affecting its replacement. Saved header text cannot inject HTML.
- Settings initialization cannot let an obsolete speech-mode change start the microphone or overwrite the latest choice. Activity updates preserve in-progress Workspace form text; routine cancellation/review preserves completed work without replay.

Coverage: `tests/unit/timers-tasks.test.js`, `startup-terminal.test.js`, `prefs-schema.test.js`, `productivity.test.js` and the real-renderer Workspace smoke. The current Workspace report contains 16 passing checks with no provider, microphone or privileged native calls.

## Credentials and recovery

- Settings, the main process and provider retries use the same Gemini key normalization in `shared/gemini-keys.js`. Saved lists retain one canonical order after invalid entries and duplicates are removed, keeping runtime selection and provider key indices aligned. Invalid, duplicate, oversized or excess new entries are rejected before persistence; failed saves preserve the selected key, entered value and saved list.
- Missing secure entries are distinguished from unreadable, damaged or undecryptable storage. An unreadable store is preserved rather than overwritten as if it were empty.
- New keys and key removals become active only after secure persistence succeeds. A failed first-key save leaves local input available and the candidate available for retry.
- Explicitly empty secure entries represent deletion and cannot resurrect old plaintext credentials. Legacy migration occurs only when the secure record is genuinely absent; failed migration leaves the candidate inactive and preserves recovery data. Failure to clear obsolete browser storage cannot turn a successful secure save into a reported failure.

Coverage: `tests/unit/secure-store.test.js`, `credential-storage.test.js`, `startup-terminal.test.js` and provider tests. Tests use controlled storage/encryption dependencies; they do not claim recovery from every OS or profile corruption case. Live speech reports contain no plaintext credential.

## Notes and news

- Delayed note edits and file imports retain the original tab identity and content snapshot. Switching tabs cannot redirect the result, and intervening typing or deletion blocks stale replacement. Deleting a background tab preserves the active draft; a failed delete save preserves the tabs and reports the error.
- Only explicit update payloads replace a note. Fenced extraction preserves first lines, blank lines, indentation and literal backticks in code. Displayed code suggestions retain operators instead of passing through prose Markdown stripping. Saved and pasted HTML is sanitized, and literal code is escaped rather than executed.
- News refreshes invalidate older refresh/chat work. A late success or failure cannot overwrite the current brief; a failed load can retry. Chat cannot double-send or append an answer to a superseded brief. Source links are limited to HTTP(S).

`tests/renderer-races-smoke.js` passed 10 scenarios in the real renderer with controlled delayed responses, isolated storage and blocked network/native actions. Its report includes corrupt-note and blocked-storage startup checks and no uncaught renderer errors.

## Live command evidence and remaining limits

`tests/voice-command-smoke.js --live-audio` passed with the exact generated command, one successful Gemini transcription and ordered native receipts. Windows acknowledgment speech started at 411.5 ms; final speech started at 2,372.7 ms and ended at 7,441.4 ms after audio submission. A separate read-only Core Audio helper captured 43 samples during final speech, all at 75%, and independently confirmed restoration to 16%, unmuted. All 78 sample readers were disposed, releasing their COM objects, and the helper exited normally.

The latest typed run's volume-stability check remains failed in its report: the level reached 75% and was then manually lowered to 20%. The user confirmed, “Yes, I lowered it.” The trace and failure are retained with `userConfirmedManualAdjustment: true`; restoration to the initial 18%, unmuted state was independently confirmed. This explains that run only. The cause of an earlier, separate 75% receipt followed by a 38% readback remains unestablished.

The smoke now observes the exact JSON written to the native media helper to detect unintended additional volume commands. `tests/unit/voice-smoke-observer.test.js` passed two tests proving observation preserves helper behavior, including when reporting throws. This observer was added after the live runs above and has not been exercised in another live volume run.

Generated reports and recordings remain under ignored `build/qa/`. The rebuilt local 1.4.0 installer passed verification of 44 packaged source files and the actual executable passed an isolated startup/persistence smoke. Its SHA-256 is `29f192b9d6e0233f10e5bab33e5b27cc5af80561dd9d159fa627ea3df9477017`; the build is unsigned, unpublished and has not replaced the installed app. Full package details are in [VALIDATION.md](VALIDATION.md). No broad assistant parity, universal desktop compatibility or exhaustive bug-free claim follows from this audit.
