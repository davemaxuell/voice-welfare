"""
TTS(⑥ 말하기): 서버가 키를 갖고 공급자를 호출한다. 오디오는 저장·로그하지 않는다.
"""
from __future__ import annotations

import httpx

from cheongeum.core.jsutil import AbortSignal, race_abort
from cheongeum.core.voice_profile import VOICE_PROFILE
from cheongeum.voice.errors import VoiceNotSupportedError, VoiceProviderError


class UnsupportedTtsProvider:
    name = "unconfigured"
    supported = False

    async def synthesize(self, text: str, *, language: str, signal: AbortSignal | None = None, pace: float | None = None) -> dict:
        raise VoiceNotSupportedError("음성 안내를 사용하려면 이용 설정에서 OpenAI API 키를 등록해 주세요.")


class OpenAITtsProvider:
    """OpenAI /audio/speech. 모델·목소리는 TTS_MODEL, TTS_VOICE로만 주입한다."""

    supported = True

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        voice: str,
        instructions: str | None = None,
        speed: float | None = None,
        timeout_ms: int = 20_000,
    ) -> None:
        if not api_key:
            raise ValueError("음성 합성 API 키가 필요합니다.")
        self.api_key = api_key
        self.base_url = base_url
        self.model = model
        self.voice = voice
        self.instructions = instructions or VOICE_PROFILE.instructions
        self.speed = speed
        self.timeout = timeout_ms / 1000
        self.name = f"openai({model}, {voice})"

    async def synthesize(self, text: str, *, language: str, signal: AbortSignal | None = None, pace: float | None = None) -> dict:
        """pace: 사용자의 말 빠르기 설정(보통=1). 설정한 기본 속도(TTS_SPEED)에 곱한다."""
        body = {"model": self.model, "voice": self.voice, "input": text, "response_format": "mp3",
                "instructions": self.instructions}
        speed = min(4.0, max(0.25, (self.speed or 1) * (pace or 1)))
        if abs(speed - 1) > 1e-9:
            body["speed"] = speed

        async def go() -> dict:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                res = await client.post(
                    f"{self.base_url}/audio/speech",
                    headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                    json=body,
                )
                if res.status_code < 200 or res.status_code >= 300:
                    try:
                        error = res.json().get("error")
                    except (ValueError, AttributeError):
                        error = None
                    code = error.get("code") if isinstance(error, dict) else None
                    raise VoiceProviderError(res.status_code, retry_after=res.headers.get("Retry-After"), provider_code=code)
                return {"audio": res.content, "mimeType": "audio/mpeg"}

        return await race_abort(go(), signal) if signal is not None else await go()
