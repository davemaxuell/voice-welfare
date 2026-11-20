"""Stream one microphone utterance to the keyed Realtime transcription service."""
from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import AsyncIterable
from urllib.parse import urlsplit, urlunsplit

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from cheongeum.voice.errors import VoiceProviderError
from cheongeum.voice.stt import PROMPT_TERMS, is_hallucination, is_prompt_echo

LIVE_MODEL = "gpt-live-transcribe"
SAMPLE_RATE = 24_000


def _event(message) -> dict:
    event = json.loads(message)
    if event.get("type") == "error" or event.get("type") == "conversation.item.input_audio_transcription.failed":
        code = (event.get("error") or {}).get("code", "")
        status = {"invalid_api_key": 401, "permission_denied": 403, "model_not_found": 404,
                  "rate_limit_exceeded": 429, "insufficient_quota": 429}.get(code, 502)
        raise VoiceProviderError(status)
    return event


class LiveTranscriber:
    model = LIVE_MODEL

    def __init__(self, base_url: str, api_key: str):
        url = urlsplit(base_url)
        self.url = urlunsplit(("wss" if url.scheme == "https" else "ws", url.netloc,
                               url.path.rstrip("/") + "/realtime", "intent=transcription", ""))
        self._key = api_key

    async def transcribe(self, frames: AsyncIterable[bytes], language: str) -> str:
        inputs = {"format": {"type": "audio/pcm", "rate": SAMPLE_RATE}, "turn_detection": None,
                  "transcription": {"model": self.model, "delay": "low", "keywords": list(PROMPT_TERMS),
                                    "languages": list(dict.fromkeys([language, "ko", "en", "zh", "ja"]))}}
        try:
            async with connect(self.url, additional_headers={"Authorization": f"Bearer {self._key}"},
                               open_timeout=8, close_timeout=1, max_size=128_000) as socket:
                async with asyncio.timeout(8):
                    await socket.send(json.dumps({"type": "session.update", "session": {"type": "transcription", "audio": {"input": inputs}}}))
                    while _event(await socket.recv()).get("type") != "session.updated":
                        pass

                async def send_audio():
                    count = 0
                    async for frame in frames:
                        count += len(frame)
                        await socket.send(json.dumps({"type": "input_audio_buffer.append", "audio": base64.b64encode(frame).decode("ascii")}))
                    if count < SAMPLE_RATE // 5:  # 100 ms of 16-bit mono audio
                        return False
                    await socket.send(json.dumps({"type": "input_audio_buffer.commit"}))
                    return True

                async def receive_final():
                    item = None
                    while True:
                        event = _event(await socket.recv())
                        if event["type"] == "input_audio_buffer.committed":
                            item = event.get("item_id")
                        elif item and event["type"] == "conversation.item.input_audio_transcription.completed" and event.get("item_id") == item:
                            text = (event.get("transcript") or "").strip()
                            return "" if is_hallucination(text) or is_prompt_echo(text) else text

                sender = asyncio.create_task(send_audio())
                receiver = asyncio.create_task(receive_final())
                try:
                    done, _ = await asyncio.wait((sender, receiver), return_when=asyncio.FIRST_COMPLETED)
                    if receiver in done:
                        return receiver.result()
                    if not sender.result():
                        return ""
                    return await asyncio.wait_for(receiver, 15)
                finally:
                    sender.cancel()
                    receiver.cancel()
                    await asyncio.gather(sender, receiver, return_exceptions=True)
        except InvalidStatus as error:
            raise VoiceProviderError(error.response.status_code) from None
