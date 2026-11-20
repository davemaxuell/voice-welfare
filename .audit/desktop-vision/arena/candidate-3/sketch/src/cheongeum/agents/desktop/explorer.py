"""
탐색기의 사실은 파일 시스템이 안다. 이 모듈은 폴더를 읽어 WindowView 모양으로 만들고, 이름 일부로 항목을 찾는다. 순수하고 OS 창을 모른다.

왜 창(UIA)이 아니라 파일 시스템인가(주인에게 말한 근거, probe-facts.md):
 - 최소화된 탐색기 창은 UIA로 제목 줄만 보이고 목록이 0개다. 창을 되살려야 읽는데, 되살리는 것은 사용자 화면을 바꾸는 일이다.
 - UIA로 목록 항목을 '누르면' 그 항목의 경로를 가드가 볼 수 없다(더블클릭으로 .exe가 실행될 수 있다). 파일 시스템 길은 가드가 경로 전체를 본다.
 - UIA 첫 호출은 643ms(COM 시작, probe-facts.md)이고, 복원된 탐색기 목록이 항목을 몇 개나 내놓는지는 아직 재지 않았다(스파이크 S3). os.scandir은 완전하고 빠르다.
 - 오프라인 시험이 된다(tmp_path).
창은 따라가게만 한다(DesktopPort.show_folder). 사실과 창이 어긋나도 사용자가 듣는 것은 파일 시스템의 사실이다.
탐색기가 기본으로 숨기는 것(숨김·시스템 속성, desktop.ini)은 같게 숨긴다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

LIST_LIMIT = 1000  # 이보다 많으면 앞쪽만 읽고 truncated


@dataclass(frozen=True)
class Entry:
    name: str  # 확장자 포함(말할 때는 speech/apps.py가 줄인다)
    kind: Literal["folder", "file"]
    ext: str | None  # 소문자, 점 없음
    size: int | None
    modified: str | None  # ISO 날짜


@dataclass(frozen=True)
class Listing:
    path: str
    entries: tuple[Entry, ...]  # 읽어 줄 차례대로: 폴더 먼저(이름), 파일은 place.sort("name"|"recent")
    folders: int
    files: int
    truncated: bool


def list_folder(path: str, *, sort: Literal["name", "recent"], limit: int = LIST_LIMIT) -> Listing:
    """
    os.scandir로 읽는다. 숨김·시스템 속성 항목과 desktop.ini는 뺀다. 이름 비교는 NFC 정규화 + casefold.
    읽을 수 없는 폴더(권한·사라짐)는 FileNotFoundError·PermissionError를 그대로 올린다: 부르는 쪽(어댑터)이 TARGET_NOT_FOUND / NAVIGATION_FAILED로 바꾼다.
    """
    raise NotImplementedError


@dataclass(frozen=True)
class Located:
    entry: Entry | None  # 하나만 맞을 때만
    hits: tuple[str, ...]  # 맞은 이름들(여럿이면 되묻기 후보, 없으면 빈 튜플)


def locate(listing: Listing, spoken: str, *, kind: Literal["folder", "file", "any"] = "any") -> Located:
    """
    말한 이름으로 항목을 찾는다. WebExecutionAgent._locate(agent.py:210)와 같은 규칙: 이름 정규화 후 정확히 같은 것 먼저, 없으면 부분 포함(2자 이상).
    확장자를 뺀 이름도 같은 이름으로 본다("이력서"가 "이력서.pdf"). 같은 이름에 확장자만 다르면 여럿이라 되묻는다(추측 금지).
    """
    raise NotImplementedError


def home_places(places: dict[str, str]) -> Listing:
    """'홈' 화면(알려진 폴더 고르기): 실제로 있는 알려진 폴더만 항목으로(kind="folder"). 경로 칸은 비운다(가상 화면)."""
    raise NotImplementedError


def parent_within(path: str, roots: list[str]) -> str | None:
    """한 단계 위 폴더. 뿌리 밖으로 나가게 되면 None(부르는 쪽이 '더 올라갈 수 없어요, 홈으로 갈게요')."""
    raise NotImplementedError
