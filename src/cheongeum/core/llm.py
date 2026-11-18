"""
LLM 호출(모든 단계가 함께 씀): OpenAI 호환 Chat Completions + strict json_schema.
openai·ollama·qwen/openai-compatible. 모델 ID는 코드에 두지 않고 .env로만. 실패하면 None(호출자가 규칙으로 대체).
의도 계획 프롬프트·스키마는 understanding/llm_planner.py.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from cheongeum.core.jsutil import AbortSignal, jdumps, race_abort, rx

log = logging.getLogger("cheongeum.llm")


@dataclass
class LlmConfig:
    provider: str = "mock"
    model: str | None = None
    baseUrl: str | None = None
    apiKey: str | None = None
    # GPT-5 계열 추론량(minimal/low 등). 비우면 보내지 않는다. 음성 응답 지연을 줄이는 용도.
    reasoningEffort: str | None = None
    timeoutMs: int | None = None


def overlay_llm(base: LlmConfig, *, provider: str | None = None, model: str | None = None, base_url: str | None = None, api_key: str | None = None, reasoning_effort: str | None = None) -> LlmConfig:
    """역할별 덮어쓰기. 비어 있는 칸은 base를 그대로 쓴다. provider·model이 둘 다 없으면 base 자체."""
    if not provider and not model and not base_url and not api_key and not reasoning_effort:
        return base
    return LlmConfig(
        provider=provider or base.provider,
        model=model or base.model,
        baseUrl=base_url if base_url is not None else base.baseUrl,
        apiKey=api_key if api_key is not None else base.apiKey,
        reasoningEffort=reasoning_effort if reasoning_effort is not None else base.reasoningEffort,
        timeoutMs=base.timeoutMs,
    )


OPENAI_BASE_URL = "https://api.openai.com/v1"
OLLAMA_BASE_URL = "http://localhost:11434/v1"

# 글 하나만 돌려받는 구조화 출력(번역, 쉬운 말로 다시 말하기, 본문 요약이 함께 쓴다)
SIMPLE_TEXT_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["text"], "properties": {"text": {"type": "string"}}}


async def post_json(url: str, headers: dict, body: dict, timeout_s: float, signal: AbortSignal | None = None) -> dict | None:
    """POST → JSON. 실패하면 None."""

    async def go() -> dict | None:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            res = await client.post(url, headers=headers, content=jdumps(body).encode("utf-8"))
            if res.status_code < 200 or res.status_code >= 300:
                return None
            return res.json()

    try:
        return await race_abort(go(), signal) if signal is not None else await go()
    except Exception:  # noqa: BLE001
        return None


def message_content(body: dict | None) -> str | None:
    if not isinstance(body, dict):
        return None
    choices = body.get("choices") or []
    message = (choices[0] if choices else {}).get("message") or {}
    if not message.get("content") or message.get("refusal"):
        return None
    return message["content"]


class OpenAIStructuredLlm:
    """OpenAI Structured Outputs(strict json_schema) 범용 호출. 실패하면 None(호출자가 규칙 기반으로 대체)."""

    def __init__(
        self,
        *,
        model: str,
        base_url: str,
        api_key: str | None = None,
        reasoning_effort: str | None = None,
        timeout_ms: int | None = None,
        provider: str | None = None,
    ) -> None:
        self.model = model
        self.base_url = base_url
        self.api_key = api_key
        self.reasoning_effort = reasoning_effort
        self.timeout_ms = timeout_ms or 30_000
        self.name = f"{provider or 'openai'}({model})"

    async def generate(self, *, system: str, user: str, schemaName: str, schema: dict, signal: AbortSignal | None = None) -> Any | None:
        body: dict[str, Any] = {
            "model": self.model,
            "response_format": {"type": "json_schema", "json_schema": {"name": schemaName, "strict": True, "schema": schema}},
        }
        if self.reasoning_effort:
            body["reasoning_effort"] = self.reasoning_effort
        body["messages"] = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        res = await post_json(f"{self.base_url.rstrip('/')}/chat/completions", headers, body, self.timeout_ms / 1000, signal)
        content = message_content(res)
        if not content:
            return None
        try:
            return json.loads(content)
        except (json.JSONDecodeError, TypeError):
            return None


def create_structured_llm(cfg: LlmConfig):
    """
    구조화 LLM 만들기. OpenAI 호환 Chat Completions + json_schema를 쓰는 공급자 모두 지원:
     - openai: 키 필요, reasoning_effort 사용
     - qwen / openai-compatible: LLM_BASE_URL 필요(예: DashScope 호환 모드)
     - ollama: 로컬 Qwen 등(기본 http://localhost:11434/v1, 키 불필요)
    """
    provider = (cfg.provider or "mock").lower()
    if provider == "mock" or not cfg.model:
        return None
    base_url = cfg.baseUrl or (OPENAI_BASE_URL if provider == "openai" else OLLAMA_BASE_URL if provider == "ollama" else None)
    if not base_url:
        return None
    if provider != "ollama" and not cfg.apiKey and not rx(r"localhost|127\.0\.0\.1").search(base_url):
        return None
    return OpenAIStructuredLlm(
        provider=provider,
        model=cfg.model,
        base_url=base_url,
        api_key=cfg.apiKey,
        # reasoning_effort는 OpenAI 추론 모델 전용(다른 공급자는 거부할 수 있음)
        reasoning_effort=cfg.reasoningEffort if provider == "openai" else None,
        timeout_ms=60_000 if provider == "ollama" else None,
    )
