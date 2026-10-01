# Olanga companions

These optional development companions add explicit browser-tab and VS Code document identity. They are not installed or connected automatically. The desktop app works without them.

In the installed app, **Workspace → Apps & updates → Work tools → Browser & editor → Open companion files** opens the bundled `extensions` folder. Its `browser` and `vscode` folders are the same files used by the source instructions below. The setup guide is also available directly in that panel.

## Chrome and Edge

1. Open `chrome://extensions` or `edge://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select the bundled `browser` folder or this repository's `extensions/browser` folder.
3. In Olanga's **Browser & editor** panel, choose **Pair browser**. Invoke the Olanga extension from the page you want to share; its companion window stays open.
4. Paste the displayed local endpoint and one-time pairing code into that window.
5. Choose **Share selected page text** or **Share current tab list**. Reading all tab titles and URLs requires a separate optional browser permission. Private tabs are excluded.

Keep the companion window open while using it. Closing it makes the connection unavailable; pairing credentials exist only in its memory. Each requested tab action displays its exact target and needs approval in that window. Saved-tab restore reuses matching URLs before opening missing tabs. Only HTTP and HTTPS URLs without embedded credentials are supported. There is no page injection beyond reading text that you selected after invoking the extension.

## VS Code

Open `extensions/vscode` as a VS Code extension development folder and run an Extension Development Host, or package it locally with the official `@vscode/vsce` tool and use **Extensions: Install from VSIX**. This companion is not published on the Marketplace.

1. In Olanga's **Browser & editor** panel, choose **Pair VS Code**.
2. Run **Olanga: Connect Companion** in the Command Palette and paste the endpoint and one-time code.
3. Select text and run **Olanga: Share Selected Text and Diagnostics**, or explicitly share open document references or existing workspace tasks.
4. Review proposed selection changes in VS Code's diff editor and choose **Apply** only after checking the diff. Changes to the original document invalidate a pending proposal. Applied edits remain unsaved and use VS Code's ordinary Undo.

Task execution requires a trusted workspace, a currently shared task, an unchanged task definition, and an explicit VS Code confirmation. Olanga can request only an existing task ID; it cannot supply a shell command. The companion reports the actual process exit code and stops its task after five minutes. Task output stays in VS Code's task terminal. Resuming documents is limited to local file references previously shared through this companion; it does not execute document contents.

## Connection and privacy

Pairing explicitly starts a listener bound to `127.0.0.1` on a random port. The one-time 256-bit code expires in five minutes. A paired browser token is bound to that exact extension origin. Ordinary website origins are rejected, and wildcard CORS is never enabled. VS Code uses a separate native client protocol and the same token requirement. Pairing and shared inbox content are held in memory until disconnect or app exit. VS Code remembers the names of previously shared document references locally so they can be reopened; document text is not persisted by the companion.

Companion sharing itself never sends content to an AI provider. Sending selected context to a cloud model is a separate explicit action in Olanga. Text from pages, documents, diagnostics and task labels is untrusted context, never permission to execute additional actions.

The companion adapters have deterministic API tests and loopback protocol tests. Live trials inside an installed browser and VS Code's extension host remain unverified for 1.5.0. Check compatibility with your browser and editor versions before relying on these optional development companions for daily work.

References: [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [Chrome tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs), [optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions), [VS Code task provider](https://code.visualstudio.com/api/extension-guides/task-provider), [VS Code API](https://code.visualstudio.com/api/references/vscode-api).
