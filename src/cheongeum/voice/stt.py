"""
STT(① 듣기): 서버가 키를 갖고 공급자를 호출하며, 클라이언트는 키를 모른다. 오디오는 저장·로그하지 않는다.
"""
from __future__ import annotations

import httpx

from cheongeum.core.jsutil import AbortSignal, I, race_abort, rx
from cheongeum.voice.errors import VoiceNotSupportedError, VoiceProviderError


class UnsupportedSttProvider:
    name = "unconfigured"
    supported = False

    async def transcribe(self, audio: bytes, *, language: str, mime_type: str, signal: AbortSignal | None = None) -> dict:
        raise VoiceNotSupportedError("음성 입력을 사용하려면 이용 설정에서 OpenAI API 키를 등록해 주세요.")


EXTENSIONS = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/flac": "flac",
    "audio/aac": "aac",
}


def audio_extension(mime_type: str) -> str:
    return EXTENSIONS.get(mime_type.split(";")[0].strip(), "webm")


# 복지 신청 용어 인식을 돕는 힌트. 사용자 발화가 아니라 고정 문구다.
STT_PROMPT = "청음아, 정부24, 주민등록등본, 국민신문고, 민원, 한국장학재단, 국가장학금, 고용24, 홈택스, 복지로, 장애인연금, 다음으로, 이전으로, 멈춰."
PROMPT_TERMS = tuple(t.strip(" .") for t in STT_PROMPT.split(","))
# 외국어로 말하면 힌트를 영어로 옮겨 내놓기도 한다
PROMPT_TERMS_EN = [
    rx(p, I)
    for p in (
        r"government\s*24", r"resident registration", r"civil (?:petition|complaint)",
        r"student aid foundation", r"national scholarship", r"employment\s*24", r"hometax", r"bokjiro",
    )
]


def is_prompt_echo(text: str) -> bool:
    """받아쓴 글이 힌트 낱말을 여러 개 그대로(또는 영어로 옮겨) 담고 있으면 힌트를 되뱉은 것으로 본다."""
    t = rx(r"\s+").sub("", text)
    hits = [term for term in PROMPT_TERMS if term in t]
    # 여러 기관을 한 요청에 말할 수 있다. 힌트가 대부분을 차지하는 나열만 재시도한다.
    return (len(hits) >= 4 and sum(map(len, hits)) >= len(t) * 0.70) or sum(bool(p.search(text)) for p in PROMPT_TERMS_EN) >= 4


# Whisper 계열이 무음·잡음에서 지어내는 글(동영상 자막으로 배운 끝인사 등). 받아쓴 글 전체가 이것뿐이면 버린다.
# "감사합니다"만 한 말은 사용자가 실제로 하기도 해서 넣지 않는다.
_HALLUCINATION = rx(
    r"^(시청\s*해\s*주셔서\s*감사합니다|시청\s*감사합니다|구독(과|이랑)?\s*좋아요(\s*(부탁|눌러)[^.!]*)?|좋아요(와|랑)?\s*구독(\s*(부탁|눌러)[^.!]*)?|"
    r"다음\s*(영상|시간)에\s*(서\s*)?(만나요|뵙겠습니다|만나겠습니다)|MBC\s*뉴스\s*\S*입니다|.{0,10}\s*뉴스\s*\S{2,4}입니다|"
    r"자막\s*(제공|by)[^.!]*|Thanks?\s*(you\s*)?for\s*watching)$",
    I,
)


def is_hallucination(text: str) -> bool:
    """받아쓴 글이 무음에서 흔히 지어내는 문장 하나뿐인지(문장부호·공백 무시)."""
    t = rx(r"[\s.!?。~,]+$").sub("", rx(r"^[\s.!?。~,]+").sub("", text))
    return bool(t) and bool(_HALLUCINATION.search(t))


class OpenAISttProvider:
    """OpenAI /audio/transcriptions. 모델 ID는 STT_MODEL로만 주입한다."""

    supported = True

    def __init__(self, *, api_key: str, base_url: str, model: str, timeout_ms: int = 20_000) -> None:
        self.api_key = api_key
        self.base_url = base_url
        self.model = model
        self.timeout = timeout_ms / 1000
        if not api_key:
            raise ValueError("받아쓰기 API 키가 필요합니다.")
        self.name = f"openai({model})"

    async def transcribe(self, audio: bytes, *, language: str, mime_type: str, signal: AbortSignal | None = None) -> dict:
        text = await self._request(audio, mime_type, language, signal)
        # 다른 언어로 말하거나 소리가 불분명하면 모델이 받아쓰기 힌트(prompt)를 그대로 내놓는 일이 있다.
        # 그 글을 명령으로 쓰면 안 되므로 버리고, 언어 자동 감지로 한 번 더 받아쓴다(예: 한국어 모드에서 "English please").
        if is_prompt_echo(text):
            retry = await self._request(audio, mime_type, None, signal)
            return {"text": "" if is_prompt_echo(retry) else retry}
        return {"text": text}

    async def _request(self, audio: bytes, mime_type: str, language: str | None, signal: AbortSignal | None) -> str:
        type_ = mime_type.split(";")[0].strip() or "audio/webm"
        data = {"model": self.model, "response_format": "json"}
        if language and self.model == "gpt-transcribe":
            data["languages[]"] = list(dict.fromkeys([language, "ko", "en", "zh", "ja"]))
            data["keywords[]"] = list(PROMPT_TERMS)
        elif language:
            data["language"] = language
        # 한국어 용어 힌트는 한국어로 받아쓸 때만(다른 언어에 섞으면 힌트를 그대로 내놓기 쉽다)
        if language == "ko" and self.model != "gpt-transcribe":
            data["prompt"] = STT_PROMPT
        headers = {"Authorization": f"Bearer {self.api_key}"}

        async def go() -> str:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                res = await client.post(
                    f"{self.base_url}/audio/transcriptions",
                    headers=headers,
                    data=data,
                    files={"file": (f"speech.{audio_extension(type_)}", audio, type_)},
                )
                if res.status_code < 200 or res.status_code >= 300:
                    raise VoiceProviderError(res.status_code)
                return (res.json().get("text") or "").strip()

        return await race_abort(go(), signal) if signal is not None else await go()
