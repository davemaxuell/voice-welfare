"""
LLM 의도 이해(보조): 규칙 파서가 먼저, LLM은 규칙이 이해 못 한 발화와 여러 명령 계획에만.
승인·중단 의도는 LLM이 만들 수 없다.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Sequence

from ieum.core.jsutil import jdumps
from ieum.core.llm import OPENAI_BASE_URL, LlmConfig, message_content, post_json
from ieum.core.turn import parse_intent
from ieum.understanding.rules import IntentContext, RuleBasedIntentProvider, clean_value

log = logging.getLogger("ieum.llm")


# 안전 관련 의도(승인·중단)는 LLM이 만들 수 없다. 규칙으로만 판정한다.
LLM_INTENT_TYPES = [
    "START_APPLICATION",
    "LOGIN",
    "AUTH_DONE",
    "FILL",
    "READ_FIELD",
    "EDIT_FIELD",
    "NEXT",
    "PREV",
    "REVIEW",
    "EXPLAIN",
    "PREPARE_SUBMIT",
    "REJECT",
    "RESUME",
    "CURRENT_STEP",
    "DESCRIBE_SCREEN",
    "ABOUT_SITE",
    "OPEN_SITE",
    "GOAL",
    "OPEN_BROWSER",
    "DISCOVER",
    "PRECHECK",
    "PREPARE_APPLY",
    "POLICY_QUESTION",
    "HELP_HUMAN",
    "UNKNOWN",
]

# OpenAI Structured Outputs(strict)용 평탄화 스키마. strict 모드는 모든 속성을 required로 요구하므로
# 쓰지 않는 칸은 null로 받고, 받은 뒤 IntentSchema로 다시 검증한다.
INTENT_JSON_SCHEMA = {
    "name": "intent",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["type", "fills", "fieldMention", "topic", "text"],
        "properties": {
            "type": {"type": "string", "enum": LLM_INTENT_TYPES},
            "fills": {
                "type": ["array", "null"],
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["fieldMention", "value"],
                    "properties": {"fieldMention": {"type": "string"}, "value": {"type": "string"}},
                },
            },
            "fieldMention": {"type": ["string", "null"]},
            "topic": {"type": ["string", "null"]},
            "text": {"type": ["string", "null"]},
        },
    },
}


def flat_to_intent(flat: Any, utterance: str) -> dict | None:
    """평탄화 응답 → Intent. 형식이 맞지 않으면 None (호출자가 규칙 결과로 대체)."""
    if not isinstance(flat, dict) or flat.get("type") not in LLM_INTENT_TYPES:
        return None
    t = flat["type"]
    candidate: dict[str, Any] = {"type": t}
    if t == "FILL":
        fills = []
        for f in flat.get("fills") or []:
            if not isinstance(f, dict) or not isinstance(f.get("value"), str):
                return None
            fills.append({"fieldMention": f.get("fieldMention"), "value": clean_value(f["value"])})
        candidate["fills"] = [f for f in fills if f["value"]]
    if t in ("READ_FIELD", "EDIT_FIELD"):
        candidate["fieldMention"] = flat.get("fieldMention")
    if t == "EXPLAIN" and flat.get("fieldMention"):
        candidate["fieldMention"] = flat["fieldMention"]
    topic = flat.get("topic")
    if t == "POLICY_QUESTION":
        candidate["topic"] = topic if topic is not None else utterance
    if t == "GOAL":
        candidate["goal"] = topic if topic is not None else utterance
    if t == "OPEN_SITE":
        candidate["target"] = topic if topic is not None else utterance
    if t in ("PRECHECK", "PREPARE_APPLY") and topic:
        candidate["service"] = topic
    if t == "UNKNOWN":
        candidate["text"] = utterance
    return parse_intent(candidate)


def system_prompt(vocabulary: Sequence[str]) -> str:
    return f"""너는 한국어 복지 신청 도우미의 의도 분류기다. 사용자 발화 하나를 지정된 JSON 스키마로 분류한다.
type 의미: START_APPLICATION(장애인연금 신청 시작), LOGIN(로그인/본인인증), AUTH_DONE(인증 마침), FILL(입력란에 값 입력),
READ_FIELD(항목 값 다시 읽기), EDIT_FIELD(항목 수정 의사, 값 없음), NEXT(다음 단계), PREV(이전 단계), REVIEW(입력 내용 전체 읽기),
EXPLAIN(항목 뜻 설명), PREPARE_SUBMIT(제출/접수 준비), REJECT(접수 거절), RESUME(다시 시작), CURRENT_STEP(현재 단계 안내), DESCRIBE_SCREEN(화면 전체 설명), ABOUT_SITE(지금 연 사이트가 어떤 곳인지), OPEN_SITE(특정 사이트 열기: topic에 사이트 이름이나 주소, 예 "Naver 열어줘"→네이버), GOAL(웹에서 여러 단계를 거쳐야 하는 목표: topic에 목표 문장), OPEN_BROWSER(사이트 이름 없이 크롬·브라우저만 켜기), DISCOVER(나에게 맞는 복지 찾기), PRECHECK(특정 제도 자격 미리 점검: topic에 제도명), PREPARE_APPLY(신청 준비·서류: topic에 제도명),
POLICY_QUESTION(제도 대상·절차 질문), HELP_HUMAN(사람 도움 요청), UNKNOWN(그 외/불확실).
fieldMention은 반드시 다음 항목명 중 하나를 그대로 쓴다: {', '.join(vocabulary)}.
규칙: 확실하지 않으면 UNKNOWN. 사용자가 말하지 않은 값을 추측·보완하지 마라. 비밀번호·주민등록번호·계좌번호는 절대 FILL로 만들지 마라.
쓰지 않는 칸은 null로 둔다."""


class OpenAICompatibleIntentProvider:
    """
    OpenAI 호환 Chat Completions 어댑터. 규칙 파서가 UNKNOWN일 때만 호출한다.
    - openai: Structured Outputs(json_schema, strict) 사용, temperature 생략(일부 모델은 기본값만 허용)
    - qwen / openai-compatible: json_object 모드(공급자별 strict 스키마 지원이 달라서)
    모델 ID는 코드에 두지 않고 LLM_MODEL로만 주입한다. 실패하면 규칙 결과를 쓴다.
    """

    def __init__(
        self,
        *,
        model: str,
        base_url: str,
        api_key: str,
        structured: bool,
        rules: RuleBasedIntentProvider,
        vocabulary: Sequence[str],
        timeout_ms: int | None = None,
        reasoning_effort: str | None = None,
    ) -> None:
        self.model = model
        self.base_url = base_url
        self.api_key = api_key
        self.structured = structured
        self.rules = rules
        self.vocabulary = list(vocabulary)
        self.timeout_ms = timeout_ms or 10_000
        self.reasoning_effort = reasoning_effort
        self.name = f"{'openai' if structured else 'openai-compatible'}({model})+mock-rule"

    async def parse(self, text: str, ctx: IntentContext) -> dict:
        ruled = await self.rules.parse(text, ctx)
        if ruled["type"] != "UNKNOWN":
            return ruled
        # 항목 값을 기다리는 중이면 발화 자체가 값이다. LLM을 거치지 않는다(지연·오분류 방지).
        if ctx.awaitingFieldId:
            return ruled
        body: dict[str, Any] = {"model": self.model}
        if self.structured:
            body["response_format"] = {"type": "json_schema", "json_schema": INTENT_JSON_SCHEMA}
            if self.reasoning_effort:
                body["reasoning_effort"] = self.reasoning_effort
        else:
            body["temperature"] = 0
            body["response_format"] = {"type": "json_object"}
        body["messages"] = [
            {"role": "system", "content": system_prompt(self.vocabulary)},
            {"role": "user", "content": jdumps({"state": ctx.state, "awaitingField": ctx.awaitingFieldId, "utterance": text})},
        ]
        res = await post_json(
            f"{self.base_url.rstrip('/')}/chat/completions",
            {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            body,
            self.timeout_ms / 1000,
        )
        content = message_content(res)
        if not content:
            return ruled
        try:
            return flat_to_intent(json.loads(content), text) or ruled
        except (json.JSONDecodeError, TypeError):
            return ruled


def create_intent_provider(cfg: LlmConfig, vocabulary: Sequence[str]):
    rules = RuleBasedIntentProvider(vocabulary)
    provider = (cfg.provider or "mock").lower()
    if provider == "mock":
        return rules
    if provider not in ("openai", "qwen", "openai-compatible"):
        log.warning("[llm] 알 수 없는 LLM_PROVIDER(%s) → mock 사용", provider)
        return rules
    base_url = cfg.baseUrl or (OPENAI_BASE_URL if provider == "openai" else None)
    missing = [k for k, ok in (("LLM_API_KEY", cfg.apiKey), ("LLM_MODEL", cfg.model), ("LLM_BASE_URL", base_url)) if not ok]
    if missing or not cfg.apiKey or not cfg.model or not base_url:
        log.warning("[llm] %s 미설정 → mock 규칙 파서만 사용합니다.", ", ".join(missing))
        return rules
    return OpenAICompatibleIntentProvider(
        model=cfg.model,
        base_url=base_url,
        api_key=cfg.apiKey,
        structured=provider == "openai",
        rules=rules,
        vocabulary=vocabulary,
        timeout_ms=cfg.timeoutMs,
        reasoning_effort=cfg.reasoningEffort,
    )


PLAN_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["steps"],
    "properties": {"steps": {"type": "array", "items": INTENT_JSON_SCHEMA["schema"]}},
}


def plan_system(vocabulary: Sequence[str]) -> str:
    return f"""{system_prompt(vocabulary)}
사용자가 한 번에 여러 가지를 말할 수 있다. 말한 순서대로 steps 배열에 하나씩 넣어라(최대 6개).
예: "부산 예시구 예시로 10 사는 김하늘이고 다음으로 넘어가줘" → FILL(이름=김하늘), FILL(주소=부산 예시구 예시로 10), NEXT.
값이 불완전해도 바꾸거나 채우지 말고 들은 그대로 넣어라(검증은 시스템이 한다). 하나뿐이면 steps에 하나만."""


async def plan_with_llm(
    llm: Any,
    text: str,
    ctx: IntentContext,
    vocabulary: Sequence[str],
    page: str | None = None,
    history: list[str] | None = None,
) -> list[dict] | None:
    """
    여러 명령을 한 문장에 말했을 때 LLM으로 순서 있는 의도 목록을 만든다. 승인·중단은 만들 수 없다.
    실패하면 None(호출자가 규칙 파서로 처리).
    """
    raw = await llm.generate(
        system=plan_system(vocabulary),
        user=jdumps({"state": ctx.state, "awaitingField": ctx.awaitingFieldId, "page": page, "recent": history or [], "utterance": text}),
        schemaName="intent_plan",
        schema=PLAN_JSON_SCHEMA,
    )
    steps = raw.get("steps") if isinstance(raw, dict) else None
    if not steps:
        return None
    intents = [flat_to_intent(s, text) for s in steps[:6]]
    return intents if all(intents) else None  # type: ignore[return-value]
