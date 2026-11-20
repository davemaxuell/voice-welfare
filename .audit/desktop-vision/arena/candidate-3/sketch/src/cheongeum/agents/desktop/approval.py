"""
앱 동작의 승인 지문(2차: 파일 열기·창 되살리기). agents/web/approval.py(approval.py:47 fingerprint, :84 recheck)의 짝.

웹 지문은 주소(origin+path)와 누를 대상(role·name)을 적는다. 앱 지문이 적는 것:
  - 앱 id와 '지금 보는 폴더'(전체 경로가 아니라 알려진 폴더 id + 뿌리 아래 상대 경로의 해시. 기록에 사용자 폴더 이름이 평문으로 남지 않게)
  - 각 동작의 종류, 이름(항목 이름), 종류(folder/file), '지금도 그 폴더에 있는가'
  - 읽어 준 문장
창 제목은 넣지 않는다(웹이 본문·제목을 넣지 않는 것과 같은 이유: 제목이 자주 바뀐다, approval.py 머리말).
'응'을 들은 지금 다시 만들어 비교한다: 폴더가 바뀌었거나 그 항목이 없어졌거나 종류가 바뀌었으면 승인을 버리고 무엇이 바뀌었는지 말한다.
"""
from __future__ import annotations


def app_fingerprint(view: dict, actions: list[dict], speech: str) -> dict:
    """view는 WindowView 모양. 반환은 dict(웹 지문과 같은 자리 dialogue.approval["fingerprint"]에 들어간다)."""
    raise NotImplementedError


def recheck_app(asked: dict, view: dict, actions: list[dict]) -> tuple[dict, str | None]:
    """
    (새 지문, 달라진 것을 말하는 문장. 같으면 None). recheck(approval.py:84)와 같은 반환.
    문장 예: 여쭤본 뒤에 폴더가 바뀌었어요 / 열려던 '이력서.pdf'가 없어졌어요.
    """
    raise NotImplementedError
