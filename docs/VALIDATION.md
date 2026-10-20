# Current source validation — October 19, 2026

This increment improves local recall, routing, capture allocation, result speech preparation and background work after `bf68716`. It is unpublished source on the existing development branch; the public version and release assets remain 1.6.0. Tests use disposable profiles and scripted providers/native results. They do not establish live Spotify, cloud transcription, physical microphone or acoustic response latency.

| Check | Confirmed result |
| --- | --- |
| Final full unit suite | **1,039 passed**, zero failures, skips or cancellations |
| Source and required assets | **86 JavaScript files passed**; version, local model, fonts and icon assets checked |
| Production renderer | **220 checks passed**: assistant 6, routines 12, audio setup 9, Workspace 18, Settings 20, layouts 91, Work tools 16, personal backups 10, Workspace recovery 11, News 8, renderer races 12, resource lifecycle 7 |
| Original compound request | The actual renderer handled typed and fixture-transcribed Open/Play Spotify plus 75% volume, verified both receipts, retained failure status when Spotify failed, continued the independent explicit volume change, and stopped undispatched steps on cancellation |
| Acknowledgment and final result | Held promises establish that acknowledgment text appears immediately, verified result text and eligible synthesis precede acknowledgment completion, playback stays ordered, and prepared synthesis is reused once |
| Memory and search | Known typed/spoken facts answer locally; a mismatched rough/final transcript cannot speak an invented memory answer; supported fact-plus-question requests learn locally and use one answer/search call; protected changes ask after success and remain audible with trailing stream whitespace |
| Checklist context | Bounded whole task identities, honest omissions, no unrelated checklist scan/upload, explicit full-store target resolution, case-sensitive omitted IDs, synthesized-goal exclusion and recovery from overlong clarification requests |
| Hidden Workspace load | With 50 memories and 40 simulated two-step requests: zero hidden-list mutations and zero session-activity storage writes; opening renders current data and unrelated activity preserves editor keyboard focus |
| Routing compatibility | **9,788 generated legacy requests** matched the baseline parser result exactly |
| Development executable | **29 packaged-executable checks passed**; 117 packaged source files, native helpers, local model and version match source; app/tray alpha and the EXE orb pixels checked at all nine native sizes. This is an unsigned local development package, with no new installer installation or public release |
| Whole-app resource gate | **Not passed**: first pair missed 1/23 limits, repeat missed 6/23. A longer diagnostic did not reproduce the tray CPU increase; the original failures remain recorded below. No new total CPU/RAM reduction is claimed |

## Local efficiency measurements

These are fixture microbenchmarks on this Windows machine, not percentages of total application CPU/RAM or live response latency. The baseline is `bf68716`. The reproducible component run uses 750 iterations across nine paired rounds, alternating baseline and candidate order, plus 500 first-use memory samples. Audio fixtures use identical samples, assert packet/WAV equivalence, and never open a physical device.

| Component | Baseline → candidate | Interpretation |
| --- | --- | --- |
| Common intent parsing | 28.38 → 21.50 microseconds per parse | 24.2% lower median; single commands 40.2%, compounds 21.7% |
| Warm relevant-memory selection, 50 facts | 0.377 → 0.034 ms | 91.1% lower median through an invalidated local index |
| Memory-only snapshot with full activity/diagnostics | 1.036 → 0.066 ms | 93.6% lower median by avoiding unrelated history cloning |
| Two-action session-only activity | 0.239 → 0.023 ms; 7 → 0 storage writes per turn | Notifications remain live; required routine journals and durable edits still save synchronously |
| First memory selection after load | 0.378 → 0.479 ms | Index construction adds about 0.101 ms; this cold operation is not faster |
| Pre-roll sample buffers over 60 seconds | 1,865 buffers / 6,571,136 bytes → 1 buffer / 48,000 bytes | Allocated sample-buffer bytes, not resident application memory; packet boundaries and endpoint timing preserved |
| Pre-roll processing, 15,000 packets | 105.95 → 8.75 ms median | Reuses a bounded ring instead of copying every incoming packet |
| WAV encoding, 10 / 60 seconds | 11.72 → 9.90 ms / 61.57 → 52.57 ms | Removes an additional 640,000 / 3,840,000-byte merged float recording |
| Large checklist prompt fixture | Approximately 940,000 → under 6,000 characters | About 99.4% smaller; unrelated questions include no checklist data |
| Ordinary 100-task context selection | 0.17 ms list / 0.48 ms exact target | Local selection overhead; an extreme 500-long-name scan took about 101 ms under concurrent test/build load and is not claimed to be faster |
| Prepared result speech, deterministic clock | 500 ms acknowledgment + 800 ms synthesis: result audio ready at 800 ms instead of 1,300 ms | Overlaps synthesis after verification; one synthesis in either case. This is a controlled fixture, not a provider or acoustic benchmark |

Memory extraction remains a narrow local rule set. Conflicting compound memories block guessing and automatic replacement. Pausing learning preserves enabled recall; disabling memory use prevents it. Queries, documents, model output and action results do not become learned facts. A complete supported fact in a separate sentence before an information question can be learned without treating that question as a fact.

## Packaged resource and resume measurements

**The whole-app resource gate did not pass.** The first pair exceeded one of 23 preset limits; the immediate baseline/candidate repeat exceeded six. Limits were unchanged. These results do not support a new overall CPU/RAM reduction claim or prove that every operation is faster.

Both builds use Electron 44.7.0, disposable profiles and synthetic silence, with no physical microphone or provider calls. Each phase has 20 counter snapshots (19 CPU intervals); at this sample count, p95 is the largest interval. CPU is a percentage of one logical core. Private resident memory is one end-of-phase snapshot and is distinct from committed memory. The repeat ran without concurrent builds or test suites; ambient machine load and Windows memory residency were not controlled.

| State | First CPU p95, baseline → candidate | Repeat CPU p95 | First private resident MiB | Repeat private resident MiB |
| --- | --- | --- | --- | --- |
| visible-idle | 26.16% → 35.66% | 37.43% → 26.20% | 234.97 → 217.48 | 225.95 → 206.75 |
| visible-settings | 1.34% → 1.46% | 1.47% → 1.47% | 217.66 → 223.06 | 230.38 → 213.88 |
| tray-idle | 1.45% → 0.00% | 4.28% → 1.47% | 223.03 → 215.20 | 220.21 → 208.17 |
| visible-voice-ready | 116.47% → 107.70% | 125.51% → 66.15% | 482.09 → 446.76 | 481.56 → 466.88 |
| tray-voice-ready | 62.44% → 77.35% | 46.33% → 51.80% | 489.17 → 454.40 | 229.88 → 471.63 |
| tray-muted | 9.43% → 10.95% | 11.42% → 14.78% | 288.11 → 154.45 | 141.46 → 271.55 |
| visible-muted | 37.34% → 47.45% | 37.24% → 31.07% | 279.55 → 156.69 | 142.73 → 269.16 |

The first miss was visible-idle CPU p95: 35.658 against a 35.312 limit. The repeat missed private-resident and total-working-set limits in tray voice-ready, tray-muted and visible-muted states. For example, repeated tray-muted working-set p95 was 285.41 → 725.79 MiB, against a 342.49 limit. These failures are retained, not treated as passing functional tests.

Private committed memory in voice/muted states was modestly lower in the candidate in both pairs, while residency changed markedly even for unchanged source: baseline tray voice-ready private residency was 489.17 then 229.88 MiB, with committed memory 582.72 then 578.35 MiB. This shows substantial run-to-run residency variation; it does not establish that the misses are harmless or rule out every allocation issue. Renderer heap samples were identically coarsened to 10,000,000 bytes and cannot establish heap stability.

Tray voice-ready average CPU increased in both pairs, 51.16% → 68.20% and 31.72% → 39.51% of one core, despite passing that phase's p95 budget. This remains an adverse signal requiring investigation. Visible voice-ready renderer work fell in both pairs: script-duration share 8.54% → 0.67% and 17.76% → 0.44%, with style recalculations 2,373 → 1 and 1,609 → 1. Capture packet size, recognition frequency, endpoint timing and model-retention policy were unchanged. The process CPU readings also include recognizer, audio-service and graphics work, so lower renderer work is not a whole-process CPU guarantee.

| Latency observation | First pair, baseline → candidate | Repeat pair, baseline → candidate |
| --- | --- | --- |
| Startup ready | 5,999 → 1,894 ms | 6,415 → 3,271 ms |
| Cold voice resume median, three samples | 3,726 → 4,079 ms | 3,752 → 1,391 ms |
| Cold voice resume p95 / maximum | 23,615 → 5,449 ms | 6,020 → 1,826 ms |

Both startup and cold-resume budget checks passed in both pairs. Cold-resume medians moved in opposite directions, and the first baseline includes a 23.6-second outlier. Three resume samples cannot establish a stable speedup or a universal no-regression claim. Readiness requires an unmuted live capture track, a running audio context, a loaded model and a recognizer; this still does not measure cloud transcription, acoustic speech or a real Spotify action.

Raw reports are `build/qa/resources/efficiency-bf68716-baseline.json`, `efficiency-final-candidate.json`, `efficiency-comparison.json` and the corresponding `efficiency-bf68716-confirm.json`, `efficiency-final-confirm.json`, `efficiency-comparison-confirm.json`. The final candidate executable is in `build/qa/efficiency-package/win-unpacked`. These local artifacts remain ignored and unpublished.

### Longer capture diagnostic

A separate sequential diagnostic kept both production packages unchanged and instrumented only the disposable renderer. It sampled 45 visible and 90 tray counter snapshots, with 12-second visible and 30-second tray settling periods. Warmed tray CPU mean was 47.53% → 45.29% and p95 was 58.76% → 56.26%; the earlier tray CPU increase did not reproduce. Visible mean CPU remained higher, 55.72% → 60.16%. These results do not replace or turn the two failed standard comparisons into passes.

Both packages delivered essentially all audio-clock output, within one 64 ms packet at the boundaries, with zero worklet gap events. Capture, recognizer acceptance and posted Vosk sample totals matched within each run; worker responses lagged by at most one at the sampled boundary. Accepted tray audio covered 94.03% → 96.57% of wall time. This found no capture-loss explanation for the earlier CPU difference, and it does not establish its cause. Pre-roll handler time per accepted audio second fell 0.548 → 0.130 ms.

CPU and audio-counter windows differ because audio counters include sampler startup and CIM time. Exact CPU per audio second cannot be derived from this diagnostic; handler timings and audio totals share the same counter window. Reports are `build/qa/resources/voice-packets-bf68716.json` and `voice-packets-final.json`, with the ignored reproducer and detailed findings in `build/qa/voice-packet-diagnostic.js` and `voice-packet-diagnostic-findings.md`. No production change was made in response to these variable measurements.

Reproduce the functional checks with `npm test`, `npm run check`, `npm run smoke:assistant`, `npm run smoke:routines`, `npm run smoke:workspace`, `npm run smoke:settings`, `npm run smoke:layout`, `npm run smoke:workbench`, `npm run smoke:audio-setup`, `npm run smoke:backups`, `npm run smoke:recovery`, `npm run smoke:news`, `npm run smoke:renderer` and `npm run smoke:resources`. CI includes the new assistant fixture. Reproduce parser, memory and activity component comparisons with `node tests/efficiency-benchmark.js bf68716 --save`; the script uses Git source and synthetic local data only. Raw reports, one-off audio/checklist benchmark scripts, screenshots, disposable profiles and build outputs remain ignored under `build/qa`; no personal credentials or media are committed.

---

# Earlier source validation — October 14, 2026

These checks cover the conversational-learning and workspace changes after the published 1.6.0 release. They do not describe a new public installer. Version/tag/release assets remain unchanged; the local development package is used only for isolated acceptance checks. Production source was frozen before the final unit run.

| Check | Confirmed result |
| --- | --- |
| Full unit suite | **935 passed**, zero failures, skips or cancellations |
| Source and required assets | **85 JavaScript files passed**; bundled backup stylesheet and existing icon/model assets checked |
| Conversational assistant | **22 focused integration cases**, included in the full unit suite: voice transcript learning, same-slot updates, spoken manual-memory replacement, mixed requests, compound-memory preservation, pause/undo, relevant context, deletion during repeat speech, current-answer memory evidence, local cancellation and stale-confirmation refusal |
| Routine conversation | **11 production-renderer checks** using the actual audio-request entry point with fixture transcription: exact editor navigation, named routine review, spoken selection, confirmation, cancellation, expiration/change rejection, duplicate confirmation and unfinished-step recovery |
| Guided audio | **8 production-renderer checks** with mocked devices; **11 AudioInput API cases** and **10 Health cases** are included in the unit total. Selection, rollback, disconnected-device recovery, local phrase isolation and hidden-meter shutdown are covered |
| Personal backup and Notes history | **10 production-renderer checks**: real JSON export/download, six-collection previews/restores, write failure rollback, paused clocks/disabled schedules across reload, retained original Notes bytes, history/trash and recovery-copy controls |
| Named workspaces and Work tools | **16 production-renderer checks** covering scoped save/resume, fresh previews, companion gates, project source freshness, partial results and readable Home controls at 400px and 150% zoom |
| Existing Settings and Workspace | **20 Settings checks** and **16 Workspace checks** |
| Renderer regressions | **12 checks** including Notes save/import races and startup with blocked storage |
| Responsive layout | **91 checks** across narrow, normal, wide and enlarged-text layouts |
| Development Windows package | **27 packaged-executable checks passed**, including keyless setup, conversational learning/update/deletion, exact routine-editor navigation, spoken-style confirmation without duplicate effects, portable modules and persistence across reload. **116 packaged source files**, native helpers, local model and version match the frozen source; app/tray orb pixels verified at all nine sizes. No new installer or release was published |
| Renderer total | **184 checks passed** across the eight fixture groups above; no live providers, personal profiles, physical microphone, Spotify playback or native desktop actions |

Learning uses conservative local extraction of seven clear everyday fact/preference categories. It does not train a model, infer new action permissions, learn from model/tool/document output or promise to remember arbitrary speech. A manually saved compound memory is preserved when one part conflicts. Mixed requests still receive their answer; a safe replacement question follows only after a successful answer. Recent memory-dependent conversation and repeatable results are cleared when a fact is deleted, disabled or replaced.

Native result uncertainty is retained in both Home and Activity. A missing/failed spoken reply does not turn a verified completed action into a failed action. Reviewing unfinished work never automatically selects completed or uncertain effects. The Windows file-workflow journal now retries transient atomic-rename locks without repeating a file operation; exhausted writes preserve verified physical results and stop remaining changes.

Reproduce with npm test, npm run check, npm run smoke:routines, npm run smoke:audio-setup, npm run smoke:backups, npm run smoke:settings, npm run smoke:workspace, npm run smoke:workbench, npm run smoke:renderer and npm run smoke:layout. CI now includes the three new fixture commands. Local renderer checks used Electron 44.7.0 and disposable profiles. The prior restriction to fixture testing remains in place: live microphone/transcription, actual Spotify and user-profile upgrade behavior are not newly verified by this increment.

Reports, disposable profiles, screenshots and build outputs stay under ignored build/qa paths. Source control contains code, test fixtures and documentation only. README and the packaged privacy notice document learning controls, limits, retention and backup exclusions.

---

# 1.6.0 validation — October 12, 2026

The 1.6.0 candidate adds protected Workspace storage and personal backups, organized explicit memories, automatic conversation-context cleanup, response preferences, direct Workspace navigation, a source-based News reader and stronger update readiness checks. Completed results appear before acknowledgment speech finishes. Settings retains the shared theme, with User preferences, Core settings and an offline Privacy notice.

These results record local pre-release validation of an **unsigned 1.6.0 build**. Published artifact checksums and remote workflow results are recorded separately on GitHub. The candidate runtime is **Electron 44.7.0**; compatibility results below do not by themselves establish a performance improvement. The isolated real-installer journey passed. Performance measurements are retained as informational evidence; further optimization was deferred to prioritize the core features and layout work.

| Check | Confirmed result |
| --- | --- |
| Unit suite | **814 tests passed**, zero failures or skips |
| Syntax and required assets | **76 JavaScript files passed**; application version **1.6.0** |
| Settings experience | **20 production-renderer checks passed**, including 18 tab/viewport combinations, keyboard focus scrolling, appearance, offline font/notice access, preference persistence, response preferences and explicit Core connection-test races |
| Responsive layout and navigation | **91 checks passed across 76 captures** for Home, Notes, News, all Workspace/Work tools sections and review dialogs at narrow, standard, wide and 125% enlarged-text sizes; no horizontal overflow or forbidden external actions |
| News reader | **8 production-renderer checks passed** for direct headlines, safe links, read markers, failed writes/refresh, saved topics, the 400px layout and explicit AI success/failure/retry with exact source context |
| Renderer races | **12 checks passed** |
| Workspace recovery and backups | **11 production-renderer checks passed**, including retained-copy download, reviewed restore and selected-copy deletion across restart |
| Existing Workspace | **16 checks passed** |
| Work tools | **12 checks passed** |
| Manual update UI | **11 scenarios passed** |
| Resource lifecycle | **7 checks passed**; these are lifecycle regressions, not a CPU/RAM comparison |
| Native updater | **10 Windows fixture cases passed** using disposable executables and the production supervisor |
| Packaged profile compatibility | **44 checks passed**, actual **1.5.2 → 1.6.0** executables sharing one disposable profile |
| Final package contents and artwork | **106 source files, including the bundled speech library**, native helpers, offline model and version matched; transparent application, tray and installer orbs verified at all nine icon sizes; unsigned signing policy verified |
| Final packaged startup | **22 checks passed in each of hidden, updated and recovery launch modes** |
| Full fixture NSIS update journey | **10 checks passed** through the real NSIS installer and production updater/renderer; installed archives matched the verified fixture builds |
| Paired resource comparison | **Not a passing performance gate:** the first pair exceeded 8 of 23 limits; the diagnostic repeat exceeded 3. Functional readiness passed in both. Further optimization is deferred; no new resource-reduction claim is made. |

The isolated NSIS journey used a separate Windows application identity, install directory and disposable profile. Both the baseline and target fixture archives matched 89 production source files plus the test host, and the archives actually installed on disk matched those verified builds. The production updater checked and installed a locally supplied release, then recorded schema-2 readiness for version 1.6.0 only after a usable renderer and visible window were available. All ten journey checks passed in the final frozen-source run; the fixture registry entry and private installation directory were removed afterward. The fixture baseline reports version 1.5.2 but packages the current updater code. This validates the updater shipped in 1.6.0; it does not prove the behavior of an older published helper during an incoming upgrade, live GitHub transport, UAC, signing or rollback.
## Resource observations and remaining work

Measurements compared the settings checkpoint (e51f6ac, Electron 36.9.5) with the 1.6.0 candidate (Electron 44.7.0) on the same eight-logical-processor Windows machine. Each full pair used separate disposable profiles, synthetic silence, no provider calls and seven visible/tray/voice/muted states. Twenty counter snapshots produce 19 CPU intervals per state; at this small sample count the reported p95 is the largest interval. Private resident memory is a separate end-of-state snapshot, not committed memory or a peak.

The first comparison exceeded eight of the 23 predefined CPU, memory and latency limits. A repeat added screen/animation assertions and renderer performance counters without changing the limits. The earlier Settings spike did not recur: the repeat measured 0.00% mean CPU and 238.06 MiB private resident memory for 1.6.0, compared with 0.30% and 241.20 MiB for the checkpoint. Both had the main screen hidden, no rendered animations, and essentially no renderer work while Settings was open. No persistent Settings drawing loop was identified.

The repeat still exceeded three limits: voice-ready CPU p95 while visible (77.39 versus 55.30 percent of one logical core), voice-ready CPU p95 in the tray (51.84 versus 36.64), and cold-resume p95 (3,693 versus 922 ms). Candidate private resident memory was lower in all seven repeated states, but this does not cancel the CPU or latency exceptions. The first pair had cold-resume p95 of 1,870 versus 1,577 ms, illustrating the variation. Both runtime probes used hardware-accelerated Intel Iris Xe/ANGLE D3D11; no software-rendering fallback explained the difference.

A longer follow-up was started with 60 voice snapshots and additional cold-resume diagnostics. It stopped when the selected screen/viewport changed during the baseline run, correctly failing the screen assertion. No candidate comparison is claimed from that incomplete experiment. Further performance tuning was explicitly deferred in favor of finishing the core features and responsive layouts. These observations precede the final Settings layout adjustment and are not a universal speed or resource guarantee.

The retained reports are build/qa/resources/settings-baseline.json, release-160.json, comparison-160.json, their -confirm counterparts, the incomplete settings-baseline-voice60.json and build/qa/gpu-runtime-comparison.json. Reproduction and optional longer voice sampling are described in [Releasing](RELEASING.md).

The final local installer has SHA-256 **a8a468aa9c752d799cec8f3624c594a8ff953e8ccce05b35898533a3bf761d11**. Package verification, startup checks and the isolated real-installer update journey passed.

## What the new checks establish

**Responsive layouts.** Settings uses the available window with responsive card columns and a fixed header above its scroller; all three tabs were inspected at 400, 768, 1280, 1536 and 2048 pixels and a short-height window. Home command and voice controls remain reachable, Notes toolbars wrap and its AI panel stacks at narrow widths, and task/timer fields can shrink with enlarged text. The separate layout suite captured 76 views at 400×550, 1100×800, 1600×950 and 400×650 with 125% zoom. Notes assistant activation reveals and focuses the input; closing returns focus while preserving unchanged note content/selection and rejecting a stale range after edits or tab changes. It exercises Electron-generated input, not a physical keyboard or a screen-reader conformance audit.

**Workspace storage and recovery.** Unit and renderer fixtures preserve malformed, unsupported-version and unreadable storage instead of allowing ordinary activity to overwrite it. Persistent edits report that recovery is required while session-only activity remains available. Reset requires a verified retained copy and explicit confirmation. Backup tests cover personal-content-only export, invalid inputs, cancelled restoration, changed data invalidating a preview, and a newer file selection winning over a delayed older read. Restoring routine definitions never executes them. Recovery copies survive restart and have separate download/delete controls. The renderer fixture downloaded exact source bytes only to its disposable output, reviewed and cancelled restoration, restored a selected copy, refused damaged data, cancelled deletion and verified that confirmed deletion removed only the selected copy across restart; they can retain older memories and metadata. The personal backup excludes keys, settings, timers, notes, checklist entries, schedules, activity and run receipts.

**Conversation and results.** The assistant keeps bounded recent context and expires inactive context automatically; no **New conversation** button was added. Memory deletion, disabling and replacement invalidate dependent context and pending replies, while a deliberate forget operation can finish. Coverage includes references to a saved fact while memories are disabled, local memory replies and later model replies. A regression also saves a fact after a pending reply has consumed its original conversation message, then deletes or disables it; the request is cancelled and a late paraphrase cannot re-enter context. Unrelated local requests remain active. A stalled acknowledgment cannot delay displaying completed action results; cancellation still prevents stale replies. Audio start and action timing use application events, not an acoustic microphone measurement. Response style and preferred address do not grant action permission.

**Core connection testing and navigation.** Opening Core settings reads configured status without a provider test. Its explicit test is deduplicated, rejects a late result after the key changes, and displays the key that actually succeeded when rotation is used. Tests use fixture keys and responses, not personal credentials or a live provider. Direct Projects, Schedules and Updates destinations dispatch no commands. Example chips only fill the editable input and do not start an action or a connection warmup.

**News.** The reader displays RSS headline information directly rather than waiting for an automatically generated summary. The eight renderer cases cover duplicate filtering, source/date labels, safe external links, read/unread state, atomic storage failures, retained headlines after a failed refresh, preference failure recovery and narrow layout. They also verify the exact headlines, publishers, dates, excerpts and URLs supplied to an explicit AI question, a successful text-only answer, provider failure and explicit retry. Unrelated Home conversation and saved memories are excluded from that News payload. Gemini is used only after an explicit News AI question. Saved topics and bounded read markers remain local; the exact retention and feed reuse behavior are described in [Privacy](../PRIVACY.md). Tests use controlled feeds and provider responses, not live-news accuracy or model-answer evaluations.

**Update readiness and data compatibility.** The supervisor requires an acknowledgment bound to the update attempt and expected installed version after the renderer initializes with visible usable controls. A surviving process alone cannot establish success. Native fixtures exercise the supervisor, while the separate NSIS row above tracks real installation. The packaged profile test preserved a timer deadline, two tasks, aliases, a playlist name, one explicit memory, a routine and its interrupted-run state, activity/diagnostics, shortcuts and encrypted preferences. Only the new local defaults—natural response style and an empty preferred address—were added. Retired Terminal history stayed inert and was not read by the upgraded renderer during observed startup. Both fixture applications exited normally with zero renderer network requests. This is packaged data compatibility, not an installed-user-profile or NSIS upgrade test.

The profile harness previously assumed that every old build still enabled Terminal, which was true of its original 1.4.1 baseline but not the 1.5.2 settings preview. It now checks the old binary's actual supported feature set, preserves the encrypted legacy preference exactly and permits only known new local defaults. No production behavior changed to make this compatibility test pass.

## Dependency review

`npm audit --omit=dev` reported no high or critical advisories and two moderate entries for one inherited UUID advisory: `vosk-browser` 0.0.8 pins `uuid` 9.0.0. The [upstream advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq) concerns v3/v5/v6 calls with caller-supplied output buffers. Inspection of the shipped Vosk bundle found its recognizer ID generated with `v4()` and no output buffer; Olanga does not import UUID directly. No affected call path was identified in this review, but the dependency audit is not clean and this is not a comprehensive security assessment. Updating a transitive package alone would not replace UUID code already embedded in the Vosk browser bundle.

## Boundaries and retained evidence

The synthetic offline corpus previously matched the expected command action lists for **7/7 recordings** with the command vocabulary, versus **3/7** with general recognition. The out-of-scope question produced no action list. This retained comparison is not a physical-microphone accuracy result or proof of new runtime performance.

The new validation uses disposable profiles, fixture provider responses and fake media where input is needed. It does not use personal API keys, the normal installed profile, a real microphone or live Spotify controls. **Live playback of “Play Spotify and raise the volume to 75%” remains unverified.** Earlier Open Spotify observations below are historical evidence, not acceptance of the Play Spotify path. Hardware, accents, app versions, language, display scaling and account state still affect real use.

Updates remain manual. A checksum confirms bytes, not publisher identity; no signing certificate has been supplied. No automatic rollback, remote CI success, published installer or universal resource reduction is implied by these local checks. Generated profiles, reports, logs, screenshots and packages remain in ignored build directories. Key reports include build/qa/workspace-recovery-smoke.json, build/qa/news-reader-smoke.json and build/qa/profile-upgrade-smoke.json.

---

# Settings and privacy — historical checkpoint e51f6ac, October 12, 2026

This section records the earlier settings checkpoint. Its counts, runtime and unpublished-build statements describe that checkpoint; the 1.6.0 section above records the later work.

The current source adds User preferences, Core settings and Privacy sections, five accent choices, stronger window contrast, adjustable orb glow, a static appearance preview, an appearance-only reset, reduced motion for the main window and corner light, bundled Outfit fonts and an offline privacy notice. The published 1.5.2 installer does not contain these changes yet.

| Check | Result |
| --- | --- |
| Unit suite | **748 passed**, zero failures or skips |
| Syntax and required assets | **73 JavaScript files passed** |
| Settings experience | **17 production-renderer checks passed**: keyboard tabs and labels, setup-only Privacy, management shortcut focus, actual offline font loading, five accents at 400px, contrast/glow with active orb states, appearance-only reset, save failure/retry, delayed writes, rapid Settings reselection, reload persistence, encrypted-backup recovery and real corner-light motion IPC |
| Packaged directory build | **101 source files matched**; **20 built-executable checks passed**, including the bundled notice, font and all four appearance preferences after a full reload |
| Existing UI regressions | Renderer races **12**, manual updates **11**, Work tools **12** and resource lifecycle **7** checks passed |
| Corner light | Focused overlay smoke passed: explicit/Windows reduced motion, all active status colors, local font, shortcuts, focus and geometry |

Validation used disposable profiles and fixture providers with external actions blocked. It did not use personal API keys, live microphone input, Spotify, or the normal installed profile. Screenshots of the new appearance controls were reviewed at normal and 400px window widths. The earlier settings preview also received native inspection and was closed. The final appearance tests measured 36 News/Notes text combinations across nine accent/contrast combinations; all exceeded 4.5:1, with a minimum of 6.34:1. Rapidly reselecting Settings before its 150 ms debounce now preserves unsaved location and toggle edits. The delayed-save regression also tests an older successful save followed by a newer failed save, ensuring Retry keeps the latest light and shortcut choices. Recognized speech and custom wake phrases are no longer written to the console, with runtime regression coverage.

The latest preview was rebuilt with the already installed matching Electron 36.9.5 distribution. An earlier fresh download returned HTTP 500. This was a directory build, not a new installer or GitHub release. Local screenshots, logs, profiles and build output remain ignored. Source check workflows now include Settings validation; no new remote CI run is claimed here.

---

# 1.5.2 release checks — October 12, 2026

This patch targets update completion and avoidable CPU/memory work. The recognition model, command vocabulary, theme and manual-update policy are unchanged. The built-in Terminal, its shell sessions and freeform command endpoints are removed.

| Check | Result |
| --- | --- |
| Combined unit suite | **744 passed**, zero failures or skips |
| Syntax, assets and version | **70 JavaScript files passed**, version **1.5.2** |
| Manual update UI and shared theme | **11 scenarios passed** |
| Work tools | **12 production renderer/preload checks passed** with isolated files and simulated providers |
| Renderer races, storage recovery and Terminal removal | **12 checks passed** |
| Native visibility and deadlines | **8 checks passed**, including live reduced-motion changes, hidden/minimized reload and exact pixel equality for the opaque window |
| Package contents | **94 packaged source files**, native helpers, offline model, version and embedded app/installer/uninstaller icons matched source |
| Packaged startup and profile compatibility | **16 checks in each of hidden, updated and recovery launch modes**, plus **44 compatibility checks**, passed using disposable profiles |
| Native updater | **6 real Windows process cases passed**, including visible progress and orphan-process rejection |
| Installed Windows upgrade | **1.5.1 → 1.5.2 passed** using the exact legacy launcher and real NSIS installer; installed payload matched and Olanga reopened visibly |
| Offline recognition | Bundled model matched expected actions for **7/7 synthetic command recordings**; cancellation/cleanup passed; no real microphone or desktop actions |

The final tray artwork has a separate halo-free orb that fills the native icon slot. Its 32-bit color pixels and AND transparency masks passed at all nine sizes, 16 through 256 px. Windows `LoadImageW`, `GetIconInfo` and `DrawIconEx` loaded the actual unpacked package asset and preserved every transparent pixel on white and dark backgrounds. The application, installer and uninstaller retained their verified orb artwork. The final tray build passed all 744 unit tests, package verification and all three packaged launch modes; it has local installer SHA-256 `8ac70598eb5aa724e2d005a558c8381b25f9105db6396f09d35dd5aa7ee81649`. This final installer was then installed over the local 1.5.2 candidate: NSIS exited successfully, the installed archive and tray asset matched the build, and the installed app reopened visibly. Native alpha checks passed again against the installed tray file.

GitHub's first check caught an 8.3-name mismatch in the native installer test's directory comparison (`RUNNER~1` versus the same expanded directory). The fixture now resolves both paths natively without weakening the containment check. All six cases passed locally with TEMP/TMP deliberately set to a real short-path alias; production updater code did not change for this correction. The next runner check exposed a separate test assumption: it required recurring animation even when Windows requested reduced motion. This was reproduced locally with one static frame, the expected product behavior. The smoke now uses Chromium media emulation to verify both preferences, requires fresh frames after restore, and records visibility/intersection diagnostics on failure. Forced reduced-motion startup passed seven checks; normal startup with the pixel comparison passed eight. No production animation behavior changed.
The profile upgrade also seeds a retired Terminal preference and saved command history. Only the obsolete runtime/local feature flag is filtered out. Other settings and saved records stay intact, and Terminal history is neither read by the new renderer during observed startup nor executed.

Native updater checks use compiled disposable Windows executables and the production PowerShell supervisor. They exercise process survival after the parent exits, a visibly displayed progress window, installation failure, unchanged-version rejection, tamper refusal, and rejection of an orphan background process as a successful restart. They do not use the installed user profile. Existing 1.5.1 builds still use their earlier launcher during the first upgrade; the new supervisor takes over subsequent updates.

The real installed upgrade was also exercised separately, before the final tray artwork adjustment. A disposable Electron driver loaded the exact launcher from the installed 1.5.1 archive and used its original `--updated /S --force-run` invocation. The real NSIS installer replaced the existing installation; both the Windows executable and packaged application reported 1.5.2, and the installed archive's SHA-256 matched the candidate. The restarted main process used the exact installed path with `--updated`, in the current Windows session, with a visible native window on two observations. Confirmation took about 92 seconds from driver startup. The installer was SHA-256 `1a2e39d06435f8acf0e1f414d3d97d4be38fe88b0083434f80e89f764f763f29`. This local build is unsigned; the release workflow builds and hashes its own artifact from the release commit.

The test did not click or download through the old Apps & updates UI, exercise the old application's shutdown cleanup, or test a future real NSIS upgrade initiated by the new supervisor. Those UI and supervisor paths have the separate checks above. The driver used disposable data; the installer reopened the normal app without the test driver reading or changing its profile. The leftover old app process was stopped before the test, after the user's quit confirmation. Evidence is retained in ignored `build/qa/installed-update-acceptance-EHmPWl/report.json`.
The paired resource run used actual **1.5.1 → 1.5.2** Windows packages on one machine with **8 logical processors**, baseline first and candidate second. Both runs used separate disposable profiles, GPU acceleration and the same synthetic silent microphone input. Each state records 20 process-counter snapshots at a requested one-second interval; CPU is recomputed from successive snapshots, leaving 19 measured intervals. The table reports mean CPU relative to **one logical core** (100% means one full core), summed over processes matching the selected executable. For example, 40.89% of one core is approximately 5.11% of this machine's total CPU capacity.

Resident private RAM excludes shared pages. It is the sum of a complete per-process `Win32_PerfRawData_PerfProc_Process.WorkingSetPrivate` snapshot taken after each state's CPU samples, not a median or peak. The counter query runs outside the measured CPU interval. Reductions below are calculated from unrounded measurements.

| State | CPU, one-core %: 1.5.1 → 1.5.2 | CPU reduction | Private resident MiB: 1.5.1 → 1.5.2 | RAM reduction |
| --- | ---: | ---: | ---: | ---: |
| Visible, idle without microphone | 40.89 → 18.70 | 54.3% | 243.9 → 226.2 | 7.3% |
| Tray, idle without microphone | 40.72 → 0.22 | 99.4% | 244.9 → 228.8 | 6.6% |
| Visible, voice ready | 107.93 → 98.28 | 8.9% | 527.4 → 519.6 | 1.5% |
| Tray, voice ready | 106.54 → 69.16 | 35.1% | 535.8 → 523.4 | 2.3% |
| Tray, sustained microphone mute | 52.60 → 6.75 | 87.2% | 511.4 → 304.2 | 40.5% |
| Visible, sustained microphone mute | 52.66 → 30.04 | 43.0% | 527.6 → 292.0 | 44.7% |

Private committed memory and total working-set medians are retained separately in the reports. They measure different things: commit is not resident RAM, and summing total working sets can count shared pages more than once. For example, visible-muted private commit fell from **665.5 to 416.8 MiB**, while its total working-set sum fell from **1,023.4 to 792.3 MiB**.

Releasing the unused recognition model after sustained mute saves memory but adds a reload: full wake readiness after unmute measured **19 ms → 2,659 ms** in this pair. The retained microphone graph resumes concurrently with model loading so capture can restart before wake recognition is ready; the idle hint reflects that readiness. This benchmark measures full readiness, not first-word capture latency. The bundled model, vocabulary and recognition thresholds are unchanged.

These results establish substantial idle and muted-state savings on this desktop, **not a universal 50% reduction in CPU or RAM**. Active recognition CPU fell by 8.9–35.1% and its private resident RAM by 1.5–2.3% in this run. It uses silence, not continuous speech, and does not measure every workload or device. Normal desktop activity, run order and measurement variability can affect results. Both runs passed, including voice resumption. Evidence is retained in ignored `build/qa/resources/baseline-151-resident.json` and `release-152-resident.json`; reproduction is described in [Releasing](RELEASING.md#compare-packaged-resource-use).

No live Spotify playback, system-volume changes, physical microphone recordings or provider requests were made for these checks. Earlier live-test limitations remain documented below. Build outputs, benchmark profiles, screenshots and raw logs stay in ignored directories.

# 1.5.0 release checks — September 30, 2026

The stable 1.5.0 source includes the Workspace, voice, media, work tools, optional integrations and manual-update changes described in the [release notes](releases/1.5.0.md). The following checks were rerun for the stable version and its local Windows installer. The tag workflow independently builds the published installer and its verification files from the release commit.

| Check | Result |
| --- | --- |
| Combined unit suite | **711 passed**, zero failures or skips |
| Syntax, assets and version | **71 JavaScript files passed**, version **1.5.0** |
| Workspace and Work tools | **12 checks passed** with production renderer/preload, selected-file operations and isolated data |
| Manual update UI and shared theme | **11 scenarios passed** |
| Renderer races and storage recovery | **11 checks passed** |
| Package contents | **91 source files**, native helpers, offline model, companion files and version matched the final source |
| Packaged startup | **13 checks passed** using a hidden disposable profile |
| Packaged profile compatibility | **35 checks passed** across actual 1.4.1 and 1.5.0 executables using one disposable profile |
| Windows installer | NSIS build passed; installer and application both verified **unsigned** |

Release testing found and corrected two test synchronization defects without changing product behavior or weakening its assertions. The Spotify startup fixture had replaced sleeps with no-ops while retaining a shortened wall-clock deadline; CPU load could exhaust it before the next fake session appeared. It now uses a deterministic clock with the production deadlines. The file Undo smoke had treated the first appearance of the original path as completion, although Undo was still verifying and removing a temporary hard link. It now waits for the verified completion receipt, checks the final single-link state, and waits for a fresh picker result before the next operation. The final complete unit and UI checks passed.

The first GitHub check also exposed noncanonical temporary paths in the file-workflow and project fixtures. The hosted runner can supply an aliased temporary directory, while the production services deliberately require resolved, unredirected paths. Both failures were reproduced locally with temporary-directory junctions. The fixtures now resolve their temporary roots before constructing file and settings paths; all 11 file-workflow and eight project tests pass with both ordinary and aliased temporary directories. Added coverage confirms that linked source and destination folders are still rejected. The production path and link checks remain unchanged.

The compatibility test preserved timer identities/deadlines, completed and pending tasks, aliases, explicit memories, routines, activity/timing records, secure preferences and shortcuts. It made no provider calls, captured no real microphone and used no installed user data. This verifies data compatibility between packaged applications; it is not an NSIS upgrade, UAC or rollback test. Beta 2 was installed and restarted locally in an earlier step; the stable 1.5.0 installer was built and checked separately.

The release remains explicit about unverified live paths. **Live playback of the corrected “Play Spotify and raise the volume to 75%” request has not been verified.** Its routing and native-function fixtures pass, but the earlier live observation used **Open Spotify**, and did not pass its sustained-volume assertion. Physical microphone behavior, real browser/VS Code extension hosts, phone setup, Gemini Live and external MCP/local model/speech servers require testing with the intended hardware and accounts. No publisher certificate was supplied. Updates remain manual, with no automatic installation or rollback.

Generated installers, profiles, recordings, screenshots and logs remain in ignored `dist/` and `build/` directories. The GitHub release contains the installer, `SHA256SUMS`, `RELEASE-METADATA.json` and release notes as downloadable assets; these binaries and diagnostic outputs are not committed to source history.

# 1.5.0-beta.2 corrections — September 30, 2026

This unsigned, unpublished local build removes Quick ask, makes Workspace the main top-bar button, and fixes the specific request **“Play Spotify and raise the volume to 75%.”** The installed beta 1 was not replaced during this correction.

The failure had two causes: Play only looked for an existing media session, and a failed playback step discarded the following volume adjustment. Spotify-scoped Play now opens the app when necessary and waits for its session. Its accessible Play fallback requires one visible, enabled control whose identity is checked again before invocation. A playing track is required for a success receipt. If playback remains unavailable, the explicitly requested independent volume action still runs, and the final reply includes both outcomes. Recognized local requests receive contextual acknowledgments; acknowledgments while transcription is pending vary without guessing the unheard request.

| Check | Result |
| --- | --- |
| Combined unit suite | **710 passed**, zero failures or skips |
| Syntax, assets and version | **71 JavaScript files passed**, version **1.5.0-beta.2** |
| Workspace and Work tools UI | **12 checks passed**, including removal of Quick ask and its shortcut, Workspace focus, and existing theme/font consistency |
| Media controller | **18 tests passed** within the combined suite, including 16 cold-start scenarios executed against production PowerShell functions with controlled session/UI fixtures |
| Native status fixtures | Both Spotify-only and current-player scopes covered for Playing, Paused and confirmed no-session states |
| Live-test cleanup fixtures | **7 tests passed** within the combined suite for unknown baselines, pre-existing playback, failed reads, delayed playback and verified restoration |
| Package contents | **91 source files**, native helpers, offline model, companion files and version matched the final source |
| Packaged startup | **13 checks passed** using a hidden disposable profile, with no provider, microphone or real media actions |
| Installer signing | Installer and application verified **unsigned**, as expected without a publisher certificate |

The routing regressions exercise successful and failed playback followed by volume, native exceptions, cancellation, complete paraphrases, omitted or changed volume proposals, and contextual acknowledgment speech. The first complete run exposed an overly restrictive new compound guard: a fully grounded paraphrase unnecessarily took another model call. That guard was corrected, retaining the existing action assertions and rejection of incomplete or unrelated proposals. The final complete suite passed.

`npm run smoke:spotify` is prepared for a separate opt-in live check through the production typed-command path. It requires actual Spotify playback and sustained native volume evidence. It rejects unknown initial playback state before dispatch, preserves pre-existing playback, checks a bounded period for delayed playback during cleanup, and records unverified restoration as failure. Natural song boundaries do not count as playback failure. Generated reports and installers remain under ignored `build/` and `dist/` directories.

**Live playback is not verified for beta 2.** Computer Use was stopped with the physical Escape key, so no further Spotify controls, real volume changes, live transcription or installation were performed. Fixture and packaged-startup results above do not establish that the corrected request succeeds against the user's current Spotify session. The earlier beta 1 live observation below exercised **Open Spotify**, not **Play Spotify**, and is retained as historical evidence.

# 1.5.0-beta.1 source preview — September 30, 2026

This is an unpublished, unsigned local prerelease. It retains the 1.4.1 theme and manual update policy and adds the work tools described in [the implementation record](NEXT-LEVEL.md).

| Check | Result |
| --- | --- |
| Combined unit suite | **688 passed**, zero failures or skips |
| Syntax, assets and version | **71 JavaScript files passed**, version **1.5.0-beta.1** |
| New Work tools UI | **12 checks passed** with the production renderer/preload and isolated profile |
| Existing Workspace UI | **16 checks passed** |
| Renderer races and storage recovery | **11 checks passed** |
| Manual update UI and theme | **11 scenarios passed** |
| Original startup/settings/persistence smoke | **Passed** |
| Native window sessions | **10 checks passed** against a disposable real Windows fixture, including normal and minimized geometry restore |
| Phone protocol | **12 real HTTPS fixture tests passed** within the unit suite; certificate verification enabled |
| Phone renderer dispatch | Busy/refusal, one-use claims, cancellation, exact command matching and persisted timer receipts covered by unit tests and the real UI smoke |
| Package contents | **91 source files**, native helpers, model and version verified; installable companion files are checked separately against source |
| Packaged startup | **13 checks passed**, including isolated persistence, inactive optional servers, setup guides and schedule persistence after reload |
| Profile compatibility | **13 seed checks and 22 transition checks passed** using the actual packaged 1.4.1 and 1.5.0-beta.1 executables with the same disposable profile |
| Release tooling | **18 tests passed**, including real unsigned Windows fixture signatures/checksums and PowerShell workflow branches for beta/stable publication |

The Work tools UI check performs real selected-file rename and checked Undo, local project indexing/search, local calendar import and reminder creation, and a phone-command handoff through actual IPC/preload to a local timer. Provider, MCP and app/window endpoints are simulated there. It also checks that opening optional pages starts no external service, approvals require separate clicks, changed filenames invalidate previews, closing/reopening rejects late previews, and shared styles fit at 100% and 150% zoom. Screenshots were inspected; remote fonts were blocked, so the shared fallback font was used.

The unit suite covers stale identities, cancellation, filesystem collisions and links, partial file recovery, waveform endpointing and capture gaps, interrupted playback, local/Live protocol races, recurring schedule DST and resume behavior, MCP approval expiry, companion pairing/authorization, stale editor versions, real task exit-code handling, and update cache tampering and publisher-policy checks. Two obsolete media-observer test stubs initially failed after stream-error handling was added; replacing the fake stderr object with a real stream restored the complete suite without weakening production checks.

The profile transition preserved the exact timer identity/deadline, completed and pending tasks, app and playlist aliases, explicit memory, routine, activity/timing records, secure preferences, custom wake groups and quick action. Completed routine steps stayed completed and the interrupted in-flight step stayed uncertain. The new executable and a subsequent reload made no provider calls, opened no microphone, played no audio, started no phone server and left updates unchecked. This checks profile compatibility between packaged executables; it does not execute an NSIS upgrade or touch the installed user profile.

A repeated packaged smoke exposed a reload race in the test: the outgoing page's globals could satisfy the readiness condition before the replacement page finished loading. The harness now requires a new document token and every expected module, checks uncaught renderer errors, and verifies schedules after a second reload. The packaged modules matched source; this was a test synchronization defect.

Final review also found and fixed two production issues. A delayed initial project-list read could replace newer in-memory metadata; all metadata operations now share one queue, with regression coverage for concurrent additions and retry after a failed read. Optional local speech could feed the normal wake recognizer; playback now blocks recognition and discards queued audio at both boundaries. Tests cover pending/rejected playback, old recognizer callbacks, partial worklet batches, stale flush acknowledgements and safe capture fallback when an acknowledgement never arrives. Two existing microphone test fixtures needed standard timer globals for the new cleanup path; their assertions were preserved, and the complete 688-test rerun passed. These are pipeline tests, not acoustic echo measurements.

## Live Spotify observation

Using the previously authorized generated recording of **“Open Spotify and raise the volume to 75%”**, Gemini transcription reached the production assistant and both native actions returned verified receipts: Spotify opened with a process ID, and Windows volume reached **75%, unmuted**. Acknowledgment was dispatched in **47 ms** and the Windows voice start event arrived in **566 ms**. The final reply started at **22.85 seconds** and ended at **27.94 seconds**, after both actions and acknowledgment. These are one-run event timings, not acoustic or general latency claims.

The overall live smoke **did not pass**: a separate Windows sampler observed mute turn on about 2.2 seconds after the successful volume receipt, with no second volume-changing command from the tested Olanga controller. The user was asked whether they muted it manually; the origin of that later change remains unconfirmed. The test restored the original **42.08%, muted** state and verified restoration. The run does establish native action receipts and actual speech start/end events; it does not establish uninterrupted audible playback or sustained unmuted volume. Repeated-mute checks after that failed assertion did not run in this attempt.

No physical microphone, acoustic loopback, wake-word accuracy, phone/browser trust setup, installed browser/VS Code extension-host session, live Gemini Live session, live MCP server, or real local model/speech server was exercised in this preview validation. Those paths have fixtures and explicit setup requirements. Signed artifacts cannot be tested without a publisher certificate. NSIS installation, UAC, antivirus and automatic rollback are not claimed as validated by launching the unpacked executable.

Generated recordings, screenshots, profiles, reports and installers stay in ignored `build/` and `dist/` directories. They are not source-control inputs.

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

These checks cover the latency work described in [the historical improvement notes](https://github.com/firestar3/Olanga-Desktop-Agent/blob/a3ab7eaceccb57e346b6d0b47b1fd8c65e9724c2/docs/IMPROVEMENTS.md#conversational-latency). No live Gemini key was used, so provider response times on real prompts are not measured here. The package version remains **1.4.0**.

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

These checks cover the first 2.0 wave described in [the historical improvement notes](https://github.com/firestar3/Olanga-Desktop-Agent/blob/a3ab7eaceccb57e346b6d0b47b1fd8c65e9724c2/docs/IMPROVEMENTS.md): local time/date/help answers, reminders and alarms, memories, the daily briefing, the health check, push-to-talk, voice interruption and the end-of-speech setting. They ran on one Windows machine after the final source change. The package version remains **1.4.0**; no installer was built.

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

The reliability improvements described in [the historical improvement notes](https://github.com/firestar3/Olanga-Desktop-Agent/blob/a3ab7eaceccb57e346b6d0b47b1fd8c65e9724c2/docs/IMPROVEMENTS.md) passed:

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
