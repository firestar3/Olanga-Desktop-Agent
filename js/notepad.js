/* ============================================
   OLANGA — NOTEPAD (tabs, formatting, AI sidebar)
   ============================================ */

const notepadTextarea = document.getElementById('notepadTextarea');
const notepadClearBtn = document.getElementById('notepadClearBtn');
const notepadExportBtn = document.getElementById('notepadExportBtn');
const notepadImportBtn = document.getElementById('notepadImportBtn');
const notepadBoldBtn = document.getElementById('notepadBoldBtn');
const notepadItalicBtn = document.getElementById('notepadItalicBtn');
const notepadStrikeBtn = document.getElementById('notepadStrikeBtn');
const notepadAiToggleBtn = document.getElementById('notepadAiToggleBtn');
const notepadRenameBtn = document.getElementById('notepadRenameBtn');
const notepadAiSidebar = document.getElementById('notepadAiSidebar');
const notepadAiCloseBtn = document.getElementById('notepadAiCloseBtn');
const notepadAiChat = document.getElementById('notepadAiChat');
const notepadAiInput = document.getElementById('notepadAiInput');
const notepadAiSendBtn = document.getElementById('notepadAiSendBtn');
const notepadAiModelSelect = document.getElementById('notepadAiModelSelect');
const notepadAiStatusDot = document.getElementById('notepadAiStatusDot');
const notepadAiStatusText = document.getElementById('notepadAiStatusText');
const notepadTabs = document.getElementById('notepadTabs');
const notepadTabAddBtn = document.getElementById('notepadTabAddBtn');

// Tab management
let notepadTabsData = [];
let currentTabId = 0;

// Load saved tabs
const savedTabs = localStorage.getItem('olangaNotepadTabs');
if (savedTabs) {
  try {
    notepadTabsData = JSON.parse(savedTabs);
  } catch (e) {
    console.error("Error parsing notepad tabs from localStorage, resetting tabs:", e);
    notepadTabsData = [{ id: 0, name: 'Note 1', content: '' }];
  }
} else {
  // Create default tab
  notepadTabsData = [{ id: 0, name: 'Note 1', content: '' }];
}

// Make sure currentTabId is initialized to an existing tab ID
if (notepadTabsData.length > 0) {
  const exists = notepadTabsData.some(t => t.id == currentTabId);
  if (!exists) {
    currentTabId = notepadTabsData[0].id;
  }
}

// Render tabs
function renderNotepadTabs() {
  notepadTabs.innerHTML = '';
  notepadTabsData.forEach(tab => {
    const tabBtn = document.createElement('button');
    tabBtn.className = `notepad-tab ${tab.id == currentTabId ? 'active' : ''}`;
    tabBtn.dataset.tab = tab.id;
    tabBtn.innerHTML = `${escapeHTML(tab.name)} <span class="notepad-tab-delete" data-tab="${tab.id}">×</span>`;
    tabBtn.addEventListener('click', (e) => {
      if (e.target.classList.contains('notepad-tab-delete')) {
        e.stopPropagation();
        deleteNotepadTab(tab.id);
      } else {
        switchNotepadTab(tab.id);
      }
    });
    notepadTabs.appendChild(tabBtn);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'notepad-tab-add';
  addBtn.id = 'notepadTabAddBtn';
  addBtn.textContent = '+';
  addBtn.title = 'Add New Tab';
  addBtn.addEventListener('click', addNotepadTab);
  notepadTabs.appendChild(addBtn);
}

// Add new tab
function addNotepadTab() {
  const newId = notepadTabsData.length > 0 ? Math.max(...notepadTabsData.map(t => Number(t.id))) + 1 : 0;
  const newTab = { id: newId, name: `Note ${notepadTabsData.length + 1}`, content: '' };
  notepadTabsData.push(newTab);
  saveNotepadTabs();
  switchNotepadTab(newId);
}

// Delete tab
function deleteNotepadTab(tabId) {
  if (notepadTabsData.length <= 1) {
    alert('Cannot delete the last tab.');
    return;
  }

  if (confirm('Delete this tab?')) {
    const tabIndex = notepadTabsData.findIndex(t => t.id == tabId);
    if (tabIndex !== -1) {
      // Save current content before deleting
      notepadTabsData[tabIndex].content = notepadTextarea.innerHTML;

      notepadTabsData = notepadTabsData.filter(t => t.id != tabId);
      saveNotepadTabs();

      // Switch to another tab
      const newCurrentTab = notepadTabsData[Math.max(0, tabIndex - 1)];
      switchNotepadTab(newCurrentTab.id);
    }
  }
}

// Switch tab
function switchNotepadTab(tabId) {
  // Save current content
  const currentTab = notepadTabsData.find(t => t.id == currentTabId);
  if (currentTab) {
    currentTab.content = notepadTextarea.innerHTML;
  }

  currentTabId = tabId;
  const newTab = notepadTabsData.find(t => t.id == tabId);
  if (newTab) {
    notepadTextarea.innerHTML = newTab.content;
  }

  renderNotepadTabs();
}

// Save tabs to localStorage
function saveNotepadTabs() {
  localStorage.setItem('olangaNotepadTabs', JSON.stringify(notepadTabsData));
}

// Rename tab (double-click on tab)
notepadTabs.addEventListener('dblclick', (e) => {
  const tabBtn = e.target.closest('.notepad-tab');
  if (tabBtn && !tabBtn.classList.contains('notepad-tab-add')) {
    const tabId = tabBtn.dataset.tab;
    const tab = notepadTabsData.find(t => t.id == tabId);
    if (tab) {
      const newName = prompt('Enter new tab name:', tab.name);
      if (newName && newName.trim()) {
        tab.name = newName.trim();
        saveNotepadTabs();
        renderNotepadTabs();
      }
    }
  }
});

// Auto-save on input
notepadTextarea.addEventListener('input', () => {
  const currentTab = notepadTabsData.find(t => t.id == currentTabId);
  if (currentTab) {
    currentTab.content = notepadTextarea.innerHTML;
    saveNotepadTabs();
  }
});

// Clear current note
notepadClearBtn.addEventListener('click', () => {
  if (notepadTextarea.innerHTML.trim() && confirm('Clear the current note? Content will be lost.')) {
    notepadTextarea.innerHTML = '';
    const currentTab = notepadTabsData.find(t => t.id === currentTabId);
    if (currentTab) {
      currentTab.content = '';
      saveNotepadTabs();
    }
  } else if (!notepadTextarea.innerHTML.trim()) {
    notepadTextarea.innerHTML = '';
  }
});

// Export note as HTML file
notepadExportBtn.addEventListener('click', () => {
  const content = notepadTextarea.innerHTML;
  if (!content.trim()) {
    alert('The current note is empty. Nothing to export.');
    return;
  }

  const blob = new Blob([content], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const currentTab = notepadTabsData.find(t => t.id === currentTabId);
  a.download = `olanga-note-${currentTab ? currentTab.name : 'note'}-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// Import note from file (HTML, TXT, JSON, and popular code files)
notepadImportBtn.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  // Allow popular coding files, txt files, json files
  input.accept = '.txt,.json,.html,.htm,.css,.js,.ts,.py,.cpp,.h,.hpp,.cc,.cs,.java,.go,.rs,.rb,.php,.sh,.bat,.ps1,.md';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      // Load all files as plain text (so HTML shows its raw code rather than rendering it)
      notepadTextarea.textContent = event.target.result;

      const currentTab = notepadTabsData.find(t => t.id == currentTabId);
      if (currentTab) {
        currentTab.content = notepadTextarea.innerHTML;
        saveNotepadTabs();
      }
    };
    reader.readAsText(file);
  };
  input.click();
});

// Initialize tabs
renderNotepadTabs();
const initialTab = notepadTabsData.find(t => t.id == currentTabId);
if (initialTab) {
  notepadTextarea.innerHTML = initialTab.content;
}

// Text formatting buttons (use mousedown and preventDefault to keep editor focus)
notepadBoldBtn.addEventListener('mousedown', (e) => {
  e.preventDefault();
  document.execCommand('bold', false, null);
  updateFormattingButtonsState();
});

notepadItalicBtn.addEventListener('mousedown', (e) => {
  e.preventDefault();
  document.execCommand('italic', false, null);
  updateFormattingButtonsState();
});

notepadStrikeBtn.addEventListener('mousedown', (e) => {
  e.preventDefault();
  document.execCommand('strikeThrough', false, null);
  updateFormattingButtonsState();
});

// Update formatting button active states based on cursor selection
function updateFormattingButtonsState() {
  notepadBoldBtn.classList.toggle('active', document.queryCommandState('bold'));
  notepadItalicBtn.classList.toggle('active', document.queryCommandState('italic'));
  notepadStrikeBtn.classList.toggle('active', document.queryCommandState('strikeThrough'));
}

document.addEventListener('selectionchange', () => {
  if (document.activeElement === notepadTextarea) {
    updateFormattingButtonsState();
  }
});
notepadTextarea.addEventListener('keyup', updateFormattingButtonsState);
notepadTextarea.addEventListener('mouseup', updateFormattingButtonsState);

// Rename tab button
if (notepadRenameBtn) {
  notepadRenameBtn.addEventListener('click', () => {
    const tab = notepadTabsData.find(t => t.id == currentTabId);
    if (tab) {
      const newName = prompt('Enter new tab name:', tab.name);
      if (newName && newName.trim()) {
        tab.name = newName.trim();
        saveNotepadTabs();
        renderNotepadTabs();
      }
    }
  });
}

// ============================================
// NOTEPAD AI SIDEBAR
// ============================================

let notepadAiSidebarOpen = false;
let notepadAiChatHistory = [];
let notepadAiChatSummary = '';
const MAX_MESSAGES = 15;
const COMPACT_COUNT = 10;

// Toggle AI sidebar
notepadAiToggleBtn.addEventListener('click', () => {
  notepadAiSidebarOpen = !notepadAiSidebarOpen;
  notepadAiSidebar.classList.toggle('hidden', !notepadAiSidebarOpen);
});

// Close AI sidebar
notepadAiCloseBtn.addEventListener('click', () => {
  notepadAiSidebarOpen = false;
  notepadAiSidebar.classList.add('hidden');
});

// Send AI message
notepadAiSendBtn.addEventListener('click', sendNotepadAiMessage);
notepadAiInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    sendNotepadAiMessage();
  }
});

async function sendNotepadAiMessage() {
  const message = notepadAiInput.value.trim();
  if (!message) return;

  // Set AI status to working
  notepadAiStatusDot.classList.add('working');
  notepadAiStatusText.textContent = 'Working...';
  notepadAiSendBtn.disabled = true;

  // Add user message to chat
  addNotepadAiMessage(message, 'user');
  notepadAiInput.value = '';

  // Get current note content (convert HTML to plain text for AI)
  const noteContent = htmlToPlainText(notepadTextarea.innerHTML);

  // Get current tab name
  const currentTab = notepadTabsData.find(t => t.id == currentTabId);
  const currentTabName = currentTab ? currentTab.name : 'Note';

  // Get selected model
  const selectedModel = notepadAiModelSelect.value;

  // Map model names to Nvidia API models
  const modelMap = {
    'fast': 'meta/llama-3.1-8b-instruct',
    'smart': 'meta/llama-3.1-70b-instruct',
    'code': 'meta/llama-3.1-70b-instruct'
  };

  const modelName = modelMap[selectedModel] || 'meta/llama-3.1-70b-instruct';

  // Prepare AI prompt with note context and chat history
  let systemPrompt;

  if (selectedModel === 'code') {
    systemPrompt = `You are a precise code-writing assistant embedded in a notepad. Your job is to write or modify code exactly as instructed — nothing more, nothing less.

Current tab name: ${currentTabName}

STRICT RULES — follow these at all times:
- Write ONLY the code that was explicitly asked for. Do not add unrequested features, functions, or logic.
- Any explanation, reasoning, warnings, or notes MUST be written as code comments (e.g. // comment or /* comment */) — never as plain prose outside of code blocks.
- Always use correct formatting and indentation for the language being written.
- Match the indentation style already present in the note (spaces vs tabs).
- Keep code clean, readable, and production-quality.
- When you provide updated content, wrap it in triple backticks with the language tag (e.g. \`\`\`python) and start with "UPDATED NOTE:" to clearly indicate it's meant to replace the current note.

IMPORTANT: When the user asks you to rename the note/tab:
- If they want to rename the current tab, respond with "RENAMED TAB: [new name]" on its own line
- Keep the new name concise and descriptive (under 20 characters if possible)

Current note content:\n\n${noteContent || '(empty)'}`;
  } else {
    systemPrompt = `You are an AI assistant for a notepad application. You have access to the user's notes and can help them edit, organize, and improve their notes.

Current tab name: ${currentTabName}

IMPORTANT: When the user asks you to make changes to their notes:
- EDIT the existing content rather than replacing everything
- Make targeted changes to specific sections
- Preserve the structure and overall content
- Only replace what needs to be changed
- Use markdown formatting in the updated note: use ** for bold text, and # at the start of lines for headers (which will be bolded)
- When you provide updated content, wrap it in triple backticks (\`\`\`) and start with "UPDATED NOTE:" to clearly indicate it's meant to replace the current note

IMPORTANT: When the user asks you to rename the note/tab:
- If they want to rename the current tab, respond with "RENAMED TAB: [new name]" on its own line
- Keep the new name concise and descriptive (under 20 characters if possible)

Current note content:\n\n${noteContent || '(empty)'}`;
  };

  // Add chat summary if it exists
  if (notepadAiChatSummary) {
    systemPrompt += `\n\nPrevious conversation summary: ${notepadAiChatSummary}`;
  }

  // Build messages array with chat history
  const messages = [
    { role: 'system', content: systemPrompt }
  ];

  // Add recent chat history (last 5 messages for context)
  const recentHistory = notepadAiChatHistory.slice(-5);
  messages.push(...recentHistory);

  // Add current message
  messages.push({ role: 'user', content: message });

  try {
    const data = await callNvidiaChat(modelName, messages, { temperature: 0.7, max_tokens: 2048 });
    const aiResponse = data.choices[0].message.content;

    // Add AI response to chat
    addNotepadAiMessage(aiResponse, 'ai');

    // Check if AI wants to rename the tab
    const renameMatch = aiResponse.match(/RENAMED TAB:\s*(.+)/i);
    if (renameMatch) {
      const newName = renameMatch[1].trim();
      if (newName && currentTab) {
        currentTab.name = newName;
        saveNotepadTabs();
        renderNotepadTabs();
        addNotepadAiMessage(`I've renamed the tab to "${newName}".`, 'ai');
      }
    }

    // Check if AI wants to update the notes
    const hasCodeBlock = /```[\s\S]*?```/.test(aiResponse);
    const hasUpdateKeywords = aiResponse.toLowerCase().includes('updated note') ||
                             aiResponse.toLowerCase().includes('here\'s the updated') ||
                             aiResponse.toLowerCase().includes('new content') ||
                             aiResponse.toLowerCase().includes('i\'ve updated') ||
                             aiResponse.toLowerCase().includes('here is the updated');

    if (hasCodeBlock || hasUpdateKeywords) {
      // Extract the updated note content — use code-safe path for code mode
      const isCodeMode = selectedModel === 'code';
      const updatedNote = isCodeMode
        ? extractUpdatedCode(aiResponse)
        : extractUpdatedNote(aiResponse);
      if (updatedNote && updatedNote !== noteContent) {
        notepadTextarea.innerHTML = updatedNote;
        // Restore focus and place cursor at end so the user can keep editing
        notepadTextarea.focus();
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(notepadTextarea);
        range.collapse(false); // collapse to end
        sel.removeAllRanges();
        sel.addRange(range);
        const activeTab = notepadTabsData.find(t => t.id == currentTabId);
        if (activeTab) {
          activeTab.content = updatedNote;
          saveNotepadTabs();
        }
        addNotepadAiMessage('I\'ve updated your notes with the changes.', 'ai');
      }
    }
  } catch (error) {
    console.error('AI error:', error);
    addNotepadAiMessage(`Sorry, I encountered an error: ${error.message}. Please check your Nvidia API key and try again.`, 'ai');
    notepadAiStatusDot.classList.add('error');
    notepadAiStatusText.textContent = 'Error';
  } finally {
    setAiStatusIdle();
  }
}

function setAiStatusIdle() {
  notepadAiStatusDot.classList.remove('working', 'error');
  notepadAiStatusText.textContent = 'Idle';
  notepadAiSendBtn.disabled = false;
}

async function callNvidiaChat(modelName, messages, options = {}) {
  if (!nvidiaApiKey) {
    throw new Error('Please add your Nvidia API key in Settings to use the AI assistant.');
  }

  // Proxied through the main process to avoid renderer CORS restrictions.
  return window.electronAPI.nvidiaChat({
    apiKey: nvidiaApiKey,
    model: modelName,
    messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.max_tokens ?? 2048
  });
}

function addNotepadAiMessage(text, type) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `notepad-ai-message ${type}-message`;

  const label = document.createElement('span');
  label.className = 'notepad-ai-label';
  label.textContent = type === 'user' ? 'You' : 'AI';

  const textP = document.createElement('p');
  textP.className = 'notepad-ai-text';
  // Strip markdown formatting from AI responses
  const cleanText = type === 'ai' ? stripMarkdown(text) : text;
  textP.textContent = cleanText;

  messageDiv.appendChild(label);
  messageDiv.appendChild(textP);

  notepadAiChat.appendChild(messageDiv);
  notepadAiChat.scrollTop = notepadAiChat.scrollHeight;

  // Add to chat history
  notepadAiChatHistory.push({ role: type === 'user' ? 'user' : 'assistant', content: text });

  // Check if we need to compact
  if (notepadAiChatHistory.length > MAX_MESSAGES) {
    compactChatHistory();
  }
}

function stripMarkdown(text) {
  // Remove markdown formatting
  return text
    .replace(/#{1,6}\s/g, '') // Remove headers
    .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold
    .replace(/\*([^*]+)\*/g, '$1') // Remove italic
    .replace(/`([^`]+)`/g, '$1') // Remove inline code
    .replace(/```[\s\S]*?```/g, '') // Remove code blocks
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove links
    .replace(/^- /gm, '') // Remove list bullets
    .replace(/^\d+\. /gm, '') // Remove numbered lists
    .trim();
}

async function compactChatHistory() {
  // Get the oldest COMPACT_COUNT messages
  const messagesToCompact = notepadAiChatHistory.slice(0, COMPACT_COUNT);

  // Create a summary prompt
  const summaryPrompt = `Summarize the following conversation between a user and an AI assistant about editing notes. Keep it concise and focus on the main topics and decisions made:\n\n${messagesToCompact.map(m => `${m.role}: ${m.content}`).join('\n')}`;

  try {
    const data = await callNvidiaChat('meta/llama-3.1-70b-instruct', [
      { role: 'system', content: 'You are a helpful assistant that summarizes conversations concisely.' },
      { role: 'user', content: summaryPrompt }
    ], { temperature: 0.3, max_tokens: 500 });

    if (data?.choices?.[0]?.message?.content) {
      notepadAiChatSummary = data.choices[0].message.content;

      // Remove the compacted messages from history
      notepadAiChatHistory = notepadAiChatHistory.slice(COMPACT_COUNT);

      // Add a system message indicating compaction
      const summaryDiv = document.createElement('div');
      summaryDiv.className = 'notepad-ai-message ai-message';
      summaryDiv.style.fontStyle = 'italic';
      summaryDiv.style.fontSize = '12px';
      summaryDiv.style.color = 'var(--text-dim)';
      summaryDiv.textContent = 'Chat Compacted';
      notepadAiChat.insertBefore(summaryDiv, notepadAiChat.firstChild);
    }
  } catch (error) {
    console.error('Failed to compact chat history:', error);
    // If compaction fails, just remove the old messages without a summary
    notepadAiChatHistory = notepadAiChatHistory.slice(COMPACT_COUNT);
  }
}

function extractUpdatedNote(aiResponse) {
  // Look for content between triple backticks with UPDATED NOTE marker
  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeBlocks = aiResponse.match(codeBlockRegex);

  if (codeBlocks && codeBlocks.length > 0) {
    // Extract content from the first code block
    let content = codeBlocks[0].replace(/```/g, '').trim();
    // Remove language identifier if present (e.g., ```text)
    const lines = content.split('\n');
    if (lines.length > 0 && /^[a-z]+$/i.test(lines[0])) {
      content = lines.slice(1).join('\n').trim();
    }
    // Convert markdown to HTML bold formatting
    return convertMarkdownToHtml(content);
  }

  // Fallback: look for UPDATED NOTE marker
  const lines = aiResponse.split('\n');
  let inNoteContent = false;
  let noteContent = [];

  for (const line of lines) {
    if (line.toLowerCase().includes('updated note:') || line.toLowerCase().includes('new content:') || line.toLowerCase().includes('---')) {
      inNoteContent = true;
      continue;
    }
    if (inNoteContent && (line.toLowerCase().includes('---') || line.trim() === '')) {
      break;
    }
    if (inNoteContent) {
      noteContent.push(line);
    }
  }

  if (noteContent.length > 0) {
    // Convert markdown to HTML bold formatting
    return convertMarkdownToHtml(noteContent.join('\n').trim());
  }

  // If no clear markers, return null (don't auto-update)
  return null;
}

// Code-safe extraction: preserves indentation, spaces, and comment lines exactly
function extractUpdatedCode(aiResponse) {
  const codeBlockRegex = /```(?:[a-zA-Z0-9]*)?(\n[\s\S]*?)```/;
  const match = aiResponse.match(codeBlockRegex);

  let rawCode = null;
  if (match) {
    rawCode = match[1];
  } else {
    // Fallback: everything after UPDATED NOTE:
    const marker = aiResponse.match(/UPDATED NOTE:\s*\n([\s\S]+)/i);
    if (marker) rawCode = marker[1];
  }

  if (!rawCode) return null;

  // Trim only trailing blank lines, preserve all internal whitespace
  rawCode = rawCode.replace(/\n+$/, '');

  // Convert to HTML preserving indentation:
  // - tabs → 4 non-breaking spaces
  // - leading spaces → non-breaking spaces (so contenteditable keeps them)
  // - newlines → <br>
  const lines = rawCode.split('\n');
  const htmlLines = lines.map(line => {
    // Escape HTML special chars first
    let escaped = line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    // Preserve leading whitespace: replace each leading tab or space
    escaped = escaped.replace(/^(\t| )+/, (match) =>
      match.replace(/\t/g, '\u00a0\u00a0\u00a0\u00a0').replace(/ /g, '\u00a0')
    );
    return escaped;
  });

  return htmlLines.join('<br>');
}

function convertMarkdownToHtml(text) {
  // Convert markdown to HTML bold formatting
  let html = text;

  // Handle headers (# at start of line) - make whole line bold
  html = html.replace(/^#+\s+(.*)$/gm, '<strong>$1</strong>');

  // Handle bold (**text**) - multiline support
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Handle italic (*text*) - multiline support
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Convert newlines to <br> for contenteditable
  html = html.replace(/\n/g, '<br>');

  return html;
}

function htmlToPlainText(html) {
  // Convert HTML back to plain text for AI processing
  let text = html;

  // Convert <br> to newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Convert <strong> to **
  text = text.replace(/<strong>(.*?)<\/strong>/gi, '**$1**');

  // Convert <em> to *
  text = text.replace(/<em>(.*?)<\/em>/gi, '*$1*');

  // Remove any other HTML tags
  text = text.replace(/<[^>]+>/g, '');

  return text;
}
