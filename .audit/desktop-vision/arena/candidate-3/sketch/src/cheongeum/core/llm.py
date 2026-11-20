"""
core/llm.py: 바뀌는 곳만. 나머지(post_json:52, message_content:68, OpenAIStructuredLlm:78, create_structured_llm:119)는 그대로.

바꾸는 것은 하나다: generate(llm.py:98)가 본문을 조립하던 열 줄을 chat_request로 빼서 OpenAIVisionLlm.look과 함께 쓴다.
generate의 시그니처(user: str)는 건드리지 않는다. tests/conftest.py:98 FakeLlm과 scripted()(json.loads(user))가 user가 문자열이라고 가정하기 때문이다.
"""
from __future__ import annotations

from typing import Any


def chat_request(
    *,
    model: str,
    system: str,
    user: str | list[dict],
    schemaName: str,
    schema: dict,
    reasoning_effort: str | None = None,
) -> dict[str, Any]:
    """
    Chat Completions 요청 본문. user가 str이면 글 호출(generate), list면 content 배열(사진 호출).
    response_format은 둘 다 strict json_schema. reasoning_effort가 있으면 그대로 싣는다.
    (현재 generate 본문: llm.py:99-105 를 그대로 옮긴 것)
    """
    raise NotImplementedError


# OpenAIStructuredLlm.generate 안에서는 이렇게 바뀐다:
#
#   body = chat_request(model=self.model, system=system, user=user, schemaName=schemaName, schema=schema,
#                       reasoning_effort=self.reasoning_effort)
#   headers = ...  (그대로)
#   res = await post_json(...)  (그대로)
