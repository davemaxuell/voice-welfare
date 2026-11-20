"""
[새 파일] 알려진 폴더 안에서만: 경로 확인, 목록 읽기, 말한 이름 → 항목 찾기. 순수 함수 + os.scandir(시험도 진짜 파일로).

resolve_in_place는 '폴더 밖으로 나가지 않는다'는 규칙의 단 하나의 구현이다. 관찰(observe_folder)과 실행 직전(DesktopAgent._run)이
둘 다 이것을 부른다. 가드(safety/desktop_guard.py)는 이름 조각의 모양만 보고, 실제 경로는 여기서 본다(웹의 _resolve_ref 자리).
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal

from cheongeum.core.desktop import PlaceId

from cheongeum.agents.desktop.model import FolderEntry, FolderView

# 다운로드·바탕화면은 최근 것부터, 그 밖은 폴더 먼저 이름순
RECENT_FIRST: frozenset[PlaceId] = frozenset({"downloads", "desktop"})
LIST_PAGE = 5


def resolve_in_place(root: Path, rel: tuple[str, ...]) -> Path | None:
    """
    root/rel의 실제 경로(os.path.realpath: 바로 가기 폴더·정션을 따라간 뒤)가 root의 실제 경로 안이면 그 경로, 아니면 None.
    rel 조각은 이미 계약이 모양을 확인했다(DesktopTarget._plain_parts). 없는 경로도 None.
    """
    raise NotImplementedError


def read_folder(root: Path, place: PlaceId, rel: tuple[str, ...], label: str) -> FolderView | None:
    """
    os.scandir로 읽는다. 숨김·시스템 속성 파일, desktop.ini·thumbs.db, 이름이 '~$'로 시작하는 임시 파일은 뺀다.
    from_internet은 '<path>:Zone.Identifier' 대체 데이터 스트림이 있는지로 본다(윈도에서만, 그 밖은 False).
    정렬은 RECENT_FIRST 규칙. 2000개 넘으면 앞 2000개만(전체 수는 따로 센다).
    """
    raise NotImplementedError


def spoken_key(filename: str) -> str:
    """말과 맞춰 볼 열쇠: NFC, 소문자, 확장자 뗌, _-.()[] → 띄어쓰기, 띄어쓰기 없앰."""
    raise NotImplementedError


def match_entry(entries: tuple[FolderEntry, ...], spoken: str, kind: Literal["folder", "file"] | None = None) -> tuple[FolderEntry | None, list[str]]:
    """
    말한 이름으로 항목 찾기(follow_link의 _locate와 같은 원칙): 완전히 같은 열쇠가 우선, 없으면 두 글자 이상 포함.
    하나만 맞을 때만 항목을 돌려준다. 여럿이면 (None, 후보 이름들) → 부르는 쪽이 되묻는다(추측 금지).
    """
    raise NotImplementedError


def speak_filename(entry: FolderEntry) -> str:
    """"기초연금_안내(2026).pdf" → "기초연금 안내 2026, PDF 파일". 폴더면 "회의자료 폴더"."""
    raise NotImplementedError
