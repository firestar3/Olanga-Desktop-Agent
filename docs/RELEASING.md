# Releasing Olanga 1.3.1

The app remains a complete Electron Windows application, distributed through this repository's GitHub Releases as an NSIS installer. No website deployment or separate backend server is needed. Users supply their provider keys.

## Verify locally

```powershell
npm ci
npm run check
npm test
npm run smoke
npm run smoke:overlay
npm run smoke:overlay:native
npm run smoke:desktop
npm run smoke:voice
npm run smoke:voice:audio
npm run dist
npm run verify:package
```

The installer is `dist/Olanga-Setup-1.3.1.exe`. `npm run pack` produces `dist/win-unpacked/` for a quick packaging check. Use a Windows desktop session for smoke checks. The native overlay check briefly moves the pointer and clicks only its own isolated test windows; leave the mouse alone while it runs. It restores the pointer afterward and makes no live model calls.

The desktop smoke check opens a temporary editor, clicks only that fixture, performs real scoped multiline typing, verifies exact text readback and captures a fresh fixture image. Close other Olanga instances first and leave the keyboard and pointer alone. Native confirmations are injected only in the test; production requires both. The default test uses no credentials or network.

The voice smoke checks are opt-in live Windows checks. They open Spotify, briefly set volume to 75%, play acknowledgment and completion, and restore the original volume/mute state. The audio variant also sends a generated test WAV to Gemini using the saved key; it needs authorization for that live provider use. Both preserve the user's normal profile and write timing/verification evidence to `build/qa/`. Physical microphone and wake-word coverage are separate.

Building does **not** update the installed app or its desktop/Start-menu shortcuts. Quit the running Olanga from its tray menu, run `dist/Olanga-Setup-1.3.1.exe`, then reopen Olanga using your shortcut. The installer preserves app data. For a light that stays visible while idle, choose **Settings → Corner Status Light → All Lights**. Closing the main window only hides it; it does not quit an older running version.

Before releasing, install the built version and check All Lights mode over another app, all eight menu items, both hide timers, shortcut persistence after restart, an ordinary Gemini question, a Gemini screen diagnosis, both edit confirmations, cancellation from each confirmation, editor-region refusal when accessibility is unavailable, and Escape during a harmless edit in a disposable document. Check that post-edit verification describes visible evidence and clearly identifies untested behavior before approving a new phase. Do not use a valuable document for the first live input test.

## Commit and publish

Choose the branch whose changes you want to release. Review the source changes and staged file list before committing:

```powershell
git status --short
git diff
git add --all
git diff --cached --stat
git commit -m "Release v1.3.1: faster voice commands and verified actions"
git push -u origin HEAD
git tag -a v1.3.1 -m "Olanga v1.3.1"
git push origin v1.3.1
```

The ignore rules exclude promotional videos/audio/screenshots under `artifacts/`, local diagnostic outputs, the extracted `model/` working copy, `dist/`, `build/` and `node_modules/`. The app icon and `vosk-model-v2.tar.gz` are required build inputs and remain versioned. The Release workflow uploads the installer as a release asset; it does not need to be committed to Git.

If you prefer the release on your usual release branch, merge this work there using your normal process **before** creating the tag. The workflow builds the commit the tag points to. `npm run check` rejects a tag that differs from `package.json` so the installer and release cannot silently disagree. If `v1.3.1` already exists, choose a new version and update both `package.json` and the root package/version entries in `package-lock.json`; do not overwrite an existing public tag.

After pushing the tag, open the repository's Actions tab and wait for **Release** to finish. The installer is attached to the matching GitHub release. A manual workflow dispatch builds an artifact without publishing a release. The installer remains unsigned until you configure Windows code signing.
