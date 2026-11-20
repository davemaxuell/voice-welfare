"""
[새 파일] 데스크톱 승인 지문. agents/web/approval.py와 같은 두 함수, 같은 모양의 결과.
승인 문(SessionOrchestrator._approve)은 승인 대기에 든 액션이 웹 것인지 데스크톱 것인지에 따라 둘 중 하나를 부른다.

지문에 넣는 것: 앱 id, 조작 종류, 폴더(장소 + 이름들), 파일 이름과 stamp(크기·고친 시각의 해시),
누를 요소의 role·name·ref, 넣을 글의 해시, 읽어 준 문장.
넣지 않는 것: 창 제목(문서 이름·시계로 계속 바뀐다), 폴더의 다른 항목(그사이 다운로드가 끝나 목록이 늘어도 취소되지 않게).
"""
from __future__ import annotations


def fingerprint(view: dict, actions: list[dict], speech: str) -> dict:
    """view = DeskView. 돌려주는 dict에는 웹 지문처럼 "speech"가 있다(시간이 지나 다시 물을 때 읽는다)."""
    raise NotImplementedError


def recheck(asked: dict, view: dict, actions: list[dict]) -> tuple[dict, str | None]:
    """
    (새 지문, 달라진 것을 말하는 문장 — 같으면 None). 문장은 코드가 만든다:
      "여쭤본 뒤에 다른 폴더로 옮겨졌어요." / "열려던 '설치안내.zip' 파일이 그사이 바뀌었어요." / "… 파일이 없어졌어요."
      / "누르려던 '저장' 단추가 창에서 없어졌어요." / "메모장 창이 닫혔어요."
    """
    raise NotImplementedError
