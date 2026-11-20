"""
[새 파일] 앱·폴더 이름 → ID. understanding/sites.py(사이트 이름 → 주소)의 짝이다.
목록에 없는 이름은 추측하지 않는다(부르는 쪽이 "그 앱은 아직 열 수 없어요"라고 말한다).
여기에는 말할 이름만 있다. 실행 방법·창 모양·허용 동작은 agents/desktop/registry.py가 같은 ID로 가진다.
두 표의 ID 집합은 core.desktop.AppId·PlaceId와 같아야 하고, 다르면 가져올 때 실패한다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from cheongeum.core.desktop import APP_IDS, PLACE_IDS, AppId, PlaceId


@dataclass(frozen=True)
class SpokenApp:
    id: AppId
    names: tuple[str, ...]
    # 말할 이름("파일 탐색기")
    label: str


@dataclass(frozen=True)
class SpokenPlace:
    id: PlaceId
    # '사진'·'문서'·'음악'·'다운로드'처럼 흔한 낱말은 '폴더'를 붙인 이름만 둔다("이 사진 뭐야?"는 화면 설명).
    # '바탕화면'만 홀로 쓴다(오늘은 '화면에 뭐'로 DESCRIBE_SCREEN에 잘못 잡힌다).
    names: tuple[str, ...]
    label: str


APPS: dict[AppId, SpokenApp] = {
    "explorer": SpokenApp("explorer", ("파일 탐색기", "파일탐색기", "탐색기", "윈도 탐색기", "내 PC", "내 컴퓨터"), "파일 탐색기"),
}

PLACES: dict[PlaceId, SpokenPlace] = {
    "downloads": SpokenPlace("downloads", ("다운로드 폴더", "내려받기 폴더", "받은 파일 폴더"), "다운로드"),
    "desktop": SpokenPlace("desktop", ("바탕화면", "바탕 화면", "데스크톱 폴더"), "바탕화면"),
    "documents": SpokenPlace("documents", ("문서 폴더", "내 문서"), "문서"),
    "pictures": SpokenPlace("pictures", ("사진 폴더", "그림 폴더"), "사진"),
    "music": SpokenPlace("music", ("음악 폴더",), "음악"),
    "videos": SpokenPlace("videos", ("동영상 폴더", "비디오 폴더"), "동영상"),
}

assert set(APPS) == set(APP_IDS), "understanding/apps.py APPS가 core.desktop.AppId와 다릅니다"
assert set(PLACES) == set(PLACE_IDS), "understanding/apps.py PLACES가 core.desktop.PlaceId와 다릅니다"


@dataclass(frozen=True)
class DesktopName:
    """말 속에서 찾은 앱 또는 폴더 하나."""

    kind: Literal["app", "place"]
    id: str
    label: str


def find_desktop_name(text: str) -> DesktopName | None:
    """
    말에 든 앱·폴더 이름(띄어쓰기 무시, 가장 긴 이름 우선). 받아쓰기가 한 글자 틀린 세 글자 이상 한글 이름도
    sites.near_site와 같은 규칙으로 맞춘다("탐색끼"→탐색기). 없으면 None.
    """
    raise NotImplementedError


def mentions_desktop(text: str) -> bool:
    """규칙 파서용: 앱이나 폴더 이름이 들어 있는지."""
    raise NotImplementedError
