/* ============================================
   OLANGA — TERMINAL (PowerShell sessions via main process)
   ============================================ */

const terminalInput = document.getElementById('terminalInput');
const terminalOutput = document.getElementById('terminalOutput');
const terminalClearBtn = document.getElementById('terminalClearBtn');
const terminalPrompt = document.getElementById('terminalPrompt');
const terminalTabsContainer = document.getElementById('terminalTabs');
const terminalTabAddBtn = document.getElementById('terminalTabAddBtn');

const terminalStorageKey = 'olangaTerminalTabs';
const terminalStartupHtml = `Windows PowerShell<br>Copyright (C) Microsoft Corporation. All rights reserved.<br><br>Try the new cross-platform PowerShell https://aka.ms/pscore6<br>`;

let terminalTabsData = [];
let currentTerminalTabId = 0;
let terminalDefaultCwd = 'C:\\';
const terminalSessionPromises = new WeakMap();
const closingTerminalTabs = new Set();
let terminalSaveWarningShown = false;

function isLiveTerminalTab(tab) {
  return terminalTabsData.includes(tab) && !closingTerminalTabs.has(tab);
}

function createTerminalHeaderEntry() {
  return {
    type: 'header',
    html: terminalStartupHtml
  };
}

function getNextTerminalTabId() {
  return terminalTabsData.length > 0 ? Math.max(...terminalTabsData.map(tab => Number(tab.id))) + 1 : 0;
}

function createTerminalTab(name, cwd) {
  return {
    id: getNextTerminalTabId(),
    name,
    cwd: cwd || terminalDefaultCwd,
    entries: [createTerminalHeaderEntry()]
  };
}

function normalizeTerminalTab(tab) {
  tab.id = Number(tab.id);
  if (!tab.entries || !Array.isArray(tab.entries)) {
    tab.entries = [createTerminalHeaderEntry()];
  }
  tab.entries = tab.entries.filter(entry => entry && typeof entry === 'object');
  if (typeof tab.cwd !== 'string' || !tab.cwd) {
    tab.cwd = terminalDefaultCwd;
  }
  if (typeof tab.name !== 'string' || !tab.name) {
    tab.name = `Terminal ${tab.id + 1}`;
  }
  return tab;
}

function saveTerminalTabs() {
  try {
    localStorage.setItem(terminalStorageKey, JSON.stringify(terminalTabsData));
    terminalSaveWarningShown = false;
    return true;
  } catch (error) {
    if (!terminalSaveWarningShown) alert('Terminal history could not be saved. Copy any output you need before closing Olanga.');
    terminalSaveWarningShown = true;
    return false;
  }
}

function getActiveTerminalTab() {
  return terminalTabsData.find(tab => tab.id === currentTerminalTabId) || terminalTabsData[0];
}

function updateTerminalPromptText() {
  const activeTab = getActiveTerminalTab();
  if (terminalPrompt && activeTab) {
    terminalPrompt.textContent = `PS ${activeTab.cwd}>`;
  }
}

function scrollTerminalToBottom() {
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function renderTerminalEntry(entry) {
  const entryDiv = document.createElement('div');
  entryDiv.className = 'terminal-entry';
  if (entry.type === 'header') {
    entryDiv.classList.add('terminal-startup-header');
    // Stored history is data; only the built-in header is trusted markup.
    entryDiv.innerHTML = terminalStartupHtml;
  } else if (entry.type === 'command') {
    entryDiv.classList.add('terminal-command-line');
    entryDiv.innerHTML = `<span class="terminal-prompt">${escapeHTML(entry.prompt || '')}</span> <span class="terminal-command-text"></span>`;
    entryDiv.querySelector('.terminal-command-text').textContent = entry.text || '';
  } else if (entry.type === 'status') {
    entryDiv.classList.add('terminal-status-line');
    entryDiv.textContent = entry.text || '';
  } else if (entry.type === 'output') {
    entryDiv.classList.add('terminal-output-line');
    entryDiv.textContent = entry.text || '';
  } else if (entry.type === 'error') {
    entryDiv.classList.add('terminal-error-line');
    entryDiv.textContent = entry.text || '';
  } else {
    entryDiv.textContent = entry.text || '';
  }
  terminalOutput.appendChild(entryDiv);
}

function renderTerminalOutput() {
  const activeTab = getActiveTerminalTab();
  terminalOutput.innerHTML = '';
  if (!activeTab) {
    return;
  }
  activeTab.entries.forEach(renderTerminalEntry);
  updateTerminalPromptText();
  scrollTerminalToBottom();
}

function renderTerminalTabs() {
  terminalTabsContainer.innerHTML = '';

  terminalTabsData.forEach(tab => {
    const tabBtn = document.createElement('button');
    tabBtn.className = `terminal-tab ${tab.id === currentTerminalTabId ? 'active' : ''}`;
    tabBtn.type = 'button';

    const label = document.createElement('span');
    label.textContent = tab.name;
    tabBtn.appendChild(label);

    const closeBtn = document.createElement('span');
    closeBtn.className = 'terminal-tab-close';
    closeBtn.title = 'Close tab';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTerminalTab(tab.id).catch((error) => {
        console.warn('[Olanga] Failed to close terminal tab:', error.message);
      });
    });
    tabBtn.appendChild(closeBtn);

    tabBtn.addEventListener('click', () => {
      switchTerminalTab(tab.id);
    });

    tabBtn.addEventListener('dblclick', () => {
      const newName = prompt('Enter terminal tab name:', tab.name);
      if (newName && newName.trim()) {
        tab.name = newName.trim();
        saveTerminalTabs();
        renderTerminalTabs();
      }
    });

    terminalTabsContainer.appendChild(tabBtn);
  });
}

function switchTerminalTab(tabId) {
  const tabExists = terminalTabsData.some(tab => tab.id === tabId);
  if (!tabExists) {
    return;
  }
  currentTerminalTabId = tabId;
  renderTerminalTabs();
  renderTerminalOutput();
}

async function ensureTerminalSession(tab) {
  if (!window.electronAPI || !window.electronAPI.createTerminalSession || !tab) {
    throw new Error('Terminal sessions are unavailable. Restart Olanga and try again.');
  }
  if (!isLiveTerminalTab(tab)) return false;
  if (terminalSessionPromises.has(tab)) return terminalSessionPromises.get(tab);
  const pending = (async () => {
    // Match the previous startup behavior: let Windows choose an existing home
    // directory instead of passing a saved path that may no longer exist.
    const response = await window.electronAPI.createTerminalSession({ sessionId: tab.id });
    if (!isLiveTerminalTab(tab)) return false;
    if (response && response.cwd) {
      tab.cwd = response.cwd;
      if (tab.id === currentTerminalTabId) updateTerminalPromptText();
    }
    return true;
  })();
  terminalSessionPromises.set(tab, pending);
  try { return await pending; }
  catch (error) { terminalSessionPromises.delete(tab); throw error; }
}

async function addTerminalTab() {
  const newTab = createTerminalTab(`Terminal ${terminalTabsData.length + 1}`, terminalDefaultCwd);
  terminalTabsData.push(newTab);
  currentTerminalTabId = newTab.id;
  await ensureTerminalSession(newTab);
  saveTerminalTabs();
  renderTerminalTabs();
  renderTerminalOutput();
}

async function closeTerminalTab(tabId) {
  const closingTab = terminalTabsData.find(tab => tab.id === tabId);
  if (!closingTab || closingTerminalTabs.has(closingTab)) return;
  if (terminalTabsData.length - closingTerminalTabs.size <= 1) {
    alert('You need at least one terminal tab open.');
    return;
  }

  closingTerminalTabs.add(closingTab);
  if (window.electronAPI && window.electronAPI.closeTerminalSession) {
    try {
      await window.electronAPI.closeTerminalSession({ sessionId: closingTab.id });
    } catch (error) {
      console.warn('[Olanga] Failed to close terminal session:', error.message);
    }
  }

  const tabIndex = terminalTabsData.indexOf(closingTab);
  closingTerminalTabs.delete(closingTab);
  terminalSessionPromises.delete(closingTab);
  if (tabIndex < 0) return;
  terminalTabsData.splice(tabIndex, 1);
  if (currentTerminalTabId === tabId) {
    const nextTab = terminalTabsData[Math.max(0, tabIndex - 1)];
    currentTerminalTabId = nextTab.id;
  }
  saveTerminalTabs();
  renderTerminalTabs();
  renderTerminalOutput();
}

function appendTerminalEntry(tabId, entry) {
  const tab = terminalTabsData.find(item => item.id === tabId);
  if (!tab) {
    return;
  }

  tab.entries.push(entry);
  if (tab.id === currentTerminalTabId) {
    renderTerminalEntry(entry);
    scrollTerminalToBottom();
  }
  saveTerminalTabs();
}

function resetTerminalTab(tabId) {
  const tab = terminalTabsData.find(item => item.id === tabId);
  if (!tab) {
    return;
  }

  tab.entries = [createTerminalHeaderEntry()];
  saveTerminalTabs();
  if (tab.id === currentTerminalTabId) {
    renderTerminalOutput();
  }
}

function ensureTerminalTabsLoaded() {
  try {
    const saved = JSON.parse(localStorage.getItem(terminalStorageKey) || '[]');
    terminalTabsData = Array.isArray(saved) ? saved.filter(tab => tab && typeof tab === 'object')
      .map((tab, index) => normalizeTerminalTab({ ...tab, id: index })) : [];
  } catch (error) {
    console.warn('[Olanga] Could not read saved terminal tabs:', error.message);
    terminalTabsData = [];
  }

  if (terminalTabsData.length === 0) {
    terminalTabsData = [createTerminalTab('Terminal 1', 'C:\\')];
  }

  const exists = terminalTabsData.some(tab => tab.id === currentTerminalTabId);
  if (!exists) {
    currentTerminalTabId = terminalTabsData[0].id;
  }
}

async function initTerminalTabs() {
  ensureTerminalTabsLoaded();
  // Saved tabs are UI state. The main process creates a shell on the first
  // explicit command; startup must not launch an optional, hidden terminal.
  terminalDefaultCwd = getActiveTerminalTab()?.cwd || terminalDefaultCwd;
  renderTerminalTabs();
  renderTerminalOutput();
}

function getTerminalPromptText() {
  const activeTab = getActiveTerminalTab();
  return `PS ${(activeTab && activeTab.cwd) || 'C:\\'}>`;
}

// Terminal input handling
terminalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const command = terminalInput.value.trim();
    if (command) {
      executeTerminalCommand(command);
      terminalInput.value = '';
    }
  }
});

terminalTabAddBtn.addEventListener('click', () => {
  addTerminalTab().catch((error) => {
    console.warn('[Olanga] Failed to add terminal tab:', error.message);
  });
});

// Terminal clear button
terminalClearBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const activeTab = getActiveTerminalTab();
  if (activeTab) {
    resetTerminalTab(activeTab.id);
  }
});

// Execute terminal command
async function executeTerminalCommand(command) {
  const activeTab = getActiveTerminalTab();
  if (!activeTab) {
    return;
  }

  // Handle special commands
  if (command.toLowerCase() === 'clear' || command.toLowerCase() === 'cls') {
    resetTerminalTab(activeTab.id);
    return;
  }

  try {
    if (!await ensureTerminalSession(activeTab) || !isLiveTerminalTab(activeTab)) return;
    appendTerminalEntry(activeTab.id, { type: 'command', text: command, prompt: `PS ${activeTab.cwd}>` });
    appendTerminalEntry(activeTab.id, { type: 'status', text: 'Running...' });
    const response = await window.electronAPI.executeTerminalSessionCommand({ command, sessionId: activeTab.id, cwd: activeTab.cwd });
    if (!isLiveTerminalTab(activeTab)) return;
    const terminalTab = activeTab;
    if (terminalTab && response && response.cwd) {
      terminalTab.cwd = response.cwd;
      if (terminalTab.id === currentTerminalTabId) {
        updateTerminalPromptText();
      }
    }

    appendTerminalEntry(activeTab.id, {
      type: 'output',
      text: (response && response.output) || '(no output)'
    });

    appendTerminalEntry(activeTab.id, {
      type: response && response.success === false ? 'error' : 'status',
      text: response && response.success === false
        ? `Command finished with exit code ${response.exitCode ?? 'unknown'}`
        : 'Command finished.'
    });
  } catch (error) {
    if (!isLiveTerminalTab(activeTab)) return;
    appendTerminalEntry(activeTab.id, {
      type: 'error',
      text: error.message || 'Command execution failed'
    });
  }
}

async function initializeTerminal() {
  await initTerminalTabs();
  renderTerminalTabs();
  renderTerminalOutput();
}

initializeTerminal().catch(error => {
  console.warn('[Olanga] Terminal initialization failed:', error.message);
});
