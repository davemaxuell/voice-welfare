"""로컬 받아쓰기. 표준 출력은 요청 하나당 JSON 한 줄로만 쓴다."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from cheongeum.voice.stt_local import LocalWhisperStt


def main() -> None:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    engine = LocalWhisperStt(sys.argv[1], threads=int(sys.argv[2]), beam_size=int(sys.argv[3]))
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request["id"]
            op = request["op"]
            if op == "available":
                import faster_whisper  # noqa: F401

                reply = {"ok": engine.available(engine.model_dir)}
            elif op == "warm":
                engine._load()
                reply = {"ok": True}
            elif op == "transcribe":
                audio = Path(request["audioPath"]).read_bytes()
                reply = {"text": engine._run(audio, request.get("language") or None, request.get("prompt"))}
            else:
                raise ValueError("unknown op")
        except Exception as exc:
            # 음성 내용이나 사용자 경로를 출력하지 않는다.
            reply = {"error": type(exc).__name__}
        print(json.dumps({"id": request_id, **reply}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
