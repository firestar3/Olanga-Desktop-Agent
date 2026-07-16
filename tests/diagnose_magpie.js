/**
 * One-shot Magpie TTS diagnostic. Uses Electron safeStorage for the API key.
 * Run: npx electron tests/diagnose_magpie.js
 */
const { app, safeStorage } = require('electron');
const http2 = require('http2');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// Match package.json name so userData resolves to %APPDATA%/olanga-control
// (bare electron scripts otherwise land in %APPDATA%/Electron).
app.setName('olanga-control');

const MAGPIE_TTS_FUNCTION_ID = '877104f7-e885-42b9-8de8-f6e4c6303969';
const GRPC_TTS_SYNTHESIZE_PATH = '/nvidia.riva.tts.RivaSpeechSynthesis/Synthesize';
const GRPC_TTS_CONFIG_PATH = '/nvidia.riva.tts.RivaSpeechSynthesis/GetRivaSynthesisConfig';
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
    encodeVarintField(3, 1), // LINEAR_PCM
    encodeVarintField(4, sampleRateHz || TTS_SAMPLE_RATE_HZ),
    encodeStringField(5, voiceName || DEFAULT_VOICE)
  ]));
}

function readVarint(bytes, startOffset) {
  let result = 0;
  let shift = 0;
  let offset = startOffset;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset };
    shift += 7;
  }
  throw new Error('Unexpected end of protobuf varint');
}

function readDelimited(bytes, startOffset) {
  const lengthInfo = readVarint(bytes, startOffset);
  const endOffset = lengthInfo.offset + lengthInfo.value;
  return { value: bytes.slice(lengthInfo.offset, endOffset), offset: endOffset };
}

function parseGrpcFrames(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const messages = [];
  let offset = 0;
  while (offset + 5 <= bytes.length) {
    const compressed = bytes.readUInt8(offset);
    const length = bytes.readUInt32BE(offset + 1);
    offset += 5;
    if (offset + length > bytes.length) break;
    const frame = bytes.slice(offset, offset + length);
    offset += length;
    if (compressed === 0) messages.push(frame);
    else {
      try { messages.push(zlib.gunzipSync(frame)); }
      catch {
        messages.push(zlib.inflateSync(frame));
      }
    }
  }
  return messages;
}

function extractAllAudio(buffer) {
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
      } else if (wireType === 0) {
        offset = readVarint(responseBytes, offset).offset;
      } else if (wireType === 2) {
        offset = readDelimited(responseBytes, offset).offset;
      } else {
        throw new Error(`Unsupported wire type ${wireType}`);
      }
    }
  }
  return { messageCount: messages.length, audio: Buffer.concat(audioChunks) };
}

function grpcUnaryCall({ pathName, apiKey, functionId, requestBytes }) {
  return new Promise((resolve, reject) => {
    const client = http2.connect('https://grpc.nvcf.nvidia.com:443');
    const responseChunks = [];
    let responseHeaders = {};
    let responseTrailers = {};
    let settled = false;

    const finish = (error, buffer) => {
      if (settled) return;
      settled = true;
      client.close();
      if (error) reject(Object.assign(error, { responseHeaders, responseTrailers }));
      else resolve({ buffer, responseHeaders, responseTrailers });
    };

    client.on('error', (error) => finish(error));

    const request = client.request({
      ':method': 'POST',
      ':path': pathName,
      ':scheme': 'https',
      ':authority': 'grpc.nvcf.nvidia.com:443',
      'content-type': 'application/grpc',
      'te': 'trailers',
      'grpc-accept-encoding': 'identity',
      'user-agent': 'olanga-control/1.0 grpc-node-http2',
      'authorization': `Bearer ${apiKey}`,
      'function-id': functionId
    });

    request.on('response', (headers) => { responseHeaders = headers; });
    request.on('data', (chunk) => responseChunks.push(Buffer.from(chunk)));
    request.on('trailers', (trailers) => { responseTrailers = trailers; });
    request.on('end', () => {
      const grpcStatus = String(responseTrailers['grpc-status'] || responseHeaders['grpc-status'] || '0');
      const grpcMessage = decodeURIComponent(String(responseTrailers['grpc-message'] || responseHeaders['grpc-message'] || ''));
      if (grpcStatus !== '0') {
        finish(new Error(`gRPC ${grpcStatus}: ${grpcMessage || 'request failed'}`));
        return;
      }
      finish(null, Buffer.concat(responseChunks));
    });
    request.on('error', (error) => finish(error));
    request.end(buildGrpcFrame(requestBytes || Buffer.alloc(0)));
  });
}

function loadApiKey() {
  const candidates = [
    path.join(app.getPath('userData'), 'secure-store.json'),
    path.join(process.env.APPDATA || '', 'olanga-control', 'secure-store.json')
  ];
  for (const storePath of candidates) {
    console.log('STORE_CANDIDATE:', storePath, fs.existsSync(storePath) ? 'EXISTS' : 'MISSING');
    if (!fs.existsSync(storePath) || !safeStorage.isEncryptionAvailable()) continue;
    try {
      const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      if (store.nvidia_api_key) {
        return safeStorage.decryptString(Buffer.from(store.nvidia_api_key, 'base64'));
      }
    } catch (err) {
      console.error('STORE_READ_ERROR:', storePath, err.message);
    }
  }
  return process.env.NVIDIA_API_KEY || '';
}

app.whenReady().then(async () => {
  try {
    console.log('USERDATA:', app.getPath('userData'));
    const apiKey = loadApiKey().trim();
    if (!apiKey) {
      console.error('NO_KEY: No NVIDIA API key in secure store or NVIDIA_API_KEY env');
      app.exit(2);
      return;
    }
    console.log('KEY_PREFIX:', apiKey.slice(0, 8) + '...');
    console.log('FUNCTION_ID:', MAGPIE_TTS_FUNCTION_ID);

    const requestBytes = buildSynthesisRequest({
      text: 'Hello from Olanga Magpie diagnostic.',
      voiceName: DEFAULT_VOICE,
      languageCode: 'en-US',
      sampleRateHz: TTS_SAMPLE_RATE_HZ
    });
    console.log('REQUEST_BYTES:', requestBytes.length);

    const { buffer, responseHeaders, responseTrailers } = await grpcUnaryCall({
      pathName: GRPC_TTS_SYNTHESIZE_PATH,
      apiKey,
      functionId: MAGPIE_TTS_FUNCTION_ID,
      requestBytes
    });

    console.log('HTTP_STATUS:', responseHeaders[':status']);
    console.log('TRAILERS:', JSON.stringify(responseTrailers));
    console.log('RESPONSE_BYTES:', buffer.length);

    const { messageCount, audio } = extractAllAudio(buffer);
    console.log('GRPC_MESSAGES:', messageCount);
    console.log('AUDIO_BYTES:', audio.length);

    if (audio.length === 0) {
      console.error('FAIL: No audio in response');
      app.exit(3);
      return;
    }

    const outPath = path.join(__dirname, 'magpie_diag.wav');
    // minimal WAV write
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + audio.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(TTS_SAMPLE_RATE_HZ, 24);
    header.writeUInt32LE(TTS_SAMPLE_RATE_HZ * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(audio.length, 40);
    fs.writeFileSync(outPath, Buffer.concat([header, audio]));
    console.log('SUCCESS wrote', outPath);
    app.exit(0);
  } catch (error) {
    console.error('FAIL:', error.message);
    if (error.responseHeaders) {
      console.error('HTTP_STATUS:', error.responseHeaders[':status']);
      console.error('RESPONSE_HEADERS:', JSON.stringify(error.responseHeaders));
      console.error('RESPONSE_TRAILERS:', JSON.stringify(error.responseTrailers || {}));
    }
    app.exit(1);
  }
});

