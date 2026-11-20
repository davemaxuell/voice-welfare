"""
[새 파일] 데스크톱 승인 지문(agents/web/approval.py의 짝). 물을 때 읽어 준 것을 적어 두었다가 '진행해'를 들으면 다시 만들어 비교한다.
넣는 것: 동작 이름, 앱, 폴더(place)와 이름 조각(rel), 그 항목의 종류·크기·바뀐 시각(파일 시스템), 읽어 준 문장.
넣지 않는 것: 창 제목(파일을 열면 바뀌고 비신뢰), 실제 경로(사용자 이름이 들어 있다).
"""
from __future__ import annotations

from cheongeum.agents.desktop.model import FolderEntry


def fingerprint(action: dict, entry: FolderEntry | None, speech: str) -> dict:
    """{'surface': 'desktop', 'verb', 'app', 'place', 'rel', 'entry': {kind, size, mtime_ns} | None, 'speech'}"""
    raise NotImplementedError


def recheck(asked: dict, action: dict, entry_now: FolderEntry | None) -> tuple[dict, str | None]:
    """
    (새 지문, 달라진 것을 말하는 문장 또는 None).
    문장 예: "열려던 '신청서.hwp' 파일이 그사이 없어졌어요." / "여쭤본 뒤에 '신청서.hwp' 파일 내용이 바뀌었어요."
    """
    raise NotImplementedError
