"""
[새 파일] 데스크톱 실행 계약: 조작(DeskAction), 관찰(DeskView), OS 경계(DesktopPort).
core/actions.py(웹 Action·Observation·ExecutionAdapter)의 짝이다. 웹 Action에 칸을 더하지 않고 따로 둔 까닭:
웹 Action은 extra="forbid"라 `click`에 app이 붙거나 `launch`에 url이 붙는 조합을 받아 주면 안 되기 때문이다.

계약에 없는 것(넣으면 parse_desk_action이 None → DENIED_SCHEMA)
 - 좌표, 창 핸들, 프로세스 번호
 - 경로 문자열: 폴더는 FolderRef(장소 + 목록에서 본 이름들)로만 가리킨다
 - 명령줄·단축키 문자열: 실행법은 core/apps.py 표에만 있고, 액션은 표의 이름(app, act)만 든다
"""
from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any, Literal, NewType, Optional, Protocol, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

from cheongeum.core.actions import Risk
from cheongeum.core.apps import FileKind, Launch, PlaceId
from cheongeum.core.picture import MaskPlan, Shot


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _Loose(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)


# ---------------------------------------------------------------- 가리키는 법


class FolderRef(_Strict):
    """
    폴더 하나: 장소(뿌리)와 그 아래로 내려간 이름들. 이름은 모두 폴더 목록에서 본 그대로다.
    검증: 이름마다 비어 있지 않고, 구분자(/ \\ :)가 없고, "."·".."이 아니고, 255자 이하.
    실제 경로로 바꾸는 곳은 agents/desktop/folders.safe_path 하나뿐이다.
    """

    place: PlaceId
    parts: list[Annotated[str, Field(min_length=1, max_length=255)]] = Field(default_factory=list, max_length=32)

    @field_validator("parts")
    @classmethod
    def _plain_names(cls, v: list[str]) -> list[str]:
        raise NotImplementedError


class ItemTarget(_Strict):
    """앱 창의 조작 요소 하나. core.actions.ActionTarget의 ref 규칙과 같다: ref는 role·name 없이는 못 쓴다."""

    ref: str = Field(min_length=1)  # UI Automation RuntimeId를 글로 적은 것
    role: str = Field(min_length=1)  # ControlType 이름("Button", "MenuItem", "ListItem" ...)
    name: str = Field(min_length=1)


# ---------------------------------------------------------------- 조작(type으로 갈리는 합)


class _DeskBase(_Strict):
    id: str = Field(min_length=1)
    # core/apps.py APPS의 id. 표에 있는지는 PolicyGuard.check_desk가 본다(스키마는 모양만).
    app: str = Field(min_length=1)
    reason: str = Field(min_length=1)
    risk: Risk
    requiresConfirmation: bool


class DeskLaunch(_DeskBase):
    """앱 켜기(이미 떠 있으면 그 창을 앞으로)."""

    type: Literal["launch"]


class DeskShowFolder(_DeskBase):
    """탐색기 창에 이 폴더를 보이기. select가 있으면 그 항목을 고른다(누르기 전 '초점 옮기기'의 짝)."""

    type: Literal["show_folder"]
    at: FolderRef
    select: Optional[str] = Field(default=None, min_length=1, max_length=255)


class DeskOpenFile(_DeskBase):
    """파일을 기본 앱으로 열기. name은 at 폴더 목록에서 본 이름 그대로."""

    type: Literal["open_file"]
    at: FolderRef
    name: str = Field(min_length=1, max_length=255)


class DeskInvoke(_DeskBase):
    """이름으로 찾은 조작 요소 누르기."""

    type: Literal["invoke"]
    target: ItemTarget


class DeskAct(_DeskBase):
    """앱 표에 적힌 이름 붙은 동작 하나. value는 받아쓴 글(TypeInto일 때만)."""

    type: Literal["act"]
    act: str = Field(min_length=1)
    value: Optional[str] = Field(default=None, max_length=300)


class DeskCapture(_DeskBase):
    """이 앱의 창 하나를 가리고 찍기(OpenAI로 보낼 사진)."""

    type: Literal["capture_window"]


DeskAction = Annotated[
    Union[DeskLaunch, DeskShowFolder, DeskOpenFile, DeskInvoke, DeskAct, DeskCapture], Field(discriminator="type")
]
DESK_ACTION_TYPES = ("launch", "show_folder", "open_file", "invoke", "act", "capture_window")


def parse_desk_action(candidate: Any) -> dict | None:
    """통과하면 정리된 dict, 아니면 None(parse_action과 같은 약속)."""
    raise NotImplementedError


def is_desk_action(action: dict) -> bool:
    """웹 Action과 가르는 유일한 기준: type이 DESK_ACTION_TYPES에 있는가(웹 ACTION_TYPES와 겹치지 않는다. 시험이 고정)."""
    raise NotImplementedError


# ---------------------------------------------------------------- 관찰


class Entry(_Loose):
    """폴더 안 항목 하나(숨김·시스템 항목은 애초에 담지 않는다)."""

    name: str
    kind: Literal["folder", "file"]
    fileKind: Optional[FileKind] = None  # 파일일 때
    size: Optional[int] = None
    modified: str  # ISO 시각
    # 승인 지문용: 크기와 고친 시각의 해시. 물은 뒤 파일이 바뀌면 다시 묻는다.
    stamp: str


class UiItem(_Loose):
    """앱 창의 이름 있는 조작 요소. 좌표는 담지 않는다. secret = 비밀번호 칸(값은 읽지 않는다)."""

    ref: str
    role: str
    name: str
    disabled: bool
    secret: bool = False
    editable: bool = False


class DeskView(_Loose):
    """
    데스크톱 화면 관찰. 여기 담긴 글(파일 이름, 창 제목, 요소 이름)은 모두 비신뢰 데이터다.
    웹 Observation과 같은 키(platform, pageId, url, title, fields, errors, capturedAt)를 가져 _finish가 그대로 쓴다.
    """

    platform: Literal["desktop"]
    app: str
    pageId: Literal["desktop-folder", "desktop-app"]
    # 코드가 만든 주소. 폴더: "folder://downloads/병원서류", 앱: "app://notepad". 사용자 계정 이름이 든 실제 경로는 넣지 않는다.
    url: str
    title: str  # 말할 제목: "다운로드 폴더의 병원서류"
    at: Optional[FolderRef] = None
    entries: list[Entry] = Field(default_factory=list)
    # 목록이 길어 잘랐으면 전체 개수
    entryCount: Optional[int] = None
    items: list[UiItem] = Field(default_factory=list)
    # 데스크톱에서는 입력 칸 값을 읽지 않는다. 늘 빈 목록(ObservationSummary 모양 맞춤).
    fields: list = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    capturedAt: str


def parse_desk_view(raw: dict) -> dict:
    raise NotImplementedError


def desk_summary(view: dict) -> dict:
    """DeskView → TurnResult.observation(ObservationSummary 모양: page, url, title, fields=[], errors)."""
    raise NotImplementedError


# ---------------------------------------------------------------- OS 경계

# agents/desktop/folders.safe_path만 만드는 경로. 포트는 이것만 받는다(뿌리 밖·바로 가기·숨김이 아님이 이미 확인된 경로).
SafePath = NewType("SafePath", Path)


class WindowInfo(_Loose):
    """최상위 창 하나. ref는 포트가 정한 불투명한 이름표(핸들을 글로 적은 것)이고 계약 밖으로 나가지 않는다."""

    ref: str
    title: str
    window_class: str
    process: str
    minimized: bool


class DesktopPort(Protocol):
    """
    OS에 닿는 유일한 문. 구현은 agents/desktop/windows.WindowsDesktop(실제)과 tests/fakes.FakeDesktop(메모리).
    DesktopAgent만 부른다(PolicyGuard.check_desk를 지난 뒤). 모든 메서드는 이벤트 루프를 막지 않는다
    (실제 구현은 COM 전용 단일 스레드에서 돈다).
    실패는 AdapterError(core.actions의 EXECUTION_ERROR_CODES)로 올린다.
    """

    async def windows(self) -> list[WindowInfo]:
        """최상위 창 목록(청음 자신의 창은 뺀다). 앞에 있는 창이 먼저."""
        ...

    async def launch(self, how: Launch) -> None: ...

    async def raise_window(self, window: str) -> None:
        """창을 앞으로(최소화돼 있으면 되돌린다)."""
        ...

    async def show_folder(self, path: SafePath, select: str | None = None) -> None:
        """탐색기 창에 폴더를 보인다(열린 탐색기 창이 있으면 그 창을 옮기고, 없으면 새로 연다)."""
        ...

    async def open_file(self, path: SafePath) -> None:
        """기본 앱으로 연다(os.startfile). 실행 파일은 DesktopAgent가 여기까지 보내지 않는다."""
        ...

    async def outline(self, window: str) -> list[UiItem]:
        """창의 이름 있는 조작 요소(깊이·개수 한도 안에서)."""
        ...

    async def invoke(self, window: str, target: dict) -> None:
        """ref로 찾고, 누르기 직전에 role·name을 다시 읽어 다르면 VERIFY_FAILED(웹 _resolve_ref와 같은 약속)."""
        ...

    async def send_keys(self, window: str, chord: str) -> None: ...

    async def type_text(self, window: str, role: str, text: str) -> None: ...

    async def read_text(self, window: str, role: str) -> str: ...

    async def capture(self, window: str, plan: MaskPlan) -> Shot:
        """
        이 창 하나만 찍는다(가려져 있어도 창 자체를 찍는다. 화면 전체를 잘라 내지 않는다).
        plan.anchors의 요소와 모든 글 칸을 검게 칠한 뒤 Picture.masked로 봉한다. 못 가리면 Refused("private").
        """
        ...
