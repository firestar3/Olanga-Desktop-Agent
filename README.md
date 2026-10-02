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

Common commands run directly through local controls, with no API key required for typed requests. Choose cloud transcription or optional on-device English recognition. Gemini handles questions and requests that need interpretation. A small corner orb keeps Olanga within reach while you work in other apps.

**Olanga 1.5.0** brings more of your daily work into **Workspace**: save app layouts, review file changes, search a project, schedule reminders and connect optional browser, editor and phone companions. It also improves request progress, spoken acknowledgments and Spotify startup, while keeping the existing controls, colors and typography. [What's new in 1.5.0](docs/releases/1.5.0.md).

Local commands, reviewed routines, action results, saved names, memories, spoken briefings and manual in-app updates remain part of the core experience. Optional integrations start only when you choose to use them.

## See it in action

https://github.com/user-attachments/assets/67067be7-3325-4c5c-af52-1d5e71b19052

> **You:** Open Spotify and raise the volume to 75%.
>
> **Olanga:** I'll open Spotify and set the volume to 75 percent.
>
> **Olanga:** Spotify is open. System volume is 75%.

This example shows a supported two-action request: open Spotify and set the system volume. Olanga checks each action before confirming it. If an action fails or cannot be verified, the final reply explains what happened. [See the validation evidence.](docs/VALIDATION.md)

| Say this | What Olanga does |
| --- | --- |
| “Play Spotify and raise the volume to 75%.” | Opens Spotify when needed, tries to resume playback, sets the volume and reports both results. If Spotify cannot play, the explicit volume adjustment still runs. |
| “Play my liked songs on Spotify.” | Opens your personal Liked Songs collection and checks playback before confirming. |
| “Play my playlist Road Trip.” | Looks for the named playlist in your Spotify library. |
| “Play Yellow by Coldplay on Spotify.” | Searches for the requested track and checks the playback result. |
| “Pause it.” / “Resume.” / “What's playing?” | Controls playback or checks the current track; recent Spotify context carries into follow-ups. |
| “Set the volume to seventy-five percent.” | Sets the Windows system volume to 75% and verifies the result. |
| “Turn the volume down, then play my liked songs.” | Runs the supported steps in order, stopping and explaining if one fails. |
| “Set a timer for one hour and thirty minutes called Focus.” | Saves its deadline locally and restores it after reopening Olanga. |
| “Show my timers.” / “Cancel the Focus timer.” | Checks running timers or cancels a named timer locally. |
| “Remind me to call Mom in 20 minutes.” | Saves a local reminder; it speaks when due if Olanga is idle and unmuted, otherwise it rings. |
| “Set an alarm for 7 AM tomorrow.” / “Stop.” | Sets a clock-time alarm. “Stop” dismisses whatever is ringing; otherwise it still pauses music. |
| “Remember that I prefer concise answers.” | Saves a memory you can review or delete in Workspace. It's included in Gemini context only while enabled. |
| “What do you remember about me?” / “Forget that I prefer concise answers.” | Lists saved memories or removes a matching fact. |
| “Brief me.” | Speaks the date/time, open tasks and upcoming timers, reminders and alarms, with headlines and weather when available. |
| “What time is it?” / “What can you do?” | Answers locally, with no model call. |
| “Open Chrome.” | Uses a known Windows launch target and checks for the expected app window. |
| “Close Notepad.” | Requests a graceful close of the matching app and reports any remaining window or save prompt. |
| “Move Chrome to the left.” / “Maximize Notepad.” | Arranges a single verified app window and checks the resulting position. |
| “Add buy milk to my tasks.” | Adds an item to your checklist. |
| “Complete task buy milk.” / “Show my tasks.” | Updates or reads your checklist; ambiguous names prompt a follow-up. |
| “Mute system audio.” / “Unmute system audio.” | Sets and verifies the requested state; repeating the command keeps that state. |
| “Explain the error on my screen.” | Requests a screen capture, then uses Gemini to help diagnose it. |
| “Fix the bug on my screen.” | Proposes an edit in a supported editor for your review, then checks the visible result after approval. |

Ask questions, request current information through Google Search, or use the optional **Notepad**, **News** and **Terminal** panels for notes, briefings and your own PowerShell sessions.

## Built for quick responses

Common app, music, volume, timer, reminder, memory and checklist commands use a local intent matcher. Supported typed requests on this path need **zero model calls**. The cloud transcription path can execute a recognized local command after **one transcription call**; reviewed on-device commands need no transcription provider. Commands receive a short local acknowledgment while work starts, followed by the actual action results. Known local requests get a brief description of the intended action; voice acknowledgments vary while transcription is still pending.

**Streamed replies**, on by default in **Settings → Voice Settings**, speak conversational answers sentence by sentence while the rest is being generated. Eligible spoken questions can receive their transcript and answer in one Gemini call. Requests for actions or current information return to the appropriate command or Google Search path; they can require additional calls. Screen tasks and pending clarifications retain their existing review and conversation flow.

Olanga also tracks a rough transcript locally while you speak. When it recognizes a complete supported command, it can shorten the end-of-speech pause. That rough transcript does not authorize execution: cloud recognition or the editable offline review still determines the submitted request.

Response time varies with hardware, network, voice engine and app startup. The [validation report](docs/VALIDATION.md) records individual native command tests and their limitations. **Workspace → Diagnostics → first audio** comes from the voice engine's playback-start event. It does not measure sound at a microphone or speaker. Benchmarks retain failed attempts and report their failure rate separately from successful-response timings.

Each request tracks actions and speech separately. A completed action stays completed if speech fails. Pending-step corrections such as “actually, make it 30 percent” change the remaining volume target; correcting an already completed volume change creates a new volume action without reopening the app.

## Get started

1. Download [**Olanga-Setup-1.5.0.exe**](https://github.com/firestar3/Olanga-Desktop-Agent/releases/download/v1.5.0/Olanga-Setup-1.5.0.exe) from the [1.5.0 release](https://github.com/firestar3/Olanga-Desktop-Agent/releases/tag/v1.5.0) and run it. It adds desktop and Start-menu shortcuts.
2. Choose **Use local commands without a key**, or add your own [Google Gemini API key](https://aistudio.google.com/apikey) for cloud transcription, conversation, screen understanding, planning, and Notes/News AI.
3. Use the built-in **Windows voice**, or choose **NVIDIA Magpie** in Settings and add a separate [NVIDIA hosted API key](https://build.nvidia.com/settings/api-keys). Use **Save & Test** to verify Magpie synthesis.
4. Type a request, or enable voice input and say **“Hey Olanga”**, wait for the listening orb, and give your request. **Settings → Speech recognition** offers cloud and on-device modes; on-device modes ask you to review the transcript before sending it. You can also enable a push-to-talk shortcut in Settings.

**Requirements:** Windows 10/11 x64; a microphone for voice input; internet and available Gemini quota for cloud features. Spotify commands require the Spotify desktop app, signed in. Its collection controls currently depend on English accessible labels. The 1.5.0 installer is **unsigned**; its checksum and signing status are included with the release.

NVIDIA is optional and used only for Magpie speech; it requires its own key. Volume commands change the Windows output volume, and a nonzero target also unmutes it.

The Spotify startup and playback corrections have automated fixture coverage. The corrected “Play Spotify” request still needs a live playback check; see the [validation record](docs/VALIDATION.md) for this and other device-dependent limits.

## Your workspace

Open **Workspace** from the top bar:

- **Activity** shows each action's actual result, including failures, cancellation and unverified outcomes. History is session-only by default. Optional saved history keeps operation types and statuses, without prompts or result text.
- **Routines** save up to 12 supported local actions, such as opening and arranging apps, setting volume and starting a focus timer. Review the individual steps and choose **Run selected steps** each time. Runs stop on failure. After interruption, completed steps cannot repeat; uncertain steps require your explicit selection after checking what happened.
- **Saved names** lets you create, edit and delete aliases for supported apps and private Spotify playlists. Enable **Use my saved names** to apply them. Olanga does not infer or save preferences from conversations.
- **Apps & updates** checks which supported apps Windows can find and which operations are available. Known apps use verified launch targets; other names can use Windows Search with an explicitly unverified result. Arrangement requires exactly one matching window. Check for an Olanga update, download it here, and choose **Install & restart** when you're ready.
- **Diagnostics** optionally saves timing and outcome measurements locally, with clear and export controls. Disabling it deletes those measurements. Gemini request and token counts are available separately for the current session.
- **Memories** lists facts you explicitly save, with add and delete controls. **Use my memories in answers** is on by default; switch it off to stop including those facts with Gemini requests without deleting them. Olanga does not infer memories from ordinary conversation.
- **Health** reports microphone, wake-word, speech recognition, voice, Gemini, storage, internet and shortcut status, with suggested fixes. Checking status does not call a model. The separate **Test Gemini connection** button sends a short Gemini request.

Routines and their recovery records are saved on this device, including the commands you chose. They never run automatically on startup. Timers, reminders, alarms and checklist entries also persist. Overdue timers and reminders ring when Olanga reopens; they cannot alert while the app is closed or Windows is asleep. Relative reminders support up to 24 hours; clock-time reminders and alarms support today or tomorrow. They are not recurring schedules.

## Work tools

Open **Workspace → Apps & updates → Work tools**. These tools use the existing theme and start only when you choose an operation.

| Tool | What you can do |
| --- | --- |
| **Working sessions** | Save selected supported app windows and their layout. Preview a restore, reuse a verified window or open a missing app, and check each result. Ambiguous window matches require a fresh selection. |
| **Files** | Choose up to 50 local files, preview renames or moves on the same volume, and apply them without overwriting another file. Checked undo refuses a file that changed after the move. |
| **Projects** | Index a folder you select, search its text locally, and inspect source paths and line references. A separate button sends only the displayed excerpts and question to Gemini for a cited answer. |
| **Selected content** | Ask about text you paste or explicitly share from a companion. Review the text before sending it to Gemini. Generated answers do not edit the source. |
| **Schedules** | Save once, daily or weekly reminders and briefings. Notifications work while Olanga is open or in the tray. Missed occurrences are grouped once; online briefing additions require their own opt-in. |
| **Calendar** | Import an `.ics` snapshot of upcoming one-off events, add a preparation reminder, or explicitly ask Gemini for a checklist. Recurrence rules and live account synchronization are not supported. |
| **Browser & editor** | Pair the optional companions to share selected text, save chosen tabs or documents, restore them after review, and review version-checked edits or existing VS Code tasks. [Companion setup](extensions/README.md). |
| **Conversation** | Ask a model running on a loopback server, use a separately configured local speech server, or explicitly start Gemini Live conversation. These optional answer paths do not execute desktop tools. |
| **MCP tools** | Connect a trusted HTTPS MCP endpoint, inspect its tool schema, and approve the exact arguments for each call. Credentials stay in memory. OAuth and local command servers are not supported. |
| **Phone remote** | Start a temporary HTTPS session, pair a phone, and send a single app, volume or timer command. Setup requires a local TLS certificate and phone trust; access can be revoked immediately. [Phone setup](docs/PHONE_REMOTE.md). |

**Workspace** is the main button in the top bar. The request card shows progress, completed steps and cancellation.

Project indexes stay in memory and require an explicit refresh after restart. Indexing is bounded to 400 text files and 8 MB; hidden files, common credential filenames and generated folders are excluded. Review the excerpts before sharing: filename filters cannot identify every secret. Window sessions save app layouts; browser tabs and editor documents use their separate companion sessions.

Local conversation requires an OpenAI-compatible chat endpoint on this computer; local speech requires a compatible WAV speech endpoint. Gemini Live is an optional preview with a ten-minute session limit and needs a supported model, API access, and an already enabled microphone. Opening Work tools never starts microphone capture or an external connection. Physical microphone, mobile-browser and live companion compatibility still need validation on the devices you intend to use.

## Optional on-device speech

**On-device commands (English, review first)** uses the bundled Vosk model with a vocabulary for common app, music, volume and timer commands. **On-device dictation** is an experimental general vocabulary option. Both modes display an editable transcript and wait for **Send request**; nothing runs before review, and errors do not silently switch to cloud transcription.

In a small offline comparison, the command vocabulary produced transcripts matching the expected action lists for **7 of 7 synthetic command recordings**, versus **3 of 7** with general dictation. Neither mode produced an action list for one out-of-scope question, which command mode transcribed incorrectly. No desktop actions ran in that comparison. This is a generated-audio benchmark, not a physical-microphone accuracy claim. Unsupported requests can still need Gemini after you submit the reviewed text. See [validation](docs/VALIDATION.md) for the recordings, timing and limits.

## Made for everyday use

- **Quick access.** The corner orb opens five customizable shortcuts, responds to number keys 1–5, and can be hidden for five seconds or an hour. Enable **Settings → Corner Status Light → All Lights** to keep it available while idle.
- **Visible status.** Purple means idle, green means listening, orange means thinking or working, and blue means speaking.
- **Natural follow-ups.** Olanga remembers recent exchanges and listens for 12 seconds after asking a question. Answer by voice or type later; conversation context expires after 30 minutes of inactivity.
- **Personal settings.** Choose a voice and speaking rate, add a custom wake phrase, and optionally launch Olanga with Windows.
- **Cancellation.** Press **Escape** in Olanga to cancel the current request and remaining actions. During approved desktop input, Escape also acts as a global stop shortcut. Closing the window keeps Olanga in the system tray; choose **Quit** there to exit.
- **Interrupt by voice.** Say “Hey Olanga” while Olanga is talking to stop the reply and start a new request. Turn this off in **Settings → Voice Settings**.
- **Push-to-talk.** Choose **Ctrl + Alt + Space**, **Ctrl + Shift + Space** or **Alt + Space** in Settings (off by default). With voice input enabled, press once to listen and again to send; holding the keys is not required. It can interrupt a reply. Settings reports shortcut conflicts, and desktop edit execution keeps priority.
- **Quicker turn-taking.** **Settings → Voice Settings → End of speech** offers a 1.5-second default pause, or 1-second and 0.7-second options. A recognized complete local command can finish sooner. Shorter pauses may cut off a thought if you pause mid-sentence.
- **Reminder alerts.** Due reminders and alarms speak if Olanga is idle and its voice is unmuted; busy or restored reminders ring instead. Windows notifications appear when Olanga isn't in front, subject to Windows notification settings. Alarm beeps pause while you're talking to Olanga.
- **Voice fallback.** If Magpie synthesis or playback fails, Olanga can continue through the Windows voice. Short Magpie replies are cached per voice for reuse.

After starting without a key, you can add a Gemini key in Settings. It becomes active only after a successful secure save. Saved Terminal tabs reopen as history; a PowerShell session starts when you submit a command, and results stay attached to the tab that issued it.

## Screen assistance, with you in control

Share your screen to get help understanding an error or preparing an edit in a supported app. You review the target and proposed actions before Olanga makes changes:

1. **Share the screen.** Approve a primary-display capture for diagnosis and planning.
2. **Define the scope.** Review the identified editor or mark the intended region on the screenshot.
3. **Review the plan.** Say “yes” or choose **Review & run** to see the proposed actions.
4. **Approve the input.** Two native confirmations are required before edits run.
5. **Check the result.** Olanga captures the result and reports what the visible evidence supports, including anything still unverified.

Open **Desktop task** below the command box to start a workflow directly. Supported actions include focusing an observed window, clicking, typing, bounded keyboard shortcuts, scrolling and short waits.

Verification checks the visible result. It does not compile code or run tests, and Olanga does not execute model-generated shell commands. You control the optional Terminal panel yourself.

For supported full-field text replacements, the result includes **Before**, **After** and **Undo text edit**. The local checkpoint lasts five minutes. Undo checks the original window, process, editor identity and current text, then verifies restoration. It refuses changed text or a changed editor instead of overwriting intervening work. Other edits may have no undo; this is not general document versioning or automatic rollback.

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
| **Local Vosk** | Offline wake-word detection and optional reviewed English transcription. Idle microphone audio is not streamed to a provider. |
| **Google Gemini** | Submitted speech and model-routed text, conversation, explicitly shared screen images, action planning, and Notes/News AI. |
| **NVIDIA Magpie — optional** | Response text for cloud speech synthesis when selected. |
| **Google News (RSS)** | Headlines for the News panel and spoken briefings, using your saved location. |
| **Windows voice and native controls** | Local acknowledgment/speech, supported app and media actions, approved desktop input and timer notifications. |
| **Optional local model/speech server** | Explicit questions or answer text sent only to a configured loopback endpoint on this computer. |
| **Optional Gemini Live** | Microphone audio sent during an explicitly started Live session; stopping, muting or losing the microphone ends the session. |
| **Optional companions and MCP** | Only content or calls you explicitly share or approve. Companion pairing is local; an MCP call goes to the server you configure. |

API keys are encrypted locally with Windows-backed credential protection. Gemini requests retrieve saved credentials in the main process, with bounded requests, cancellation and redacted error reporting. Conversation context, desktop captures, plans and temporary undo checkpoints stay in memory. The separate Windows Snipping Tool used for selected-area diagnosis may retain captures according to its own settings.

Saved names, routines, timers, reminders, alarms, memories and checklist entries stay in the local profile. Memories you ask Olanga to keep are included as labeled context in Gemini requests only while **Use my memories in answers** is on; they never authorize actions. Daily briefings read your local tasks and timers, fetch optional RSS headlines, and request weather through Google Search when a Gemini key and location are available. Missing online sources are omitted. Activity retention and performance collection are opt-in; diagnostic exports contain timing and outcome fields, not transcripts, keys or screenshots. Local preferences do not grant additional permission to act.

Gemini **3.5 Flash-Lite** handles transcription, routing and responses; **3.5 Flash** handles reasoning, with Flash-Lite as an availability fallback. Google Search is a separate path used for current-information requests.

<details>
<summary>Connection troubleshooting</summary>

- **Google 429:** quota or rate limit; check your Google AI Studio usage and billing.
- **Google 503:** temporary provider unavailability; retry later.
- **Magpie authentication failure:** check the separate NVIDIA key with **Save & Test**, or select the Windows voice. This does not disable Gemini features.
- **An older version is still running:** closing the main window leaves the tray process active. Quit it, install the new version, then reopen Olanga from your shortcut.

</details>

## Updates

Use **Workspace → Apps & updates → Check for updates** to compare your version with the latest stable GitHub release. Choose **Download update** to download it inside Olanga, with progress and cancellation. Once the download is verified, **Install & restart** updates the existing installation and reopens Olanga, preserving your settings and saved data. Checks, downloads and installation happen only when you choose them; nothing installs on ordinary quit.

Olanga verifies the downloaded installer's SHA-256 against the release checksum and checks the file again before installation. An explicit update check can recover a complete cached installer after a restart, using fresh release metadata and a new hash check. Interrupted partial downloads restart when you choose Download again.

The 1.5.0 installer is **unsigned**. A checksum confirms file bytes, not publisher identity. Signing support is prepared for a future publisher certificate. Automatic updates and automatic rollback remain disabled.

Versions through 1.4.0 have a release-page link only. Install 1.5.0 from [Releases](https://github.com/firestar3/Olanga-Desktop-Agent/releases/tag/v1.5.0) to get the in-app update flow for future versions.

## Run from source

Use Windows and Node.js 22 for the same environment as the release workflow:

```powershell
git clone https://github.com/firestar3/Olanga-Desktop-Agent.git
cd Olanga-Desktop-Agent
npm ci
npm start
```

See [validation](docs/VALIDATION.md) for reproducible checks and measured coverage, [architecture](docs/ARCHITECTURE.md) for the native and provider boundaries, and the [maintainer release guide](docs/RELEASING.md) for packaging and publication.

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

[Release notes](docs/releases/1.5.0.md) · [Architecture](docs/ARCHITECTURE.md) · [Validation](docs/VALIDATION.md) · [MIT license](LICENSE)
