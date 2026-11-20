"""
[새 파일] 앱 이름 → 앱, 폴더 이름 → 장소. understanding/sites.py(사이트 이름 → 주소)의 짝.
표는 core/apps.py에 있고(PolicyGuard도 읽어야 해서), 여기는 사람 말에서 이름을 찾는 일만 한다.
목록에 없는 이름은 추측하지 않는다. 웹 검색으로 넘기지도 않는다("메모장 홈페이지"를 네이버에서 찾던 일이 없어진다).
"""
from __future__ import annotations

from cheongeum.core.apps import AppSpec, PlaceSpec


def resolve_app(said: str) -> AppSpec | None:
    """
    말에 든 앱 이름으로 앱 표의 한 줄을 찾는다. 긴 이름이 먼저 맞는다("파일 탐색기" > "탐색기").
    받아쓰기가 한 글자 틀린 세 글자 이상 한글 이름도 맞춘다(sites.near_site와 같은 규칙).
    """
    raise NotImplementedError


def resolve_place(said: str) -> PlaceSpec | None:
    """말에 든 폴더 이름으로 장소 표의 한 줄을 찾는다. "바탕화면에 뭐 있어?" → desktop."""
    raise NotImplementedError


def mentions_app(text: str) -> bool:
    """규칙 파서용(sites.mentions_known_site의 짝)."""
    raise NotImplementedError


def mentions_place(text: str) -> bool:
    """
    규칙 파서용. '문서'·'사진'·'음악' 같은 흔한 낱말은 '폴더'가 붙거나 '내 문서'일 때만 장소로 본다
    ("서류 사진 찍어야 해?"가 사진 폴더가 되지 않게). '바탕화면'·'다운로드 폴더'는 그대로.
    """
    raise NotImplementedError
