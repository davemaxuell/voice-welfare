"""
앱 조작 계약: 이름 붙은 동작(AppAction)과 창 모습(WindowView). actions.py의 웹 계약(Action·Observation)의 짝이다.

왜 웹 계약을 늘리지 않고 짝을 두는가:
 - Observation.url은 필수이고(actions.py:189) 가드의 등급은 URL 출처로만 정해진다(guard.py:93 tier_of).
   'uia://explorer' 같은 가짜 주소는 출처가 "null"이라 tier none이 되고(jsutil.py:110), 허용 목록에 "null"을 넣으면 모든 비웹 주소가 full이 된다.
 - 앱 동작의 핵심 사실은 주소가 아니라 '어느 폴더의 어느 이름인가'이고, 가드는 그 길을 알아야 막을 수 있다.
한 문으로 검사하는 것은 같다: parse_app_action → PolicyGuard.check(guard.py:103) → 실행 → 재관찰. 문이 둘로 갈라지지 않는다.

좌표 없음: AppTarget은 ActionTarget처럼 이름으로만 가리킨다. 사진 속 위치도, 접근성 트리의 화면 위치도 계약에 없다.
모델이 쓴 글은 AppAction의 어느 칸에도 들어가지 못한다. reason은 코드가 쓰고, folder는 코드가 지금 보는 폴더에서 채운다.
"""
from __future__ import annotations

from typing import Any, Literal, Optional, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from cheongeum.core.actions import Risk
from cheongeum.core.apps import APP_BY_ID, PLACE_BY_ID, is_single_name
from cheongeum.core.jsutil import AbortSignal

# 이름 붙은 동작의 닫힌 집합. 앱이 더 필요한 동작(read_text, press_button, type_text …)은 그 앱을 켤 때
# 이 Literal과 core/apps.py의 AppSpec.verbs에 한 줄씩 더한다(APPS.md). 두 곳이 어긋나면 test_apps_registry가 실패한다.
AppVerb = Literal[
    "launch",  # 앱 열기(이미 떠 있으면 창을 앞으로: 두 번 말해도 창이 둘이 되지 않는다)
    "focus_window",  # 창을 앞으로
    "list",  # 지금 폴더 내용 다시 보기(재관찰)
    "open",  # 폴더·알려진 폴더로 들어가기 / 파일을 기본 프로그램으로 열기(2차, 승인)
    "up",  # 상위 폴더로
    "history_back",  # 방금 있던 폴더로
    "read_item",  # 파일 속 글을 읽어 주기(2차: docs.read_document로 PDF·HWPX)
    "restore_window",  # 최소화된 창 되살리기(승인)
    "capture_window",  # 이 창 하나만 사진 찍기(3차: PrintWindow, 가린 뒤)
]
APP_VERBS = frozenset(AppVerb.__args__)  # type: ignore[attr-defined]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _Loose(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)


class AppTarget(_Strict):
    """
    이름으로 가리킨다. folder + name = 그 폴더 안의 항목, folder만 = 그 폴더 자신(up·list·history_back의 기준), place = 알려진 폴더.
    아무것도 없으면 폴더가 필요 없는 동작(launch, focus_window). 좌표·핸들·화면 위치 없음.
    """

    place: Optional[str] = None  # PLACE_BY_ID의 id
    folder: Optional[str] = None  # 지금 보는 폴더의 실제 경로(코드가 WindowView에서 채운다)
    name: Optional[str] = None  # 그 폴더 안 항목의 이름 한 칸
    kind: Optional[Literal["folder", "file"]] = None

    @model_validator(mode="after")
    def _addressed_by_name(self) -> "AppTarget":
        if self.place is not None:
            if self.place not in PLACE_BY_ID:
                raise ValueError("unknown place")
            if self.folder is not None or self.name is not None:
                raise ValueError("place excludes folder/name")
            return self
        if self.name is not None and (self.folder is None or not is_single_name(self.name)):
            raise ValueError("a name needs its folder and must be a single path component")
        return self


class AppAction(_Strict):
    id: str = Field(min_length=1)
    type: AppVerb
    app: str
    target: Optional[AppTarget] = None
    reason: str = Field(min_length=1)  # 코드가 만든 한국어 한 문장. 기록·승인 문장에 쓴다.
    risk: Risk
    requiresConfirmation: bool

    @model_validator(mode="after")
    def _known_app(self) -> "AppAction":
        if self.app not in APP_BY_ID:
            raise ValueError("unknown app")
        return self


class WindowItem(_Loose):
    """폴더 안 항목 하나. 이름은 비신뢰 데이터다(말로만 읽고, 어떤 LLM 입력에도 넣지 않는다)."""

    name: str
    kind: Literal["folder", "file", "place"]
    ext: Optional[str] = None
    sizeBytes: Optional[int] = Field(default=None, ge=0)
    modified: Optional[str] = None


class WindowView(_Loose):
    """앱 창을 본 모습. Observation의 짝. path는 말하지 않는다(기록·승인 비교용)."""

    app: str
    kind: Literal["home", "folder", "other"]  # home = 알려진 폴더 고르기 화면(가상)
    title: str
    place: Optional[str] = None
    path: Optional[str] = None
    items: list[WindowItem]
    folders: int = Field(ge=0)
    files: int = Field(ge=0)
    truncated: bool  # 항목이 너무 많아 앞쪽만 담았다
    capturedAt: str


def parse_app_action(candidate: Any) -> dict | None:
    """AppAction.safeParse, 통과하면 정리된 dict, 아니면 None(가드는 DENIED_SCHEMA)."""
    try:
        return AppAction.model_validate(candidate).model_dump(exclude_none=True)
    except (ValidationError, TypeError):
        return None


def parse_window_view(raw: dict) -> dict:
    """WindowView.parse, 실패하면 ValidationError."""
    return WindowView.model_validate(raw).model_dump(exclude_none=True)


class AppExecutionAdapter(Protocol):
    """
    앱 쪽 실행기. 결과는 웹과 같은 ActionResult 모양의 dict(actions.py:95)라서 TurnResult의 ExecutedAction.result가 그대로 받는다.
    오류 코드도 웹과 같다(TARGET_NOT_FOUND, AMBIGUOUS_TARGET, VERIFY_FAILED, TIMEOUT, ABORTED, NOT_SUPPORTED, NAVIGATION_FAILED, UNKNOWN).
    """

    async def execute(self, action: dict, signal: AbortSignal | None = None) -> dict: ...

    async def observe(self) -> dict: ...  # WindowView 모양
