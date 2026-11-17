"""
TTS(⑥ 말하기): 서버가 키를 갖고 공급자를 호출한다. 오디오는 저장·로그하지 않는다.
"""
from __future__ import annotations

import httpx

from ieum.core.jsutil import AbortSignal, race_abort
from ieum.voice.errors import VoiceNotSupportedError, VoiceProviderError


class UnsupportedTtsProvider:
    name = "browser-only"
    supported = False

    async def synthesize(self, text: str, *, language: str, signal: AbortSignal | None = None) -> dict:
        raise VoiceNotSupportedError("서버 TTS가 설정되지 않았습니다. 브라우저 음성 합성을 사용하세요.")


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
        self.api_key = api_key
        self.base_url = base_url
        self.model = model
        self.voice = voice
        self.instructions = instructions
        self.speed = speed
        self.timeout = timeout_ms / 1000
        self.name = f"openai({model}, {voice})"

    async def synthesize(self, text: str, *, language: str, signal: AbortSignal | None = None) -> dict:
        body: dict = {"model": self.model, "voice": self.voice, "input": text, "response_format": "mp3"}
        # 말투 지시(TTS_INSTRUCTIONS)는 한국어용이라 다른 언어에서는 쓰지 않는다
        if self.instructions and language == "ko":
            body["instructions"] = self.instructions
        if self.speed and self.speed != 1:
            body["speed"] = self.speed

        async def go() -> dict:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                res = await client.post(
                    f"{self.base_url}/audio/speech",
                    headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                    json=body,
                )
                if res.status_code < 200 or res.status_code >= 300:
                    raise VoiceProviderError(res.status_code)
                return {"audio": res.content, "mimeType": "audio/mpeg"}

        return await race_abort(go(), signal) if signal is not None else await go()
