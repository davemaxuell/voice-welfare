"""
.env의 음성 설정을 실제 API로 확인한다. 마이크 없이 왕복 테스트:
TTS로 한국어 문장을 합성 → 그 음성을 STT로 받아쓰기 → 원문과 비교.
사용: uv run python scripts/check_voice.py  (합성한 음성은 reports/voice-check.mp3로 저장해 직접 들어볼 수 있다)
"""
import asyncio
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

from ieum.core.jsutil import rx
from ieum.server.runtime import load_config
from ieum.voice import create_voice_providers

ROOT = Path(__file__).resolve().parents[1]


async def main() -> int:
    load_dotenv(ROOT / ".env")
    stt, tts = create_voice_providers(load_config().voice)
    print(f"STT: {stt.name if stt.supported else '미설정(브라우저 음성 사용)'} · TTS: {tts.name if tts.supported else '미설정(브라우저 음성 사용)'}")
    if not stt.supported and not tts.supported:
        return 0
    sentence = "주소는 부산광역시 예시구 예시로 10"
    audio: bytes | None = None
    if tts.supported:
        t0 = time.monotonic()
        out = await tts.synthesize(sentence, language="ko")
        audio = out["audio"]
        (ROOT / "reports").mkdir(exist_ok=True)
        (ROOT / "reports" / "voice-check.mp3").write_bytes(audio)
        print(f"✓ TTS {int((time.monotonic() - t0) * 1000)}ms, {len(audio)} bytes → reports/voice-check.mp3")
    if stt.supported:
        if audio is None:
            print("TTS가 없어 STT 왕복 테스트는 건너뜁니다. 웹 UI에서 마이크로 확인하세요.")
            return 0
        t0 = time.monotonic()
        text = (await stt.transcribe(audio, language="ko", mime_type="audio/mpeg"))["text"]
        same = rx(r"[\s.,]").sub("", text) == rx(r"[\s.,]").sub("", sentence)
        print(f'✓ STT {int((time.monotonic() - t0) * 1000)}ms: "{text}" {"(원문과 일치)" if same else f"(원문: \"{sentence}\")"}')
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
