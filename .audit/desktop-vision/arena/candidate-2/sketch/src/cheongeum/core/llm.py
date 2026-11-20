"""
[바뀌는 것만] core/llm.py

OpenAIStructuredLlm.generate(user: str)는 그대로 둔다(llm.py:98). 사진은 다른 클래스·다른 메서드로만 간다.
"""
from __future__ import annotations

from typing import Any

from cheongeum.core.jsutil import AbortSignal
from cheongeum.core.llm import LlmConfig  # 기존
from cheongeum.core.picture import Picture


class OpenAIVisionLlm:
    """
    OpenAI Chat Completions에 사진 한 장을 보내는 호출(strict json_schema). VisionLlm 구현.
    messages = [{system}, {user: [{"type":"text","text":user}, {"type":"image_url","image_url":{"url":picture.data_url(),"detail":detail}}]}]
    post_json·message_content(llm.py:52, :68)를 그대로 쓴다. 실패·거절이면 None.
    """

    def __init__(self, *, model: str, api_key: str, base_url: str, reasoning_effort: str | None = None, timeout_ms: int = 30_000, detail: str = "high") -> None:
        self.name = f"openai-vision({model})"
        raise NotImplementedError

    async def see(
        self, *, system: str, user: str, picture: Picture, schemaName: str, schema: dict, signal: AbortSignal | None = None
    ) -> Any | None:
        raise NotImplementedError


def create_vision_llm(cfg: LlmConfig) -> OpenAIVisionLlm | None:
    """
    사진 역할(LLM_VISION_*) 만들기. 주인 결정(2026-11-18): 사진은 OpenAI(호스팅)로만 간다.
    그래서 provider가 "openai"가 아니거나 키·모델이 없으면 None이다. ollama·qwen·openai-compatible로 떨어지지 않는다.
    None이면 사진 기능이 꺼진다(Eyes.on == False → "사진 설명은 지금 꺼져 있어요" + 글 설명).
    """
    raise NotImplementedError
