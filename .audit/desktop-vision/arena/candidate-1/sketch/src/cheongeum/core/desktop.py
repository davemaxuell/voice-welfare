"""
[새 파일] 데스크톱 실행 계약. 웹 Action(core/actions.py:76)의 형제다. 둘은 type 값이 겹치지 않아 TurnResult가 type으로 가른다.

불변식(타입으로 막는다):
 - 좌표가 없다. 대상은 등록된 앱 ID, 알려진 폴더 ID, 그 아래 이름 조각뿐이다.
 - 경로 문자열이 없다. 모델이나 사용자 말이 임의 경로(C:\\Windows\\..., ..\\..)를 만들 수 없다.
   rel은 청음이 관찰한 목록에서 그대로 복사한 이름 조각이고, 실행 직전 포트가 실제 경로가 그 폴더 안인지 다시 본다.
 - 동작은 여섯 가지 이름뿐이다. OS 호출은 agents/desktop/windows.py가 이 이름에서 만든다.
"""
from __future__ import annotations

from typing import Any, Literal, Optional, get_args

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from cheongeum.core.actions import Risk
from cheongeum.core.jsutil import rx

# 등록된 앱(닫힌 목록). 이름표(understanding/apps.py)와 실행 프로필(agents/desktop/registry.py)이 이 목록을 키로 쓰고,
# 두 표 모두 가져올 때 이 목록과 같은지 확인한다(하나라도 빠지면 import가 실패).
AppId = Literal["explorer"]
# 알려진 폴더(Windows Known Folder). 읽기·열기는 이 폴더와 그 하위만.
PlaceId = Literal["downloads", "desktop", "documents", "pictures", "music", "videos"]
DESKTOP_VERBS = ("launch_app", "show_folder", "select_item", "open_file", "read_file", "focus_window")
# 목록 하나에서 만든다(SemanticAction과 같은 방식). 웹 ActionType 값과 겹치지 않아야 TurnResult가 type으로 가를 수 있다
# (tests/unit/test_desktop_contract.py가 교집합이 비었는지 본다).
DesktopVerb = Literal[DESKTOP_VERBS]  # type: ignore[valid-type]
# 앱 등급: control = 등록된 앱(이름 붙은 동작), describe = 남의 창(읽어 주기만), none = 자격 증명·인증서 창(읽지도 찍지도 않음)
AppTier = Literal["control", "describe", "none"]

APP_IDS: tuple[str, ...] = get_args(AppId)
PLACE_IDS: tuple[str, ...] = get_args(PlaceId)

# 파일 이름 한 조각: 경로 구분자·와일드카드·제어 문자 없음, '.'·'..' 아님
_PLAIN_NAME = rx(r'^[^\\/:*?"<>|\x00-\x1f]{1,255}$')


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class DesktopTarget(_Strict):
    """데스크톱 동작의 대상. app은 언제나 있다. 파일·폴더는 place + rel(관찰한 이름 그대로)."""

    app: AppId
    place: Optional[PlaceId] = None
    rel: Optional[list[str]] = None
    kind: Optional[Literal["folder", "file"]] = None
    # 말하고 기록할 이름(rel의 마지막 조각과 같다). 승인 질문·조작 기록용.
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    # focus_window·select_item이 겨누는 창(관찰한 HWND). 제목은 넣지 않는다(바뀌고 비신뢰).
    hwnd: Optional[int] = Field(default=None, gt=0)

    @field_validator("rel")
    @classmethod
    def _plain_parts(cls, v: Optional[list[str]]) -> Optional[list[str]]:
        """이름 조각마다 _PLAIN_NAME, '.'·'..' 금지, 32단계 이하."""
        raise NotImplementedError

    @model_validator(mode="after")
    def _rel_needs_place(self) -> "DesktopTarget":
        """rel이 있으면 place도 있어야 하고, kind·name이 rel의 마지막과 맞아야 한다."""
        raise NotImplementedError


class DesktopAction(_Strict):
    id: str = Field(min_length=1)
    type: DesktopVerb
    target: DesktopTarget
    reason: str = Field(min_length=1)
    risk: Risk
    requiresConfirmation: bool


def parse_desktop_action(candidate: Any) -> dict | None:
    """DesktopAction 검증. 통과하면 정리된 dict(None 칸은 뺌), 아니면 None(가드가 DENIED_SCHEMA로 거절)."""
    try:
        return DesktopAction.model_validate(candidate).model_dump(exclude_none=True)
    except (ValidationError, TypeError):
        return None
