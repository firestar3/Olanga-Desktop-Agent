# Olanga Privacy Notice

Last updated: October 12, 2026

This notice explains how the Windows desktop app in the [Olanga repository](https://github.com/firestar3/Olanga-Desktop-Agent) handles your information. It covers the app and its bundled companions. Services you connect, websites you open and your operating system have their own policies.

## At a glance

- Wake-word detection runs on your computer. Idle microphone audio is not streamed to an AI provider.
- Cloud features send the information needed for the feature to the provider you configure. This can include speech, text, conversation context and explicitly shared screen images.
- Saved API keys use Windows-backed encryption. Most other saved content is local but is not encrypted by Olanga.
- Olanga has no developer-operated account service, advertising SDK, automatic analytics upload or automatic crash-report upload. Optional performance measurements stay on your computer unless you export and share them.

## When information leaves your computer

| Feature | Information shared and destination |
| --- | --- |
| Gemini speech and answers | With cloud recognition selected, audio captured for an activated request goes to Google Gemini. Model-routed typed or reviewed transcripts go as text. Requests may also include recent conversation, current checklist entries, saved location and local time, enabled memories, and a previous screen diagnosis when relevant to the conversation. |
| On-device speech | The bundled Vosk recognizer transcribes audio locally. You review the transcript before sending it. Supported commands can run locally; questions or unsupported requests can still send the reviewed text and context to Gemini. Choosing on-device recognition does not make every feature offline. |
| Screen assistance | Selected-area diagnosis sends the image you select to Gemini. Desktop tasks send a primary-display screenshot, the task, visible window names and related screen information for diagnosis and planning. Approved edits include a new screenshot for verification. The selected edit region limits input actions; it does not crop the primary-display image shared for a desktop task. |
| Notes, projects and selected content | Asking Notes AI shares the current note, its title, your question and recent Notes AI conversation. Project search stays local; choosing **Ask Gemini about these sources** sends the displayed excerpts, source paths and your question. Asking about selected content sends the text you review. |
| Calendar preparation | Calendar import stays local. Asking Gemini to prepare for a selected event sends its title, time, location and description. |
| Current information and news | Google Search grounding through Gemini uses your question and relevant context. News retrieval sends topic and location queries to Google News RSS. AI news summaries and follow-up questions also use Gemini. Briefings may request weather and headlines; scheduled online briefing additions have a separate opt-in. |
| Spoken replies | The Windows voice uses the system speech service. If you select NVIDIA Magpie, response text and voice settings go to NVIDIA for speech generation using your NVIDIA key. Short generated replies may be cached in memory. |
| Gemini Live conversation | Starting this optional mode sends microphone audio continuously during that session, including sounds picked up between turns. Stopping, muting, losing the microphone or closing Work tools ends the session. It has a ten-minute limit. |
| Local model and speech servers | Explicit local questions or answer text go to the loopback server you configure on this computer. Olanga restricts these endpoints to loopback addresses; the server's own storage and network behavior is outside Olanga's control. |
| MCP connections | Connecting contacts the HTTPS server you specify to initialize it and retrieve its tools. Each approved tool call sends its exact reviewed arguments and optional bearer token to that server. |
| Updates and external links | Checking for updates contacts GitHub. Downloading retrieves the installer and verification files from GitHub release services. Opening a link contacts its destination through your browser. Update checks, downloads and installation are manual. |

Internet services receive ordinary connection information, such as your IP address. When a Gemini key is configured, Olanga may open a connection while you begin speaking or typing to reduce waiting time. That preparation request contains no API key, prompt or audio, but it still contacts Google. Configured Magpie voice discovery and testing also contact NVIDIA. The app's font and interface assets are bundled locally.

An activated voice request can follow a wake phrase, push-to-talk or a follow-up listening window. A false wake can activate recording, so watch the listening indicator and mute the microphone when you do not want voice input. Hiding the window leaves Olanga running in the tray; it does not stop listening.

## What Olanga keeps locally

The normal Windows profile is `%APPDATA%\olanga-control`. Development builds or custom launch options can use a different location.

| Data | Storage and retention |
| --- | --- |
| Gemini and NVIDIA keys | Saved in `secure-store.json` using Electron's Windows-backed credential encryption. The app must decrypt them to use your providers. Settings also have an encrypted backup, but several preferences have ordinary local-storage copies. |
| Preferences and personal content | Appearance, location, wake phrases, notes, checklist entries, timers, reminders, alarms, saved names, routines, memories and schedules remain in the local profile until you change or remove them. These records are not encrypted by Olanga. |
| Conversation and media | Recent assistant conversation, request audio, screen captures, plans and generated speech are held in memory, not saved as an Olanga chat or recording archive. Normal conversation context is discarded when next checked after 30 minutes of inactivity, and on app exit; it is bounded to recent messages. A temporary text-edit undo checkpoint lasts up to five minutes. Windows Snipping Tool may separately save captures or place them in clipboard history under your Windows settings. |
| Activity and performance | Keeping activity after restart and collecting local performance measurements are off by default. Saved activity keeps up to 40 receipts with operation types and statuses, without request text or detailed results. Measurements keep up to 200 timing/outcome entries. Routines separately retain up to 10 run records. |
| Work tools | Saved project folders, window sessions and file-operation receipts use local JSON files. Project text indexes and imported calendar snapshots stay in memory. File receipts keep source/destination paths and verification metadata for recovery, up to 30 receipts. Saved companion sessions can contain tab URLs/titles and document paths. Schedule history can contain reminder text and briefing results. |
| Connections and downloads | MCP tokens and companion pairing credentials stay in memory. Phone pairing uses a temporary HTTPS session with an essential session cookie on the phone. Downloaded installers, verification metadata and installation results can remain in the local update cache. Exported files stay wherever you save them. |

Local content is accessible to software or people with sufficient access to your Windows account or computer. Windows encryption of API keys does not encrypt notes, memories, exported files or the whole profile. Backups and system-managed caches may retain additional copies.

## Your controls

- **Microphone and voice:** use the microphone mute button to stop voice input, or choose on-device recognition in Core settings. Use the separate voice mute button or Windows voice to avoid Magpie speech requests. Quit from the tray to exit the app fully.
- **Provider keys:** remove saved Gemini keys in Core settings. To remove the NVIDIA key, clear its field and save. This removes Olanga's saved copy; revoke a key with its provider if you need to invalidate it everywhere.
- **Memories and saved names:** use Workspace to view, remove or disable them. **Use my memories in answers** controls whether saved memories are included in future Gemini requests. Deleting a memory does not erase previous conversation context or provider copies.
- **Activity and diagnostics:** use Workspace to clear history or measurements. Turning off performance collection deletes its saved measurements. Exports are created only when you request them and are not uploaded by Olanga.
- **Work tools:** forget a project, remove a saved session or schedule, clear the calendar snapshot, or clear notification history from the corresponding panel. Forgetting a project does not delete the source files. Disconnect MCP or companions and stop phone access when finished.
- **Other content:** delete notes, checklist entries, timers and routines with their own controls. Clear location fields to stop including saved location in future requests. There is no automatic expiry for every type of saved content and no single in-app button that erases every profile file.

To remove the entire local profile, first quit Olanga from the tray, save any content you want to keep elsewhere, then remove the specific `olanga-control` folder described above. This also removes credentials, preferences, saved content, operation recovery history and downloaded updates. Do not assume uninstalling removes this profile. It does not remove original project files, your exports, companion-app data, Windows clipboard history, backups or information already sent to providers. File deletion is not a guarantee of forensic erasure.

## Provider policies and retention

Your configured providers process requests under their own terms, account settings and retention policies. Olanga does not control their storage, processing locations or deletion procedures. Use their account/privacy tools for requests concerning information they hold.

Google's treatment of Gemini data differs between unpaid and paid services. Its current terms say unpaid inputs and outputs can be used to improve products and reviewed by people, with regional exceptions; paid-service terms provide different protections and still permit limited safety-related logging. Review the terms that apply to your account before sending private information. [Gemini API terms](https://ai.google.dev/gemini-api/terms) · [Google Privacy Policy](https://policies.google.com/privacy).

For other configured services, see [NVIDIA's Privacy Policy](https://www.nvidia.com/en-us/about-nvidia/privacy-policy/) and [GitHub's Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). An MCP service, browser destination or locally installed server may have additional policies of its own.

## Questions and changes

For questions about this notice or the app's behavior, use the [project issue tracker](https://github.com/firestar3/Olanga-Desktop-Agent/issues). Issues are public: do not post API keys, personal recordings, private screenshots or profile files. The maintainer cannot inspect or delete data that exists only on your computer or in your provider account.

This notice will be updated when the app's data handling changes. The date above identifies this revision; repository history records previous versions. The software's license is provided separately in [LICENSE](https://github.com/firestar3/Olanga-Desktop-Agent/blob/main/LICENSE).
