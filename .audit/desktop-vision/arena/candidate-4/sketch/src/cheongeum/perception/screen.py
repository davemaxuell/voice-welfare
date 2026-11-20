"""화면 설명: 글 또는 그림으로 현재 화면을 설명한다.

공개 표면은 `ScreenExplainer.explain` 하나다. 그림 촬영, 가리기, 판단, 비식별,
OpenAI 호출, 숫자·이름 검증은 모두 이 안에서 끝난다. 호출하는 쪽은 말만 받는다.

불변식
- 그림은 `ScreenSource.picture`가 준 PNG만 쓴다. 좌표는 어디에도 없다.
- 모델 출력은 `{summary, names}`뿐이다. 행동 필드가 없다.
- 이름은 살아 있는 목록(`ScreenRead.names`)에 있을 때만 남는다.
- 그림에만 있는 숫자는 말하지 않는다(`unsupported_numbers`는 글 원문과 비교).
- 화면 글과 그림 글은 지시가 아니다. 시스템 프롬프트가 그렇게 말한다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

Source = Literal["auto", "text", "picture"]
Used = Literal["picture", "text", "refused"]


@dataclass(frozen=True)
class Scope:
    """확인하고 싶은 화면 하나. 웹이면 origin+path, 데스크톱이면 앱 id+창 핸들."""

    id: str
    kind: Literal["web", "desktop"]
    label: str


@dataclass(frozen=True)
class ExplainRequest:
    """사용자가 청한 것. `source="auto"`는 글이 빈약할 때만 그림을 쓴다."""

    question: str
    source: Source = "auto"


@dataclass(frozen=True)
class ScreenRead:
    """글로 읽은 화면. 그림 판단과 검증의 근거가 된다. 원문을 담는다."""

    kind: str  # 화면 종류 (digest.kind 또는 desktop 분류)
    text_lines: tuple[str, ...]  # 검증에 쓰는 원문
    names: tuple[str, ...]  # 살아 있는 목록의 이름(링크·버튼·항목)
    has_sensitive: bool  # detect_sensitive가 값을 찾았는지
    has_iframe: bool  # 웹이면 true일 때 그림을 보내지 않는다
    blocked: bool  # 차단·보안문자 단서
    auth_kind: Literal["login", "verification", "other"]
    thin: bool  # 글이 빈약한가(auto 판단용)


@dataclass(frozen=True)
class MaskBox:
    """가릴 영역. 웹은 셀렉터 기준, 데스크톱은 창 안의 사각형."""

    kind: Literal["selector", "rect"]
    value: str | tuple[int, int, int, int]


@dataclass(frozen=True)
class ScreenPicture:
    png: bytes
    masks: tuple[MaskBox, ...]


class ScreenSource(Protocol):
    """웹 어댑터와 데스크톱 포트가 구조적으로 구현한다. perception은 그 둘을 가져오지 않는다."""

    async def read(self, scope: Scope) -> ScreenRead:
        """글과 이름을 읽는다. 실패하면 예외를 올린다."""
        ...

    async def picture(self, scope: Scope, masks: tuple[MaskBox, ...]) -> bytes:
        """이 창·이 페이지만 찍는다. 숨김 커서를 끄고 masks를 가린다."""
        ...


class VisionLlm(Protocol):
    """`core.llm.OpenAIStructuredLlm.generate(..., images=...)`가 맞는 모양."""

    async def generate(self, *, system: str, user: str, schemaName: str, schema: dict, signal=None, images: tuple[bytes, ...] = ()) -> dict | None: ...


@dataclass(frozen=True)
class Explained:
    speech: str
    used: Used
    names: tuple[str, ...] = ()
    dropped: tuple[str, ...] = field(default=())  # 검증에서 빠진 숫자·이름(로그용, 비식별)


class ScreenExplainer:
    """화면을 설명한다. 생성자에서 의존을 받고 턴마다 상태를 들고 있지 않는다."""

    def __init__(self, source_for: dict[str, ScreenSource], vision: VisionLlm | None) -> None:
        self._source_for = source_for  # 종류별(web, desktop)
        self._vision = vision  # None이면 그림 설명은 꺼져 있다(LLM_VISION_* 미설정)

    async def explain(self, scope: Scope, request: ExplainRequest, ctx) -> Explained:
        """글 또는 그림으로 설명한다.

        순서: read → decide_picture → (그림이면) picture → vision.generate
        → 숫자 검증(글 원문 기준) → 이름 검증(read.names 기준) → 말 만들기.
        그림이 거부되면 이유를 말하고, auto면 글 설명으로 물러난다.
        """
        raise NotImplementedError
