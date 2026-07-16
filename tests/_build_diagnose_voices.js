const fs = require('fs');
const path = require('path');
const main = fs.readFileSync('main.js', 'utf8');
const start = main.indexOf('function parseSynthesisConfigResponse');
const end = main.indexOf('function parseSynthResponse', start);
if (start < 0 || end < 0) throw new Error('parse fn not found');
const parseFn = main.slice(start, end).trim();
let s = fs.readFileSync('tests/diagnose_magpie.js', 'utf8');
const endExtract = s.indexOf('function grpcUnaryCall');
const extra = [
  "const { spawnSync } = require('child_process');",
  '',
  parseFn,
  '',
  "function extractVoiceIdsFromConfig(modelConfig) {",
  "  const voiceIds = new Set();",
  "  for (const cfg of modelConfig) {",
  "    const params = cfg.parameters || {};",
  "    const baseVoiceName = params.voiceName || cfg.model_name || DEFAULT_VOICE;",
  "    if (baseVoiceName) voiceIds.add(baseVoiceName);",
  "    const rawSub = params.subvoices || params.subVoices || params.voices || '';",
  "    const subvoices = Array.isArray(rawSub) ? rawSub : String(rawSub).split(',').map((x) => x.trim()).filter(Boolean);",
  "    for (const sub of subvoices) {",
  "      const voiceSuffix = String(sub).split(':')[0];",
  "      const voiceName = voiceSuffix.startsWith(baseVoiceName) ? voiceSuffix : baseVoiceName + '.' + voiceSuffix;",
  "      voiceIds.add(voiceName);",
  "    }",
  "  }",
  "  return [...voiceIds].sort();",
  "}",
  '',
  "function runPythonListVoices(apiKey) {",
  "  const pyScript = path.join(__dirname, 'diagnose_magpie_voices_python.py');",
  "  if (!fs.existsSync(pyScript)) return { skipped: true, reason: 'no helper script' };",
  "  const env = Object.assign({}, process.env, { NVIDIA_API_KEY: apiKey });",
  "  const attempts = [['python', [pyScript]], ['python3', [pyScript]], ['py', ['-3', pyScript]]];",
  "  for (const pair of attempts) {",
  "    const cmd = pair[0]; const args = pair[1];",
  "    const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 120000 });",
  "    if (r.error && r.error.code === 'ENOENT') continue;",
  "    return { cmd, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };",
  "  }",
  "  return { skipped: true, reason: 'python not found' };",
  "}",
  ''
].join('\n');
s = s.slice(0, endExtract) + extra + s.slice(endExtract);
const whenReady = `app.whenReady().then(async () => {
  try {
    console.log('USERDATA:', app.getPath('userData'));
    const apiKey = loadApiKey().trim();
    if (!apiKey) { console.error('NO_KEY'); app.exit(2); return; }
    console.log('KEY_PREFIX:', apiKey.slice(0, 8) + '...');
    console.log('FUNCTION_ID:', MAGPIE_TTS_FUNCTION_ID);
    console.log('GRPC_PATH:', GRPC_TTS_CONFIG_PATH);
    const { buffer, responseHeaders } = await grpcUnaryCall({
      pathName: GRPC_TTS_CONFIG_PATH,
      apiKey,
      functionId: MAGPIE_TTS_FUNCTION_ID,
      requestBytes: Buffer.alloc(0)
    });
    console.log('HTTP_STATUS:', responseHeaders[':status']);
    console.log('RESPONSE_BYTES:', buffer.length);
    const { modelConfig } = parseSynthesisConfigResponse(buffer);
    console.log('--- FULL_MODEL_CONFIG_JSON ---');
    console.log(JSON.stringify({ modelConfig }, null, 2));
    for (const cfg of modelConfig) {
      console.log('--- MODEL:', cfg.model_name || '(unnamed)');
      for (const [k, v] of Object.entries(cfg.parameters || {})) console.log('PARAM ' + k + '=', v);
    }
    const voiceIds = extractVoiceIdsFromConfig(modelConfig);
    console.log('--- VOICE_IDS_ELECTRON (' + voiceIds.length + ') ---');
    for (const id of voiceIds) console.log(id);
    console.log('--- PYTHON_RIVA_CLIENT ---');
    const py = runPythonListVoices(apiKey);
    if (py.skipped) console.log('PYTHON_SKIPPED:', py.reason);
    else {
      console.log('PYTHON_CMD:', py.cmd, 'exit=', py.status);
      if (py.stdout) console.log(py.stdout);
      if (py.stderr) console.log(py.stderr);
    }
    app.exit(voiceIds.length ? 0 : 3);
  } catch (error) {
    console.error('FAIL:', error.message);
    if (error.responseHeaders) console.error('HTTP_STATUS:', error.responseHeaders[':status']);
    app.exit(1);
  }
});`;
s = s.replace(/app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*\}\);\s*$/, whenReady);
fs.writeFileSync('tests/diagnose_magpie_voices.js', s);
console.log('wrote tests/diagnose_magpie_voices.js', s.length);

