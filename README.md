# Olanga

Olanga is a hands-free desktop AI voice assistant for Windows. It lives full-screen when you need it, sits quietly in the system tray when you don’t, and listens locally for a wake word before anything leaves your machine.

Built with Electron. Wake detection runs offline with **Vosk**. Once you’re talking, **Google Gemini** handles intelligence and screen vision, and replies can speak through **Windows TTS** or **NVIDIA Magpie** voices.

## Core experience

Say a wake phrase → Olanga listens → Gemini thinks → Olanga speaks back.

- **Offline wake word** — Always-on local listening. Nothing is streamed until you wake it. Presets like *“Hey”* and *“Hey Olanga”* stay on; you can add custom wake words in Settings.
- **Conversation** — Speak or type. Olanga shows your transcript and its reply on the home orb screen, keeps a short in-session strand, and can ask a clarifying follow-up before returning to idle.
- **Fast intelligence** — Gemini answers questions, looks up current info (weather, news, sports, events), and uses your location when you’ve set it.
- **Screen vision** — Ask about something on screen and Olanga opens the Windows snipping tool so you can select a region for Gemini to analyze.
- **Natural speech** — Default Windows voices, or Magpie TTS with a NVIDIA key and a voice you pick in Settings.
- **Always listening in the background** — Close the window and Olanga keeps running in the tray. One instance only; opening it again brings the existing window forward.

Orb states match what Olanga is doing: idle → listening (green) → thinking (orange) → speaking (blue).

## Corner status light

A small click-through glow wraps the bottom-right of your screen so you can see Olanga’s state even when the main window is hidden.

In **Settings → Corner Status Light**:

- **Mode** — *No Lights* · *No Constant Light* (glow only when active; default) · *All Lights* (includes idle purple)
- **Size** — *Small* · *Normal* · *Large*

## Settings

Open the gear icon anytime (or finish first-launch setup).

| Setting | What it does |
| --- | --- |
| **Gemini API key(s)** | Required for chat, search, and vision. Multiple keys supported; encrypted at rest. |
| **Key rotation** | Optional auto-switch to another Gemini key on rate limits. |
| **NVIDIA API key** | Optional. Powers Magpie TTS and AI helpers in Notepad / News. |
| **TTS engine** | Windows (default) or Magpie. |
| **Speech rate & Magpie voice** | Speed slider and voice picker when Magpie is on. |
| **Location** | City / state / country for weather, local search, and news context. |
| **Wake words** | Presets stay locked on. Add custom phrases by typing them, then saying each one five times. |
| **Corner Status Light** | Mode and size (above). |
| **Features** | Toggle optional panels: Notepad, News, Terminal (off by default). |
| **View Intro** | Replay the first-run animation. |

Get a Gemini key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

## Tools on the home screen

Always available alongside the orb:

- **Timers** — Set, label, and cancel from the UI or by voice; alarms loop until cleared.
- **Tasks** — Add, complete, due dates, clear; persisted locally; voice-friendly.
- **Mic & TTS mutes** — Toolbar toggles (and voice control) so you can silence listening or speech without quitting.
- **Live clock** — Date and time in the top bar.

## Voice control of your PC

- **Spotify** — Play songs, artists, albums, or playlists (Spotify Desktop should be open).
- **Media** — Play/pause, next/previous, volume up/down, mute.
- **Open apps** — e.g. *“Open Discord”*, *“Launch Chrome”* via Windows Search.
- **Vision** — *“Look at my screen…”* then snip the area you care about.

## Optional panels

Keep the voice assistant front and center by default. Enable any of these under **Settings → Features**:

- **Notepad** — Multi-tab notes with basic formatting, import/export. With a NVIDIA key, an AI sidebar can rewrite or help edit.
- **News** — Short location-aware brief from feeds, topic chips, refresh/export, and optional AI Q&A (NVIDIA).
- **Terminal** — Multi-tab PowerShell sessions with a live working-directory prompt.

## Example prompts

- *“Hey Olanga — what’s the weather today?”*
- *“Look at my screen, why is this error happening?”*
- *“Play Shape of You on Spotify.”*
- *“Skip this track.”* / *“Turn the volume down.”*
- *“Open Discord.”*
- *“Set a timer for ten minutes.”*
- *“Add a task: finish the README by Friday.”*

## Installation

1. Install [Node.js](https://nodejs.org/).
2. Clone this repo, then:

```bash
npm install
npm start
```

## Building a Windows installer

Olanga packages into a normal Windows application with [electron-builder](https://www.electron.build/): a Start-menu entry, a desktop shortcut, its own icon, and no terminal window.

```bash
npm install --save-dev electron-builder
npm run dist
```

The build needs no extra setup: it reuses the repo's `icon.png` (converted to a Windows `.ico` automatically) and bundles the Vosk model alongside the app.

The installer lands in `dist/` as `Olanga-Setup-1.0.0.exe`. It installs per-user, so no administrator prompt is required. Use `npm run pack` for an unpacked build in `dist/win-unpacked/` when you want to test packaging without producing an installer.

### Publishing a release

Pushing a version tag builds the installer on GitHub and attaches it to the matching release, so users always have a download link:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The workflow lives in `.github/workflows/release.yml`. It runs the unit tests, verifies the icon and Vosk model are present, builds the installer, and publishes it. You can also trigger it manually from the Actions tab, which uploads the installer as a workflow artifact without creating a release.

For this to work, `electron-builder` must be in `devDependencies` — the workflow fails with an explicit message if it or any packaging input is missing.

A few notes:

- **The icon** comes from `icon.png` in the repo root, which must be at least 256×256. electron-builder converts it to a multi-resolution `.ico` for you.
- **The Vosk model** ships next to the app rather than inside the `app.asar` archive, because the model is fetched over a `file://` URL and Chromium cannot read inside an asar.
- **Your API keys carry over.** The packaged build uses the same `olanga-control` user-data directory as `npm start`, so the encrypted key store is shared.
- **Windows SmartScreen** will warn about an unknown publisher because the build is unsigned. Choose **More info → Run anyway** to install. Removing the warning requires a code-signing certificate.

## Running tests

```bash
npm test
```

## Launch at login

Under **Settings → Startup**, enable **Launch at login** to have Windows start Olanga automatically. It starts hidden in the tray with the wake word already armed. The toggle is only available in an installed build.

## Troubleshooting

<<<<<<< HEAD
- **App won't start after closing it?** Olanga is designed to stay alive in your system tray (bottom right corner of Windows). If you try to open a second instance while it's hidden, it will just bring the hidden window back into focus. To completely close Olanga, right-click the orb in your system tray and click "Quit".
- **Audio isn't playing / Vision isn't working?** Check the Developer Console (`Ctrl+Shift+I` while Olanga is focused) for specific rate-limit or API key errors.

## Application Photo

<img width="1917" height="1078" alt="image" src="https://github.com/user-attachments/assets/c89b4dfb-f145-4375-a3a0-c6cab62474a3" />
<img width="1919" height="1079" alt="image" src="https://github.com/user-attachments/assets/82cb99a9-a946-40ad-ac86-a40cbdc27f95" />
<img width="1919" height="1079" alt="image" src="https://github.com/user-attachments/assets/ff343bde-0902-4da5-a110-a63a916ec40a" />
<img width="1919" height="1079" alt="image" src="https://github.com/user-attachments/assets/38fcaddf-c2fa-490a-abb4-187dc72f0479" />
<img width="1917" height="1079" alt="image" src="https://github.com/user-attachments/assets/9fa513d5-59c7-4426-a06b-005bfa4b4687" />
<img width="1919" height="1079" alt="image" src="https://github.com/user-attachments/assets/4b65289f-603d-4c9f-ac44-f4be48ffa1bf" />


=======
- **Closed but still running?** Olanga hides to the system tray. Right-click the tray icon → **Quit** to exit fully. A second launch focuses the existing window.
- **No audio / vision / API errors?** With Olanga focused, open DevTools (`Ctrl+Shift+I`) and check for key or rate-limit messages.
>>>>>>> 5767019 (Update status light, settings, and README)

## Screenshots

<img width="1917" height="1078" alt="Olanga home" src="https://github.com/user-attachments/assets/4bb4668a-9b1d-4c2b-a4d2-88d077950e1c" />
<img width="2559" height="1439" alt="Olanga UI" src="https://github.com/user-attachments/assets/77a8d0f5-be6a-439a-bb75-b1fd3a91c798" />
<img width="2557" height="1439" alt="Olanga features" src="https://github.com/user-attachments/assets/c72cd236-f7a1-492a-8f40-a2231f415092" />
<img width="2557" height="1439" alt="Olanga settings" src="https://github.com/user-attachments/assets/f460ae8a-1288-41c0-b062-5c5adc4aeec3" />
<img width="2559" height="1439" alt="Olanga panels" src="https://github.com/user-attachments/assets/7959e695-0d5e-4da6-9d08-be18c72ff153" />
