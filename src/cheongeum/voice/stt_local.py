"""
STT(① 듣기) 로컬: 한국어 음성은 이 컴퓨터 안에서 받아쓴다(faster-whisper + seastar105/whisper-small-komixv2, CTranslate2 int8).
음성이 밖으로 나가지 않는다. 다른 언어는 설정된 다른 공급자(OpenAI)로 보내거나, 없으면 같은 로컬 모델로 받아쓴다.
모델 준비: uv run python scripts/setup_local_models.py
"""
from __future__ import annotations

import asyncio
import io
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Sequence

from cheongeum.core.jsutil import AbortSignal, race_abort
from cheongeum.voice.stt import STT_PROMPT, is_hallucination, is_prompt_echo

log = logging.getLogger("cheongeum.voice")

# 테스트용 대체 엔진: (오디오, 언어, 힌트) → 받아쓴 글
Engine = Callable[[bytes, "str | None", "str | None"], str]


class LocalWhisperStt:
    """faster-whisper를 이 프로세스 안에서 돌린다(별도 서버 없음). CPU int8."""

    supported = True

    def __init__(
        self,
        model_dir: str | Path,
        *,
        threads: int = 0,
        beam_size: int = 1,
        use_prompt: bool = False,
        engine: Engine | None = None,
        label: str | None = None,
    ) -> None:
        self.model_dir = Path(model_dir)
        self.threads = max(0, threads)
        self.beam_size = max(1, beam_size)
        self.use_prompt = use_prompt
        self._engine = engine
        self._model: Any = None
        self._load_lock = threading.Lock()
        # 받아쓰기는 한 번에 하나(CPU를 나눠 쓰면 둘 다 느려진다). 이벤트 루프(Playwright·모든 세션)는 막지 않는다.
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stt-local")
        self.name = f"local({label or _model_label(self.model_dir)})"

    @staticmethod
    def available(model_dir: str | Path) -> bool:
        """변환된 모델이 있는지. tokenizer.json이 없으면 faster-whisper가 실행 중에 내려받으려 하므로 필수로 본다."""
        d = Path(model_dir)
        return (d / "model.bin").is_file() and (d / "tokenizer.json").is_file()

    def warm(self) -> None:
        """서버 시작 때 백그라운드 스레드에서 모델을 미리 불러온다(첫 말이 늦지 않게)."""
        try:
            self._load()
        except Exception as e:  # noqa: BLE001
            log.error("[voice] 로컬 받아쓰기 모델을 불러오지 못했습니다(%s)", type(e).__name__)

    def _load(self) -> None:
        if self._engine is not None or self._model is not None:
            return
        with self._load_lock:
            if self._model is None:
                from faster_whisper import WhisperModel

                self._model = WhisperModel(str(self.model_dir), device="cpu", compute_type="int8", cpu_threads=self.threads)
                log.info("[voice] 로컬 받아쓰기 모델 준비: %s", self.name)

    def _run(self, audio: bytes, language: str | None, prompt: str | None) -> str:
        if self._engine is not None:
            return self._engine(audio, language, prompt)
        self._load()
        samples = decode_audio(audio)
        if samples.size == 0:
            return ""
        segments, _info = self._model.transcribe(
            samples,
            language=language,
            task="transcribe",
            beam_size=self.beam_size,
            vad_filter=True,  # 말소리 없는 구간을 버린다(무음에서 글을 지어내는 것을 줄임)
            condition_on_previous_text=False,
            without_timestamps=True,
            initial_prompt=prompt,
        )
        # 생성기라 이 스레드 안에서 끝까지 읽는다
        return " ".join(s.text.strip() for s in segments).strip()

    async def transcribe(self, audio: bytes, *, language: str, mime_type: str, signal: AbortSignal | None = None) -> dict:
        # 한국어 용어 힌트는 켰을 때만(미세조정 모델은 힌트를 되뱉기 쉽다)
        prompt = STT_PROMPT if self.use_prompt and language == "ko" else None
        work = asyncio.get_running_loop().run_in_executor(self._executor, self._run, audio, language or None, prompt)
        # 멈춤 신호가 오면 기다리지 않는다(이미 시작한 계산은 끝까지 돌지만 결과는 버린다)
        text = (await race_abort(work, signal) if signal is not None else await work).strip()
        if is_prompt_echo(text) or is_hallucination(text):
            return {"text": ""}
        return {"text": text}


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


def _model_label(model_dir: Path) -> str:
    """'whisper-small-komixv2-ct2' → 'whisper-small-komixv2'"""
    name = model_dir.name
    return name[: -len("-ct2")] if name.endswith("-ct2") else name


class LanguageRoutedStt:
    """
    대화 언어로 받아쓰기 공급자를 고른다: local_languages는 이 컴퓨터에서, 나머지는 other(OpenAI)로.
    other가 없으면 모든 언어를 로컬 모델로 받아쓴다(음성이 밖으로 나가지 않음).
    """

    supported = True

    def __init__(self, local: Any, other: Any = None, local_languages: Sequence[str] = ("ko",), all_languages: Sequence[str] = ()) -> None:
        self.local = local
        self.other = other
        self.localLanguages = list(local_languages) if other is not None else list(all_languages or local_languages)
        self.name = f"{local.name}+{other.name}" if other is not None else local.name

    def pick(self, language: str) -> Any:
        return self.local if self.other is None or language in self.localLanguages else self.other

    def warm(self) -> None:
        warm = getattr(self.local, "warm", None)
        if warm:
            warm()

    async def transcribe(self, audio: bytes, *, language: str, mime_type: str, signal: AbortSignal | None = None) -> dict:
        return await self.pick(language).transcribe(audio, language=language, mime_type=mime_type, signal=signal)
