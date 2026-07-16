import os, sys, json, traceback
FID = "877104f7-e885-42b9-8de8-f6e4c6303969"
api_key = os.environ.get("NVIDIA_API_KEY", "").strip()
print("KEY_PREFIX:", api_key[:8] + "..." if api_key else "MISSING")
if not api_key:
    sys.exit(2)
try:
    import riva.client
    from riva.client import Auth, SpeechSynthesisService
except Exception as e:
    print("RIVA_IMPORT_FAIL:", e)
    sys.exit(3)
try:
    auth = Auth(
        uri="grpc.nvcf.nvidia.com:443",
        use_ssl=True,
        metadata_args=[
            ["authorization", f"Bearer {api_key}"],
            ["function-id", FID],
        ],
    )
    tts = SpeechSynthesisService(auth)
    if hasattr(tts, "get_config"):
        resp = tts.get_config()
    elif hasattr(tts, "get_synthesis_config"):
        resp = tts.get_synthesis_config()
    else:
        print("NO_GET_CONFIG_METHOD:", [m for m in dir(tts) if "config" in m.lower()])
        sys.exit(4)
    if hasattr(resp, "SerializeToString"):
        from google.protobuf.json_format import MessageToDict
        data = MessageToDict(resp, preserving_proto_field_name=True)
    else:
        data = resp
    print("--- PYTHON_CONFIG_JSON ---")
    print(json.dumps(data, indent=2))
    voice_ids = set()
    mc = data.get("model_config") or data.get("modelConfig") or []
    if isinstance(mc, dict):
        mc = [mc]
    for cfg in mc:
        params = cfg.get("parameters") or {}
        if isinstance(params, list):
            params = {p.get("key"): p.get("value") for p in params if p.get("key")}
        base = params.get("voiceName") or cfg.get("model_name") or ""
        if base:
            voice_ids.add(base)
        raw = params.get("subvoices") or params.get("subVoices") or ""
        subs = raw if isinstance(raw, list) else [x.strip() for x in str(raw).split(",") if x.strip()]
        for sub in subs:
            suffix = str(sub).split(":")[0]
            name = suffix if suffix.startswith(base) else (base + "." + suffix if base else suffix)
            voice_ids.add(name)
    print("--- VOICE_IDS_PYTHON (%d) ---" % len(voice_ids))
    for v in sorted(voice_ids):
        print(v)
except Exception as e:
    print("PYTHON_FAIL:", type(e).__name__, str(e))
    traceback.print_exc()
    sys.exit(1)
