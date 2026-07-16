import os, sys, traceback
import riva.client
from riva.client import Auth, SpeechSynthesisService
from riva.client.proto.riva_audio_pb2 import AudioEncoding

api_key = os.environ.get("NVIDIA_API_KEY", "").strip()
print("KEY_PREFIX:", api_key[:8] + "..." if api_key else "MISSING")
FID = "877104f7-e885-42b9-8de8-f6e4c6303969"
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
    resp = tts.synthesize(
        text="Hello from official Riva Python client.",
        voice_name="Magpie-Multilingual.EN-US.Sofia",
        language_code="en-US",
        encoding=AudioEncoding.LINEAR_PCM,
        sample_rate_hz=22050,
    )
    audio = resp.audio if hasattr(resp, "audio") else b""
    print("PYTHON_SUCCESS audio_bytes=", len(audio))
except Exception as e:
    print("PYTHON_FAIL:", type(e).__name__, str(e))
    traceback.print_exc()
    sys.exit(1)
