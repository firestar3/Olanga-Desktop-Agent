<p align="center">
  <img src="icon.png" alt="Olanga" width="112" height="112">
</p>

<h1 align="center">Olanga</h1>

<p align="center"><strong>Voice control for your Windows desktop.</strong></p>

<p align="center">
  Open apps, control Spotify, adjust the volume and get help with your screen.<br>
  Speak naturally. Olanga gets to work and tells you what happened.
</p>

<p align="center">
  <a href="https://github.com/firestar3/Olanga-Desktop-Agent/releases/latest">Download for Windows</a>
  · <a href="#see-it-in-action">Watch the demo</a>
  · <a href="#built-for-quick-responses">Performance</a>
  · <a href="docs/ARCHITECTURE.md">How it works</a>
</p>

<p align="center">Windows 10/11 x64 · Offline wake word · Gemini intelligence · Windows or Magpie voice</p>

---

Olanga is an open-source Windows assistant for the things you do throughout the day: opening an app, finding a playlist, setting a timer, or understanding an error on your screen. Use your voice or type a request. Combine supported actions in one sentence, keep a conversation going, and review proposed screen edits before they run.

Common commands run directly through local controls. Gemini handles transcription, questions and requests that need interpretation. A small corner orb keeps Olanga within reach while you work in other apps.

## See it in action

https://github.com/user-attachments/assets/d76c1174-1269-4949-855f-a5e954b14844

> **You:** Open Spotify and raise the volume to 75%.
>
> **Olanga:** On it.
>
> **Olanga:** Spotify is open. System volume is 75%.

One request, two actions: Olanga opens Spotify, sets the system volume and verifies both results before confirming. In the live spoken-command test, acknowledgment began in **0.30 seconds** and final confirmation began in **1.79 seconds**. [See how this was measured.](#built-for-quick-responses)

| Say this | What Olanga does |
| --- | --- |
| “Play my liked songs on Spotify.” | Opens your personal Liked Songs collection and checks playback before confirming. |
| “Play my playlist Road Trip.” | Looks for the named playlist in your Spotify library. |
| “Pause it.” / “Resume.” / “What's playing?” | Controls playback or checks the current track; recent Spotify context carries into follow-ups. |
| “Set the volume to seventy-five percent.” | Sets the Windows system volume to 75% and verifies the result. |
| “Turn the volume down, then play my liked songs.” | Runs the supported steps in order, stopping and explaining if one fails. |
| “Set a timer for five minutes.” | Starts a timer through the local command path. |
| “Open Chrome.” | Launches it through Windows Search; reports when the window has not been verified. |
| “Add buy milk to my tasks.” | Adds an item to your checklist. |
| “Explain the error on my screen.” | Requests a screen capture, then uses Gemini to help diagnose it. |
| “Fix the bug on my screen.” | Proposes an edit in a supported editor for your review, then checks the visible result after approval. |

Ask questions, request current information through Google Search, or use the optional **Notepad**, **News** and **Terminal** panels for notes, briefings and your own PowerShell sessions.

## Built for quick responses

Common app, music, volume and timer commands use a local intent matcher, avoiding extra planning and response calls. Typed commands on this path need **zero model calls**; spoken commands need **one transcription call**. Windows speech acknowledges the request while the work starts, and the final reply waits for the actions to finish.

Measured in Olanga **1.3.1** with “Open Spotify and raise the volume to 75%”:

| From request submission | Typed command | Generated spoken command |
| --- | ---: | ---: |
| Acknowledgment speech starts | **0.16 s** | **0.30 s** |
| Final confirmation speech starts | **1.53 s** | **1.79 s** |
| Gemini requests | 0 | 1 |

Both runs used the production app, real Spotify, Windows audio controls and Windows speech. They verified the Spotify window and **75% system volume**, and recorded both replies completing without interruption.

These are individual measurements from one Windows machine on September 24, 2026. The spoken test used a generated WAV and live Gemini transcription; timing starts at submission and excludes recording and end-of-speech detection. Results vary with hardware, network, voice engine and app startup. The [validation report](docs/VALIDATION.md) documents the method, complete timings and test coverage.

## Get started

1. Download **`Olanga-Setup-1.3.1.exe`** from [Releases](https://github.com/firestar3/Olanga-Desktop-Agent/releases) and run the installer. It adds desktop and Start-menu shortcuts.
2. Add your own [Google Gemini API key](https://aistudio.google.com/apikey) during setup. Gemini powers speech transcription, conversation, screen understanding, planning, and Notes/News AI.
3. Use the built-in **Windows voice**, or choose **NVIDIA Magpie** in Settings and add a separate [NVIDIA hosted API key](https://build.nvidia.com/settings/api-keys). Use **Save & Test** to verify Magpie synthesis.
4. Say **“Hey Olanga”**, wait for the listening orb, and give your request. You can also type in the command box.

**Requirements:** Windows 10/11 x64; a microphone for voice input; internet and available Gemini quota for cloud features. Spotify commands require the Spotify desktop app, signed in. Its collection controls currently depend on English accessible labels. The installer is unsigned.

NVIDIA is optional and used only for Magpie speech; it requires its own key. Volume commands change the Windows output volume, and a nonzero target also unmutes it.

## Made for everyday use

- **Quick access.** The corner orb opens five customizable shortcuts, responds to number keys 1–5, and can be hidden for five seconds or an hour. Enable **Settings → Corner Status Light → All Lights** to keep it available while idle.
- **Visible status.** Purple means idle, green means listening, orange means thinking or working, and blue means speaking.
- **Natural follow-ups.** Olanga remembers recent exchanges and listens for 12 seconds after asking a question. Answer by voice or type later; conversation context expires after 30 minutes of inactivity.
- **Personal settings.** Choose a voice and speaking rate, add a custom wake phrase, and optionally launch Olanga with Windows.
- **Immediate cancellation.** Press **Escape** to cancel the current request and remaining actions. Closing the window keeps Olanga in the system tray; choose **Quit** there to exit.
- **Voice fallback.** If Magpie synthesis or playback fails, Olanga can continue through the Windows voice. Short Magpie replies are cached per voice for reuse.

## Screen assistance, with you in control

Share your screen to get help understanding an error or preparing an edit in a supported app. You review the target and proposed actions before Olanga makes changes:

1. **Share the screen.** Approve a primary-display capture for diagnosis and planning.
2. **Define the scope.** Review the identified editor or mark the intended region on the screenshot.
3. **Review the plan.** Say “yes” or choose **Review & run** to see the proposed actions.
4. **Approve the input.** Two native confirmations are required before edits run.
5. **Check the result.** Olanga captures the result and reports what the visible evidence supports, including anything still unverified.

Open **Desktop task** below the command box to start a workflow directly. Supported actions include focusing an observed window, clicking, typing, bounded keyboard shortcuts, scrolling and short waits.

Verification checks the visible result. It does not compile code or run tests, and Olanga does not execute model-generated shell commands. You control the optional Terminal panel yourself.

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

Gemini **3.5 Flash-Lite** handles transcription, routing and responses; **3.5 Flash** handles reasoning, with Flash-Lite as an availability fallback. Google Search is a separate path used for current-information requests.

<details>
<summary>Connection troubleshooting</summary>

- **Google 429:** quota or rate limit; check your Google AI Studio usage and billing.
- **Google 503:** temporary provider unavailability; retry later.
- **Magpie authentication failure:** check the separate NVIDIA key with **Save & Test**, or select the Windows voice. This does not disable Gemini features.
- **An older version is still running:** closing the main window leaves the tray process active. Quit it, install the new version, then reopen Olanga from your shortcut.

</details>

## Run from source

Use Windows and Node.js 22 for the same environment as the release workflow:

```powershell
git clone https://github.com/firestar3/Olanga-Desktop-Agent.git
cd Olanga-Desktop-Agent
npm ci
npm start
```

Run the checks and build a complete installer:

```powershell
npm run check
npm test
npm run smoke
npm run dist
npm run verify:package
```

The installer is written to **`dist/Olanga-Setup-1.3.1.exe`**. It bundles the offline wake-word model and native helpers. Building alone does not update an existing installation; run the new installer to update, preserving saved settings and keys.

Version 1.3.1 passed **169 unit tests**, startup and package checks, and live Windows tests for the compound Spotify and volume command. See [validation](docs/VALIDATION.md) for the verified behavior and remaining coverage.

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

---

## Screenshots

<details>
<summary>Explore the app</summary>

<img width="1917" height="1078" alt="Olanga home screen" src="https://github.com/user-attachments/assets/c89b4dfb-f145-4375-a3a0-c6cab62474a3" />
<img width="1919" height="1079" alt="Olanga listening" src="https://github.com/user-attachments/assets/82cb99a9-a946-40ad-ac86-a40cbdc27f95" />
<img width="1919" height="1079" alt="Olanga answering" src="https://github.com/user-attachments/assets/ff343bde-0902-4da5-a110-a63a916ec40a" />
<img width="1919" height="1079" alt="Olanga settings" src="https://github.com/user-attachments/assets/38fcaddf-c2fa-490a-abb4-187dc72f0479" />
<img width="1917" height="1079" alt="Olanga notepad" src="https://github.com/user-attachments/assets/9fa513d5-59c7-4426-a06b-005bfa4b4687" />
<img width="1919" height="1079" alt="Olanga news" src="https://github.com/user-attachments/assets/4b65289f-603d-4c9f-ac44-f4be48ffa1bf" />

</details>

---

[Architecture](docs/ARCHITECTURE.md) · [Validation](docs/VALIDATION.md) · [MIT license](LICENSE)
