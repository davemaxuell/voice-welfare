"""
[바뀌는 부분만] core/llm.py

1. ImagePart: 그림 한 장(바이트 + 형식 + 해상도 힌트). vision이 MaskedShot에서만 만든다.
2. OpenAIStructuredLlm.generate(..., images=()): 그림이 있으면 user 메시지 content를 목록으로 만든다.
   그림이 없으면 요청 본문은 지금(llm.py:99-105)과 바이트까지 같다(시험으로 고정).
3. create_vision_llm: LLM_VISION_* 역할. 주인 결정(2026-11-18)에 따라 OpenAI(호스팅)만 만든다.
   WEB 역할은 글만 받는 로컬 모델(ollama·qwen)일 수 있어 그림을 그쪽으로 보내지 않는다.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any, Literal, Protocol, Sequence

from cheongeum.core.jsutil import AbortSignal


@dataclass(frozen=True)
class ImagePart:
    mime: Literal["image/png", "image/jpeg"]
    data: bytes
    # high = 작은 글자를 읽어야 할 때(기본). 비용·지연은 S1 시험에서 잰다.
    detail: Literal["low", "high", "auto"] = "high"

    def data_url(self) -> str:
        """data:{mime};base64,... (로그·기록에 남기지 않는다)"""
        raise NotImplementedError


def user_content(user: str, images: Sequence[ImagePart]) -> str | list[dict]:
    """
    그림이 없으면 user 문자열 그대로(지금과 같은 본문).
    있으면 [{"type": "text", "text": user}, {"type": "image_url", "image_url": {"url": data_url, "detail": ...}}, ...].
    """
    raise NotImplementedError


class VisionLlm(Protocol):
    """그림을 받는 구조화 LLM 경계(StructuredLlm과 같고 images가 더 있다). 시험은 tests/fakes/vision.py의 FakeVision."""

    name: str

    async def generate(
        self,
        *,
        system: str,
        user: str,
        schemaName: str,
        schema: dict,
        images: Sequence[ImagePart],
        signal: AbortSignal | None = None,
    ) -> Any | None: ...


class OpenAIStructuredLlm:
    # __init__은 그대로(llm.py:81-96)

    async def generate(
        self,
        *,
        system: str,
        user: str,
        schemaName: str,
        schema: dict,
        signal: AbortSignal | None = None,
        images: Sequence[ImagePart] = (),
    ) -> Any | None:
        """
        지금 본문(llm.py:99-105)에서 user 메시지 content만 user_content(user, images)로 바꾼다.
        images는 키워드 뒤쪽 기본값이라 지금 부르는 곳(글만)은 아무것도 바뀌지 않는다.
        """
        raise NotImplementedError


def create_vision_llm(cfg: "LlmConfig") -> OpenAIStructuredLlm | None:  # noqa: F821  (LlmConfig는 같은 모듈)
    """
    LLM_VISION_*(없으면 기본 LLM_*)로 그림 설명 LLM을 만든다.
    provider가 openai가 아니면 None(그림 설명 꺼짐). 키가 없어도 None.
    VISION=off면 부르는 쪽(runtime)이 아예 부르지 않는다.
    """
    raise NotImplementedError
