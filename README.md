<p align="center">
  <img src="icon.png" alt="Olanga" width="112" height="112">
</p>

<h1 align="center">Olanga</h1>

<p align="center"><strong>Your desktop, one request away.</strong></p>

<p align="center">
  Open apps. Control Spotify. Set the volume. Ask questions.<br>
  Get help with your screen and review edits before they run.
</p>

<p align="center">
  <a href="https://github.com/firestar3/Olanga-Desktop-Agent/releases/latest">Download for Windows</a>
  · <a href="#see-it-in-action">Try commands</a>
  · <a href="#speed-you-can-measure">Measured speed</a>
  · <a href="docs/ARCHITECTURE.md">How it works</a>
</p>

<p align="center">Windows 10/11 x64 · Offline wake word · Gemini intelligence · Windows or Magpie voice</p>

---

Olanga brings voice commands, conversation, music control and screen assistance into one Windows app. Speak naturally or type a request. Olanga acknowledges it, runs supported actions, and tells you the result. A small corner orb keeps shortcuts within reach while you work in other apps.

## See it in action

> **You:** Open Spotify and raise the volume to 75%.
>
> **Olanga:** On it.
>
> **Olanga:** Spotify is open. System volume is 75%.

That sequence opens Spotify, checks for its window, sets the Windows output volume, and reads the volume back before reporting completion. The acknowledgment and final reply take separate turns, so a quick result does not cut off the opening response.

| Say this | What Olanga does |
| --- | --- |
| “Play my liked songs on Spotify.” | Opens your personal Liked Songs collection and checks playback before confirming. |
| “Play my playlist Road Trip.” | Looks for the named playlist in your Spotify library. |
| “Pause it.” / “Resume.” / “What's playing?” | Controls playback or checks the current track; recent Spotify context carries into follow-ups. |
| “Set the volume to seventy-five percent.” | Sets the Windows system volume to 75% and verifies the result. |
| “Turn the volume down, then play my liked songs.” | Runs the supported steps in order, stopping and explaining if one fails. |
| “Set a timer for five minutes.” | Starts a timer through the local command path. |
| “Open Chrome.” | Requests an app launch through Windows Search and states when the window has not been verified. |
| “Add buy milk to my tasks.” | Adds an item to your checklist. |
| “Explain the error on my screen.” | Requests a screen capture, then uses Gemini to help diagnose it. |
| “Fix the bug on my screen.” | Prepares a scoped edit for review and approval, then checks the visible result. |

You can also ask ordinary questions or request current information through Google Search. Optional **Notepad**, **News** and **Terminal** panels keep notes, briefings and your own PowerShell sessions in the same app.

## Speed you can measure

**Quick acknowledgment. Direct execution. A clear finish.**

Common, explicit app, music, volume and timer commands use a local intent matcher. Typed commands on this path need **zero model calls**; spoken commands need **one transcription call**. The local Windows voice can acknowledge the request while the work starts. Ambiguous requests use Gemini for interpretation and planning.

For the Spotify + 75% volume command above, the verified 1.3.1 runs measured:

| From request submission | Typed command | Generated spoken command |
| --- | ---: | ---: |
| Acknowledgment speech starts | **0.16 s** | **0.30 s** |
| Final confirmation speech starts | **1.53 s** | **1.79 s** |
| Final confirmation finishes | 6.60 s | 6.86 s |
| Gemini requests | 0 | 1 |

Both runs used the production Electron app, real Spotify and Windows audio controls, and Windows speech. Both observed Spotify's window, independently read back **75% volume**, and recorded completed speech events without interruption. The tests restored the original volume afterward.

These are individual measurements from one Windows machine on September 24, 2026, not a latency guarantee. The spoken test used a generated WAV and live Gemini transcription; timing starts at audio submission and excludes microphone recording and end-of-speech detection. Hardware, network conditions, provider load, voice engine and app startup can change results. See the [validation report](docs/VALIDATION.md) for methods and coverage, including **169 passing unit tests** for this release.

## Get started

1. Download **`Olanga-Setup-1.3.1.exe`** from [Releases](https://github.com/firestar3/Olanga-Desktop-Agent/releases) once 1.3.1 is published, and run the installer. It adds desktop and Start-menu shortcuts.
2. Add your own [Google Gemini API key](https://aistudio.google.com/apikey) during setup. Gemini powers speech transcription, conversation, screen understanding, planning, and Notes/News AI.
3. Use the built-in **Windows voice**, or choose **NVIDIA Magpie** in Settings and add a separate [NVIDIA hosted API key](https://build.nvidia.com/settings/api-keys). Use **Save & Test** to verify Magpie synthesis.
4. Say **“Hey Olanga”**, wait for the listening orb, and give your request. You can also type in the command box.

**Requirements:** Windows 10/11 x64; a microphone for voice input; internet and available Gemini quota for cloud features. Spotify commands require the Spotify desktop app, signed in. Its collection controls currently depend on English accessible labels. The installer is unsigned.

NVIDIA is optional and used only for Magpie speech. **A Google key and an NVIDIA key are separate credentials.** Exact volume commands change the Windows output volume; a nonzero target also unmutes it.

## Made for everyday use

- **A corner orb that stays within reach.** Click it for five customizable shortcuts, hide it for five seconds or an hour, or reopen Olanga. Use number keys 1–5 for shortcuts. Choose **Settings → Corner Status Light → All Lights** to keep it available while idle.
- **A clear state at a glance.** Purple is idle, green is listening, orange is thinking or working, and blue is speaking.
- **Conversation that carries forward.** Olanga remembers recent exchanges and listens for 12 seconds after asking a follow-up question. You can answer by voice or type later. Context stays in memory, with limits of 24 messages, 24,000 characters and 30 minutes of inactivity.
- **Your preferred voice and wake phrase.** Choose voice and speaking rate, add a custom wake word, and optionally launch Olanga with Windows.
- **An easy stop.** Press **Escape** to cancel the current request and remaining actions. Closing the window keeps Olanga in the system tray; choose **Quit** there to exit.
- **Speech that can recover.** Magpie caches short replies per voice. If synthesis or playback fails, Olanga can continue through the Windows voice; already-started audio may be repeated with an explanation.

## Screen assistance, with you in control

Olanga can help explain an error, inspect shared screen content, or prepare an edit in another app. Screen changes follow a reviewable sequence:

1. **Share the screen.** Approve a primary-display capture for diagnosis and planning.
2. **Define the scope.** Review the identified editor or mark the intended region on the screenshot.
3. **Review the plan.** Say “yes” or choose **Review & run** to see the proposed actions.
4. **Approve the input.** Two native confirmations are required before edits run.
5. **Check the result.** Olanga captures the result and reports what the visible evidence supports, including anything still unverified.

Open **Desktop task** below the command box to start a workflow directly. Supported actions include focusing an observed window, clicking, typing, bounded keyboard shortcuts, scrolling and short waits.

A visible code correction does not establish that compilation or tests passed. Olanga reports that distinction, and does not execute model-generated shell commands or code. The optional Terminal panel is controlled by the user.

<details>
<summary>Desktop scope and current limits</summary>

- Each plan permits at most **12 steps**, **2,000 typed characters**, **30 seconds of execution**, and **five minutes before expiry**.
- Editor-only input requires an accessible, non-password editable control fully inside the approved rectangle. The target app may need accessibility support enabled.
- Elevated windows, secure desktops, secondary-display targets and background terminal automation are unsupported.
- A different app or a further phase requires fresh observation and approval.
- Escape stops remaining input. Changes already delivered are not automatically rolled back.
- The corner light stays above ordinary windows; exclusive fullscreen apps and Windows secure desktops may cover it.

</details>

## Providers and privacy

| Component | What it handles |
| --- | --- |
| **Local Vosk** | Offline wake-word detection. Idle microphone audio is not streamed to a provider. |
| **Google Gemini** | Submitted speech and model-routed text, conversation, explicitly shared screen images, action planning, and Notes/News AI. |
| **NVIDIA Magpie — optional** | Response text for cloud speech synthesis when selected. |
| **Windows voice and native controls** | Local acknowledgment/speech, supported app and media actions, and approved desktop input. |

API keys are encrypted locally with Windows-backed credential protection. Conversation context, desktop captures and plans stay in memory. The separate Windows Snipping Tool used for selected-area diagnosis may retain captures according to its own settings.

Current model defaults are **Gemini 3.5 Flash-Lite** for transcription, routing and responses, and **Gemini 3.5 Flash** for reasoning, with Flash-Lite as an availability fallback. Current-information requests use a separate Google Search call, so search quota is not required for routine actions.

<details>
<summary>Connection troubleshooting</summary>

- **Google 429:** quota or rate limit; check your Google AI Studio usage and billing.
- **Google 503:** temporary provider unavailability; retry later.
- **Magpie authentication failure:** check the separate NVIDIA key with **Save & Test**, or select the Windows voice. This does not disable Gemini features.
- **An older version is still running:** closing the main window leaves the tray process active. Quit it, install the new version, then reopen Olanga from your shortcut.

</details>

## Build and verify

Use Windows and Node.js 22 for the same environment as the release workflow:

```powershell
git clone https://github.com/firestar3/Olanga-Desktop-Agent.git
cd Olanga-Desktop-Agent
npm ci
npm start
```

Run the regular checks and build a complete installer:

```powershell
npm run check
npm test
npm run smoke
npm run dist
npm run verify:package
```

The installer is written to **`dist/Olanga-Setup-1.3.1.exe`**. It bundles the offline wake-word model and native helpers. Building alone does not update an existing installation; run the new installer to update, preserving saved settings and keys.

<details>
<summary>Optional live Windows checks</summary>

```powershell
npm run smoke:overlay
npm run smoke:overlay:native
npm run smoke:desktop
npm run smoke:voice
npm run smoke:voice:audio
```

The native overlay and desktop checks operate disposable test windows. Close other Olanga instances and leave the keyboard and pointer alone during those tests.

The voice checks open Spotify, briefly set system volume to 75%, play acknowledgment and completion speech, then restore volume and mute state. The audio variant uses a generated WAV and your saved Gemini key for live transcription; run it only when you intend that provider request.

The regular unit and startup checks need no live credentials. Live checks write local reports under ignored `build/qa/`. Physical microphone quality and wake-word recognition are not covered by the generated-audio test. See [validation](docs/VALIDATION.md) for the exact coverage of this release.

</details>

## Publish a release

The [Release workflow](.github/workflows/release.yml) builds the Windows installer and attaches it to a GitHub Release when you push a **`v*` tag**. The tag must match `package.json`; the current version is **`1.3.1`**.

From your project directory, review and commit the source changes, then push the branch and tag:

```powershell
git add --all
git diff --cached --stat
git commit -m "Release v1.3.1: faster voice commands and verified actions"
git push -u origin HEAD
git tag -a v1.3.1 -m "Olanga v1.3.1"
git push origin v1.3.1
```

The ignore rules exclude promotional videos/audio/screenshots in `artifacts/`, local diagnostic outputs, the extracted `model/` working copy, `dist/`, `build/` and `node_modules/`. The required app icon and `vosk-model-v2.tar.gz` stay versioned so a fresh checkout can build the complete app. The installer is uploaded as a release asset by the workflow.

Watch [GitHub Actions](https://github.com/firestar3/Olanga-Desktop-Agent/actions/workflows/release.yml), then find the installer under [Releases](https://github.com/firestar3/Olanga-Desktop-Agent/releases). For a future release, update the version in both `package.json` and `package-lock.json` and use a new matching tag. Manual workflow runs produce an installer artifact without publishing a release. Full instructions are in [RELEASING.md](docs/RELEASING.md).

---

[Architecture](docs/ARCHITECTURE.md) · [Validation](docs/VALIDATION.md) · [Release guide](docs/RELEASING.md) · [MIT license](LICENSE)
