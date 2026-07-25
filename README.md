# Olanga

**A hands-free AI voice assistant for your Windows desktop.** Say a wake word, ask anything, and Olanga answers out loud — it can also look at your screen, control your music, open your apps, and keep your timers and tasks.

Olanga listens for its wake word **entirely offline**. Nothing is sent anywhere until you actually wake it.

<img width="1917" height="1078" alt="Olanga home screen" src="https://github.com/user-attachments/assets/c89b4dfb-f145-4375-a3a0-c6cab62474a3" />

---

## Download and install

1. Go to the [**latest release**](https://github.com/firestar3/Olanga-Desktop-Agent/releases/latest) and download the installer — `Olanga-Setup-1.1.0.exe` at the time of writing.
2. Run it. Windows will show a blue **"Windows protected your PC"** screen because the app isn't code-signed — click **More info → Run anyway**. (Olanga is unsigned because certificates cost hundreds of dollars a year; the source is right here if you'd rather build it yourself.)
3. Follow the installer. It installs for your user only, so there's no administrator prompt, and it adds Start-menu and desktop shortcuts.
4. Launch **Olanga**.

**Requirements:** Windows 10 or 11 (64-bit), a microphone, and a free Google Gemini API key (below).

---

## First run: get your API key

Olanga needs your own Gemini API key to think. Keys are free.

1. Visit [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and sign in with a Google account.
2. Click **Create API key** and copy it.
3. Paste it into Olanga's setup screen and save.

Your key is encrypted at rest on your own machine using Windows' credential protection — it never goes anywhere except to Google when you ask a question.

**Optional but recommended:**

- **Location** — Add your city and state in Settings so weather and local questions are accurate.
- **NVIDIA API key** — Add one for two things: the more natural-sounding Magpie voices, and the text generation behind the writing helpers in the Notepad and News panels. Get one at [build.nvidia.com](https://build.nvidia.com/). Without it, Olanga falls back to built-in Windows voices and those helpers stay off.

---

## Using Olanga

Just say **"Hey Olanga"** (or simply **"Hey"**), wait for the orb to turn green, then ask your question.

The orb and the corner glow tell you what's happening:

| Color | Meaning |
| --- | --- |
| Purple | Idle — waiting for the wake word |
| Green | Listening to you |
| Orange | Thinking |
| Blue | Speaking |

You can also **type** instead of talking, using the input box on the home screen. Press **Escape** at any time to stop Olanga and return it to idle.

Closing the window with the **X** doesn't quit — Olanga keeps listening from the system tray. Click the tray icon to bring it back, or right-click it and choose **Quit** to exit completely.

### Things to try

- *"Hey Olanga, what's the weather today?"*
- *"Look at my screen — why am I getting this error?"*
- *"Play Shape of You on Spotify."*
- *"Skip this track."* / *"Turn the volume down."*
- *"Open Discord."* / *"Close Discord."*
- *"Set a timer for ten minutes."*
- *"Add a task: finish the report by Friday."*

---

## What Olanga can do

**Answer questions and search the web.** Powered by Google Gemini, with live lookups for weather, news, sports, and current events.

**See your screen.** Ask about something visual and Olanga opens the Windows snipping tool — select an area and it analyzes that image alongside your question.

**Control your PC by voice.**

- **Spotify** — play songs, artists, albums, or playlists (keep the Spotify desktop app open)
- **Media keys** — play/pause, next, previous, volume, mute
- **Launch and close apps** — *"Open Chrome"*, *"Launch Word"*, *"Close Spotify"* (closing asks the app to shut down normally, so you still get any "save your work?" prompt)

**Keep track of things.** Timers with labels and looping alarms, plus a task list with due dates. Both work by voice or by clicking.

**Stay out of your way.** Mute the mic or Olanga's voice from the toolbar, and it runs quietly in the tray until you need it.

---

## Wake words

The built-in phrases — including *"Hey"* and *"Hey Olanga"* — are always active.

To add your own, go to **Settings → Wake Words → Add Custom Wake Word**, type the phrase you intend to say, then say it five times. Olanga saves your typed phrase plus each spoken variation (up to six total), so it recognizes how *you* actually pronounce it.

---

## Corner status light

A small glow curls around the bottom-right corner of your screen so you can tell Olanga's state even when the window is hidden. It's click-through, so it never blocks anything.

Under **Settings → Corner Status Light**:

- **Mode** — *No Lights*, *No Constant Light* (only glows while active — the default), or *All Lights* (also shows the idle purple)
- **Size** — *Small*, *Normal*, or *Large*

---

## Launch at login

Under **Settings → Startup**, turn on **Launch at login** and Windows will start Olanga automatically, hidden in the tray with the wake word already armed. This option is only available in the installed app.

---

## Optional panels

Olanga keeps the voice assistant front and center, so these extras are off by default. Turn any of them on under **Settings → Features**:

- **Notepad** — multi-tab notes with formatting and import/export. With an NVIDIA key, an AI sidebar can rewrite and edit for you.
- **News** — a short, location-aware briefing built from news feeds, with topic filters and optional AI Q&A.
- **Terminal** — multi-tab PowerShell sessions inside the app.

---

## All settings

| Setting | What it does |
| --- | --- |
| **Gemini API key(s)** | Required. Add more than one and Olanga can rotate between them if you hit a rate limit. |
| **NVIDIA API key** | Optional. Powers Magpie voices and the text generation in the Notepad and News helpers. |
| **TTS engine** | Windows voices (default) or NVIDIA Magpie. |
| **Speech rate** | How fast Olanga talks. |
| **Magpie voice** | Ten voices to choose from when Magpie is enabled. |
| **Location** | City, state, and country for weather, local search, and news. |
| **Wake words** | Presets stay on; add your own custom phrases. |
| **Startup** | Launch at login. |
| **Corner Status Light** | Glow mode and size. |
| **Features** | Show or hide the Notepad, News, and Terminal panels. |
| **View Intro** | Replay the first-run animation. |

---

## Troubleshooting

**Olanga doesn't respond to the wake word.** Check that Windows is using the microphone you expect and that the mic isn't muted in the toolbar. Speak the phrase as a single steady phrase rather than shouting it.

**It won't reopen after I closed it.** It's still running in the system tray, near the clock. Click the tray icon to show the window. To quit for real, right-click the tray icon and choose **Quit**.

**No voice, or errors when asking questions.** This is almost always the API key — check that it's saved in Settings and that you haven't exhausted the free tier. Press `Ctrl+Shift+I` with Olanga focused to open developer tools and look for rate-limit or key messages.

**Windows says the app is unsafe.** That's the unsigned-installer warning described above. Choose **More info → Run anyway**.

---

## Privacy

- Wake word detection runs **locally** with Vosk. Your microphone audio is not streamed anywhere while Olanga is idle.
- Only after you wake it does your request go to Google Gemini (and to NVIDIA if you've enabled Magpie voices).
- API keys are encrypted on your machine. Notes, tasks, and timers stay local.

---

## Build from source

For developers, or if you'd rather not run a prebuilt binary.

```bash
npm install
npm start
```

Run the unit tests with:

```bash
npm test
```

### Build the installer

```bash
npm install --save-dev electron-builder
npm run dist
```

The installer appears in `dist/` as `Olanga-Setup-<version>.exe`, matching the version in `package.json`. Use `npm run pack` for an unpacked build in `dist/win-unpacked/` when you want to check packaging without producing an installer.

The build needs no extra setup — it reuses the repo's `icon.png` (converted to a Windows `.ico` automatically) and bundles the Vosk model beside the app rather than inside the `app.asar` archive, since the model is fetched over a `file://` URL that can't reach inside an archive.

Both `npm start` and the installed build share the same `olanga-control` user-data directory, so your saved API keys work in either.

---

## Screenshots

<img width="1919" height="1079" alt="Olanga listening" src="https://github.com/user-attachments/assets/82cb99a9-a946-40ad-ac86-a40cbdc27f95" />
<img width="1919" height="1079" alt="Olanga answering" src="https://github.com/user-attachments/assets/ff343bde-0902-4da5-a110-a63a916ec40a" />
<img width="1919" height="1079" alt="Olanga settings" src="https://github.com/user-attachments/assets/38fcaddf-c2fa-490a-abb4-187dc72f0479" />
<img width="1917" height="1079" alt="Olanga notepad" src="https://github.com/user-attachments/assets/9fa513d5-59c7-4426-a06b-005bfa4b4687" />
<img width="1919" height="1079" alt="Olanga news" src="https://github.com/user-attachments/assets/4b65289f-603d-4c9f-ac44-f4be48ffa1bf" />

---

## Built with

[Electron](https://www.electronjs.org/) · [Vosk](https://alphacephei.com/vosk/) for offline wake-word detection · [Google Gemini](https://ai.google.dev/) for intelligence and vision · [NVIDIA](https://build.nvidia.com/) for Magpie TTS voices and the text generation behind the Notepad and News helpers

MIT licensed.
