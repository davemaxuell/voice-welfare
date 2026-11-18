"""STT·TTS 공급자(① 듣기, ⑥ 말하기). 마이크·스피커 쪽 처리(VAD·끼어들기·재생)는 브라우저 web/static에서 한다."""

from cheongeum.voice.config import VoiceConfig, create_voice_providers
from cheongeum.voice.errors import VoiceNotSupportedError, VoiceProviderError
from cheongeum.voice.stt import OpenAISttProvider, UnsupportedSttProvider, audio_extension, is_prompt_echo
from cheongeum.voice.tts import OpenAITtsProvider, UnsupportedTtsProvider

__all__ = [
    "OpenAISttProvider",
    "OpenAITtsProvider",
    "UnsupportedSttProvider",
    "UnsupportedTtsProvider",
    "VoiceConfig",
    "VoiceNotSupportedError",
    "VoiceProviderError",
    "audio_extension",
    "create_voice_providers",
    "is_prompt_echo",
]
