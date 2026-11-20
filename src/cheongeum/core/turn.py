"""상태·의도·TurnResult·API 스키마(PC 웹 클라이언트·데스크톱 앱 공용). 원본 @cheongeum/shared."""
from __future__ import annotations

from typing import Annotated, Any, Literal, Optional, Protocol, Union, get_args

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, field_validator

from cheongeum.core.actions import Action, ActionResult, ObservedField, StepInfo
from cheongeum.core.choices import ChoiceKey
from cheongeum.core.intents import INTENTS
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


def _intent(intent_type: str, /, **fields: Any):
    ns: dict[str, Any] = {"__annotations__": {"type": Literal[intent_type]}}  # type: ignore[valid-type]
    for k, (ann, default) in fields.items():
        ns["__annotations__"][k] = ann
        ns[k] = default
    return type(f"Intent_{intent_type}", (_M,), ns)


# 의도 종류와 매개변수는 의도 표(core/intents.py)에서
INTENT_MODELS = [_intent(i.type, **i.params) for i in INTENTS]
INTENT_TYPES = tuple(i.type for i in INTENTS)
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


SemanticAction = Literal[
    "review-before-output",
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
    "find-place",
    "precheck",
    "prepare-apply",
    "chat",
    "web-answer",
    "open-site",
    "follow-link",
    "confirm-click",
    "back",
    "read-main",
    "list-links",
    "search",
    "consent",
    "describe-screen",
    "describe-picture",
    "welfare-retrieval",
    "edit-field",
    "clarify",
    "help",
    "help-list",
    "none",
]


SEMANTIC_ACTIONS = get_args(SemanticAction)


class LabelValue(_M):
    label: str
    value: str


class PendingConfirmation(_M):
    actionId: str
    kind: Optional[Literal["field-entry", "click", "file-transfer", "visual-navigation", "practice-submission", "public-research",
                           "vault-save", "vault-clear"]] = None
    purpose: str
    site: str
    description: Optional[str] = None
    values: list[LabelValue]
    realSubmission: Literal[False]


class GroundedAnswerCard(_M):
    answer: str
    serviceId: str
    serviceName: str
    fields: list[str]
    grounded: bool
    source: SourceCitation
    dataKind: Literal["live", "stored", "private-program"]
    dataOrigin: str
    dataDate: Optional[str] = None
    nextAction: str


class HumanAuthHandoff(_M):
    id: str
    taskId: str
    kind: Literal["login", "verification", "captcha"]
    status: Literal["waiting", "completed", "cancelled", "expired", "interrupted", "blocked"]
    site: str


class OfferedChoice(_M):
    """서버가 제안한 선택지 하나(core/choices.py). 고를 때는 key와 이 응답의 turnId를 보낸다."""

    key: ChoiceKey
    label: str


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


class SpeechPrefs(_M):
    """말하기 설정(속도·답 길이·목소리·진행 알림). UI가 브라우저 TTS에 반영한다."""

    rate: float = 1.25
    length: Literal["short", "normal", "detailed"] = "normal"
    voice: Optional[str] = None
    progressSpoken: bool = True


class IntroLine(_M):
    """청음 소개 한 줄: 말할 문장과 그동안 아바타가 할 동작(cheongeum-avatar.glb의 클립 이름)."""

    text: str
    pose: Literal["welcome", "listening", "screen-reading", "confirmation", "auth-handoff", "stopped", "complete"]
    # 건너뛰어도 말할 줄(소개 끝의 연습 신청서 제안)
    ask: Optional[bool] = None


class TaskReviewSummary(_M):
    status: Literal["completed", "incomplete", "needs_input"]
    difficulty: Literal["easy", "medium", "hard"]
    rounds: int = Field(ge=0)
    maxRounds: int = Field(ge=1)
    browserIterations: int = Field(ge=0)


class TurnResult(_M):
    sessionId: str
    turnId: str
    # 민감정보가 제거된 사용자 발화. 원문은 어디에도 저장하지 않는다.
    userUtterance: str
    intentType: str
    state: SessionState
    stopGeneration: Optional[int] = Field(default=None, ge=0)
    semanticAction: SemanticAction
    field: Optional[str] = None
    value: Optional[str] = None
    page: Optional[str] = None
    speech: str
    localSpeechOnly: Optional[Literal[True]] = None
    # speech의 언어(음성 합성·인식 언어도 이것을 따른다)
    lang: Lang = "ko"
    trace: list[TraceEntry]
    actions: list[ExecutedAction]
    observation: Optional[ObservationSummary] = None
    verification: Optional[Verification] = None
    review: Optional[TaskReviewSummary] = None
    pendingConfirmation: Optional[PendingConfirmation] = None
    authHandoff: Optional[HumanAuthHandoff] = None
    answerCard: Optional[GroundedAnswerCard] = None
    handoff: Optional[AgentHandoff] = None
    # 현재 화면의 접근 등급: full = 지원 사이트(신청 가능), read-only = 그 외 사이트(읽기·이동·검색만)
    accessMode: Optional[Literal["full", "read-only", "none"]] = None
    sources: list[SourceCitation]
    missingFields: list[str]
    pendingActions: int = Field(ge=0)
    realSubmission: Literal[False]
    flags: Flags
    latencyMs: int = Field(ge=0)
    speechPrefs: Optional[SpeechPrefs] = None
    # 이 응답 뒤에 고를 수 있는 것(없으면 빠진다. 승인은 pendingConfirmation이 따로 맡는다)
    offeredChoices: Optional[list[OfferedChoice]] = None
    # Public catalogue labels for an on-desktop clarification, separate from dictation.
    publicSuggestions: Optional[list[str]] = Field(default=None, max_length=2)
    # 청음 소개(첫 실행·'청음 소개 다시 해줘'): 줄마다 아바타 동작과 함께 차례로 말한다
    introScript: Optional[list[IntroLine]] = None


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
