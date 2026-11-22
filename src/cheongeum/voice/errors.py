"""STT·TTS 공급자 오류."""
from __future__ import annotations


class VoiceNotSupportedError(Exception):
    code = "NOT_SUPPORTED"


class VoiceProviderError(Exception):
    def __init__(self, status: int, *, retry_after: str | None = None, provider_code: str | None = None) -> None:
        super().__init__(f"voice provider error (HTTP {status})")
        self.status = status
        self.retry_after = retry_after
        self.provider_code = provider_code
