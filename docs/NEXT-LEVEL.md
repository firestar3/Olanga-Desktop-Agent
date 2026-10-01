# Olanga 1.5.0 implementation

This work extends the existing 1.4.1 behavior. Existing colors, fonts, local commands, reviewed actions, cancellation and manual updates remain the baseline. Optional integrations do not start, connect or upload content on application startup.

| Workstream | Deliverable | Acceptance evidence |
| --- | --- | --- |
| Request completion | Unified action/speech lifecycle, accurate playback events, bounded failures | Cancellation, late replies, failed speech and terminal-state regressions |
| Corrections | Scoped corrections to an active/recent explicit request | No replay of completed steps; ambiguous references fail closed |
| Working sessions | Explicit snapshots and reviewed restore of supported windows | Identity, geometry, duplicate-window and partial-failure checks |
| Files | Selected-file rename/move preview and checked undo | Collision, mutation, symlink and partial-failure fixtures |
| Project knowledge | User-selected folders, local search and cited optional answers | Scope, size, stale-source and privacy checks |
| Voice | Sample-based capture/endpointing and device recovery | Audio fixtures, cancellation and fallback tests |
| Optional conversation | Explicit local endpoint and live conversation sessions | Protocol fixtures; live-provider coverage recorded separately |
| Companion integrations | Browser and editor adapters with explicit context transfer | Identity, authorization and stale-document tests |
| Daily use | Compact request/status UI, keyboard access and scheduled local reminders | Renderer and persistence smoke checks |
| Extensibility | Explicitly configured integrations and paired remote controls | Authentication, replay and approval tests |
| Distribution | Recovery-aware manual updates and signing validation | Packaged and upgrade checks; signing requires a maintainer certificate |

Physical microphone measurements, external account authentication, publisher signing and representative multi-machine results must be recorded as actually performed or unverified. A mock or synthetic fixture must never be reported as a live integration result.

## Delivered scope

All workstreams above have implementations and regression coverage in 1.5.0. Optional paths are explicitly selected and retain the existing native command routes. Workspace is the main top-bar entry point; Quick ask has been removed. The release also includes the Spotify startup, independent volume-step and acknowledgment corrections described in the [release notes](releases/1.5.0.md). The installer is unsigned, and all update checks, downloads and installations remain manual.

The implementations have the following boundaries:

- Window sessions restore supported app geometry. Browser tabs and VS Code documents have separately selected companion sessions and require companion approval to restore.
- File workflows rename or move selected local files on the same volume. They do not delete or overwrite files. Undo checks identities and contents before restoration.
- Project search is bounded keyword passage retrieval, with explicit cloud sharing and citations. It is not an always-on whole-disk index.
- Corrections cover explicit volume targets and cancellation of pending timer steps. Arbitrary replanning across every application is not claimed.
- Spotify-scoped Play can open Spotify when no media session exists and requires a playing track before reporting success. If playback fails, a remaining explicitly requested volume adjustment can still run. These corrections have controlled native-function and routing coverage; live playback of the corrected request remains unverified.
- Local conversation and WAV speech need compatible loopback servers. Gemini Live is a separate, explicitly started conversation preview, without desktop action tools.
- Schedules run while Olanga is open or in the tray. Imported calendar context is a one-off `.ics` snapshot; live calendar synchronization and recurring calendar rules are not implemented.
- Browser and VS Code companions are development extensions with installation instructions. Protocol/adapter tests do not replace trials inside the actual extension hosts.
- MCP supports configured HTTPS endpoints with per-call review, JSON/SSE, and in-memory bearer credentials. OAuth, arbitrary local command servers and autonomous tool execution are outside this implementation.
- Phone control requires a local TLS identity and phone trust. It supports a single allowlisted app, volume or timer command while Olanga is idle. Physical-phone and browser dictation compatibility remains unverified.
- Signing support is ready for a future certificate. No signing certificate was supplied. Manual downloads can recover a complete verified cache; partial downloads restart. There is no automatic updater or automatic rollback.

See [validation](VALIDATION.md) for the actual checks, the earlier live Spotify observation, and remaining hardware/account coverage. The historical beta observations do not establish live playback success for the corrected Play request.
