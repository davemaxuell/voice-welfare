"""
첫 실행 설정 1단계(키를 넣기 전)에 틀 문장을 녹음한다. 개발자가 .env의 키로 한 번 돌린다.
setup-audio/manifest.json의 문장을 청음과 같은 목소리로 합성해 setup-audio/<언어>/<id>.mp3에 둔다.
처음 듣는 분을 위해 기본 빠르기(1배)로 녹음한다. 이미 있는 파일은 --force가 없으면 건너뛴다.

uv run python scripts/record_setup_clips.py [--force] [--lang ko|en|zh|ja]
"""
import argparse
import asyncio
import json
from dataclasses import replace
from pathlib import Path

from dotenv import load_dotenv

from cheongeum.server.runtime import load_config
from cheongeum.voice import create_voice_providers

ROOT = Path(__file__).resolve().parents[1]
AUDIO = ROOT / "src" / "cheongeum" / "web" / "static" / "setup-audio"


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="있는 파일도 다시 녹음")
    parser.add_argument("--lang", choices=["ko", "en", "zh", "ja"], help="이 언어만")
    args = parser.parse_args()
    load_dotenv(ROOT / ".env")
    _stt, tts = create_voice_providers(replace(load_config().voice, ttsSpeed=1.0))
    if not tts.supported:
        raise SystemExit(".env에 OPENAI_API_KEY(또는 VOICE_API_KEY)가 있어야 녹음할 수 있어요.")
    manifest = json.loads((AUDIO / "manifest.json").read_text(encoding="utf-8"))
    made = 0
    for clip_id, texts in manifest.items():
        for lang, text in texts.items():
            if args.lang and lang != args.lang:
                continue
            path = AUDIO / lang / f"{clip_id}.mp3"
            if path.exists() and not args.force:
                continue
            out = await tts.synthesize(text, language=lang, pace=1.0)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(out["audio"])
            made += 1
            print(f"{lang}/{clip_id}.mp3 ({len(out['audio'])} bytes)")
    print(f"녹음 {made}개")


if __name__ == "__main__":
    asyncio.run(main())
