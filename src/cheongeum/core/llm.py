"""
LLM 호출(모든 단계가 함께 씀): OpenAI 호환 Chat Completions + strict json_schema.
openai·ollama·qwen/openai-compatible. 모델 ID는 코드에 두지 않고 .env로만. 실패하면 None(호출자가 규칙으로 대체).
의도 계획 프롬프트·스키마는 understanding/llm_planner.py.
화면 사진은 글 호출(generate)과 다른 클래스·다른 메서드(OpenAIVisionLlm.see)로만 간다.
"""
from __future__ import annotations

import base64
import json
import logging
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from cheongeum.core.jsutil import AbortSignal, jdumps, race_abort, rx
from cheongeum.core.picture import Picture

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


@dataclass(frozen=True)
class FileAttachment:
    name: str
    mime: str
    content: bytes

    def content_part(self) -> dict:
        url = f"data:{self.mime};base64,{base64.b64encode(self.content).decode('ascii')}"
        if self.mime == "application/pdf":
            return {"type": "file", "file": {"filename": self.name, "file_data": url}}
        return {"type": "image_url", "image_url": {"url": url}}


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

# A delegated turn may override effort for one model family without changing shared clients.
REASONING_EFFORT_OVERRIDE: ContextVar[tuple[str, str] | None] = ContextVar("reasoning_effort_override", default=None)


def resolve_reasoning_effort(model: str, base_url: str, default: str | None) -> str | None:
    override = REASONING_EFFORT_OVERRIDE.get()
    if override and base_url.rstrip("/") == OPENAI_BASE_URL:
        family, effort = override
        if model == family or model.startswith(f"{family}-"):
            return effort
    return default


# 글 하나만 돌려받는 구조화 출력(번역, 쉬운 말로 다시 말하기, 본문 요약이 함께 쓴다)
SIMPLE_TEXT_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["text"], "properties": {"text": {"type": "string"}}}


class ModelConnections:
    """역할별 인증은 요청에만 두고, 런타임에서 HTTP 연결을 재사용한다."""
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None

    async def post(self, url: str, headers: dict, body: bytes, timeout: float) -> httpx.Response:
        if self._client is None:
            self._client = httpx.AsyncClient()
        request = self._client.build_request("POST", url, headers=headers, content=body, timeout=timeout)
        request.headers.pop("cookie", None)
        return await self._client.send(request)

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None


async def post_json(url: str, headers: dict, body: dict, timeout_s: float, signal: AbortSignal | None = None,
                    pool: ModelConnections | None = None) -> dict | None:
    """POST → JSON. 실패하면 None."""

    async def go() -> dict | None:
        encoded = jdumps(body).encode("utf-8")
        if pool is not None:
            res = await pool.post(url, headers, encoded, timeout_s)
        else:
            async with httpx.AsyncClient(timeout=timeout_s) as client:
                res = await client.post(url, headers=headers, content=encoded)
        return res.json() if res.is_success else None

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


class _OpenAIChat:
    """Chat Completions 한 번(strict json_schema). 글 호출과 사진 호출이 같은 요청·같은 실패 처리(None)를 쓴다."""

    def __init__(
        self,
        *,
        model: str,
        base_url: str,
        api_key: str | None = None,
        reasoning_effort: str | None = None,
        timeout_ms: int | None = None,
        provider: str | None = None,
        pool: ModelConnections | None = None,
    ) -> None:
        self.model = model
        self.pool = pool
        self.usage = {"calls": 0, "inputTokens": 0, "outputTokens": 0}
        self.base_url = base_url
        self.api_key = api_key
        self.reasoning_effort = reasoning_effort
        self.timeout_ms = timeout_ms or 30_000
        self.name = f"{provider or 'openai'}({model})"
        self.provider = provider or "openai"
        self.file_recipient = "OpenAI" if base_url.rstrip("/") == OPENAI_BASE_URL else f"설정된 서버 {urlsplit(base_url).hostname}"

    async def _ask(self, *, system: str, content: str | list[dict], schemaName: str, schema: dict, signal: AbortSignal | None) -> Any | None:
        body: dict[str, Any] = {
            "model": self.model,
            "response_format": {"type": "json_schema", "json_schema": {"name": schemaName, "strict": True, "schema": schema}},
        }
        effort = self.reasoning_effort
        if self.provider == "openai":
            effort = resolve_reasoning_effort(self.model, self.base_url, effort)
        if effort:
            body["reasoning_effort"] = effort
        body["messages"] = [{"role": "system", "content": system}, {"role": "user", "content": content}]
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        self.usage["calls"] += 1
        res = await post_json(f"{self.base_url.rstrip('/')}/chat/completions", headers, body, self.timeout_ms / 1000, signal, self.pool)
        usage = res.get("usage") if isinstance(res, dict) else None
        if isinstance(usage, dict):
            for local, remote in (("inputTokens", "prompt_tokens"), ("outputTokens", "completion_tokens")):
                if isinstance(usage.get(remote), int):
                    self.usage[local] += usage[remote]
        content_out = message_content(res)
        if not content_out:
            return None
        try:
            return json.loads(content_out)
        except (json.JSONDecodeError, TypeError):
            return None


class OpenAIStructuredLlm(_OpenAIChat):
    """OpenAI Structured Outputs(strict json_schema) 범용 호출. 실패하면 None(호출자가 규칙 기반으로 대체)."""

    async def generate(self, *, system: str, user: str, schemaName: str, schema: dict, signal: AbortSignal | None = None, attachment: FileAttachment | None = None) -> Any | None:
        content: str | list[dict] = user
        if attachment is not None:
            if self.provider != "openai":
                return None
            content = [{"type": "text", "text": user}, attachment.content_part()]
        return await self._ask(system=system, content=content, schemaName=schemaName, schema=schema, signal=signal)


class OpenAIVisionLlm(_OpenAIChat):
    """
    화면 사진 한 장을 보는 호출. generate가 없어 글 역할(의도·목표·답)을 대신할 수 없고,
    see는 Picture(가림이 끝난 사진)만 받는다. 바이트·파일 경로·주소를 받는 길은 없다.
    """

    def __init__(self, *, detail: str = "high", **chat: Any) -> None:
        super().__init__(**chat)
        self.detail = detail

    async def see(
        self, *, system: str, user: str, picture: Picture, schemaName: str, schema: dict, signal: AbortSignal | None = None
    ) -> Any | None:
        if not isinstance(picture, Picture):
            raise TypeError("see는 Picture만 받습니다.")
        content = [
            {"type": "text", "text": user},
            {"type": "image_url", "image_url": {"url": picture.data_url(), "detail": self.detail}},
        ]
        return await self._ask(system=system, content=content, schemaName=schemaName, schema=schema, signal=signal)


def _endpoint(cfg: LlmConfig) -> tuple[str, str] | None:
    """(공급자, 주소). 쓸 수 없는 설정(mock, 모델·주소·키 없음)이면 None."""
    provider = (cfg.provider or "mock").lower()
    if provider == "mock" or not cfg.model:
        return None
    base_url = cfg.baseUrl or (OPENAI_BASE_URL if provider == "openai" else OLLAMA_BASE_URL if provider == "ollama" else None)
    if not base_url:
        return None
    if provider != "ollama" and not cfg.apiKey and not rx(r"localhost|127\.0\.0\.1").search(base_url):
        return None
    return provider, base_url


def create_structured_llm(cfg: LlmConfig, *, pool: ModelConnections | None = None):
    """
    구조화 LLM 만들기. OpenAI 호환 Chat Completions + json_schema를 쓰는 공급자 모두 지원:
     - openai: 키 필요, reasoning_effort 사용
     - qwen / openai-compatible: LLM_BASE_URL 필요(예: DashScope 호환 모드)
     - ollama: 로컬 Qwen 등(기본 http://localhost:11434/v1, 키 불필요)
    """
    at = _endpoint(cfg)
    if at is None:
        return None
    provider, base_url = at
    return OpenAIStructuredLlm(
        pool=pool,
        provider=provider,
        model=cfg.model,
        base_url=base_url,
        api_key=cfg.apiKey,
        # reasoning_effort는 OpenAI 추론 모델 전용(다른 공급자는 거부할 수 있음)
        reasoning_effort=cfg.reasoningEffort if provider == "openai" else None,
        timeout_ms=cfg.timeoutMs or (60_000 if provider == "ollama" else None),
    )


def create_vision_llm(cfg: LlmConfig, *, detail: str = "high", pool: ModelConnections | None = None) -> OpenAIVisionLlm | None:
    """
    사진 모델 만들기(LLM_VISION_* 역할). 주인 결정(2026-11-18): 화면 사진은 OpenAI로만 보낸다.
    공급자가 openai가 아니거나 모델·키가 없으면 None이고, 그때는 사진 기능이 없다(다른 공급자로 대신하지 않는다).
    """
    at = _endpoint(cfg)
    if at is None or at[0] != "openai" or at[1].rstrip("/") != OPENAI_BASE_URL or not cfg.apiKey:
        return None
    return OpenAIVisionLlm(
        pool=pool,
        provider="openai",
        model=cfg.model,
        base_url=at[1],
        api_key=cfg.apiKey,
        reasoning_effort=cfg.reasoningEffort,
        timeout_ms=cfg.timeoutMs or 120_000,
        detail=detail,
    )
