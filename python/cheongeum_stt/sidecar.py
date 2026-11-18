"""로컬 받아쓰기. 표준 출력은 요청 하나당 JSON 한 줄로만 쓴다."""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path


def decode_audio(data: bytes, rate: int = 16000):
    """
    브라우저 녹음(webm/opus·mp4)·wav·mp3 바이트 → 16kHz 모노 float32. PyAV로 푼다.
    faster-whisper의 decode_audio는 최신 PyAV에서 없어진 인자(metadata_errors)를 써서 직접 푼다.
    깨진 마지막 조각(녹음을 끊을 때 생김)은 건너뛴다.
    """
    import av
    import numpy as np
    from av.audio.resampler import AudioResampler

    resampler = AudioResampler(format="s16", layout="mono", rate=rate)
    parts: list = []
    with av.open(io.BytesIO(data), mode="r") as container:
        frames = container.decode(audio=0)
        while True:
            try:
                frame = next(frames)
            except StopIteration:
                break
            except av.error.InvalidDataError:
                continue
            parts += [f.to_ndarray().reshape(-1) for f in resampler.resample(frame)]
        parts += [f.to_ndarray().reshape(-1) for f in resampler.resample(None)]
    if not parts:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(parts).astype(np.float32) / 32768.0


class LocalWhisper:
    def __init__(self, directory: Path, threads: int, beam: int):
        self.directory = directory
        self.threads = max(0, threads)
        self.beam = max(1, beam)
        self.model = None

    def available(self) -> bool:
        import faster_whisper  # noqa: F401 — 파일과 실행 라이브러리를 모두 확인한다.

        return all((self.directory / name).is_file() for name in ("model.bin", "tokenizer.json"))

    def load(self):
        from faster_whisper import WhisperModel

        if self.model is None:
            self.model = WhisperModel(str(self.directory), device="cpu", compute_type="int8", cpu_threads=self.threads)
        return self.model

    def transcribe(self, audio: bytes, language: str | None, prompt: str | None) -> str:
        model = self.load()
        samples = decode_audio(audio)
        if samples.size == 0:
            return ""
        segments, _ = model.transcribe(
            samples,
            language=language,
            task="transcribe",
            beam_size=self.beam,
            vad_filter=True,
            condition_on_previous_text=False,
            without_timestamps=True,
            initial_prompt=prompt,
        )
        return " ".join(segment.text.strip() for segment in segments).strip()


def main() -> None:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    engine = LocalWhisper(Path(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]))
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request["id"]
            op = request["op"]
            if op == "available":
                reply = {"ok": engine.available()}
            elif op == "warm":
                engine.load()
                reply = {"ok": True}
            elif op == "transcribe":
                audio = Path(request["audioPath"]).read_bytes()
                reply = {"text": engine.transcribe(audio, request.get("language") or None, request.get("prompt"))}
            else:
                raise ValueError("unknown op")
        except Exception as exc:
            # 음성 내용이나 사용자 경로를 출력하지 않는다.
            reply = {"error": type(exc).__name__}
        print(json.dumps({"id": request_id, **reply}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
