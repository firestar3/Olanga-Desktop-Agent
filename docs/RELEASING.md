# Releasing Olanga

The app remains a complete Electron Windows application, distributed through this repository's GitHub Releases as an NSIS installer. No website deployment or separate backend server is needed. Users supply their provider keys.

## Manual in-app updates

**Workspace → Apps & updates → Check for updates** reads the latest stable release metadata from the fixed public repository `firestar3/Olanga-Desktop-Agent`. It compares semantic versions and offers **Download update** when a newer release has valid installer and checksum assets. Each explicit check refreshes metadata, with an eight-second deadline; concurrent requests share one check. There is no startup check or background polling.

Checking does not download an installer. If a completed installer is cached from a previous session, the explicit check also fetches its small `SHA256SUMS` manifest and rehashes the local bytes before offering installation. A separate **Download update** action fetches a missing version-matched installer and manifest. The main process validates fixed repository URLs, every redirect, bounded file sizes and hashes, including GitHub asset digests when supplied. Downloads stream to a private updates directory under the app's data folder, with progress, cancellation and partial-file cleanup. Network, rate-limit and malformed-response failures remain distinct from “up to date.”

Only **Install & restart** launches an installer, after rehashing the saved file. The renderer cannot supply a download URL, file path or executable arguments. The NSIS update path retains the existing installation directory, installation mode and app data, and reopens Olanga. An ordinary app quit never installs anything. The button is available in packaged Windows builds; source checkouts can check and download but cannot install. Complete downloads have bounded local cache metadata and can be recovered by a later explicit Check; startup does not scan files or contact GitHub. Partial downloads restart from the beginning, and abandoned partial files are removed by an explicit Download. Tampered, linked, stale-version or mismatched cache entries cannot become installable. Versions through 1.4.0 need one manual installer update to gain this flow.

Checksum verification does not verify publisher identity. The checked-in publisher policy is disabled, so the current unsigned build does not claim a verified signature. A future build with an explicit publisher pin also requires a valid Authenticode signature with that exact certificate on download, cache recovery and immediately before installation. Installation, elevated-install cancellation and rollback are separate from the download and launch checks. See the [GitHub Releases API documentation](https://docs.github.com/en/rest/releases/releases#get-the-latest-release).

## Verify locally

```powershell
npm ci
npm run check
npm test
npm run smoke
npm run smoke:workspace
npm run smoke:workbench
npm run smoke:sessions
npm run smoke:updates
npm run smoke:offline
npm run smoke:apps
npm run smoke:overlay
npm run smoke:overlay:native
npm run smoke:desktop
npm run smoke:voice
npm run smoke:voice:audio
npm run dist
npm run verify:package
npm run smoke:packaged
```

The installer is `dist/Olanga-Setup-<package-version>.exe`. `npm run pack` produces `dist/win-unpacked/` for a quick packaging check. Use a Windows desktop session for smoke checks. The native overlay check briefly moves the pointer and clicks only its own isolated test windows; leave the mouse alone while it runs. It restores the pointer afterward and makes no live model calls.

The Workspace check exercises real UI and local state with an isolated profile and blocked network. The updates smoke uses the real renderer and preload with simulated update IPC: explicit actions, progress, cancellation, retries and reload races are checked without downloading or launching an installer. The offline check compares the bundled Vosk recognizers using synthetic WAVs; it does not use a microphone or dispatch desktop actions. The app-adapter check launches and arranges only its own disposable fixture, including missing/multiple-window and cancellation cases.

The desktop smoke check opens a temporary editor, clicks only that fixture, performs a real scoped full-field replacement, verifies exact text readback and captures a fresh fixture image. It restores the original text and checks that intervening text or control changes prevent undo. Close other Olanga instances first and leave the keyboard and pointer alone. Native confirmations are injected only in the test; production requires both. The default test uses no credentials or network.

After building, the packaged smoke launches the actual `dist/win-unpacked/Olanga.exe` with an isolated profile. It checks preload isolation, new APIs, keyless startup, timer/checklist persistence and absence of provider requests. It does not install the app, test an upgrade or use the normal profile.

For a preview build kept alongside the stable package, use `npm run dist -- --config.directories.output=dist/next-level`, then set `$env:OLANGA_BUILD_DIR='dist/next-level'` for package verification, signing verification and the packaged smoke. To check profile compatibility, run `node tests/profile-upgrade-smoke.js` with the old 1.4.1 executable at `dist/win-unpacked/Olanga.exe` and the new preview at `dist/next-level/win-unpacked/Olanga.exe`. The script seeds a disposable profile with the old executable and verifies it with the new one; optional `OLANGA_UPGRADE_OLD_EXE`, `OLANGA_UPGRADE_NEW_EXE` and matching `*_VERSION` variables support other transitions. This is a packaged-binary profile check, not an installer upgrade test.

The voice smoke checks are opt-in live Windows checks. They open Spotify, briefly set volume to 75%, play acknowledgment and completion, and restore the original volume/mute state. The audio variant also sends a generated test WAV to Gemini using the saved key; it needs authorization for that live provider use. Both preserve the user's normal profile and write timing/verification evidence to `build/qa/`. Physical microphone and wake-word coverage are separate.

`npm run smoke:spotify` specifically exercises **“Play Spotify and raise the volume to 75%”** through the production typed-command path. It requires a verified playing track and a fresh Spotify-session readback, plus sustained 75% volume through the spoken result. It restores the original volume/mute state and pauses playback if Spotify was not originally playing. This opt-in check changes the real player and system audio; it is separate from the opening-only smoke and is not run by CI. Add `--live-audio` only when live Gemini transcription of that generated command is authorized.

Building does **not** update the installed app or its desktop/Start-menu shortcuts. Quit the running Olanga from its tray menu, run the version-matched installer, then reopen Olanga using your shortcut. The installer preserves app data. For a light that stays visible while idle, choose **Settings → Corner Status Light → All Lights**. Closing the main window only hides it; it does not quit an older running version.

Before releasing, install the built version and check All Lights mode over another app, all eight menu items, both hide timers, shortcut persistence after restart, an ordinary Gemini question, a Gemini screen diagnosis, both edit confirmations, cancellation from each confirmation, editor-region refusal when accessibility is unavailable, and Escape during a harmless edit in a disposable document. Check that post-edit verification describes visible evidence and clearly identifies untested behavior before approving a new phase. Do not use a valuable document for the first live input test.

## Commit and publish

Choose a new version and update `package.json` and both root version entries in `package-lock.json`. Write the public feature and update notes in `docs/releases/<version>.md`; the workflow prepends them to its generated verification notice. Choose the branch whose changes you want to release. Review the source changes and staged file list before committing:

```powershell
git status --short
git diff
git add --all
git diff --cached --stat
$releaseVersion = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
git commit -m "Release v$releaseVersion"
git fetch origin
git merge-base --is-ancestor origin/main HEAD
if ($LASTEXITCODE -ne 0) { throw 'Integrate the current remote main before publishing. Do not force-push.' }
git push origin HEAD:main
if ($LASTEXITCODE -ne 0) { throw 'Publishing main failed. Resolve it before creating the release tag.' }
git tag -a "v$releaseVersion" -m "Olanga v$releaseVersion"
git push origin "v$releaseVersion"
```

The ignore rules exclude promotional videos/audio/screenshots under `artifacts/`, local diagnostic outputs, the extracted `model/` working copy, `dist/`, `build/` and `node_modules/`. The app icon and `vosk-model-v2.tar.gz` are required build inputs and remain versioned. The Release workflow uploads the installer and verification files as release assets; they do not need to be committed to Git.

This publishes the reviewed commit to remote `main` even when your checkout has another branch name, then tags that same commit. If branch protection requires a pull request, merge it and check out the resulting `main` commit before tagging. The workflow builds the commit the tag points to. `npm run check` rejects a tag that differs from `package.json` so the installer and release cannot silently disagree. Do not overwrite an existing public tag or installer. Asset uploads deliberately omit `--clobber`; a collision fails instead of silently replacing published bytes.

After pushing the tag, open the repository's Actions tab and wait for **Release** to finish. A manual workflow dispatch builds a downloadable Actions artifact without publishing a release.

## Checksums and signing status

After the build and package checks, `.github/workflows/release.yml` requires exactly one installer matching the package version. It inspects Authenticode on both that installer and `dist/win-unpacked/Olanga.exe`, then hashes the completed installer. The workflow publishes these files together:

- `Olanga-Setup-<version>.exe`
- `SHA256SUMS`, containing the actual SHA-256 of that installer
- `RELEASE-METADATA.json`, recording the version, commit, digest and observed signing status
- `RELEASE-NOTES.md`, stating whether the installer is signed or unsigned and that updates remain manual

The notes also appear in the GitHub release body. These checks occur when the workflow runs; editing the workflow does not verify an existing or future installer. JSON metadata and checksums are not publisher signatures.

After downloading the installer and `SHA256SUMS` from the same release, verify the file before running it:

```powershell
$installerName = 'Olanga-Setup-<version>.exe' # Replace with the downloaded filename.
$entry = Get-Content -LiteralPath SHA256SUMS | Where-Object {
  $_ -match '^([a-fA-F0-9]{64})  (.+)$' -and $Matches[2] -ceq $installerName
}
if (@($entry).Count -ne 1) { throw 'No unique checksum entry matches this installer.' }
$expected = $entry.Substring(0, 64)
$actual = (Get-FileHash -LiteralPath $installerName -Algorithm SHA256).Hash
if ($actual -ine $expected) { throw 'Installer checksum mismatch. Do not run it.' }
Get-AuthenticodeSignature -LiteralPath $installerName | Select-Object Status, SignerCertificate
```

A matching hash establishes that the local bytes match the downloaded manifest. It does not establish publisher identity if both files came from an untrusted source. A signed release must additionally show a valid Authenticode signature from the expected publisher; compare that identity through a trusted channel. An unsigned release is intentionally reported as `NotSigned`.

## Optional Windows signing

Configure **both** GitHub Actions repository/environment secrets only when you have a usable Windows signing certificate:

- `WIN_CSC_LINK`: the base64-encoded PFX/P12 certificate accepted by electron-builder.
- `WIN_CSC_KEY_PASSWORD`: its nonempty password.

Never commit or print the certificate or password. When both secrets exist, the workflow enables executable signing and sets `forceCodeSigning=true`; it then refuses publication unless both the installer and packaged app have valid Authenticode signatures. A partial configuration fails rather than silently falling back. With neither secret, executable signing is explicitly disabled, and the workflow requires `NotSigned` status and labels the release unsigned. Icon and version resource editing remain enabled. This opt-in path uses electron-builder's [Windows signing configuration](https://www.electron.build/docs/features/code-signing/code-signing-win/); hardware-backed/cloud signing requires a separately reviewed setup.

No signing credentials were supplied or exercised as part of implementing this workflow. Signed release creation must be validated with the configured publisher certificate before claiming a signed distribution is ready.

Optionally set the repository variable `OLANGA_SIGNING_PUBLISHER_THUMBPRINT` to the signing certificate's exact 40-character hexadecimal thumbprint. A pin without both signing secrets fails the build. `scripts/prepare-signing.js` embeds it in the build's copy of `desktop/trusted-publisher.json` before packaging; the tracked template remains disabled. `scripts/verify-signing.js` checks the actual installer and packaged executable through the fixed Windows helper, requires the same valid certificate on both, and enforces the configured pin. Release metadata records the observed and expected thumbprints. It never derives trust from a downloaded manifest. Certificate rotation requires a separately planned migration or deliberate manual installer replacement; do not silently remove the old pin to make an update pass.

## Automatic updates and rollback remain disabled

`build.publish` remains `null`; the workflow does not publish an automatic-update feed. The app has no automatic download, installation or rollback path. Both `automaticUpdatesEnabled` and `rollbackValidated` are recorded as false in release metadata. Configuring a signing secret does not turn those features on.

Before introducing automatic updates, require verified publisher signatures plus tests of update interruption, a failed startup after upgrade, preserved user data, schema compatibility when returning to an older build, and recovery to a previously verified installer. Until then, keep updates manual and retain prior release installers for deliberate recovery. Do not claim that reinstalling an older executable safely reverses data migrations unless that version transition has been tested.
