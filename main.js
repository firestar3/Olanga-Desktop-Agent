const { app, BrowserWindow, ipcMain, shell, Tray, Menu, clipboard, protocol, net, safeStorage, screen } = require('electron');
const fs = require('fs');
const http2 = require('http2');
const zlib = require('zlib');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const os = require('os');

// Keep userData at %APPDATA%/olanga-control so secure-store.json stays stable
// across npm start / electron . / diagnostic scripts.
app.setName('olanga-control');

const statusLight = require('./shared/status-light.js');

let mainWindow;
let tray = null;
let statusIndicatorWindow = null;
let currentStatusState = 'idle';
// off = never glow; active = glow only when listening/thinking/speaking; all = include idle purple
let statusLightMode = statusLight.DEFAULT_MODE;
let statusLightSize = statusLight.DEFAULT_SIZE;

function normalizeStatusLightMode(mode) {
  return statusLight.normalizeMode(mode);
}

function normalizeStatusLightSize(size) {
  return statusLight.normalizeSize(size);
}

function getStatusIndicatorSize() {
  return statusLight.sizeToPixels(statusLightSize);
}

function resolveStatusVisualState(state, mode = statusLightMode) {
  return statusLight.resolveVisualState(state, mode);
}

function positionStatusIndicator() {
  if (!statusIndicatorWindow || statusIndicatorWindow.isDestroyed()) return;
  try {
    const display = screen.getPrimaryDisplay();
    const { x, y, width, height } = display.workArea;
    const size = getStatusIndicatorSize();
    // Flush to the bottom-right so the arc wraps the real screen corner.
    statusIndicatorWindow.setBounds({
      x: Math.round(x + width - size),
      y: Math.round(y + height - size),
      width: size,
      height: size
    });
  } catch (error) {
    console.warn('[Main] Failed to position status indicator:', error.message);
  }
}

function createStatusIndicatorWindow() {
  if (statusIndicatorWindow && !statusIndicatorWindow.isDestroyed()) {
    positionStatusIndicator();
    return statusIndicatorWindow;
  }

  statusIndicatorWindow = new BrowserWindow({
    width: getStatusIndicatorSize(),
    height: getStatusIndicatorSize(),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'status-indicator-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  statusIndicatorWindow.setMenuBarVisibility(false);
  statusIndicatorWindow.setAlwaysOnTop(true, 'screen-saver');
  // Click-through so the glow never blocks the desktop or other apps.
  statusIndicatorWindow.setIgnoreMouseEvents(true, { forward: true });
  positionStatusIndicator();

  statusIndicatorWindow.once('ready-to-show', () => {
    if (!statusIndicatorWindow || statusIndicatorWindow.isDestroyed()) return;
    statusIndicatorWindow.showInactive();
    sendStatusIndicatorState(currentStatusState);
  });

  statusIndicatorWindow.loadFile('status-indicator.html');

  statusIndicatorWindow.on('closed', () => {
    statusIndicatorWindow = null;
  });

  return statusIndicatorWindow;
}

function sendStatusIndicatorState(state) {
  const next = statusLight.normalizeState(state);
  currentStatusState = next;
  if (!statusIndicatorWindow || statusIndicatorWindow.isDestroyed()) return;
  try {
    statusIndicatorWindow.webContents.send(
      'status-indicator-state',
      resolveStatusVisualState(next, statusLightMode)
    );
  } catch (error) {
    console.warn('[Main] Failed to update status indicator:', error.message);
  }
}

function setStatusLightMode(mode) {
  statusLightMode = normalizeStatusLightMode(mode);
  sendStatusIndicatorState(currentStatusState);
}

function setStatusLightSize(size) {
  statusLightSize = normalizeStatusLightSize(size);
  positionStatusIndicator();
}

function destroyStatusIndicatorWindow() {
  if (!statusIndicatorWindow || statusIndicatorWindow.isDestroyed()) {
    statusIndicatorWindow = null;
    return;
  }
  try {
    statusIndicatorWindow.destroy();
  } catch (_) {}
  statusIndicatorWindow = null;
}

// Transparent + fullscreen at construction is unreliable on Windows and can
// leave a tiny non-expandable window. Size to the display instead.
function ensureWindowExpanded() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const display = screen.getDisplayMatching(mainWindow.getBounds()) || screen.getPrimaryDisplay();
    const bounds = display.bounds;
    if (mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
    }
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(400, 550);
    mainWindow.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: Math.max(bounds.width, 800),
      height: Math.max(bounds.height, 600)
    });
    if (!mainWindow.isMaximized()) {
      mainWindow.maximize();
    }
  } catch (error) {
    console.warn('[Main] Failed to expand window:', error.message);
  }
}

const isDev = process.argv.includes('--dev');
// Set when Windows starts Olanga at login, so it boots straight to the tray.
const startsHidden = process.argv.includes('--hidden');

const APP_ID = 'com.aarav.olanga';
// Without this, Windows groups the taskbar entry and notifications under the
// generic Electron identity instead of Olanga.
app.setAppUserModelId(APP_ID);

// Only an installed build can register itself: during `npm start` the
// executable is electron.exe, which Windows could not relaunch on its own.
function getOpenAtLogin() {
  if (!app.isPackaged) return { supported: false, enabled: false };
  try {
    return {
      supported: true,
      enabled: !!app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin
    };
  } catch (error) {
    console.warn('[Main] Failed to read login item settings:', error.message);
    return { supported: true, enabled: false };
  }
}

function setOpenAtLogin(enabled) {
  if (!app.isPackaged) return { supported: false, enabled: false };
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      openAsHidden: !!enabled,
      args: ['--hidden']
    });
  } catch (error) {
    console.warn('[Main] Failed to write login item settings:', error.message);
  }
  return getOpenAtLogin();
}

// Serve local read-only assets (the Vosk model tarball) over a CORS-enabled
// custom scheme so the renderer can fetch() them while webSecurity stays on.
const ASSET_SCHEME = 'olanga-asset';

protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
]);

// Directories the asset scheme may serve from, most specific first. A packaged
// build keeps the Vosk model beside the asar (see extraResources in
// package.json) because Chromium's file:// handler cannot read inside an asar
// archive, which is what net.fetch below ends up using.
function getAssetRoots() {
  const roots = [__dirname];
  if (app.isPackaged && process.resourcesPath) {
    roots.unshift(process.resourcesPath, path.join(process.resourcesPath, 'app.asar.unpacked'));
  }
  return roots.map((root) => path.normalize(root + path.sep));
}

function resolveAssetPath(requestPath) {
  for (const root of getAssetRoots()) {
    const resolved = path.normalize(path.join(root, requestPath));
    // Never serve files outside the root being checked.
    if (!resolved.startsWith(root)) continue;
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

function registerAssetProtocol() {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const url = new URL(request.url);
    // pathname is absolute-looking ("/vosk-...."); strip the leading slash so
    // path.join keeps the file under the asset root on Windows.
    const requestPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const resolved = resolveAssetPath(requestPath);

    if (!resolved) {
      console.warn(`[Main] Asset not found for ${ASSET_SCHEME}:// request:`, requestPath);
      return new Response('Not found', { status: 404 });
    }

    const fileResponse = await net.fetch(pathToFileURL(resolved).toString());
    // The app page runs on file:// (origin "null"), so CORS headers are
    // required for fetch() against this scheme.
    const headers = new Headers(fileResponse.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(fileResponse.body, {
      status: fileResponse.status,
      headers
    });
  });
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.max(width, 1024),
    height: Math.max(height, 700),
    x: display.workArea.x,
    y: display.workArea.y,
    minWidth: 400,
    minHeight: 550,
    frame: false,
    transparent: true,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false // CRITICAL: keeps VAD and audio processing running at full speed in the background
    },
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    hasShadow: true
  });

  mainWindow.once('ready-to-show', () => {
    // A login-item launch stays in the tray; the renderer still boots so the
    // wake word is armed without ever showing the window.
    if (startsHidden) return;
    ensureWindowExpanded();
    mainWindow.show();
    // Re-assert after show — Windows sometimes applies a tiny default size on first paint.
    setTimeout(() => ensureWindowExpanded(), 50);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    ensureWindowExpanded();
  });

  mainWindow.loadFile('index.html');
  if (isDev) {
    // Docked rather than detached: a detached window hides behind the
    // full-screen transparent window and looks like it never opened.
    mainWindow.webContents.openDevTools({ mode: 'bottom' });

    // Mirror renderer logs into the terminal so errors are copyable even when
    // DevTools is not visible. Electron 35+ passes a details object; older
    // versions pass positional arguments.
    mainWindow.webContents.on('console-message', (...args) => {
      const details = args[1] && typeof args[1] === 'object'
        ? args[1]
        : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
      const where = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : '';
      console.log(`[Renderer:${details.level}] ${details.message}${where}`);
    });
  }

  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Prevent app from closing when clicking the X button
  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  ensureWindowExpanded();
  mainWindow.focus();
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  tray = new Tray(iconPath);
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Olanga', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('Olanga Voice Assistant');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      showMainWindow();
    }
  });
}

const GRPC_TTS_AUTHORITY = 'grpc.nvcf.nvidia.com:443';
// Official nvidia-riva-client uses the nvidia.riva.tts package (not nvidia.riva).
const GRPC_TTS_SERVICE = 'nvidia.riva.tts.RivaSpeechSynthesis';
const GRPC_TTS_SYNTHESIZE_PATH = `/${GRPC_TTS_SERVICE}/Synthesize`;
const GRPC_TTS_CONFIG_PATH = `/${GRPC_TTS_SERVICE}/GetRivaSynthesisConfig`;

// Public NVIDIA NVCF function id for the hosted Magpie TTS Multilingual model.
// Works for any account with a valid nvapi key, so no per-account discovery is required.
const MAGPIE_TTS_FUNCTION_ID = '877104f7-e885-42b9-8de8-f6e4c6303969';
// Official Magpie hosted demo default (build.nvidia.com / HF NIM docs).
const DEFAULT_TTS_VOICE_NAME = 'Magpie-Multilingual.EN-US.Sofia';
// Magpie returns raw LINEAR_PCM audio; this rate must match the WAV header built in the renderer.
const TTS_SAMPLE_RATE_HZ = 22050;
const AUDIO_ENCODING_LINEAR_PCM = 1;

function concatUint8Arrays(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function encodeVarint(value) {
  let current = value >>> 0;
  const bytes = [];
  while (current > 127) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Uint8Array.from(bytes);
}

function encodeLengthDelimitedField(fieldNumber, bytes) {
  return concatUint8Arrays([
    encodeVarint((fieldNumber << 3) | 2),
    encodeVarint(bytes.length),
    bytes
  ]);
}

function encodeStringField(fieldNumber, text) {
  return encodeLengthDelimitedField(fieldNumber, Buffer.from(text, 'utf8'));
}

function encodeVarintField(fieldNumber, value) {
  return concatUint8Arrays([
    encodeVarint((fieldNumber << 3) | 0),
    encodeVarint(value)
  ]);
}

function buildGrpcFrame(messageBytes) {
  const payload = Buffer.from(messageBytes);
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function readVarint(bytes, startOffset) {
  let result = 0;
  let shift = 0;
  let offset = startOffset;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, offset };
    }
    shift += 7;
  }
  throw new Error('Unexpected end of protobuf varint');
}

function readDelimited(bytes, startOffset) {
  const lengthInfo = readVarint(bytes, startOffset);
  const endOffset = lengthInfo.offset + lengthInfo.value;
  return {
    value: bytes.slice(lengthInfo.offset, endOffset),
    offset: endOffset
  };
}

function parseGrpcFrames(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const messages = [];
  let offset = 0;

  while (offset + 5 <= bytes.length) {
    const compressed = bytes.readUInt8(offset);
    const length = bytes.readUInt32BE(offset + 1);
    offset += 5;

    if (offset + length > bytes.length) {
      break;
    }

    const frame = bytes.slice(offset, offset + length);
    offset += length;

    if (compressed === 0) {
      messages.push(frame);
    } else {
      // gRPC compression flag is set — try gzip then deflate.
      try {
        messages.push(zlib.gunzipSync(frame));
      } catch {
        try {
          messages.push(zlib.inflateSync(frame));
        } catch (err) {
          throw new Error(`Failed to decompress gRPC frame: ${err.message}`);
        }
      }
    }
  }

  return messages;
}

function parseSynthesisConfigResponse(buffer) {
  const messages = parseGrpcFrames(buffer);
  const responseBytes = messages[0] || Buffer.alloc(0);
  let offset = 0;
  const modelConfig = [];

  while (offset < responseBytes.length) {
    const tagInfo = readVarint(responseBytes, offset);
    offset = tagInfo.offset;
    const fieldNumber = tagInfo.value >>> 3;
    const wireType = tagInfo.value & 7;

    if (fieldNumber === 1 && wireType === 2) {
      const configInfo = readDelimited(responseBytes, offset);
      offset = configInfo.offset;
      const configBytes = configInfo.value;
      let configOffset = 0;
      const config = { model_name: '', parameters: {} };

      while (configOffset < configBytes.length) {
        const configTagInfo = readVarint(configBytes, configOffset);
        configOffset = configTagInfo.offset;
        const configFieldNumber = configTagInfo.value >>> 3;
        const configWireType = configTagInfo.value & 7;

        if (configFieldNumber === 1 && configWireType === 2) {
          const modelInfo = readDelimited(configBytes, configOffset);
          configOffset = modelInfo.offset;
          config.model_name = Buffer.from(modelInfo.value).toString('utf8');
        } else if (configFieldNumber === 2 && configWireType === 2) {
          const entryInfo = readDelimited(configBytes, configOffset);
          configOffset = entryInfo.offset;
          const entryBytes = entryInfo.value;
          let entryOffset = 0;
          const entry = { key: '', value: '' };

          while (entryOffset < entryBytes.length) {
            const entryTagInfo = readVarint(entryBytes, entryOffset);
            entryOffset = entryTagInfo.offset;
            const entryFieldNumber = entryTagInfo.value >>> 3;
            const entryWireType = entryTagInfo.value & 7;

            if (entryWireType !== 2) {
              if (entryWireType === 0) {
                entryOffset = readVarint(entryBytes, entryOffset).offset;
              } else {
                throw new Error(`Unsupported config entry wire type: ${entryWireType}`);
              }
              continue;
            }

            const valueInfo = readDelimited(entryBytes, entryOffset);
            entryOffset = valueInfo.offset;
            const text = Buffer.from(valueInfo.value).toString('utf8');
            if (entryFieldNumber === 1) {
              entry.key = text;
            } else if (entryFieldNumber === 2) {
              entry.value = text;
            }
          }

          if (entry.key) {
            config.parameters[entry.key] = entry.value;
          }
        } else {
          if (configWireType === 0) {
            configOffset = readVarint(configBytes, configOffset).offset;
          } else if (configWireType === 2) {
            configOffset = readDelimited(configBytes, configOffset).offset;
          } else {
            throw new Error(`Unsupported config wire type: ${configWireType}`);
          }
        }
      }

      modelConfig.push(config);
    } else if (wireType === 0) {
      offset = readVarint(responseBytes, offset).offset;
    } else if (wireType === 2) {
      offset = readDelimited(responseBytes, offset).offset;
    } else {
      throw new Error(`Unsupported config response wire type: ${wireType}`);
    }
  }

  return { modelConfig };
}

function parseSynthResponse(buffer) {
  // Magpie/NVCF may return audio across multiple gRPC frames (and multiple
  // field-1 audio chunks within a frame). Concatenate everything.
  const messages = parseGrpcFrames(buffer);
  const audioChunks = [];

  for (const responseBytes of messages) {
    let offset = 0;
    while (offset < responseBytes.length) {
      const tagInfo = readVarint(responseBytes, offset);
      offset = tagInfo.offset;
      const fieldNumber = tagInfo.value >>> 3;
      const wireType = tagInfo.value & 7;

      if (fieldNumber === 1 && wireType === 2) {
        const audioInfo = readDelimited(responseBytes, offset);
        audioChunks.push(Buffer.from(audioInfo.value));
        offset = audioInfo.offset;
        continue;
      }

      if (wireType === 0) {
        offset = readVarint(responseBytes, offset).offset;
      } else if (wireType === 2) {
        offset = readDelimited(responseBytes, offset).offset;
      } else if (wireType === 5) {
        offset += 4; // fixed32
      } else if (wireType === 1) {
        offset += 8; // fixed64
      } else {
        throw new Error(`Unsupported synth response wire type: ${wireType}`);
      }
    }
  }

  if (audioChunks.length === 0) {
    throw new Error('No audio returned from NVIDIA TTS');
  }

  return Buffer.concat(audioChunks);
}

// Builds a Riva SynthesizeSpeechRequest protobuf message.
// Field numbers follow riva/proto/riva_tts.proto:
//   1=text, 2=language_code, 3=encoding, 4=sample_rate_hz, 5=voice_name
function buildSynthesisRequest({ text, voiceName, languageCode, sampleRateHz }) {
  return Buffer.from(concatUint8Arrays([
    encodeStringField(1, text),
    encodeStringField(2, languageCode || 'en-US'),
    encodeVarintField(3, AUDIO_ENCODING_LINEAR_PCM),
    encodeVarintField(4, sampleRateHz || TTS_SAMPLE_RATE_HZ),
    encodeStringField(5, voiceName || DEFAULT_TTS_VOICE_NAME)
  ]));
}

// A fresh TLS handshake per request added a few hundred ms to every spoken
// chunk, so the session is kept open between calls and dropped once idle.
const TTS_SESSION_IDLE_MS = 5 * 60 * 1000;
let ttsSession = null;
let ttsSessionIdleTimer = null;
let ttsCallsInFlight = 0;

function releaseTtsSession(session) {
  if (ttsSession === session) ttsSession = null;
}

function scheduleTtsSessionClose() {
  if (ttsSessionIdleTimer) clearTimeout(ttsSessionIdleTimer);
  ttsSessionIdleTimer = setTimeout(() => {
    ttsSessionIdleTimer = null;
    if (ttsCallsInFlight > 0 || !ttsSession) return;
    const session = ttsSession;
    ttsSession = null;
    try { session.close(); } catch (_) {}
  }, TTS_SESSION_IDLE_MS);
  if (typeof ttsSessionIdleTimer.unref === 'function') ttsSessionIdleTimer.unref();
}

function getTtsSession() {
  if (ttsSession && !ttsSession.closed && !ttsSession.destroyed) return ttsSession;

  const session = http2.connect(`https://${GRPC_TTS_AUTHORITY}`);
  // Permanent listener so a late failure can never become an unhandled 'error'.
  session.on('error', () => releaseTtsSession(session));
  session.on('close', () => releaseTtsSession(session));
  session.on('goaway', () => releaseTtsSession(session));
  ttsSession = session;
  return session;
}

// NVCF answers with DEADLINE_EXCEEDED when a function has no worker ready, but
// only after stalling for far longer than a reply can wait on.
const GRPC_TTS_DEADLINE_MS = 12000;

function grpcUnaryCall({ pathName, apiKey, functionId, requestBytes, timeoutMs = GRPC_TTS_DEADLINE_MS }) {
  return new Promise((resolve, reject) => {
    const client = getTtsSession();
    const responseChunks = [];
    let responseHeaders = {};
    let responseTrailers = {};
    let settled = false;
    let abortTimer = null;

    const onSessionError = (error) => finish(error);

    const finish = (error, buffer) => {
      if (settled) return;
      settled = true;
      if (abortTimer) clearTimeout(abortTimer);
      client.off('error', onSessionError);
      ttsCallsInFlight = Math.max(0, ttsCallsInFlight - 1);
      // A session that just failed can't be trusted; the next call reconnects.
      if (error) releaseTtsSession(client);
      scheduleTtsSessionClose();
      if (error) {
        reject(error);
      } else {
        resolve(buffer);
      }
    };

    client.on('error', onSessionError);
    ttsCallsInFlight += 1;

    let request;
    try {
      request = client.request({
        ':method': 'POST',
        ':path': pathName,
        ':scheme': 'https',
        // Match official Riva clients: host:port in authority + function-id metadata.
        ':authority': GRPC_TTS_AUTHORITY,
        'content-type': 'application/grpc',
        'te': 'trailers',
        'grpc-accept-encoding': 'identity',
        'user-agent': 'olanga-control/1.0 grpc-node-http2',
        'authorization': `Bearer ${apiKey}`,
        'function-id': functionId,
        // Standard gRPC deadline, in milliseconds.
        'grpc-timeout': `${timeoutMs}m`
      });
    } catch (error) {
      releaseTtsSession(client);
      finish(error);
      return;
    }

    // The server doesn't always honour grpc-timeout, so give up locally too.
    abortTimer = setTimeout(() => {
      finish(new Error(`Magpie did not respond within ${timeoutMs}ms`));
      try { request.close(http2.constants.NGHTTP2_CANCEL); } catch (_) {}
    }, timeoutMs + 500);

    request.on('response', (headers) => {
      responseHeaders = headers;
    });

    request.on('data', (chunk) => {
      responseChunks.push(Buffer.from(chunk));
    });

    request.on('trailers', (trailers) => {
      responseTrailers = trailers;
    });

    request.on('end', () => {
      const grpcStatus = String(responseTrailers['grpc-status'] || responseHeaders['grpc-status'] || '0');
      if (grpcStatus !== '0') {
        const grpcMessage = decodeURIComponent(String(responseTrailers['grpc-message'] || responseHeaders['grpc-message'] || 'gRPC request failed'));
        if (grpcStatus === '5' && /function .*not found for account/i.test(grpcMessage)) {
          finish(new Error(`TTS function id not found for this account (${functionId})`));
          return;
        }
        if (/failed to establish link to worker/i.test(grpcMessage)) {
          finish(new Error('Magpie has no worker available right now (NVIDIA capacity)'));
          return;
        }
        finish(new Error(`gRPC ${grpcStatus}: ${grpcMessage}`));
        return;
      }

      finish(null, Buffer.concat(responseChunks));
    });

    request.on('error', (error) => finish(error));

    request.end(buildGrpcFrame(requestBytes || Buffer.alloc(0)));
  });
}

const NVCF_FUNCTIONS_URL = 'https://api.nvcf.nvidia.com/v2/nvcf/functions';

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function collectFunctionRecords(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data.flatMap(collectFunctionRecords);
  if (typeof data !== 'object') return [];

  const nestedLists = [];
  for (const key of ['functions', 'items', 'data', 'results']) {
    if (Array.isArray(data[key])) nestedLists.push(...data[key]);
  }

  if (nestedLists.length > 0) {
    return nestedLists.flatMap(collectFunctionRecords);
  }

  return [data];
}

function extractFunctionId(record) {
  return (
    record?.functionId ||
    record?.function_id ||
    record?.id ||
    record?.function?.id ||
    record?.deployment?.functionId ||
    record?.deployment?.function_id ||
    null
  );
}

function extractFunctionName(record) {
  return [
    record?.name,
    record?.functionName,
    record?.function_name,
    record?.displayName,
    record?.display_name,
    record?.title,
    record?.modelName,
    record?.model_name
  ].filter(Boolean).join(' ').trim();
}

// Returns every NVCF function id this account is authorized for that looks like a
// TTS model, ordered by preference (Magpie first). Never throws: returns [] on failure.
async function discoverTtsFunctionIds(apiKey) {
  let data;
  try {
    const response = await fetch(`${NVCF_FUNCTIONS_URL}?visibility=authorized,private,public`, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });
    if (!response.ok) return [];
    data = await response.json();
  } catch (error) {
    return [];
  }

  const records = collectFunctionRecords(data);
  const preferredNames = [
    'magpie-tts-multilingual',
    'magpie-multilingual',
    'magpie',
    'chatterbox-multilingual-tts',
    'tts'
  ];

  const ids = [];
  for (const preferredName of preferredNames) {
    for (const record of records) {
      const name = normalizeText(extractFunctionName(record));
      const blob = normalizeText(JSON.stringify(record));
      if (name.includes(preferredName) || blob.includes(preferredName)) {
        const functionId = extractFunctionId(record);
        if (functionId && !ids.includes(functionId)) {
          ids.push(functionId);
        }
      }
    }
  }

  return ids;
}

async function resolveTtsFunctionId(apiKey, functionId) {
  const explicitFunctionId = (functionId || '').trim();
  if (explicitFunctionId) return explicitFunctionId;

  // Prefer a function this account is actually authorized for; fall back to the
  // public hosted Magpie function id when discovery turns up nothing.
  const [discovered] = await discoverTtsFunctionIds(apiKey);
  return discovered || MAGPIE_TTS_FUNCTION_ID;
}

async function fetchNvidiaTtsConfig(apiKey, functionId) {
  const resolvedFunctionId = await resolveTtsFunctionId(apiKey, functionId);
  try {
    const responseBuffer = await grpcUnaryCall({
      pathName: GRPC_TTS_CONFIG_PATH,
      apiKey,
      functionId: resolvedFunctionId,
      requestBytes: Buffer.alloc(0)
    });
    const config = parseSynthesisConfigResponse(responseBuffer);
    return {
      functionId: resolvedFunctionId,
      modelConfig: config.modelConfig || []
    };
  } catch (error) {
    console.warn('[Main] Magpie voice config fetch failed:', error.message);
    return {
      functionId: resolvedFunctionId,
      modelConfig: []
    };
  }
}

// NVIDIA Magpie/Riva TTS is a gRPC-only service exposed via NVCF. We speak the
// Riva RivaSpeechSynthesis/Synthesize protocol over HTTP/2 (see grpcUnaryCall),
// which returns raw LINEAR_PCM audio that the renderer wraps into a WAV.
//
// Function ids are account-scoped, so we try the fast path (an explicit id from
// Settings, then the public Magpie id) and, if those aren't authorized for the
// account, fall back to discovering a TTS function the account can actually call.
let lastWorkingTtsFunctionId = null;

const TRANSIENT_TTS_ERROR = /no worker available|failed to establish link to worker|did not respond within|unavailable|gRPC 4:/i;
// Retry only a failure that came back quickly: a call that already burned its
// deadline would just double how long the caller waits before speaking.
const FAST_FAILURE_MS = 4000;

async function synthesizeNvidiaTts(apiKey, functionId, text, voiceName, languageCode) {
  const startedAt = Date.now();
  try {
    return await synthesizeNvidiaTtsOnce(apiKey, functionId, text, voiceName, languageCode);
  } catch (error) {
    const failedFast = Date.now() - startedAt < FAST_FAILURE_MS;
    if (!failedFast || !TRANSIENT_TTS_ERROR.test(error.message || '')) throw error;
    console.warn(`[Main] Magpie unavailable, retrying once: ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    return synthesizeNvidiaTtsOnce(apiKey, functionId, text, voiceName, languageCode);
  }
}

async function synthesizeNvidiaTtsOnce(apiKey, functionId, text, voiceName, languageCode) {
  const requestBytes = buildSynthesisRequest({
    text,
    voiceName: voiceName || DEFAULT_TTS_VOICE_NAME,
    languageCode: languageCode || 'en-US',
    sampleRateHz: TTS_SAMPLE_RATE_HZ
  });

  const tried = new Set();
  let lastError = null;

  const attempt = async (candidateId) => {
    const id = (candidateId || '').trim();
    if (!id || tried.has(id)) return null;
    tried.add(id);
    try {
      const responseBuffer = await grpcUnaryCall({
        pathName: GRPC_TTS_SYNTHESIZE_PATH,
        apiKey,
        functionId: id,
        requestBytes
      });
      const audio = parseSynthResponse(responseBuffer);
      lastWorkingTtsFunctionId = id;
      return audio;
    } catch (error) {
      lastError = error;
      // Only move on to another id when this one simply isn't usable for the
      // account; any other failure (auth, network, bad audio) is real.
      if (!/not (available|found)/i.test(error.message || '')) {
        throw error;
      }
      return null;
    }
  };

  let audio = await attempt(functionId);
  if (audio) return audio;
  // Whatever worked last time first: re-walking the candidate list (and the
  // function-discovery request behind it) costs a round trip per chunk.
  audio = await attempt(lastWorkingTtsFunctionId);
  if (audio) return audio;
  audio = await attempt(MAGPIE_TTS_FUNCTION_ID);
  if (audio) return audio;

  for (const discoveredId of await discoverTtsFunctionIds(apiKey)) {
    audio = await attempt(discoveredId);
    if (audio) return audio;
  }

  throw lastError || new Error('No NVIDIA TTS function id is available for this account');
}

function decodeHtmlEntities(text) {
  const namedEntities = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' '
  };

  return String(text || '')
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCharCode(Number(decimal)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&([a-z]+);/gi, (_, entity) => namedEntities[entity.toLowerCase()] || `&${entity};`);
}

function stripHtml(text) {
  return decodeHtmlEntities(String(text || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseRssFeed(xmlText, feedLabel, maxItems = 6) {
  const items = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xmlText)) !== null && items.length < maxItems) {
    const itemXml = match[1];
    const titleMatch = itemXml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = itemXml.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const descriptionMatch = itemXml.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
    const pubDateMatch = itemXml.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    const sourceMatch = itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/i);

    const title = stripHtml(titleMatch?.[1] || '');
    const link = decodeHtmlEntities((linkMatch?.[1] || '').trim());
    const description = stripHtml(descriptionMatch?.[1] || '');
    const pubDate = pubDateMatch?.[1] ? new Date(pubDateMatch[1]).toISOString() : null;
    const source = stripHtml(sourceMatch?.[1] || feedLabel || 'News');

    if (!title) continue;

    items.push({
      title,
      link,
      description,
      pubDate,
      source
    });
  }

  return items;
}

function buildGoogleNewsRssUrl(query) {
  const normalizedQuery = String(query || '').trim();
  const searchQuery = normalizedQuery ? `${normalizedQuery} when:1d` : 'top news when:1d';
  return `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=en-US&gl=US&ceid=US:en`;
}

async function fetchNewsBundle(payload = {}) {
  const city = String(payload.city || '').trim();
  const state = String(payload.state || '').trim();
  const country = String(payload.country || '').trim();
  const topics = Array.isArray(payload.topics)
    ? payload.topics.map(topic => String(topic || '').trim()).filter(Boolean)
    : [];

  const locationParts = [city, state, country].filter(Boolean);
  const locationLabel = locationParts.length > 0 ? locationParts.join(', ') : 'your area';
  const countryLabel = country || 'United States';
  const topicQueries = topics.length > 0 ? topics.flatMap((topic) => ([
    `${locationLabel} ${topic}`,
    `${countryLabel} ${topic}`,
    topic
  ])) : [];
  const queries = [
    `${countryLabel} news`,
    'top stories',
    `${locationLabel} news`,
    ...topicQueries,
    'breaking news'
  ];

  const feeds = await Promise.all(
    queries.map(async (query) => {
      const response = await fetch(buildGoogleNewsRssUrl(query), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Olanga Desktop Assistant)'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`News feed error: ${response.status} ${errorText}`.trim());
      }

      const xmlText = await response.text();
      return parseRssFeed(xmlText, query, 5);
    })
  );

  const seen = new Set();
  const articles = [];
  for (const feedItems of feeds) {
    for (const article of feedItems) {
      const dedupeKey = `${article.title.toLowerCase()}|${article.link}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      articles.push(article);
    }
  }

  return {
    locationLabel,
    countryLabel,
    topics,
    generatedAt: new Date().toISOString(),
    articles: articles.slice(0, 16)
  };
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    showMainWindow();
  });

  app.whenReady().then(() => {
    console.log('[Main] userData:', app.getPath('userData'));
    console.log('[Main] secure-store:', getSecureStorePath());
    registerAssetProtocol();
    createWindow();
    createTray();
    createStatusIndicatorWindow();
    screen.on('display-metrics-changed', () => {
      positionStatusIndicator();
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      createStatusIndicatorWindow();
    } else {
      showMainWindow();
    }
  });
}

app.on('before-quit', () => {
  app.isQuiting = true;
  destroyStatusIndicatorWindow();
});

ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.on('window-expand', () => {
  showMainWindow();
});

ipcMain.on('status-indicator-set', (_event, state) => {
  sendStatusIndicatorState(state);
});

ipcMain.on('status-indicator-set-mode', (_event, mode) => {
  setStatusLightMode(mode);
});

ipcMain.on('status-indicator-set-size', (_event, size) => {
  setStatusLightSize(size);
});

ipcMain.handle('get-open-at-login', () => getOpenAtLogin());

ipcMain.handle('set-open-at-login', (_event, enabled) => setOpenAtLogin(enabled));

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'spotify:']);

function openExternalSafe(url) {
  try {
    const parsed = new URL(String(url));
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
      console.warn(`[Main] Blocked openExternal for disallowed protocol: ${parsed.protocol}`);
      return;
    }
    shell.openExternal(parsed.toString());
  } catch {
    console.warn(`[Main] Blocked openExternal for invalid URL: ${url}`);
  }
}

ipcMain.on('open-external', (event, url) => {
  openExternalSafe(url);
});

// Escape special characters for SendKeys (+ ^ % ~ ( ) { } [ ]) and single
// quotes for PowerShell single-quoted string literals.
function escapeForSendKeys(value) {
  return String(value ?? '')
    .replace(/[{}^%+~()[\]]/g, '{$&}')
    .replace(/'/g, "''");
}

function runPowerShell(script) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) {
          console.warn('[Main] PowerShell error:', error.message, stderr?.toString?.() || '');
        }
        resolve({ error, stdout, stderr });
      }
    );
  });
}

// Hardware media keys via user32 keybd_event (Windows media transport).
// Works regardless of which window is focused — same as keyboard media keys.
const MEDIA_VIRTUAL_KEYS = {
  VOLUME_MUTE: 0xAD,
  VOLUME_DOWN: 0xAE,
  VOLUME_UP: 0xAF,
  MEDIA_NEXT: 0xB0,
  MEDIA_PREV: 0xB1,
  MEDIA_PLAY_PAUSE: 0xB3
};

function sendMediaKey(virtualKey, repeat = 1) {
  const count = Math.max(1, Number(repeat) || 1);
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OlangaMedia {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
1..${count} | ForEach-Object {
  [OlangaMedia]::keybd_event(${virtualKey}, 0, 0, [UIntPtr]::Zero)
  [OlangaMedia]::keybd_event(${virtualKey}, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
}
`;
  runPowerShell(script);
}

const SPOTIFY_KIND = {
  SONG: 'track',
  ALBUM: 'album',
  PLAYLIST: 'playlist',
  ARTIST: 'artist'
};

async function resolveSpotifyUri(type, term) {
  const kind = SPOTIFY_KIND[String(type || '').toUpperCase()] || 'track';
  const cleaned = String(term || '').trim();
  if (!cleaned) return null;

  const query = encodeURIComponent(`site:open.spotify.com/${kind} ${cleaned}`);
  const url = `https://html.duckduckgo.com/html/?q=${query}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  });
  if (!response.ok) {
    throw new Error(`Spotify lookup HTTP ${response.status}`);
  }

  const html = await response.text();
  const pattern = new RegExp(`open\\.spotify\\.com\\/${kind}\\/([a-zA-Z0-9]+)`, 'i');
  const match = html.match(pattern);
  if (!match?.[1]) return null;
  // Trailing :play tells the Spotify desktop client to start playback, not
  // just navigate to the page (without it, the current song keeps playing).
  return `spotify:${kind}:${match[1]}:play`;
}

function activateSpotifyAndPlay(type, term) {
  const playKey = (String(type || '').toUpperCase() === 'SONG') ? '+{ENTER}' : '{ENTER}';
  const previousClipboard = clipboard.readText();
  clipboard.writeText(String(term || '').trim());

  // Classic Ctrl+K search with focus forced onto Spotify — more reliable than
  // spotify:search: + Enter, which often just toggles the current track.
  const script = `
$wshell = New-Object -ComObject wscript.shell
Start-Process 'spotify:'
Start-Sleep -Milliseconds 1200
1..12 | ForEach-Object {
  if ($wshell.AppActivate('Spotify')) { break }
  Start-Sleep -Milliseconds 300
}
Start-Sleep -Milliseconds 400
$wshell.SendKeys('^k')
Start-Sleep -Milliseconds 700
$wshell.SendKeys('^a')
Start-Sleep -Milliseconds 80
$wshell.SendKeys('^v')
Start-Sleep -Milliseconds 1600
$wshell.SendKeys('${playKey}')
`;

  setTimeout(() => {
    runPowerShell(script).then(() => {
      try {
        clipboard.writeText(previousClipboard);
      } catch (_) {}
    });
  }, 200);
}

ipcMain.on('play-spotify', async (event, { type, term }) => {
  const searchTerm = String(term || '').trim();
  if (!searchTerm) return;

  console.log(`[Main] Spotify play requested (${type}): ${searchTerm}`);

  try {
    const uri = await resolveSpotifyUri(type, searchTerm);
    if (uri) {
      console.log(`[Main] Opening Spotify URI: ${uri}`);
      shell.openExternal(uri);
      return;
    }
    console.warn('[Main] Spotify URI not found; falling back to in-app search');
  } catch (error) {
    console.warn('[Main] Spotify URI lookup failed:', error.message);
  }

  activateSpotifyAndPlay(type, searchTerm);
});

ipcMain.on('reload-spotify', () => {
  runPowerShell('Stop-Process -Name Spotify -Force -ErrorAction SilentlyContinue');

  setTimeout(() => {
    shell.openExternal('spotify:');
  }, 1200);

  setTimeout(() => {
    sendMediaKey(MEDIA_VIRTUAL_KEYS.MEDIA_PLAY_PAUSE);
  }, 4500);
});

ipcMain.on('media-control', (event, command) => {
  const virtualKey = MEDIA_VIRTUAL_KEYS[command];
  if (!virtualKey) return;

  // Press volume keys multiple times so the change is noticeable.
  const repeat = (command === 'VOLUME_UP' || command === 'VOLUME_DOWN') ? 5 : 1;
  sendMediaKey(virtualKey, repeat);
});

ipcMain.on('open-app', (event, appName) => {
  const safeAppName = escapeForSendKeys(appName);
  console.log(`[Main] Opening app via Windows Search: ${appName}`);
  // Use Windows Search to find and open the app
  const script = `
    $wshell = New-Object -ComObject wscript.shell
    $wshell.SendKeys('^{ESC}')
    Start-Sleep -Milliseconds 400
    $wshell.SendKeys('${safeAppName}')
    Start-Sleep -Milliseconds 600
    $wshell.SendKeys('{ENTER}')
  `;
  
  const ps = spawn('powershell', ['-NoProfile', '-Command', script]);
  
  ps.stderr.on('data', (data) => {
    console.error(`[Main] PowerShell Error: ${data.toString()}`);
  });
});

// Spoken app names rarely match the executable ("Word" is WINWORD.EXE).
const CLOSE_APP_ALIASES = {
  chrome: 'chrome',
  'google chrome': 'chrome',
  edge: 'msedge',
  'microsoft edge': 'msedge',
  firefox: 'firefox',
  word: 'winword',
  'microsoft word': 'winword',
  excel: 'excel',
  powerpoint: 'powerpnt',
  outlook: 'outlook',
  code: 'code',
  'vs code': 'code',
  'visual studio code': 'code',
  cursor: 'cursor',
  terminal: 'windowsterminal',
  'windows terminal': 'windowsterminal',
  teams: 'teams',
  'microsoft teams': 'teams',
  obs: 'obs64',
  roblox: 'robloxplayerbeta'
};

// Closing these would break the desktop, the session, or Olanga itself.
const CLOSE_APP_BLOCKLIST = [
  'explorer', 'olanga', 'electron', 'dwm', 'winlogon', 'csrss', 'wininit',
  'services', 'lsass', 'smss', 'svchost', 'fontdrvhost', 'sihost', 'ctfmon',
  'searchhost', 'shellexperiencehost', 'startmenuexperiencehost', 'textinputhost',
  'applicationframehost', 'systemsettings', 'lockapp', 'runtimebroker', 'audiodg',
  'conhost'
];

function escapeForPowerShellString(value) {
  return String(value ?? '').replace(/'/g, "''");
}

// Wildcards would widen the -like match to unrelated (or all) processes.
function sanitizeAppName(value) {
  return String(value ?? '').replace(/[*?\[\]`$;|&<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildCloseAppTargets(appName) {
  const clean = sanitizeAppName(appName).toLowerCase();
  if (!clean) return [];

  const alias = CLOSE_APP_ALIASES[clean];
  const targets = alias ? [alias, clean] : [clean];
  // "Microsoft Word" should still match a window titled "... - Word".
  const words = clean.split(' ').filter((word) => word.length >= 3);
  if (words.length > 1) targets.push(words[words.length - 1]);

  return [...new Set(targets)];
}

// Closes visible application windows matching a spoken name. Only processes that
// own a main window are eligible, which keeps background services out of reach.
ipcMain.handle('close-app', async (event, appName) => {
  const targets = buildCloseAppTargets(appName);
  if (targets.length === 0) {
    return { ok: false, reason: 'empty-name' };
  }

  const targetList = targets.map((target) => `'${escapeForPowerShellString(target)}'`).join(',');
  const blockedList = CLOSE_APP_BLOCKLIST.map((name) => `'${name}'`).join(',');

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$targets = @(${targetList})
$blocked = @(${blockedList})
$byName = @()
$byTitle = @()
foreach ($p in Get-Process) {
  if ($p.MainWindowHandle -eq 0) { continue }
  $name = $p.ProcessName.ToLower()
  if ($blocked -contains $name) { continue }
  $title = ''
  if ($p.MainWindowTitle) { $title = $p.MainWindowTitle.ToLower() }
  $nameHit = $false
  $titleHit = $false
  foreach ($t in $targets) {
    if ($name -like "*$t*") { $nameHit = $true }
    elseif ($title -like "*$t*") { $titleHit = $true }
  }
  if ($nameHit) { $byName += $p } elseif ($titleHit) { $byTitle += $p }
}
# A window merely titled "Spotify" (a browser tab, say) is only a candidate when
# no actual Spotify process matched.
$candidates = $byTitle
if ($byName.Count -gt 0) { $candidates = $byName }
if ($candidates.Count -eq 0) { Write-Output 'NONE'; exit 0 }
$names = (($candidates | ForEach-Object { $_.ProcessName }) | Sort-Object -Unique) -join ', '
$ids = $candidates | ForEach-Object { $_.Id }
foreach ($p in $candidates) { $null = $p.CloseMainWindow() }
Start-Sleep -Milliseconds 2000
$survivors = Get-Process -Id $ids
if ($survivors) {
  $survivors | Stop-Process -Force
  Write-Output "FORCED:$names"
} else {
  Write-Output "CLOSED:$names"
}
`;

  console.log(`[Main] Closing app matching: ${targets.join(' | ')}`);
  const { stdout } = await runPowerShell(script);
  const output = String(stdout || '').trim();

  if (/^FORCED:/.test(output) || /^CLOSED:/.test(output)) {
    const [status, closed] = output.split(':');
    console.log(`[Main] ${status === 'FORCED' ? 'Force-closed' : 'Closed'}: ${closed}`);
    return { ok: true, closed, forced: status === 'FORCED' };
  }

  console.log(`[Main] No open window matched: ${targets.join(' | ')}`);
  return { ok: false, reason: 'not-running' };
});

ipcMain.handle('request-screenshot', async () => {
  return new Promise((resolve) => {
    clipboard.clear();
    
    const { exec } = require('child_process');
    exec(`powershell -Command "start ms-screenclip:"`);
    
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      const image = clipboard.readImage();
      if (!image.isEmpty()) {
        clearInterval(interval);
        resolve(image.toDataURL());
      } else if (attempts > 60) { // 30 seconds timeout
        clearInterval(interval);
        resolve(null);
      }
    }, 500);
  });
});

ipcMain.handle('fetch-news-bundle', async (event, payload = {}) => {
  return fetchNewsBundle(payload);
});

ipcMain.handle('nvidia-tts-config', async (event, payload = {}) => {
  const apiKey = (payload.apiKey || '').trim();
  const functionId = (payload.functionId || '').trim();

  if (!apiKey) {
    throw new Error('Missing NVIDIA API key');
  }

  return fetchNvidiaTtsConfig(apiKey, functionId);
});

ipcMain.handle('nvidia-tts-synthesize', async (event, payload = {}) => {
  let apiKey = (payload.apiKey || '').trim();
  // Prefer the renderer key; fall back to the secure store so Magpie still
  // works if the renderer hasn't finished loading keys yet.
  if (!apiKey) {
    try {
      const store = readSecureStore();
      if (store.nvidia_api_key && safeStorage.isEncryptionAvailable()) {
        apiKey = safeStorage.decryptString(Buffer.from(store.nvidia_api_key, 'base64')).trim();
      }
    } catch (error) {
      console.warn('[Main] Failed to load NVIDIA key from secure store:', error.message);
    }
  }

  const functionId = (payload.functionId || '').trim();
  // Magpie rejects inputs over ~2000 chars after normalization.
  const text = String(payload.text || '').trim().slice(0, 1800);
  const voiceName = (payload.voiceName || DEFAULT_TTS_VOICE_NAME).trim() || DEFAULT_TTS_VOICE_NAME;
  const languageCode = (payload.languageCode || 'en-US').trim() || 'en-US';

  if (!apiKey) {
    throw new Error('Missing NVIDIA API key');
  }

  if (!text) {
    throw new Error('Missing TTS text');
  }

  const startedAt = Date.now();
  try {
    const audioBytes = await synthesizeNvidiaTts(apiKey, functionId, text, voiceName, languageCode);
    console.log(`[Main] Magpie TTS ${text.length} chars, voice=${voiceName}, ${Date.now() - startedAt}ms`);
    return { audioBase64: Buffer.from(audioBytes).toString('base64') };
  } catch (error) {
    console.warn(`[Main] Magpie TTS failed after ${Date.now() - startedAt}ms: ${error.message}`);
    throw error;
  }
});

// NVIDIA chat completions proxy (renderer can't call it directly now that
// webSecurity/CORS enforcement is enabled).
ipcMain.handle('nvidia-chat', async (event, payload = {}) => {
  const chatApiKey = (payload.apiKey || '').trim();
  if (!chatApiKey) {
    throw new Error('Missing NVIDIA API key');
  }

  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${chatApiKey}`
    },
    body: JSON.stringify({
      model: payload.model,
      messages: payload.messages,
      temperature: payload.temperature ?? 0.7,
      max_tokens: payload.max_tokens ?? 2048
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error: ${response.status} - ${errorText}`);
  }

  return response.json();
});

// ============================================
// SECURE KEY STORE (encrypted at rest via safeStorage)
// ============================================

function getSecureStorePath() {
  return path.join(app.getPath('userData'), 'secure-store.json');
}

function readSecureStore() {
  try {
    const raw = fs.readFileSync(getSecureStorePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeSecureStore(store) {
  fs.writeFileSync(getSecureStorePath(), JSON.stringify(store), 'utf8');
}

ipcMain.handle('secure-store-get', async (event, key) => {
  const storePath = getSecureStorePath();
  const store = readSecureStore();
  const encrypted = store[String(key)];
  if (!encrypted) {
    console.warn(`[Main] secure-store-get miss for "${key}" (path=${storePath})`);
    return null;
  }
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[Main] safeStorage encryption unavailable');
      return null;
    }
    const value = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    console.log(`[Main] secure-store-get ok for "${key}" (chars=${String(value || '').length})`);
    return value;
  } catch (error) {
    console.warn(`[Main] Failed to decrypt secure value for "${key}":`, error.message);
    return null;
  }
});

ipcMain.handle('secure-store-set', async (event, payload = {}) => {
  const key = String(payload.key || '');
  const value = payload.value;
  if (!key) throw new Error('Missing secure store key');

  const store = readSecureStore();
  if (value === null || value === undefined || value === '') {
    delete store[key];
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level encryption is unavailable');
    }
    store[key] = safeStorage.encryptString(String(value)).toString('base64');
  }
  writeSecureStore(store);
  return { ok: true };
});

const terminalSessions = new Map();

function escapePowerShellSingleQuotedString(value) {
  return String(value ?? '').replace(/'/g, "''");
}

function createTerminalSession(sessionId, cwd) {
  const resolvedCwd = cwd || os.homedir();
  const processHandle = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', '-'], {
    cwd: resolvedCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  const session = {
    id: String(sessionId),
    process: processHandle,
    cwd: resolvedCwd,
    buffer: '',
    running: false,
    queue: [],
    currentCommand: null
  };

  function failQueuedCommands(error) {
    if (session.currentCommand) {
      session.currentCommand.reject(error);
      session.currentCommand = null;
    }
    while (session.queue.length > 0) {
      const queuedCommand = session.queue.shift();
      queuedCommand.reject(error);
    }
    session.running = false;
  }

  const handleData = (chunk) => {
    session.buffer += chunk.toString('utf8');
    let newlineIndex = session.buffer.indexOf('\n');

    while (newlineIndex !== -1) {
      const rawLine = session.buffer.slice(0, newlineIndex);
      session.buffer = session.buffer.slice(newlineIndex + 1);
      const line = rawLine.replace(/\r$/, '');

      if (session.currentCommand) {
        if (line.startsWith('__OLANGA_CWD__:')) {
          session.cwd = line.slice('__OLANGA_CWD__:'.length).trim();
        } else if (line.startsWith('__OLANGA_EXIT__:')) {
          const exitCode = Number(line.slice('__OLANGA_EXIT__:'.length).trim());
          session.currentCommand.exitCode = Number.isNaN(exitCode) ? 0 : exitCode;
        } else if (line === '__OLANGA_DONE__') {
          const pending = session.currentCommand;
          session.currentCommand = null;
          session.running = false;
          pending.resolve({
            output: pending.outputLines.join('\n').trimEnd(),
            cwd: session.cwd,
            success: pending.exitCode === 0,
            exitCode: pending.exitCode
          });
          process.nextTick(() => drainTerminalSession(session.id));
        } else if (line && !line.startsWith('PS ')) {
          session.currentCommand.outputLines.push(line);
        }
      }

      newlineIndex = session.buffer.indexOf('\n');
    }
  };

  processHandle.stdout.on('data', handleData);
  processHandle.stderr.on('data', handleData);
  processHandle.on('close', (code) => {
    failQueuedCommands(new Error(`Terminal session closed unexpectedly (code ${code ?? 'unknown'})`));
    terminalSessions.delete(session.id);
  });

  processHandle.stdin.write(`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\r\n`);
  processHandle.stdin.write(`$ErrorActionPreference = 'Continue'\r\n`);
  processHandle.stdin.write(`Set-Location -LiteralPath '${escapePowerShellSingleQuotedString(resolvedCwd)}'\r\n`);

  terminalSessions.set(session.id, session);
  return { cwd: resolvedCwd };
}

function drainTerminalSession(sessionId) {
  const session = terminalSessions.get(String(sessionId));
  if (!session || session.running || session.currentCommand || session.queue.length === 0) {
    return;
  }

  const nextCommand = session.queue.shift();
  session.running = true;
  session.currentCommand = {
    resolve: nextCommand.resolve,
    reject: nextCommand.reject,
    outputLines: [],
    exitCode: 0
  };

  session.process.stdin.write(`${nextCommand.command}\r\n`);
  session.process.stdin.write(`Write-Output "__OLANGA_EXIT__:$LASTEXITCODE"\r\n`);
  session.process.stdin.write(`Write-Output "__OLANGA_CWD__:$((Get-Location).Path)"\r\n`);
  session.process.stdin.write(`Write-Output "__OLANGA_DONE__"\r\n`);
}

ipcMain.handle('terminal-session-create', async (event, payload = {}) => {
  const sessionId = String(payload.sessionId ?? '');
  if (!sessionId) {
    throw new Error('Missing terminal session ID');
  }

  const cwd = payload.cwd || os.homedir();
  if (terminalSessions.has(sessionId)) {
    return { cwd: terminalSessions.get(sessionId).cwd };
  }

  return createTerminalSession(sessionId, cwd);
});

ipcMain.handle('terminal-session-execute', async (event, payload = {}) => {
  const sessionId = String(payload.sessionId ?? '');
  const command = String(payload.command ?? '').trim();

  if (!sessionId) {
    throw new Error('Missing terminal session ID');
  }

  if (!command) {
    throw new Error('Missing terminal command');
  }

  let session = terminalSessions.get(sessionId);
  if (!session) {
    createTerminalSession(sessionId, payload.cwd || os.homedir());
    session = terminalSessions.get(sessionId);
  }

  return new Promise((resolve, reject) => {
    session.queue.push({ command, resolve, reject });
    drainTerminalSession(sessionId);
  });
});

ipcMain.handle('terminal-session-close', async (event, payload = {}) => {
  const sessionId = String(payload.sessionId ?? '');
  const session = terminalSessions.get(sessionId);

  if (!session) {
    return { closed: true };
  }

  try {
    if (session.process && !session.process.killed) {
      session.process.stdin.write('exit\r\n');
      session.process.kill();
    }
  } catch (error) {
    try {
      session.process.kill('SIGKILL');
    } catch (killError) {
      // Ignore cleanup errors.
    }
  }

  terminalSessions.delete(sessionId);
  return { closed: true };
});

ipcMain.handle('execute-command', async (event, payload) => {
  const { exec } = require('child_process');
  
  let commandStr = '';
  let commandCwd = null;
  
  if (payload && typeof payload === 'object') {
    commandStr = payload.command || '';
    commandCwd = payload.cwd || null;
  } else {
    commandStr = payload || '';
  }
  
  if (!commandCwd) {
    const os = require('os');
    commandCwd = os.homedir();
  }

  return new Promise((resolve) => {
    // Append PowerShell instruction to output the current working directory path at the end of execution
    const fullCommand = `${commandStr}; Write-Output "__CWD__:$((Get-Location).Path)"`;
    
    exec(`powershell -NoProfile -Command "${fullCommand.replace(/"/g, '\\"')}"`, 
      { 
        timeout: 30000, 
        maxBuffer: 1024 * 1024,
        cwd: commandCwd
      },
      (error, stdout, stderr) => {
        let output = stdout || '';
        let errorOutput = stderr || '';
        
        // Parse current working directory from the output
        const cwdPattern = /__CWD__:(.*)$/m;
        const match = output.match(cwdPattern);
        let newCwd = commandCwd;
        
        if (match) {
          newCwd = match[1].trim();
          output = output.replace(cwdPattern, '').trim();
        }
        
        if (error && !output) {
          resolve({
            output: errorOutput || error.message,
            cwd: newCwd,
            success: false,
            exitCode: typeof error.code === 'number' ? error.code : 1
          });
        } else {
          resolve({
            output: output + (errorOutput ? '\n' + errorOutput : ''),
            cwd: newCwd,
            success: !error,
            exitCode: error && typeof error.code === 'number' ? error.code : 0
          });
        }
      }
    );
  });
});
