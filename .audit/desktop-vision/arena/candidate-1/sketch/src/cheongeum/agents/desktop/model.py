"""
[새 파일] 데스크톱에서 청음이 아는 것(관찰). 관찰할 때마다 OS에서 새로 만든다. 청음이 따로 '지금 폴더'를 들고 다니지 않는다:
탐색기 창이 있으면 그 창의 위치(셸 자동화 API)가 진실이고, 창 없이 읽은 폴더는 그 읽기 한 번의 결과일 뿐이다.
창 제목·UIA 이름·파일 이름은 모두 비신뢰 글이다(명령으로 해석하지 않는다).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from cheongeum.core.context import OutcomeStatus
from cheongeum.core.desktop import AppId, AppTier, PlaceId

# 창 종류: 누가 이 창의 주인인가(제목이 아니라 프로세스·창 종류로 정한다)
#  own = 청음 자신(Electron 셸: 이 파이썬의 조상 프로세스), browser = 청음이 띄운 브라우저(이 파이썬의 자손 프로세스),
#  app = 등록된 앱, shell = 바탕화면·작업 표시줄, credential = 자격 증명·인증서 창, foreign = 그 밖의 남의 창
WindowKind = Literal["own", "browser", "app", "shell", "credential", "foreign"]


@dataclass(frozen=True)
class WindowRef:
    hwnd: int
    pid: int
    # 실행 파일 이름(소문자, 경로 없이): "explorer.exe"
    process: str
    # 창 종류 이름: "CabinetWClass"
    window_class: str
    # 비신뢰. 말할 때만 쓰고 판정·지문에는 쓰지 않는다.
    title: str
    minimized: bool = False


@dataclass(frozen=True)
class FolderEntry:
    """파일 시스템에서 읽은 항목 하나(숨김·시스템 파일은 목록에 넣지 않는다)."""

    name: str
    kind: Literal["folder", "file"]
    # 소문자 확장자(점 포함), 폴더면 ""
    ext: str
    size: int
    mtime_ns: int
    # Zone.Identifier(인터넷에서 받음 표시)가 있음
    from_internet: bool


@dataclass(frozen=True)
class FolderView:
    place: PlaceId
    # place 아래 상대 이름 조각(루트면 빈 튜플)
    rel: tuple[str, ...]
    # 실제 경로(포트·에이전트 안에서만. TurnResult·LLM·기록에는 넣지 않는다: 사용자 이름이 들어 있다)
    path: Path
    # 말할 위치: "다운로드", "다운로드 안의 회의자료"
    label: str
    # 정렬된 항목: 다운로드·바탕화면은 최근 바뀐 순, 그 밖은 폴더 먼저 이름순
    entries: tuple[FolderEntry, ...]
    # 탐색기 창에서 선택된 항목 이름(창이 없으면 비어 있음)
    selected: tuple[str, ...] = ()


@dataclass(frozen=True)
class DesktopView:
    """데스크톱 관찰 하나. window가 없으면 창 없이 읽은 폴더."""

    window: WindowRef | None
    kind: WindowKind | None
    app: AppId | None
    tier: AppTier
    folder: FolderView | None = None
    # 남의 창(foreign): UIA로 읽은 이름들(버튼·메뉴·글). 비신뢰.
    texts: tuple[str, ...] = ()
    # 탐색기 창이 폴더가 아닌 곳(홈·내 PC·휴지통)을 보고 있음
    special_location: bool = False
    captured_at: str = ""


@dataclass(frozen=True)
class Focus:
    """
    이번 턴이 말하는 표면. 턴을 시작할 때 resolve_focus가 한 번 정한다(agents/desktop/focus.py).
    web이면 지금까지와 똑같이 동작한다(데스크톱이 꺼져 있으면 언제나 web).
    """

    surface: Literal["web", "desktop"]
    window: WindowRef | None = None
    kind: WindowKind | None = None
    app: AppId | None = None

    @staticmethod
    def web() -> "Focus":
        return Focus("web")


@dataclass
class DesktopOutcome:
    """DesktopAgent 결과(WebOutcome의 짝). status 값은 core.context.OutcomeStatus 하나를 같이 쓴다."""

    status: OutcomeStatus
    actions: list[dict]
    view: DesktopView | None = None
    message: str | None = None
    # needs-approval: 사용자가 '진행해'라고 하면 그대로 실행할 동작
    pending: dict | None = None
    # 이름이 여러 개 맞을 때 후보(말할 이름)
    candidates: list[str] | None = None
    # read_file: 읽어 줄 글(이미 잘라 둔 것)
    text: str | None = None
    # pending 대상으로 탐색기에서 선택(초점)을 옮겼는지
    focused: bool = False
    extra: dict = field(default_factory=dict)
