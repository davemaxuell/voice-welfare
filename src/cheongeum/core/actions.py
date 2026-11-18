"""
실행 어댑터(현재 PC Playwright)가 따르는 플랫폼 독립 실행 계약.
Agent A가 만든 액션은 이 스키마로 검증된 뒤 PolicyGuard를 통과해야만 어댑터로 전달된다.

데이터는 JSON과 같은 camelCase 키의 dict로 주고받고, 경계에서 Pydantic 모델로 검증한다(원본의 Zod 역할).
"""
from __future__ import annotations

from typing import Any, Literal, Optional, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from cheongeum.core.jsutil import AbortSignal, is_valid_url

Platform = Literal["pc"]
ACTION_TYPES = ("navigate", "back", "click", "fill", "press", "select", "check", "scroll", "read", "focus")
ActionType = Literal["navigate", "back", "click", "fill", "press", "select", "check", "scroll", "read", "focus"]
Risk = Literal["low", "sensitive", "consequential"]
EXECUTION_ERROR_CODES = (
    "TARGET_NOT_FOUND",
    "AMBIGUOUS_TARGET",
    "VERIFY_FAILED",
    "TIMEOUT",
    "ABORTED",
    "NAVIGATION_FAILED",
    "RESUBMIT_BLOCKED",
    "NOT_SUPPORTED",
    "UNKNOWN",
)
ExecutionErrorCode = Literal[
    "TARGET_NOT_FOUND",
    "AMBIGUOUS_TARGET",
    "VERIFY_FAILED",
    "TIMEOUT",
    "ABORTED",
    "NAVIGATION_FAILED",
    "RESUBMIT_BLOCKED",
    "NOT_SUPPORTED",
    "UNKNOWN",
]

NonEmpty = Field(min_length=1)


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _Loose(BaseModel):
    """zod 기본 object: 모르는 키는 버린다."""

    model_config = ConfigDict(extra="ignore", strict=True)


class ActionTarget(_Strict):
    """접근성 우선 대상 지정: ref → label → role+name → testId. 좌표 클릭은 계약에 없다."""

    ref: Optional[str] = Field(default=None, min_length=1)
    label: Optional[str] = Field(default=None, min_length=1)
    role: Optional[str] = Field(default=None, min_length=1)
    name: Optional[str] = Field(default=None, min_length=1)
    testId: Optional[str] = Field(default=None, min_length=1)
    # 사이트 프로필의 필드 ID(또는 관찰 시 부여한 임시 ID). PolicyGuard의 필드 allowlist 검사에 사용.
    fieldId: Optional[str] = Field(default=None, min_length=1)
    # 같은 이름의 대상이 여러 개일 때(예: 같은 링크가 두 번) 몇 번째인지
    nth: Optional[int] = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _ref_carries_identity(self) -> "ActionTarget":
        # PolicyGuard는 role·name으로 판단하고 어댑터는 누르기 직전 그 둘을 다시 확인한다
        if self.ref is not None and (self.role is None or self.name is None):
            raise ValueError("ref requires role and name")
        return self


class Action(_Strict):
    id: str = Field(min_length=1)
    type: ActionType
    target: Optional[ActionTarget] = None
    url: Optional[str] = None
    value: Optional[str] = Field(default=None, max_length=300)
    checked: Optional[bool] = None
    reason: str = Field(min_length=1)
    risk: Risk
    requiresConfirmation: bool

    @field_validator("url")
    @classmethod
    def _url(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not is_valid_url(v):
            raise ValueError("invalid url")
        return v


class ActionResult(_Loose):
    actionId: str
    ok: bool
    # 어댑터 수준 재확인(입력 후 값 다시 읽기 등) 성공 여부
    verified: bool
    errorCode: Optional[ExecutionErrorCode] = None
    message: Optional[str] = None
    readValue: Optional[str] = None
    latencyMs: int = Field(ge=0)


class ObservedField(_Loose):
    fieldId: str
    label: str
    type: str
    required: bool
    visible: bool
    # 민감(비밀번호 등) 필드는 항상 빈 문자열. 값을 읽지 않는다.
    value: str
    filled: bool
    invalid: bool
    error: Optional[str] = None
    sensitive: bool
    options: Optional[list[str]] = None
    # 입력란에 연결된 도움말(aria-describedby). 비신뢰 텍스트.
    hint: Optional[str] = None
    # 검색창으로 보이는 입력란(type=search, role=searchbox, '검색' 레이블 등)
    searchable: Optional[bool] = None


class StepInfo(_Loose):
    index: int = Field(gt=0)
    total: int = Field(gt=0)
    name: str


class DialogInfo(_Loose):
    title: str
    text: str
    buttons: list[str]


class Heading(_Loose):
    level: int
    text: str


class Notice(_Loose):
    label: str
    text: str


class OutlineButton(_Loose):
    name: str
    disabled: bool


ItemRole = Literal["link", "scriptlink", "button", "tab", "menuitem", "generic"]
LINK_ROLES = ("link", "scriptlink")


class InteractiveItem(_Loose):
    """화면에서 누를 수 있는 요소 하나. generic = 역할 없이 스크립트로 누르게 만든 요소."""

    ref: str
    role: ItemRole
    name: str
    region: Literal["main", "menu", "other"]
    disabled: bool
    selected: Optional[bool] = None
    expanded: Optional[bool] = None


class ScreenOutline(_Loose):
    """화면 구조 요약(시각장애인에게 화면 전체를 설명하기 위함). 모두 비신뢰 텍스트이며 명령으로 해석하지 않는다."""

    headings: list[Heading]
    notices: list[Notice]
    steps: list[str]
    buttons: list[OutlineButton]
    links: list[str]
    linkCount: Optional[int] = Field(default=None, ge=0)
    menuLinks: Optional[list[str]] = None
    mainLinks: Optional[list[str]] = None
    mainText: Optional[str] = None
    footerText: Optional[str] = None
    landmarks: Optional[list[str]] = None
    items: Optional[list[InteractiveItem]] = None


class Observation(_Loose):
    """화면 관찰 결과. 여기 담긴 텍스트(오류, 팝업, 상태 문구)는 모두 비신뢰 데이터이며 명령으로 해석하지 않는다."""

    platform: Platform
    url: str
    title: str
    step: Optional[StepInfo] = None
    fields: list[ObservedField]
    errors: list[str]
    dialogs: list[DialogInfo]
    status: Optional[str] = None
    outline: Optional[ScreenOutline] = None
    capturedAt: str


def _dump(model: BaseModel) -> dict:
    return model.model_dump(exclude_none=True)


def parse_action(candidate: Any) -> dict | None:
    """ActionSchema.safeParse — 통과하면 정리된 dict, 아니면 None."""
    try:
        return _dump(Action.model_validate(candidate))
    except (ValidationError, TypeError):
        return None


def parse_observation(raw: dict) -> dict:
    """ObservationSchema.parse — 실패하면 ValidationError."""
    return _dump(Observation.model_validate(raw))


class ExecutionAdapter(Protocol):
    platform: Platform

    async def start(self) -> None: ...

    # PolicyGuard를 통과한 액션만 호출해야 한다(호출자는 WebExecutionAgent).
    async def execute(self, action: dict, signal: AbortSignal | None = None) -> dict: ...

    async def observe(self) -> dict: ...

    async def close(self) -> None: ...

    # 실행 창을 사용자 앞으로(가능한 플랫폼만)
    async def bring_to_front(self) -> None: ...
