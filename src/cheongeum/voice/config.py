"""앱에서 사용하는 받아쓰기와 음성 합성은 같은 인증된 API를 쓴다."""
from dataclasses import dataclass, field

from cheongeum.core.llm import OPENAI_BASE_URL
from cheongeum.core.model_stack import STACK
from cheongeum.voice.live import LIVE_MODEL, LiveTranscriber
from cheongeum.voice.stt import OpenAISttProvider, UnsupportedSttProvider
from cheongeum.voice.tts import OpenAITtsProvider, UnsupportedTtsProvider

DEFAULT_SPEED = 1.35


@dataclass
class VoiceConfig:
    apiKey: str | None = field(default=None, repr=False)
    baseUrl: str = OPENAI_BASE_URL
    sttModel: str = STACK.transcription
    ttsModel: str = "gpt-4o-mini-tts"
    ttsVoice: str = "coral"
    ttsInstructions: str | None = None
    ttsSpeed: float = DEFAULT_SPEED
    liveModel: str = STACK.voice


def create_voice_providers(cfg: VoiceConfig) -> tuple:
    if not cfg.apiKey:
        return UnsupportedSttProvider(), UnsupportedTtsProvider()
    base = cfg.baseUrl.rstrip("/")
    file_model = VoiceConfig.sttModel if cfg.sttModel == LIVE_MODEL else cfg.sttModel
    stt = OpenAISttProvider(api_key=cfg.apiKey, base_url=base, model=file_model)
    stt.live = LiveTranscriber(base, cfg.apiKey)
    # Live sessions use a different protocol from Realtime transcription.
    stt.edge_model = cfg.liveModel if base == OPENAI_BASE_URL and cfg.liveModel != LIVE_MODEL else None
    return (
        stt,
        OpenAITtsProvider(api_key=cfg.apiKey, base_url=base, model=cfg.ttsModel,
                          voice=cfg.ttsVoice, instructions=cfg.ttsInstructions, speed=cfg.ttsSpeed),
    )
