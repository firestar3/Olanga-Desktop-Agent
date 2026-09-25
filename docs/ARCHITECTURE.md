# How Olanga works

Olanga remains a complete Electron Windows app. The main process owns windows, tray, encrypted storage, native desktop input and Magpie TTS. A sandboxed renderer calls narrow preload APIs. Privileged IPC accepts only the local main frame. The existing GitHub tag workflow builds the same x64 NSIS installer, including the offline Vosk model and unpacked native helper.

## Gemini-only intelligence

- Speech starts with a local Windows acknowledgment concurrent with a bounded transcription-only Gemini request. Its transcript enters the same action routing as typed text; ordinary questions then use Gemini for their answer. Live-information requests use a separate Google Search call.
- Familiar explicit music, volume, timer and app commands: local intent matching → native/local execution → spoken result. Typed commands need no model; spoken commands use the existing Gemini transcription, without additional planning or response calls.
- Ambiguous actions: Gemini routing → Gemini bounded command proposal → validation → dispatch once. Native execution receipts are spoken directly; other requests retain the separate response writer. Pending clarifications and desktop workflows retain their existing routing.
- Screen diagnosis: permission to capture → Gemini perception → Gemini reasoning → separate Gemini response writer.
- Desktop edits: capture permission → observed window/editor scope → Gemini diagnosis and structured plan → immutable native preparation → spoken/typed yes opens review → two native confirmations → bounded Windows input → fresh result capture → Gemini evidence check → separate final response.

The router and response model is gemini-3.5-flash-lite. Reasoning uses gemini-3.5-flash, falling back to gemini-3.5-flash-lite on unavailable/missing-model responses, never to bypass authentication or quota errors. The shared Gemini adapter converts system instructions, conversation roles and bounded inline images, and requests JSON schemas for plans and verification. Requests have cancellation and timeouts; truncated output cannot dispatch actions. No production NVIDIA chat endpoint or NIM reasoning IPC remains. NVIDIA credentials are only for optional Magpie audio synthesis.

The response writer has no tools. Search results, screenshots, comments and window titles are data, not authority. Only the user goal and explicit clarifications authorize a proposal. A voice summary failure does not replay a completed action. Conversation is bounded to 24 messages / 24,000 characters and expires after 30 minutes of inactivity. Desktop answers preserve the pending question but need a fresh capture for a new plan.

## Desktop boundary and verification

Spotify uses a warm, fixed PowerShell helper with JSON stdin. Personal Liked Songs navigates directly to `spotify:collection:tracks`; library playlists stay in Spotify's library. Playback uses accessible Spotify controls and [Windows media-session state](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssession) to verify the result before announcing success. Public web search, clipboard replacement and blind keypress sequences are no longer part of music playback. Unknown, ambiguous or inaccessible controls produce an honest failure message. Spotify's English accessible labels are required for collection selection; media transport uses Windows session APIs.

Native requests are bounded, cancellation terminates the active helper, and stale results cannot speak or dispatch another action. Pausing and resuming are separate, state-aware operations. Short Magpie confirmations are cached in memory per voice/language; the Liked Songs confirmation can synthesize while Spotify starts, but plays only after a verified success.

Simple compound requests split at unquoted "and", "then", or "and then" only when every clause is supported; unsupported clauses cause the entire fast route to fall back. Spotify launch IPC awaits an observed window. Exact volume uses Windows Core Audio and a separate readback, with numeric targets bounded to 0–100 at both the renderer proposal and native IPC boundaries. Final speech waits for the acknowledgment and all dispatched actions; an action failure stops remaining steps and preserves completed outcomes. Generic Windows Search app launches await dispatch but explicitly report that their window is unverified.

The closed action vocabulary lives in shared/action-plan.js. Main-process plans use immutable copies, single-use IDs and a five-minute lifetime. A plan has at most 12 steps and 2,000 typed characters; execution lasts at most 30 seconds. Scope is one observed native window, optionally narrowed to a rectangle. A model cannot widen scope through its proposed steps. The fixed PowerShell helper accepts JSON data and invokes Win32/UI Automation; it never evaluates model-generated scripts.

The native runner verifies window/process identity, display geometry and focus, and registers Escape before input. Editor typing additionally requires a non-password editable accessible control entirely inside the approved region, with stable runtime identity. Approved newlines use Return key pairs because Chromium ignores Unicode carriage-return packets. Known terminals and privileged targets are blocked. This is conservative input containment, not an OS sandbox or a guarantee about every app’s interpretation of a shortcut.

The second edit confirmation includes permission for one post-edit primary-screen capture. The runner checks target/display identity before and after this image. If capture fails, input delivery remains distinct from verification. The Gemini verifier returns verified, incomplete or uncertain, backed by concrete visible observations. Remaining work prevents a verified status. A source-code correction cannot establish compilation or runtime correctness without visible test evidence. New edits or another target need a fresh proposal and confirmations.

Captures and plans stay in memory. The native runner retains metadata only. Regression fixtures can save synthetic images under ignored build/qa; no real user screenshot is included in automated provider checks.

## Corner light

The separate topmost window retains one native focusability style and uses native cursor hit testing for transparent margins. Five stored shortcut IDs cross its IPC boundary. The compact orb, app-themed menu, five-second/one-hour hides and reopening fix are preserved.

## Further engineering work

1. Add IntelliJ/VS Code document adapters with reviewed diffs, exact changed ranges, undo checkpoints and separately approved test execution. Screenshot verification cannot replace compiler/test evidence.
2. Maintain Electron/dependency upgrades with Windows integration coverage across scaling and accessibility providers.
3. Sign installers and introduce a signed update channel with rollback once release credentials are configured.
4. Move remaining Gemini credentials/requests behind a main-process provider service and split global renderer scripts into modules.
5. Add opt-in redacted diagnostics, provider usage visibility and separately approved multi-app recipes. Keep credentials, screenshots and typed text out of logs.

These are maintenance and product investments; the current build does not claim universal app compatibility or flawless autonomous execution.
