const path = require('node:path');
const { spawn } = require('node:child_process');
const { isLikedSongs } = require('../shared/fast-intents');

const ACTIONS = new Set(['OPEN', 'LIKED', 'SONG', 'ALBUM', 'PLAYLIST', 'ARTIST', 'LIBRARY', 'RELOAD', 'PLAY', 'PAUSE', 'PLAY_PAUSE', 'NEXT', 'PREV', 'STATUS', 'VOLUME_SET', 'VOLUME_STATUS', 'VOLUME_UP', 'VOLUME_DOWN', 'VOLUME_MUTE']);
function normalizeMediaRequest(payload) {
  if (!payload || typeof payload !== 'object' || !ACTIONS.has(payload.action)) throw new Error('Unsupported media action.');
  const term = typeof payload.term === 'string' ? payload.term.trim() : '';
  if (term.length > 300 || /[\x00-\x1f]/.test(term)) throw new Error('Invalid Spotify search.');
  if (['SONG', 'ALBUM', 'PLAYLIST', 'ARTIST', 'LIBRARY'].includes(payload.action) && !term) throw new Error('Name the music you want to play.');
  const action = ['PLAYLIST', 'LIBRARY'].includes(payload.action) && isLikedSongs(term) ? 'LIKED' : payload.action;
  const request = { action, term, spotifyOnly: payload.spotifyOnly === true || ['OPEN', 'LIKED', 'SONG', 'ALBUM', 'PLAYLIST', 'ARTIST', 'LIBRARY', 'RELOAD'].includes(action) };
  if (action === 'VOLUME_SET') {
    if (typeof payload.level !== 'number' || !Number.isFinite(payload.level) || payload.level < 0 || payload.level > 100) throw new Error('Volume must be a number between 0 and 100.');
    request.level = payload.level;
  }
  return request;
}

function createMediaController({ spawnProcess = spawn, platform = process.platform, timeoutMs = 22000 } = {}) {
  let child = null;
  let pending = null;
  let sequence = 0;
  let buffer = '';
  function stop(message = 'Media request cancelled.') {
    const previous = child;
    child = null;
    buffer = '';
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      pending = null;
    }
    if (previous) previous.kill();
  }
  function connect() {
    if (child) return;
    const helper = path.join(__dirname, 'media-helper.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const worker = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child = worker;
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', chunk => {
      if (child !== worker) return;
      buffer += chunk;
      if (buffer.length > 64000) return stop('Invalid media helper response.');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let result;
        try { result = JSON.parse(line); } catch { return stop('The Windows media helper could not initialize.'); }
        if (!pending || result.id !== pending.id) return stop('Unexpected media helper response.');
        const current = pending;
        pending = null;
        clearTimeout(current.timer);
        const receipt = result.result;
        if (!receipt || typeof receipt !== 'object' || typeof receipt.ok !== 'boolean' || typeof receipt.message !== 'string') {
          current.reject(new Error('Invalid media helper result.'));
        } else if (receipt.ok && receipt.verified !== true) {
          current.resolve({ ...receipt, ok: false, verified: false, message: 'Windows did not verify that media change. Please check the player or volume.' });
        } else {
          current.resolve(receipt);
        }
      }
    });
    worker.stderr.resume();
    const disconnected = () => { if (child === worker) stop('Windows media control disconnected.'); };
    worker.on('error', disconnected);
    worker.on('exit', disconnected);
    worker.stdin.on('error', disconnected);
  }
  return {
    async execute(payload) {
      const request = normalizeMediaRequest(payload);
      if (platform !== 'win32') return { ok: false, message: 'Media control currently requires Windows.' };
      if (pending) throw new Error('A media request is still running.');
      connect();
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => stop('Windows media control took too long to respond. The requested change could not be verified.'), timeoutMs);
        pending = { id, timer, resolve, reject };
        child.stdin.write(JSON.stringify({ ...request, id }) + '\n');
      });
    },
    cancel: () => { if (pending) stop(); },
    dispose: stop
  };
}

module.exports = { createMediaController, normalizeMediaRequest };
