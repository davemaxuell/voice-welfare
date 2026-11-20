"""
[새 파일] 앱 창 사진의 판단(순수 함수). agents/web/shot.py의 짝: 같은 이름, 같은 결과 타입, 입력만 DeskView.
"""
from __future__ import annotations

from typing import Sequence

from cheongeum.core.picture import MaskPlan, Refused


def picture_refusal(view: dict) -> Refused | None:
    """
    auth     창에 비밀번호 칸(UiItem.secret)이 있음, 또는 창 제목·요소 이름이 로그인·본인인증·인증서(웹 auth_page와 같은 낱말)
    blocked  요소 이름에 보안문자·자동입력 방지
    (앱 표의 picture 정책 never·ask는 PolicyGuard.check_desk가 본다. 여기는 화면에서 보이는 것만.)
    """
    raise NotImplementedError


def mask_plan(view: dict, known_private: Sequence[str]) -> MaskPlan:
    """
    anchors = editable인 요소의 ref 전부(메모장 본문, 주소 표시줄, 검색 칸: 사용자가 친 글은 통째로 가린다)
    private = private_values(항목 이름·파일 이름) ∪ known_private 중 이름에 나오는 것
    폴더 화면은 파일 이름이 그대로 보인다. 이름에 금고 값(사용자 이름 등)이 든 파일은 그 줄을 가린다.
    """
    raise NotImplementedError


def picture_names(view: dict) -> list[str]:
    """폴더면 항목 이름, 앱 창이면 조작 요소 이름(40개까지)."""
    raise NotImplementedError


def picture_sources(view: dict) -> list[str]:
    raise NotImplementedError
