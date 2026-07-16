/**
 * Magpie TTS gRPC matrix diagnostic (NVCF).
 * Run: npx electron tests/diagnose_magpie_matrix.js
 */
const { app, safeStorage } = require('electron');
const http2 = require('http2');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const os = require('os');

app.setName('olanga-control');

const MAGPIE_TTS_FUNCTION_ID = '877104f7-e885-42b9-8de8-f6e4c6303969';
const PATHS = [
  '/nvidia.riva.RivaSpeechSynthesis/Synthesize',
  '/nvidia.riva.RivaSpeechSynthesis/GetRivaSynthesisConfig'
];
const CONTENT_TYPES = ['application/grpc', 'application/grpc+proto'];
const DEFAULT_VOICE = 'Magpie-Multilingual.EN-US.Sofia';
const TTS_SAMPLE_RATE_HZ = 22050;

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

function buildSynthesisRequest({ text, voiceName, languageCode, sampleRateHz }) {
  return Buffer.from(concatUint8Arrays([
    encodeStringField(1, text),
    encodeStringField(2, languageCode || 'en-US'),
    encodeVarintField(3, 1),
    encodeVarintField(4, sampleRateHz || TTS_SAMPLE_RATE_HZ),
    encodeStringField(5, voiceName || DEFAULT_VOICE)
  ]));
}

function serializeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function grpcUnaryCallDetailed({ pathName, apiKey, functionId, requestBytes, contentType, functionIdHeaderName }) {
  return new Promise((resolve) => {
    const client = http2.connect('https://grpc.nvcf.nvidia.com:443');
    const responseChunks = [];
    let responseHeaders = {};
    let responseTrailers = {};
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch (_) {}
      resolve(result);
    };

    client.on('error', (error) => {
      finish({ ok: false, transportError: error.message, responseHeaders, responseTrailers, body: Buffer.alloc(0) });
    });

    const extraHeaders = {
      [functionIdHeaderName]: functionId
    };

    const request = client.request({
      ':method': 'POST',
      ':path': pathName,
      ':scheme': 'https',
      ':authority': 'grpc.nvcf.nvidia.com:443',
      'content-type': contentType,
      'te': 'trailers',
      'grpc-accept-encoding': 'identity',
      'user-agent': 'olanga-control/1.0 grpc-node-http2-diagnose',
      'authorization': `Bearer ${apiKey}`,
      ...extraHeaders
    });

    request.on('response', (headers) => { responseHeaders = headers; });
    request.on('data', (chunk) => responseChunks.push(Buffer.from(chunk)));
    request.on('trailers', (trailers) => { responseTrailers = trailers; });
    request.on('end', () => {
      const body = Buffer.concat(responseChunks);
      const grpcStatus = String(responseTrailers['grpc-status'] ?? responseHeaders['grpc-status'] ?? '0');
      const grpcMessageRaw = responseTrailers['grpc-message'] ?? responseHeaders['grpc-message'] ?? '';
      const grpcMessage = grpcMessageRaw ? decodeURIComponent(String(grpcMessageRaw)) : '';
      const httpStatus = String(responseHeaders[':status'] ?? '');
      finish({
        ok: grpcStatus === '0',
        httpStatus,
        grpcStatus,
        grpcMessage,
        responseHeaders: serializeHeaders(responseHeaders),
        responseTrailers: serializeHeaders(responseTrailers),
        bodyLength: body.length,
        body
      });
    });
    request.on('error', (error) => {
      finish({ ok: false, transportError: error.message, responseHeaders: serializeHeaders(responseHeaders), responseTrailers: serializeHeaders(responseTrailers), body: Buffer.alloc(0) });
    });

    request.end(buildGrpcFrame(requestBytes || Buffer.alloc(0)));
  });
}

function loadApiKey() {
  const candidates = [
    path.join(app.getPath('userData'), 'secure-store.json'),
    path.join(process.env.APPDATA || '', 'olanga-control', 'secure-store.json')
  ];
  for (const storePath of candidates) {
    if (!fs.existsSync(storePath) || !safeStorage.isEncryptionAvailable()) continue;
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (store.nvidia_api_key) {
      return safeStorage.decryptString(Buffer.from(store.nvidia_api_key, 'base64'));
    }
  }
  return process.env.NVIDIA_API_KEY || '';
}

function exportKeyToTemp(apiKey) {
  const tmp = path.join(os.tmpdir(), `olanga-nvidia-key-${process.pid}.txt`);
  fs.writeFileSync(tmp, apiKey.trim(), { encoding: 'utf8', mode: 0o600 });
  return tmp;
}

app.whenReady().then(async () => {
  const synthBytes = buildSynthesisRequest({
    text: 'Hello from Olanga Magpie diagnostic.',
    voiceName: DEFAULT_VOICE,
    languageCode: 'en-US',
    sampleRateHz: TTS_SAMPLE_RATE_HZ
  });
  const configBytes = Buffer.alloc(0);

  const apiKey = loadApiKey().trim();
  if (!apiKey) {
    console.error('NO_KEY');
    app.exit(2);
    return;
  }
  console.log('KEY_PREFIX:', apiKey.slice(0, 8) + '...');
  console.log('FUNCTION_ID:', MAGPIE_TTS_FUNCTION_ID);
  console.log('USERDATA:', app.getPath('userData'));

  const keyTmp = exportKeyToTemp(apiKey);
  console.log('KEY_TMP_FOR_PYTHON:', keyTmp);

  const functionIdHeaders = ['function-id', 'nvcf-function-id'];
  let anySuccess = false;
  let attempt = 0;

  for (const pathName of PATHS) {
    const requestBytes = pathName.includes('GetRivaSynthesisConfig') ? configBytes : synthBytes;
    for (const contentType of CONTENT_TYPES) {
      for (const functionIdHeaderName of functionIdHeaders) {
        attempt += 1;
        console.log('\n=== ATTEMPT', attempt, '===');
        console.log('path:', pathName);
        console.log('content-type:', contentType);
        console.log('function header:', functionIdHeaderName);
        const result = await grpcUnaryCallDetailed({
          pathName,
          apiKey,
          functionId: MAGPIE_TTS_FUNCTION_ID,
          requestBytes,
          contentType,
          functionIdHeaderName
        });
        if (result.transportError) console.log('TRANSPORT_ERROR:', result.transportError);
        console.log('HTTP_STATUS:', result.httpStatus ?? '(none)');
        console.log('GRPC_STATUS:', result.grpcStatus ?? '(none)');
        console.log('GRPC_MESSAGE:', result.grpcMessage || '(empty)');
        console.log('RESPONSE_HEADERS:', JSON.stringify(result.responseHeaders || {}, null, 0));
        console.log('RESPONSE_TRAILERS:', JSON.stringify(result.responseTrailers || {}, null, 0));
        console.log('BODY_BYTES:', result.bodyLength ?? 0);
        if (result.ok && (result.bodyLength || 0) > 0) {
          anySuccess = true;
          console.log('RESULT: SUCCESS (non-empty body)');
        } else if (result.ok) {
          console.log('RESULT: gRPC OK but empty body');
        } else {
          console.log('RESULT: FAIL');
        }
      }
    }
  }

  try { fs.unlinkSync(keyTmp); console.log('KEY_TMP_DELETED:', keyTmp); } catch (e) { console.log('KEY_TMP_DELETE_FAILED:', e.message); }

  app.exit(anySuccess ? 0 : 1);
});
