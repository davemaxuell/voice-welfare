"""상태·의도·TurnResult·API 스키마(PC 웹 클라이언트·데스크톱 앱 공용). 원본 @cheongeum/shared."""
from __future__ import annotations

from typing import Annotated, Any, Literal, Optional, Protocol, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, field_validator

from cheongeum.core.actions import Action, ActionResult, ObservedField, StepInfo
from cheongeum.core.jsutil import AbortSignal, is_valid_url

# PRD §6 상태 머신. 앞쪽은 턴 처리 파이프라인 단계, 뒤쪽은 턴 사이에 유지되는 세션 상태.
SESSION_STATES = (
    "AWAITING_CONSENT",
    "IDLE",
    "LISTENING",
    "TRANSCRIBED",
    "INTENT_DETECTED",
    "OBSERVING",
    "PLANNING",
    "POLICY_CHECK",
    "EXECUTING",
    "VERIFYING",
    "SPEAKING",
    "APPLICATION_OPEN",
    "BROWSING",
    "NEEDS_CLARIFICATION",
    "AWAITING_FIELD_VALUE",
    "VALIDATION_ERROR",
    "WAITING_FOR_USER_CONFIRMATION",
    "AUTH_HANDOFF",
    "RECOVERING",
    "PAUSED",
    "STOPPED",
    "MOCK_SUBMITTED",
    "DONE",
)
SessionState = Literal[
    "AWAITING_CONSENT",
    "IDLE",
    "LISTENING",
    "TRANSCRIBED",
    "INTENT_DETECTED",
    "OBSERVING",
    "PLANNING",
    "POLICY_CHECK",
    "EXECUTING",
    "VERIFYING",
    "SPEAKING",
    "APPLICATION_OPEN",
    "BROWSING",
    "NEEDS_CLARIFICATION",
    "AWAITING_FIELD_VALUE",
    "VALIDATION_ERROR",
    "WAITING_FOR_USER_CONFIRMATION",
    "AUTH_HANDOFF",
    "RECOVERING",
    "PAUSED",
    "STOPPED",
    "MOCK_SUBMITTED",
    "DONE",
]

PIPELINE_PHASES = ("TRANSCRIBED", "INTENT_DETECTED", "OBSERVING", "PLANNING", "POLICY_CHECK", "EXECUTING", "VERIFYING", "SPEAKING")

STATE_LABELS_KO: dict[str, str] = {
    "AWAITING_CONSENT": "동의 대기",
    "IDLE": "대기",
    "LISTENING": "듣는 중",
    "TRANSCRIBED": "전사 완료",
    "INTENT_DETECTED": "의도 파악",
    "OBSERVING": "화면 확인 중",
    "PLANNING": "계획 중",
    "POLICY_CHECK": "안전 확인 중",
    "EXECUTING": "실행 중",
    "VERIFYING": "결과 확인 중",
    "SPEAKING": "안내 중",
    "APPLICATION_OPEN": "신청서 작성 중",
    "BROWSING": "웹 페이지 읽는 중(읽기 전용)",
    "NEEDS_CLARIFICATION": "확인 필요",
    "AWAITING_FIELD_VALUE": "새 값 기다리는 중",
    "VALIDATION_ERROR": "입력 오류",
    "WAITING_FOR_USER_CONFIRMATION": "승인 대기",
    "AUTH_HANDOFF": "직접 인증 필요",
    "RECOVERING": "오류 복구 중",
    "PAUSED": "일시정지",
    "STOPPED": "중단됨",
    "MOCK_SUBMITTED": "모의접수 완료",
    "DONE": "완료",
}


class AGENT_IDS:
    """두 에이전트의 논리적 경계 (MVP에서는 같은 프로세스 안의 모듈)."""

    orchestrator = "orchestrator"
    welfare = "welfare-information-and-dialogue"
    web = "web-navigation-and-execution"
    # 화면 이해 담당(Agent A 소속, 규칙 기반 화면 정리)
    screen = "screen-understanding"
    # 검증 담당(A·B 공통, 말하기 전 근거 대조)
    verifier = "answer-verifier"


class _M(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)


# ---------------------------------------------------------------- Intent


class Fill(_M):
    fieldMention: str = Field(min_length=1)
    value: str = Field(min_length=1, max_length=200)


def _intent(intent_type: str, /, **fields: Any):
    ns: dict[str, Any] = {"__annotations__": {"type": Literal[intent_type]}}  # type: ignore[valid-type]
    for k, (ann, default) in fields.items():
        ns["__annotations__"][k] = ann
        ns[k] = default
    return type(f"Intent_{intent_type}", (_M,), ns)


_REQ = ...
INTENT_MODELS = [
    _intent("START_APPLICATION"),
    _intent("LOGIN"),
    _intent("AUTH_DONE"),
    _intent("FILL", fills=(Annotated[list[Fill], Field(min_length=1, max_length=5)], _REQ)),
    _intent("READ_FIELD", fieldMention=(Annotated[str, Field(min_length=1)], _REQ)),
    _intent("EDIT_FIELD", fieldMention=(Annotated[str, Field(min_length=1)], _REQ)),
    _intent("NEXT"),
    _intent("PREV"),
    _intent("REVIEW"),
    _intent("EXPLAIN", fieldMention=(Optional[str], None)),
    _intent("PREPARE_SUBMIT"),
    _intent("APPROVE"),
    _intent("REJECT"),
    _intent("STOP"),
    _intent("RESUME"),
    _intent("CURRENT_STEP"),
    _intent("DESCRIBE_SCREEN"),
    _intent("ABOUT_SITE"),
    _intent("REPHRASE"),
    _intent("OPEN_BROWSER"),
    _intent("DISCOVER"),
    _intent("SERVICE_DETAIL", service=(Optional[str], None)),
    _intent("PRECHECK", service=(Optional[str], None)),
    _intent("PREPARE_APPLY", service=(Optional[str], None)),
    _intent("GOAL", goal=(Annotated[str, Field(min_length=2, max_length=200)], _REQ)),
    _intent("OPEN_SITE", target=(Annotated[str, Field(min_length=1)], _REQ)),
    _intent("FOLLOW_LINK", name=(Annotated[str, Field(min_length=1)], _REQ)),
    _intent("READ_MAIN", more=(bool, _REQ)),
    _intent("LIST_LINKS", more=(bool, _REQ)),
    _intent("SEARCH", query=(Annotated[str, Field(min_length=1, max_length=100)], _REQ), site=(Optional[str], None)),
    _intent("POLICY_QUESTION", topic=(str, _REQ)),
    _intent("HELP_HUMAN"),
    _intent("UNKNOWN", text=(str, _REQ)),
]
INTENT_TYPES = tuple(m.model_fields["type"].annotation.__args__[0] for m in INTENT_MODELS)  # type: ignore[union-attr]
_IntentUnion = Annotated[Union[tuple(INTENT_MODELS)], Field(discriminator="type")]  # type: ignore[valid-type]
_intent_adapter: TypeAdapter = TypeAdapter(_IntentUnion)


def parse_intent(candidate: Any) -> dict | None:
    """IntentSchema.safeParse"""
    try:
        return _intent_adapter.validate_python(candidate).model_dump(exclude_none=True)
    except (ValidationError, TypeError):
        return None


# ---------------------------------------------------------------- TurnResult


class SourceCitation(_M):
    title: str
    url: str
    lastCheckedAt: str
    version: Optional[str] = None
    note: Optional[str] = None

    @field_validator("url")
    @classmethod
    def _url(cls, v: str) -> str:
        if not is_valid_url(v):
            raise ValueError("invalid url")
        return v


class PolicyDecision(_M):
    allowed: bool
    code: str
    reason: str


class ExecutedAction(_M):
    agent: str
    action: Action
    policy: PolicyDecision
    result: Optional[ActionResult] = None


SEMANTIC_ACTIONS = (
    "navigate",
    "fill",
    "read",
    "navigate-next",
    "navigate-prev",
    "explain-field",
    "review",
    "prepare-submit",
    "submit",
    "reject",
    "stop",
    "resume",
    "auth-handoff",
    "read-state",
    "agent-handoff",
    "rephrase",
    "set-language",
    "about-site",
    "goal",
    "open-browser",
    "discover",
    "precheck",
    "prepare-apply",
    "chat",
    "web-answer",
    "open-site",
    "follow-link",
    "back",
    "read-main",
    "list-links",
    "search",
    "consent",
    "describe-screen",
    "welfare-retrieval",
    "edit-field",
    "clarify",
    "help",
    "none",
)
SemanticAction = Literal[
    "navigate",
    "fill",
    "read",
    "navigate-next",
    "navigate-prev",
    "explain-field",
    "review",
    "prepare-submit",
    "submit",
    "reject",
    "stop",
    "resume",
    "auth-handoff",
    "read-state",
    "agent-handoff",
    "rephrase",
    "set-language",
    "about-site",
    "goal",
    "open-browser",
    "discover",
    "precheck",
    "prepare-apply",
    "chat",
    "web-answer",
    "open-site",
    "follow-link",
    "back",
    "read-main",
    "list-links",
    "search",
    "consent",
    "describe-screen",
    "welfare-retrieval",
    "edit-field",
    "clarify",
    "help",
    "none",
]


class LabelValue(_M):
    label: str
    value: str


class PendingConfirmation(_M):
    actionId: str
    purpose: str
    site: str
    values: list[LabelValue]
    realSubmission: Literal[False]


class ObservationSummary(_M):
    page: str
    url: str
    title: str
    step: Optional[StepInfo] = None
    fields: list[ObservedField]
    errors: list[str]
    status: Optional[str] = None


class TraceEntry(_M):
    phase: str
    agent: str
    atMs: int
    note: Optional[str] = None


# 대화 언어: 한국어(기본)·영어·중국어(간체)·일본어
LANGS = ("ko", "en", "zh", "ja")
Lang = Literal["ko", "en", "zh", "ja"]


class AgentHandoff(_M):
    """Agent B → Agent A 인계 계약."""

    from_: Literal["welfare-information-and-dialogue"] = Field(alias="from")
    to: Literal["web-navigation-and-execution"]
    taskId: str
    goal: str
    targetUrl: str
    sources: list[SourceCitation]
    requiresApprovedDomain: Literal[True]
    # PolicyGuard 허용 목록으로 확인한 결과. false면 Agent A는 열지 않는다.
    domainApproved: bool
    # 근거 자료가 가리키는 공식 페이지(참고용, 허용 목록 밖이면 열지 않음)
    officialUrl: Optional[str] = None

    model_config = ConfigDict(extra="ignore", strict=True, populate_by_name=True)


class Verification(_M):
    requiredFieldsComplete: Optional[bool] = None
    fieldValueMatches: Optional[bool] = None
    receipt: Optional[str] = None


class Flags(_M):
    secretDetected: bool
    masked: bool


class TurnResult(_M):
    sessionId: str
    turnId: str
    # 민감정보가 제거된 사용자 발화. 원문은 어디에도 저장하지 않는다.
    userUtterance: str
    intentType: str
    state: SessionState
    semanticAction: SemanticAction
    field: Optional[str] = None
    value: Optional[str] = None
    page: Optional[str] = None
    speech: str
    # speech의 언어(음성 합성·인식 언어도 이것을 따른다)
    lang: Lang = "ko"
    trace: list[TraceEntry]
    actions: list[ExecutedAction]
    observation: Optional[ObservationSummary] = None
    verification: Optional[Verification] = None
    pendingConfirmation: Optional[PendingConfirmation] = None
    handoff: Optional[AgentHandoff] = None
    # 현재 화면의 접근 등급: full = 지원 사이트(신청 가능), read-only = 그 외 사이트(읽기·이동·검색만)
    accessMode: Optional[Literal["full", "read-only", "none"]] = None
    sources: list[SourceCitation]
    missingFields: list[str]
    pendingActions: int = Field(ge=0)
    realSubmission: Literal[False]
    flags: Flags
    latencyMs: int = Field(ge=0)


def parse_turn_result(d: dict) -> dict:
    """TurnResultSchema.parse — 실패하면 ValidationError."""
    return TurnResult.model_validate(d).model_dump(exclude_none=True, by_alias=True)


def draft(state: str, semantic: str, speech: str, **extra: Any) -> dict:
    """
    Draft(응답 초안) 만들기. state · semanticAction · speech는 필수, 나머지(field, value, actions, view, verification, handoff,
    sources, missingFields, masked, secretDetected, summary, lang)는 선택이고 값이 None이면 뺀다.
    오케스트레이터의 _finish가 TurnResult로 바꾼다.
    """
    return {"state": state, "semanticAction": semantic, "speech": speech, **{k: v for k, v in extra.items() if v is not None}}


# ---------------------------------------------------------------- 구조화 LLM 경계


class StructuredLlm(Protocol):
    """구조화 출력(JSON 스키마) LLM 경계. 구현(OpenAI 등)은 core/llm.py에 있고, 없으면 각 기능은 규칙 기반으로 동작한다."""

    name: str

    async def generate(
        self, *, system: str, user: str, schemaName: str, schema: dict, signal: AbortSignal | None = None
    ) -> Any | None: ...
