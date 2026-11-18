"""
STT·TTS 공급자 고르기. 설정하지 않으면 미지원(웹은 브라우저 음성으로 대체).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from cheongeum.core.turn import LANGS
from cheongeum.voice.stt import OpenAISttProvider, UnsupportedSttProvider
from cheongeum.voice.stt_local import LanguageRoutedStt, LocalWhisperStt
from cheongeum.voice.tts import OpenAITtsProvider, UnsupportedTtsProvider

log = logging.getLogger("cheongeum.voice")


@dataclass
class VoiceConfig:
    stt: str | None = None
    tts: str | None = None
    apiKey: str | None = None
    baseUrl: str | None = None
    # 받아쓰기만 다른 서버로(예: 로컬 오픈소스 Whisper 계열의 OpenAI 호환 서버). STT_PROVIDER=local일 때
    sttBaseUrl: str | None = None
    sttModel: str | None = None
    # 이 프로세스 안에서 돌리는 로컬 받아쓰기(faster-whisper) 모델 폴더. STT_PROVIDER=local이고 STT_BASE_URL이 없을 때
    sttLocalModel: str | None = None
    sttLocalThreads: int = 0
    sttLocalBeam: int = 1
    sttLocalPrompt: bool = False
    ttsModel: str | None = None
    ttsVoice: str | None = None
    ttsInstructions: str | None = None
    # 말하기 속도 배율(0.25~4, 기본 1)
    ttsSpeed: float | None = None


def create_voice_providers(cfg: VoiceConfig) -> tuple:
    """→ (stt, tts)"""
    base_url = (cfg.baseUrl or "https://api.openai.com/v1").rstrip("/")

    def pick(kind: str, provider: str | None, model: str | None, make, none):
        p = (provider or "mock").lower()
        if p in ("mock", "browser"):
            return none
        if p != "openai":
            log.warning("[voice] %s_PROVIDER=%s 어댑터는 아직 없습니다 → 브라우저 음성 사용", kind, p)
            return none
        if not cfg.apiKey or not model:
            log.warning("[voice] %s: API 키 또는 %s_MODEL 미설정 → 브라우저 음성 사용", kind, kind)
            return none
        return make()

    local = (cfg.stt or "").lower() == "local"
    # 로컬 오픈소스 받아쓰기(OpenAI 호환 /audio/transcriptions, 키 불필요): 음성이 컴퓨터 밖으로 나가지 않고 비용이 없다
    if local and cfg.sttBaseUrl:
        stt = OpenAISttProvider(api_key="", base_url=cfg.sttBaseUrl.rstrip("/"), model=cfg.sttModel or "whisper-1")
    elif local and cfg.sttLocalModel:
        stt = _local_stt(cfg, base_url)
    else:
        stt = pick(
            "STT",
            cfg.stt,
            cfg.sttModel,
            lambda: OpenAISttProvider(api_key=cfg.apiKey or "", base_url=base_url, model=cfg.sttModel or ""),
            UnsupportedSttProvider(),
        )
    tts = pick(
        "TTS",
        cfg.tts,
        cfg.ttsModel,
        lambda: OpenAITtsProvider(
            api_key=cfg.apiKey or "",
            base_url=base_url,
            model=cfg.ttsModel or "",
            voice=cfg.ttsVoice or "alloy",
            instructions=cfg.ttsInstructions,
            speed=cfg.ttsSpeed,
        ),
        UnsupportedTtsProvider(),
    )
    return stt, tts


def _local_stt(cfg: VoiceConfig, base_url: str):
    """
    한국어는 이 컴퓨터에서(faster-whisper), 다른 언어는 OpenAI(키·STT_MODEL이 있을 때) 또는 같은 로컬 모델로.
    모델이 없거나 faster-whisper를 불러올 수 없으면 서버 받아쓰기를 끈다: 한국어 음성을 몰래 OpenAI로 보내지 않는다.
    """
    model_dir = cfg.sttLocalModel or ""
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        log.error("[voice] STT_PROVIDER=local: faster-whisper를 불러올 수 없습니다(uv sync) → 서버 받아쓰기 끔")
        return UnsupportedSttProvider()
    if not LocalWhisperStt.available(model_dir):
        log.error("[voice] STT_LOCAL_MODEL=%s 에 모델이 없습니다. uv run python scripts/setup_local_models.py 를 실행하세요 → 서버 받아쓰기 끔", model_dir)
        return UnsupportedSttProvider()
    local = LocalWhisperStt(model_dir, threads=cfg.sttLocalThreads, beam_size=cfg.sttLocalBeam, use_prompt=cfg.sttLocalPrompt)
    other = (
        OpenAISttProvider(api_key=cfg.apiKey, base_url=base_url, model=cfg.sttModel)
        if cfg.apiKey and cfg.sttModel
        else None
    )
    return LanguageRoutedStt(local, other, local_languages=("ko",), all_languages=LANGS)
