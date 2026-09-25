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
