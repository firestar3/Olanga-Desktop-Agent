// Launch targets are application-owned data. User app names never become paths
// or command-line arguments; they only select one of these adapters.
const APP_CATALOG = [
  { id: 'spotify', name: 'Spotify', aliases: ['spotify'], processes: ['Spotify'], appPaths: ['Spotify.exe'], paths: [{ root: 'AppData', path: 'Spotify/Spotify.exe' }], packages: ['SpotifyAB.SpotifyMusic', 'Spotify.SpotifyMusic'] },
  { id: 'discord', name: 'Discord', aliases: ['discord'], processes: ['Discord'], appPaths: ['Discord.exe'], paths: [{ root: 'LocalAppData', path: 'Discord/Update.exe', args: ['--processStart', 'Discord.exe'] }], processRoots: [{ root: 'LocalAppData', path: 'Discord' }] },
  { id: 'chrome', name: 'Google Chrome', aliases: ['chrome', 'google chrome'], processes: ['chrome'], appPaths: ['chrome.exe'], paths: ['ProgramFiles', 'ProgramFilesX86', 'LocalAppData'].map(root => ({ root, path: 'Google/Chrome/Application/chrome.exe' })) },
  { id: 'edge', name: 'Microsoft Edge', aliases: ['edge', 'microsoft edge'], processes: ['msedge'], appPaths: ['msedge.exe'], paths: ['ProgramFilesX86', 'ProgramFiles', 'LocalAppData'].map(root => ({ root, path: 'Microsoft/Edge/Application/msedge.exe' })) },
  { id: 'firefox', name: 'Firefox', aliases: ['firefox', 'mozilla firefox'], processes: ['firefox'], appPaths: ['firefox.exe'], paths: ['ProgramFiles', 'ProgramFilesX86'].map(root => ({ root, path: 'Mozilla Firefox/firefox.exe' })) },
  { id: 'notepad', name: 'Notepad', aliases: ['notepad'], processes: ['Notepad'], paths: [{ root: 'System', path: 'notepad.exe' }], packages: ['Microsoft.WindowsNotepad'] },
  { id: 'calculator', name: 'Calculator', aliases: ['calculator', 'calc'], processes: ['CalculatorApp', 'Calculator', 'calc'], paths: [{ root: 'System', path: 'calc.exe' }], packages: ['Microsoft.WindowsCalculator'] },
  ...[
    ['word', 'Microsoft Word', ['word', 'microsoft word'], 'WINWORD'],
    ['excel', 'Microsoft Excel', ['excel', 'microsoft excel'], 'EXCEL'],
    ['powerpoint', 'Microsoft PowerPoint', ['powerpoint', 'microsoft powerpoint'], 'POWERPNT'],
    ['outlook', 'Microsoft Outlook', ['outlook', 'microsoft outlook'], 'OUTLOOK'],
  ].map(([id, name, aliases, executable]) => ({ id, name, aliases, processes: id === 'outlook' ? [executable, 'olk'] : [executable], appPaths: [executable + '.EXE'], paths: ['ProgramFiles', 'ProgramFilesX86'].flatMap(root => ['root/Office16', 'Office16'].map(folder => ({ root, path: `Microsoft Office/${folder}/${executable}.EXE` }))), ...(id === 'outlook' ? { packages: ['Microsoft.OutlookForWindows'] } : {}) })),
  { id: 'teams', name: 'Microsoft Teams', aliases: ['teams', 'microsoft teams'], processes: ['ms-teams', 'Teams'], paths: [{ root: 'LocalAppData', path: 'Microsoft/Teams/current/Teams.exe' }], packages: ['MSTeams', 'MicrosoftTeams'] },
  { id: 'slack', name: 'Slack', aliases: ['slack'], processes: ['slack'], appPaths: ['slack.exe'], paths: [{ root: 'LocalAppData', path: 'slack/slack.exe' }, { root: 'ProgramFiles', path: 'Slack/slack.exe' }], packages: ['91750D7E.Slack'] },
  { id: 'vscode', name: 'Visual Studio Code', aliases: ['vs code', 'visual studio code', 'code'], processes: ['Code'], appPaths: ['Code.exe'], paths: [{ root: 'LocalAppData', path: 'Programs/Microsoft VS Code/Code.exe' }, { root: 'ProgramFiles', path: 'Microsoft VS Code/Code.exe' }] },
  { id: 'explorer', name: 'File Explorer', aliases: ['file explorer', 'windows explorer', 'explorer'], processes: ['explorer'], paths: [{ root: 'Windows', path: 'explorer.exe' }], windowClasses: ['CabinetWClass', 'ExploreWClass'] },
];

for (const app of APP_CATALOG) Object.freeze(app);
Object.freeze(APP_CATALOG);

function normalizeAppName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Please specify an app name of at most 120 characters.');
  return value.trim().replace(/\s+/g, ' ');
}

function findApp(value, catalog = APP_CATALOG) {
  const normalized = normalizeAppName(value).toLocaleLowerCase('en-US');
  return catalog.find(app => app.id === normalized || app.aliases.some(alias => alias.toLocaleLowerCase('en-US') === normalized)) || null;
}

function safeSearchName(value) {
  const name = normalizeAppName(value);
  // Search accepts names, never URLs, paths, switches, or command expressions.
  if (!/^[\p{L}\p{N} ._()+'#-]+$/u.test(name) || /(?:^|\s)-|\.exe\s|^(?:powershell|pwsh|cmd|wscript|cscript|mshta|rundll32|regsvr32|msiexec)\s/i.test(name)) throw new Error('Please use an app name without paths, arguments, or commands.');
  return name;
}

module.exports = { APP_CATALOG, normalizeAppName, findApp, safeSearchName };
