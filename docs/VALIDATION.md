# 1.4.1 validation — September 26, 2026

This release restores Workspace's shared app theme and adds manual in-app update downloads and installation. It also includes the four follow-up fixes described in the 1.4.0 record below.

| Check | Result |
| --- | --- |
| Unit suite | **506 passed**, zero failures or skips |
| Syntax, assets and version | **42 application JavaScript files passed**, version **1.4.1** |
| Isolated startup/settings smoke | **Passed** |
| Workspace UI and persistence | **16 checks passed** |
| Renderer races and storage recovery | **11 checks passed** |
| Manual update UI | **11 scenarios passed** with the real renderer and preload and simulated update IPC |
| Real GitHub download through production Electron transport | **127,417,454 installer bytes downloaded and SHA-256 verified**, with no installer execution |
| Windows installer and packaged app | NSIS build passed; **51 source files**, native helpers, offline model and version matched; packaged startup/persistence smoke passed |

The updater checks cover explicit actions, progress, cancellation, retry, errors, reopening the panel and late state responses. In particular, installation verification cannot offer a misleading download-cancel button, and a stale initial state cannot replace a newer ready event. Computed styles and screenshots at normal and narrow widths confirmed that Workspace's font declarations, fields, buttons, tabs and dialog colors match the existing app. The isolated visual tests block Google Fonts; all components use the same fallback in those screenshots.

The live download used a disposable profile and a fixture installed version of 1.3.1 to retrieve the then-current public 1.4.0 release. The production service verified GitHub's asset digests, the published checksum file and the streamed installer bytes in **6.472 seconds** for that one run. This is not a download-speed guarantee. No user profile, provider key or microphone was used. The first live attempt exposed Electron 36's failure to return manual redirects through `net.fetch`; the corrected native request adapter passed the complete download and seven additional transport regressions.

Installer-launch tests use simulated child processes to verify the fixed NSIS update/restart arguments, duplicate-request handling and failure recovery. They do **not** execute an installation or establish upgrade, UAC, antivirus, signing or rollback behavior on this machine. Windows publisher signatures are not verified by the in-app updater; checksums establish matching bytes. Ready downloads last for the current app session, with abandoned cache files cleaned on a later explicit download. There are no automatic checks, downloads or installations on quit.

Local reports, fixtures and screenshots remain under ignored `build/qa/`; generated media and installers are not committed to the repository.

The first release CI run exposed a test-clock defect: `Date.now()` used the fixture date while the zero-argument `Date` constructor used the runner's actual date. The test harness now uses the same clock for both. All **506 unit tests passed under UTC**, and the **19 timer/task tests passed under both UTC and America/Los_Angeles**, retaining the exact today/tomorrow assertions. No application behavior changed for this correction.

# 1.4.0 publication and follow-up validation — September 26, 2026

The public [Olanga 1.4.0 release](https://github.com/firestar3/Olanga-Desktop-Agent/releases/tag/v1.4.0) was built from `b74b8dbe226ceb6e90100e97902792e46ec3b41d`. Its [Windows release workflow](https://github.com/firestar3/Olanga-Desktop-Agent/actions/runs/36280354990) passed unit tests, syntax and asset checks, renderer checks, the installer build and packaged-source verification. The installer is **127,417,454 bytes**, with SHA-256 `b8c44d6ee8a3d8582940935ce10964a2ad87e315c21dcde90744bff489a0dd24`. GitHub's asset digest, the published checksum file and the release metadata agree. It is **unsigned**, as recorded in that metadata.

Four additional fixes were verified after that tag was published: cut-off streamed answers report failure, split response labels stay buffered, interrupted playback does not report completion, and failed note imports restore the original note without changing another active tab. These fixes are on `main`; they are **not included in the published 1.4.0 installer**. The existing tag and release assets were preserved.

| Current source check | Result |
| --- | --- |
| Unit suite | **471 passed, zero failures or skips** |
| Syntax, assets and version | **40 application JavaScript files passed** |
| Isolated startup/settings smoke | **Passed** |
| Workspace UI and persistence | **16 checks passed** |
| Renderer races and storage recovery | **11 checks passed**, including the new failed-import regression |
| Rebuilt local package | **49 source files**, native helpers, offline model and version matched; the packaged executable's isolated smoke passed |
| Release workflow syntax | YAML and all **9 PowerShell blocks** parsed successfully |
| Repository file review | No generated media, build outputs, extracted model directory or credential files in the push |

The failed-import regression failed against the previous source and passed after the fix. Streaming regressions cover provider truncation, response-label chunk boundaries and failed playback. The UI checks use isolated profiles; they make no live provider, microphone or privileged desktop calls. The rebuilt local installer includes the follow-up fixes and remains unpublished. This release pass does not establish live streaming latency, physical-microphone accuracy or an installation/upgrade result.

The sections below are historical records. Their test counts, local installer hashes and unpublished-build statements describe those earlier runs, not the current public release.

# Conversational latency validation — September 26, 2026

These checks cover the latency work described in [IMPROVEMENTS.md](IMPROVEMENTS.md#conversational-latency). No live Gemini key was used, so provider response times on real prompts are not measured here. The package version remains **1.4.0**.

| Check | Result | Evidence |
| --- | --- | --- |
| Unit suite | **464 tests passed, zero failures** (21 new) | `npm test` |
| Syntax, assets and version | **40 application JavaScript files passed** | `npm run check` |
| Isolated startup/settings smoke | **Passed** | `npm run smoke` |
| Renderer races | **10 checks passed** | `npm run smoke:renderer` |
| Workspace UI | **16 checks passed** in three consecutive runs after the review-removal fix | `npm run smoke:workspace` |
| Bundled Vosk comparison | **7/7** command lists, general **3/7**, no out-of-scope action | `npm run smoke:offline` |

New unit coverage includes:
- **Streaming provider:** SSE parsing across split byte chunks, thought filtering, retries before text only, cancellation mid-stream, error events, size and length stops.
- **Conversation module:** the lane classifier, sentence splitting (decimals, initials, abbreviations, long clauses) and the streaming reply parser with transcript verification and escapes.
- **Speech stream:** ordered sentences, stop and supersede, mute, Magpie pre-synthesis and Windows fallback.
- **Lane routing:** typed and spoken lanes, escapes, local commands found in a spoken transcript, one audio router call, pending clarifications and interrupted replies.
- **Endpointing and prompt:** smart endpointing thresholds, rough-transcript hand-off and the cacheable router prompt.
- **Grounded direct dispatch:** positive cases and specialist fallbacks.

An end-to-end run in a real Electron renderer used the production preload, IPC and main-process provider with a local HTTPS interceptor acting as Gemini. The interceptor sent the first chunk after 300 ms and later chunks 400 ms apart, with speech muted.
- **Typed question:** the first sentence appeared after **333 ms** and the reply finished at **1,132 ms**. The earlier path would have shown and spoken nothing before the final chunk.
- **Spoken question:** the transcript arrived from the same stream after **317 ms** and the first answer sentence at **717 ms**.
- **Request count:** each turn made **one** provider request, where the previous path made two for questions (transcription, router) and three for live questions (transcription, router, Search).

A connection measurement against Gemini's endpoint used unauthenticated requests without a body. Opening a new connection took about **400 ms** with either Node `fetch` or Electron `net.fetch`. Requests after 5–12 seconds idle took about **115 ms** with Node `fetch` and **61–77 ms** with `net.fetch`. The warm-up request targets that first-connection cost.

While checking these changes, the Workspace smoke again failed its routine-label check once, because an approved review dialog lingered after closing. Approval now removes the dialog immediately, and three consecutive runs passed.

Not covered: real Gemini time to first token, prompt-cache hit rates, the rough on-device transcript on a physical microphone, voice interruption of a streamed reply with real audio, and Magpie synthesis of streamed sentences against the live service.

# 2.0 foundations validation — September 26, 2026

These checks cover the first 2.0 wave described in [IMPROVEMENTS.md](IMPROVEMENTS.md): local time/date/help answers, reminders and alarms, memories, the daily briefing, the health check, push-to-talk, voice interruption and the end-of-speech setting. They ran on one Windows machine after the final source change. The package version remains **1.4.0**; no installer was built.

| Check | Result | Evidence |
| --- | --- | --- |
| Unit suite | **443 tests passed, zero failures** (38 new) | `npm test` |
| Syntax, assets and version | **39 application JavaScript files passed** | `npm run check` |
| Isolated startup/settings smoke | **Passed** | `npm run smoke` |
| Renderer races | **10 checks passed** | `npm run smoke:renderer` |
| Workspace UI | **16 checks passed**, no forbidden calls or renderer errors | `npm run smoke:workspace` |
| Bundled Vosk comparison | **7/7** command lists with the unchanged command vocabulary; general recognition **3/7**; the out-of-scope question produced no action | `npm run smoke:offline` |

New unit coverage includes the grammar for reminders, alarms, memories, briefings and dismissals, with negative cases that must still reach Gemini. It also covers next-occurrence alarm times, persistence of timer kinds, spoken rings only while idle, notification payloads, and stop/clarification behavior. Further tests cover memory limits, sanitizing and Gemini context gating, briefing text, health checks, push-to-talk registration and conflicts, voice interruption filtering, preference defaults and validation of model-proposed reminders.

The first two Workspace runs after the change failed one routine-label check, plus a check that failed as a result. A routine review approved in the previous scenario was closed but not yet removed from the page. Instrumented reruns showed its close handler running normally. Four instrumented runs and three clean runs then passed all 16 checks, so the failure was not reproduced. Chromium delivers dialog close events with rendering updates, which is a plausible cause; this is not established.

An attempt to add alarm, time and briefing phrases to the on-device command vocabulary made Vosk transcribe “and” as “an”, dropping the command benchmark to **3/7**. That change was reverted, and the rerun restored **7/7**. Mean recognition times in both runs (command 2,220 ms; general 5,539 ms; model load 1,782 ms) were slower than the earlier September 26 run with the same vocabulary. Machine load is a likely cause but was not measured.

A throwaway preview in an isolated profile, with speech muted and renderer network blocked, confirmed the Memories, Health and Settings layouts. It also confirmed local replies for a memory, a reminder, an alarm, a task, the time and a briefing. The briefing's headlines came from the live Google News feed through the existing main-process news path.

Not covered: voice interruption with a physical microphone and speakers, push-to-talk against shortcuts held by other applications, Windows toast display, live Gemini routing of the new markers, and weather through Google Search.

# Bug-audit validation — September 25, 2026

This audit adds behavior regressions for the reported voice/action failure and for failures found in native app control, persistence, credentials, cancellation, notes and news. The checks below ran on one Windows machine on September 25 PDT; the live reports use September 26 UTC timestamps. [BUG_AUDIT.md](BUG_AUDIT.md) describes the fixes and their coverage. These results do not establish that every bug is fixed or that Olanga matches another assistant across all tasks.

## Current evidence

| Check | Result | Local evidence |
| --- | --- | --- |
| Frozen-source unit suite | **405 tests passed, zero failures** | `npm test` |
| Application syntax, assets and version | **35 application JavaScript files passed**, version **1.4.0** | `npm run check` |
| Isolated startup/settings smoke | **Passed**, including the current credential and local-startup paths | `tests/electron-smoke.js` |
| Real-renderer note/news/storage races | **10 checks passed**; no network, microphone, privileged native calls or uncaught renderer errors | `build/qa/renderer-races-smoke.json` |
| Workspace UI and persistence | **16 checks passed**; no microphone, provider or privileged native calls | `build/qa/workspace-smoke.json` |
| Native app launch, arrangement and graceful close | **16 checks passed** in **39.692 s**, using disposable fixture windows | `build/qa/app-adapter-smoke.json` |
| Generated WAV of the exact Spotify/75% command with live Gemini | **Passed**; **one request, one attempt, one success**; final speech completed; **43 independent volume samples during final speech all measured 75%** | `build/qa/voice-command-audio-smoke.json` |
| Typed command with independent volume sampling | Action and speech checks passed; volume-stability check **failed after a user-confirmed manual volume reduction**; the failure is preserved | `build/qa/voice-command-smoke.json` |
| Bundled Vosk comparison | **7/7 expected command action lists matched** with command vocabulary; **3/7** with general recognition; no provider, microphone or desktop actions | `build/qa/offline-speech-grammar-comparison.json` |
| Rebuilt Windows package | **44 source files**, all native helpers, offline model and version match; **packaged executable smoke passed** | `npm run verify:package`, `build/qa/packaged-smoke.json` |

The renderer smoke exercises delayed note edits and imports, tab switches/deletions, safe code/HTML formatting, failed note deletion, overlapping news refreshes and chats, corrupt saved notes, and blocked browser storage. Workspace coverage now also verifies that a failed manual checklist save retains the input, rolls back the checkbox and displays the problem. The native fixture checks exact process matching, title/substring rejection, pending save/close behavior, multiple windows, graceful close with zero-window readback, and cleanup of its own windows. It does not close user applications.

Focused voice/audio regression runs passed **59 tests**, covering speech cancellation/fallback, unavailable storage, microphone lifecycle, bounded recording, offline decoder/recognizer cleanup and fatal worker errors. The new test-only native command observer passed **two tests**, including a reporting failure that must not change the helper request or receipt. These tests are included in the final 405-test frozen-source suite.

## Current local installer

The rebuilt `dist/Olanga-Setup-1.4.0.exe` is **127,395,290 bytes**. Its SHA-256 is `29f192b9d6e0233f10e5bab33e5b27cc5af80561dd9d159fa627ea3df9477017`, recorded in local `dist/SHA256SUMS` and `dist/RELEASE-METADATA.json`. Both installer and packaged executable report **NotSigned**. The metadata identifies this as a local build containing uncommitted source changes.

Package verification matched all **44 source files**, unpacked PowerShell helpers, the offline model and version. The actual `dist/win-unpacked/Olanga.exe` passed its isolated smoke: renderer/preload isolation, keyless startup without microphone access, timer/checklist save and reload, no saved credentials and no provider requests. This does not test installation, upgrade, signing or rollback. The updated installer remains local and unpublished; it has not replaced the installed app or the public 1.3.1 release.

## Current voice timing and volume evidence

The production renderer, preload, main process, Spotify helper, Core Audio and Windows speech handled “Open Spotify and raise the volume to 75%.” The generated recording was transcribed as “Open Spotify and raise the volume to 75%.” Both turns executed the ordered app/volume actions and spoke “Spotify is open. System volume is 75%.”

| From request/audio submission | Typed run | Generated WAV with live Gemini |
| --- | ---: | ---: |
| Acknowledgment function called | 5.7 ms | 39.4 ms |
| Native acknowledgment speech starts | 1,102.9 ms | 411.5 ms |
| Final speech starts | 2,413.0 ms | 2,372.7 ms |
| Final speech ends | 7,496.5 ms | 7,441.4 ms |

The acknowledgment was requested promptly, but native speech startup varied; these measurements do not claim instantaneous audible confirmation. Speech evidence consists of native start/end/error events, not acoustic recording. Timings exclude physical recording and end-of-speech detection.

A separate hidden helper sampled the default Windows output endpoint every 100 ms using read-only Core Audio calls, with timestamps aligned to speech events. In the generated-audio run, all 43 samples during final speech measured 75%, and the level remained stable through the following one-second observation. All **78** sample readers were disposed, releasing their COM objects; the helper exited normally and independently confirmed restoration to the original **16%, unmuted** state.

In the typed run, the sampler observed the verified 75% level stepping down to 20%. The user confirmed, **“Yes, I lowered it.”** The report records `userConfirmedManualAdjustment: true` while retaining `passed: false`, the failed stability check and the complete trace. Its **79** sample readers were disposed, releasing their COM objects, and the original **18%, unmuted** state was restored and independently confirmed. This confirmation explains this run only. The earlier, separate observation of an immediate 75% receipt followed by a 38% readback still has **no established cause**.

The smoke now also records the exact normalized JSON sent to the native media helper and checks for one intended volume mutation during the assistant turn. That observer was added and unit-tested **after** these live runs; the two reports above do not contain that additional evidence. No further live volume run was performed after the user's clarification.

These runs did not exercise a physical microphone, wake-word detection or live Magpie synthesis. The local recognizer and speech-error paths also have controlled behavioral tests.

## Current bundled-model comparison

The offline comparison reran from **04:40:19 to 04:41:05 UTC on September 26** using eight Windows-generated WAV fixtures, the bundled Vosk model and real audio decoding. Seven fixtures are supported commands; the eighth is an out-of-scope weather question.

| Mode | Expected command action lists matched | Mean recognition time for seven commands |
| --- | ---: | ---: |
| General recognition | 3/7 | 2,060.4 ms |
| Command vocabulary | 7/7 | 815.5 ms |

Model loading took **2,689 ms** separately. Both modes produced no local action list for the weather question, but command vocabulary transcribed it inaccurately. All decoding contexts closed, recognizers were removed, and cancellation left no active work. No network request, microphone capture, speech playback or desktop dispatch occurred. These times measure recognition after audio submission, not recording, review or task completion; they are not a direct comparison with cloud task timings. Editable review remains required in both offline modes. Evidence: `build/qa/offline-speech-grammar-comparison.json`.

## Reproducing the new audit checks

```powershell
node --test tests/unit/tts-response.test.js tests/unit/audio-controls.test.js tests/unit/offline-speech.test.js tests/unit/voice-smoke-observer.test.js
.\node_modules\.bin\electron.cmd tests/renderer-races-smoke.js
npm run smoke:workspace
npm run smoke:apps
npm run smoke:offline
```

The renderer and Workspace checks use isolated profiles and controlled data. The native app smoke uses disposable fixture windows; leave the pointer and keyboard alone while it runs. `npm run smoke:voice` temporarily sets system volume to 75% and speaks; `npm run smoke:voice:audio` also sends the generated command WAV to Gemini using the saved credential. Both restore the baseline volume/mute state and stop the independent sampler in cleanup. Run live checks only when those effects are intended, and avoid manual volume changes during a stability measurement.

Reports, screenshots, recordings, sampler scripts and temporary profiles remain under ignored `build/qa/`. Test source is tracked. Final release verification and package evidence are recorded separately from these source-level and native behavior checks.

# Historical pre-audit 1.4.0 validation — September 25, 2026

The following is the earlier validation snapshot, before the current bug audit. Its unit counts, scenario counts, voice timings and installer hash describe that earlier source/build, not the current working tree. Some report filenames are reused by later runs; the current evidence above takes precedence for their present contents.

The following checks cover the implemented Workspace, app adapters, optional offline recognition, provider boundary and release preparation. Measurements were collected on one Windows machine on September 25, 2026 (some report timestamps are September 26 UTC). They do not establish universal app compatibility or broad OpenJarvis parity. Packaging and publication are separate from source verification.

## Final automated source checks

- **325 unit tests passed, zero failures.** Coverage includes routing, receipts, persistence, routines, optional memory, offline speech review, native guardrails/undo, provider validation, release metadata and startup/Terminal failures.
- **Syntax, assets and version checks passed for 33 application JavaScript files**, with package version **1.4.0**.
- **Isolated Electron startup/settings smoke passed**, including timer/checklist creation, reload, completion/dismissal and persisted results.
- **Native overlay lifecycle passed six open/close cycles** through the orb, Escape and outside clicks, plus reopening after Open app and the five-second hide.

Additional startup tests verify first-key activation only after secure save, usable local input after a failed save, obsolete speech-mode initialization, honest microphone hints, lazy Terminal sessions, invalid directories, spawn/pipe errors, concurrent closes and stale replies. Unit/provider tests use controlled dependencies; native coverage is described separately below.

## Repeated production voice/action check

The production renderer, preload, main-process provider service, Spotify helper, Core Audio and Windows speech were rerun with “Open Spotify and raise the volume to 75%.” The passing typed run made zero model requests. The passing generated-WAV run made exactly one successful main-process Gemini transcription request. Both observed Spotify, received verified action receipts, independently read back 75% and unmuted after final speech, checked repeated mute/unmute requests, and restored the original 20%, unmuted state.

| From request submission | Typed | Generated WAV with live Gemini |
| --- | ---: | ---: |
| Acknowledgment function called | 1.9 ms | 35.9 ms |
| Native acknowledgment speech starts | 129.8 ms | 332.9 ms |
| Final speech starts | 1,474.4 ms | 1,760.1 ms |
| Final speech ends | 6,545.4 ms | 6,832.2 ms |

Speech completed in the required order without interruption. Evidence is native start/end/error events, not an acoustic recording. These individual timings exclude recording and end-of-speech detection. Reports: `build/qa/voice-command-smoke.json` and `build/qa/voice-command-audio-smoke.json`.

**Unresolved observation:** an earlier typed attempt returned an immediate verified 75% native receipt, but its later independent readback was 38%. Repeating the typed check and then the live-audio check passed. The cause of the intervening change was not established; passing repeats do not explain or resolve that observation. Physical microphone capture, wake-word recognition and live Magpie synthesis remain outside these runs.

## Workspace and local recovery

`tests/workspace-smoke.js` passed all **15 scenarios** in a real Electron renderer with an isolated profile. It exercised keyless setup; saved-name create/edit/enable/delete; routine review and cancellation; readable mixed-action review; exact local timer/checklist effects; reload without replay; operation-only retained activity; interrupted-run selection; diagnostics export and opt-out deletion; offline transcript correction/cancel/send/abort; and the Apps tab. It observed no renderer errors, microphone requests, provider requests or privileged native action calls. This test verifies UI and local state, not native app launch or speech playback.

Local evidence: `build/qa/workspace-smoke.json`, eleven screenshots beside it, and a synthetic timing export. The updated routine-review and interrupted-resume screenshots were visually inspected. Unit coverage additionally tests malformed stored records, storage failures, stale receipts, concurrent routines, partial failure, unverified outcomes and cancellation races.

## Native app adapters

`tests/app-adapter-smoke.js` passed **11 checks** using a disposable Windows fixture application and the production app controller/helper. It verified delayed startup through the actual process/window, reuse of an existing instance, left/right/maximized geometry, multiple-window reporting and refusal to arrange ambiguously, a missing app, cancellation after dispatch and startup without a visible window. The fixture cleaned up its own processes and files; user applications were not closed.

The run also observed Windows denying foreground focus. The receipt correctly reported the app as open with `focused: false`. This fixture validates the native mechanism, not every installation path or version of the 15 catalog apps. Evidence: `build/qa/app-adapter-smoke.json`.

A later rerun was interrupted by system sleep: its report spans 01:05:15–02:41:00 UTC on September 26 and ends with a timeout, not an incorrect window count. Read-only Windows System log inspection found Kernel-Power 506 entries entering Modern Standby during that interval and a 507 exit at 02:40:52 UTC. The failed report is preserved as `build/qa/app-adapter-smoke-interrupted.json`; timestamp/transition evidence is in `build/qa/app-adapter-standby-evidence.json`.

The unchanged fixture passed all 11 checks after wake in 21.09 seconds (02:56:38–02:56:59 UTC). It reported exactly two windows without focusing either and refused arrangement with `ambiguous-window`, then closed its fixture. That successful rerun is the current `build/qa/app-adapter-smoke.json`. Native timing tests require an awake desktop; no adapter or fixture code was changed for this environmental interruption.

## Native text replacement and undo

The disposable native editor smoke passed **three consecutive runs** after a readback reliability fix. Each run used production Win32/UI Automation to replace the complete field, read back the exact multiline value, capture fresh evidence, restore and verify the original value, and refuse undo after either an intervening text change or replacement of the editor control. Approval dialogs were injected only for the fixture, and no provider or user document was involved.

An earlier run failed because the immediately read accessible value did not match the replacement. The helper now allows up to 1.5 seconds for readback after its single `SetValue` call. It does not send the edit again, and every read retains the editor identity checks; changed identity or focus fails immediately. Deterministic tests execute that production C# verification routine against delayed, permanently stale, normalized-newline and conflicting readers. Together with the automation tests, all **24 targeted tests** passed, including full helper compilation.

This verifies a supported accessible field, not arbitrary document undo. Evidence: `build/qa/desktop-edit-smoke.json` and `build/qa/desktop-edit-repeat-verification.json` (the final two runs).

## Offline speech comparison

`tests/offline-speech-smoke.js --compare-grammar` used the bundled Vosk model and real WAV decoding with network blocked. Eight recordings were generated by Windows System.Speech: seven supported commands and one out-of-scope weather question. Each recording was tested against the same general and constrained command recognizers.

| Mode | Expected command actions | Mean recognition time for the seven commands |
| --- | ---: | ---: |
| General dictation | 3/7 | 3.02 s |
| Command vocabulary | 7/7 | 1.04 s |

Both modes produced no local actions for the out-of-scope question; command mode did not transcribe that question accurately. Model loading took 1.57 s separately. Recognizers and audio decoding contexts were released, and cancellation settled without active work. These timings measure recognition after audio submission, excluding microphone recording, review, action execution and final speech. They are not comparable to the earlier cloud task-completion timings.

This benchmark uses synthetic speech, a small English command set and no desktop dispatch. It does not measure physical microphone accuracy, accents, noise, wake-word quality, memory/CPU consumption or recognition of arbitrary questions. The app requires editable transcript review in **both** offline modes and retains cloud recognition as the default. Evidence: `build/qa/offline-speech-grammar-comparison.json`.

## Provider and distribution boundaries

Provider regression tests use controlled HTTP responses to exercise main-process credential retrieval, endpoint/body validation, quotas, bounded retries, key rotation, model fallback, cancellation during credentials/backoff/response work, response limits, concurrency, timeout, redacted errors and session usage metadata. They do not establish live provider availability or quota.

The **12 release-service tests** passed with mocked GitHub responses and local unsigned PE fixtures. Tests cover semantic-version comparison, trusted URLs, invalid/draft/prerelease data, timeout and stalled streams, bounded responses, caching and concurrent checks. The exact workflow artifact-verification step hashed final fixture bytes and observed `NotSigned`; the configured-signing branch correctly rejected those unsigned files. Workflow PowerShell blocks also parsed successfully.

No signing credentials, live signed installer, GitHub publication, automatic update, or rollback was tested or enabled by these checks. The manual checker retrieves metadata only and explicitly reports that asset verification was not performed. Release preparation is described in [RELEASING.md](RELEASING.md).

## Local package verification

The unsigned **`Olanga-Setup-1.4.0.exe`** built successfully (127,388,745 bytes after correcting the app-smoke script command). `npm run verify:package` passed for **41 source files**, all unpacked native helpers, the bundled offline model and version 1.4.0.

The final local `SHA256SUMS` and `RELEASE-METADATA.json` record installer SHA-256 `98d6a78258301a179f0efcd5e6995bbe0d01aef332e289d4ce9ea31ce4b6dc11`. Authenticode inspection reported `NotSigned` for both the installer and packaged executable. This verifies the observed local bytes and unsigned status; it does not establish publisher identity.

`npm run smoke:packaged` launched the actual `dist/win-unpacked/Olanga.exe` with an isolated profile. It verified packaged renderer/preload isolation and the new APIs, keyless startup without a microphone, timer/checklist persistence across reload, and no saved credentials or provider requests. Evidence: `build/qa/packaged-smoke.json`.

This checks the built application, not installation, upgrade migration, signing or rollback. The 1.4.0 installer remains local and unpublished; the latest public installer is 1.3.1.

## Reproducing checks

From the Windows source checkout:

```powershell
npm run check
npm test
npm run smoke
npm run smoke:workspace
npm run smoke:offline
npm run smoke:apps
npm run smoke:desktop
```

The app-adapter and desktop tests operate disposable native windows. Leave the pointer and keyboard alone during those runs. The desktop fixture injects approvals only for its own editor; production still requires native confirmation.

`npm run smoke:voice` opens Spotify, temporarily changes system volume to 75%, speaks acknowledgments/results and restores the original level and mute state. `npm run smoke:voice:audio` additionally sends a generated WAV to Gemini using the saved key. Run the latter only when that provider request is intended. Neither uses a physical microphone. Optional overlay checks are `npm run smoke:overlay` and `npm run smoke:overlay:native`.

Generated reports, temporary profiles, screenshots and audio stay under ignored `build/qa/`; promotional media and local videos are also ignored. Test source remains tracked. Installer build and verification procedures belong in [RELEASING.md](RELEASING.md).

After building, `npm run verify:package` checks packaged content and `npm run smoke:packaged` tests the built executable in a separate profile. The latter does not install the app or alter the normal user profile.

# Earlier reliability validation (September 25, 2026)

The reliability improvements described in [the improvement plan](IMPROVEMENTS.md) passed:

- **197 unit tests.** New cases cover timer restart/deadline/dismissal behavior, overdue alarms, malformed storage, failed saves, decimal duration parsing, exact and ambiguous task matches, clarification without replaying compound steps, direct action results, relative-volume ambiguity, repeated mute/unmute, Windows speech cancellation without native events, duplicate speech events, and alarm resource cleanup even when audio initialization never resolves.
- **Syntax, version, and asset checks** for all 26 application JavaScript files at that stage. The package still reported 1.3.1 for this earlier run.
- **Isolated Electron smoke.** The real renderer creates a timer and checklist item, reloads, verifies the original deadline and rendered content, completes the task and dismisses the timer through their UI controls, then reloads again to verify persistence. Existing startup, shortcuts, settings, credential validation, and desktop dialog checks also pass. This uses a temporary profile and blocked network.
- **Real Windows voice/action smoke.** The production renderer, preload, IPC, native helper, and Windows speech complete “Open Spotify and raise the volume to 75%.” Both actions return verified receipts, and an independent readback confirms 75% and unmuted. Acknowledgment was queued at 2 ms, native acknowledgment speech started at 702 ms, final speech started at 2,056 ms and ended at 7,118 ms without interruption. These are one-run observations, not latency guarantees.
- **Real repeated mute/unmute.** Two consecutive mute requests and two consecutive unmute requests through production IPC each produce the requested state, verified by separate Core Audio reads while preserving the 75% level. The test restores and independently verifies the original **22%, unmuted** state.

The Windows smoke made no model requests. Native speech evidence consists of start/end/error events, not an acoustic recording. Live transcription, physical microphone capture, and live Magpie synthesis were not rerun in this change. Unit tests exercise those routing/fallback boundaries; the earlier synthetic transcription result below remains historical evidence.

Local report: `build/qa/voice-command-smoke.json`. These observations precede the additional Workspace and provider changes above; they do not establish that the final 1.4.0 installer was packaged or installed.

# Validation for 1.3.1

## Compound voice command regression (September 24, 2026)

The previous suite missed the reported command: "Open Spotify and raise the volume to 75%". It tested media operations and mocked routing separately, without exercising this conjunction, absolute volume, native launch completion, or acknowledgment/final-speech ordering.

- All 169 unit tests pass. New coverage includes ordered compounds, spoken percentage numbers, unsupported clauses, bounded absolute volume, native result validation, cancellation, partial failures, immediate acknowledgment, and recovery from interrupted Magpie replies.
- Syntax/assets/version checks pass for 26 JavaScript files. Isolated Electron startup/settings smoke passes.
- `npm run smoke:voice` passes with real production renderer, preload, IPC, Spotify launch, Core Audio and Windows speech. No model requests occur. Acknowledgment speech started at 163 ms; final speech started at 1,527 ms and naturally ended at 6,596 ms.
- `npm run smoke:voice:audio` passes using a generated WAV of the exact command and one live Gemini transcription request, explicitly approved by the user. Transcript: "Open Spotify and raise the volume to 75%." Acknowledgment speech started at 296 ms; final speech started at 1,788 ms and naturally ended at 6,865 ms. These timings start at audio submission, excluding recording and end-of-speech detection.
- Both live tests observed a Spotify window/process, received verified results for both actions, independently read back system volume at 75% and unmuted, and spoke "Spotify is open. System volume is 75%." Native speech events show acknowledgment completion before final audio starts. Each test restored the prior volume of 22% and prior mute state.
- The audio test uses an isolated profile with only encrypted OS-crypt metadata copied for credential decryption. The saved Gemini credential remains in memory; it is not written to reports. The normal user profile is read-only during testing.
- Local evidence: `build/qa/voice-command-smoke.json`, `build/qa/voice-command-audio-smoke.json`, screenshots beside them, and `build/qa/voice-fix-unit-tests.txt`.

The installer build and package verification pass: 33 source assets, native helpers, offline model and version 1.3.1 match. Silent installation exited successfully; the installed ASAR matches the verified package, the executable reports 1.3.1, and Olanga was restarted. No commit, tag, push or GitHub release was made.

Limits: speech evidence is Windows start/end/error events, not acoustic recording. The audio input was synthetic, so physical microphone quality, wake-word recognition and VAD timing remain untested. Live Magpie service synthesis was not tested; its interruption and fallback behavior has behavioral regression coverage. These results verify this concrete task and do not establish universal desktop compatibility or broad OpenJarvis parity.

# Historical validation for 1.3.0

## Automated checks

- All 120 unit tests pass. Coverage includes Gemini-only routing, follow-up context, provider fallback, unavailable credentials, action cancellation, one bounded plan repair, explicit click/key normalization, immutable approvals, native scope limits and verification failures.
- Syntax/assets/version checks pass for 24 JavaScript files.
- Isolated Electron startup and Settings checks pass with an empty profile and blocked network. NVIDIA chat IPC is absent; Magpie controls remain.
- The existing compact light and reopen regression coverage remains in the unit suite. Its implementation is unchanged in this release.

## Real Windows input

The committed desktop smoke test opens a separate disposable editor and restricts all input to that process and its accessible text field. It exercises production Win32/UI Automation input, reads back the exact multiline text and checks that the post-edit image differs from the initial fixture image. Native confirmations are injected only in this test. Production still requires both dialogs; unit tests verify that denying either prevents input.

This test exposed and fixed dropped line breaks: Chromium ignores Unicode carriage-return packets, so approved newlines now use Return key pairs. The fixture enables Chromium's native UI Automation provider. Apps without accessible editable controls remain unsupported in editor-only mode.

## Live Gemini checks

Synthetic text and fixture images used the saved Google key without printing it. No personal screen images or files were sent.

- The conversation sequence passed: request to complete a task → ask which task → Buy milk → one stubbed completion → Thanks without replay. Six messages remained in context.
- The complete live screen edit passed with production planning and native input. Gemini diagnosed subtraction in the fixture add function, proposed focus / Ctrl+A / exact replacement, and native input produced the expected multiline function. Gemini inspected a fresh image, verified the visible correction and produced a separate final response. The final passing run received HTTP 200 for all three calls.
- Runtime code execution was not performed or claimed. The verified goal was the visible operator correction with formatting preserved.
- Earlier runs encountered provider 503s, truncated replies and invalid proposals. Failed proposals sent no input. The unavailable 3.8 model was removed from defaults, thinking/output budgets were bounded, common click/key shorthand is normalized before review, and one invalid-format repair is allowed before preparation.
- Google Search returned quota errors with this account. Search is now a separate path, so it is not required for routine speech routing or actions. Live-information requests still need available Google Search quota.

NVIDIA reasoning has been removed. Magpie's existing TTS integration is retained; a valid separate NVIDIA key is still required for that voice. No new successful live Magpie authentication test is claimed.

## Distribution and limits

The existing x64 Windows NSIS release workflow is preserved. Package verification confirms 30 source files, the unpacked native helper, offline wake-word model and version 1.3.0 match the source. No git commands, commits, tags, pushes or GitHub publication were performed.

The tests do not establish universal desktop compatibility. A physical microphone conversation, IntelliJ edits, arbitrary Explorer/Settings workflows, all display configurations and runtime correctness of generated fixes are not covered by the disposable fixture. Further phases require new approval. The installer remains unsigned.

The 1.3.0 installer completed successfully. The installed ASAR hash and native helper match the verified build, and Olanga was restarted using the normal Start-menu shortcut. The installed executable reports version 1.3.0.0.
