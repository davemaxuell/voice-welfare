"""
[새 파일] 웹 화면 사진의 판단(모두 순수 함수): 찍어도 되는가, 무엇을 가리는가, 사진이 필요한 화면인가.
입력은 화면 관찰(view) 하나다. 청음이 화면에 대해 이미 아는 것만으로 정한다. 브라우저를 만지지 않는다.
"""
from __future__ import annotations

from typing import Sequence

from cheongeum.core.picture import MaskPlan, Refused

# 본문 글이 이보다 짧고 큰 그림이 있으면 "글이 적은 화면"
THIN_TEXT_CHARS = 120


def picture_refusal(view: dict) -> Refused | None:
    """
    이 화면을 사진으로 보내면 안 되는 까닭. 찍기 "전"에, PolicyGuard보다 먼저 본다. 하나라도 맞으면 찍지 않는다.

      blocked  digest_page(view).kind == "blocked" (digest.BLOCKED: 접속 차단·보안문자 글, digest.py:17)
      auth     auth_page_kind(view) != "other" (로그인·본인인증·간편인증 앱 단서, auth_page.py:55)
               또는 보이는 비밀번호 칸·일회용 번호 칸(fields[].sensitive)이 하나라도 있음
      private  신청서 화면(pageId가 mock-welfare이거나 step이 있음): 넣은 값이 검토 화면에 글로 보인다
      (빈 화면·허용되지 않은 주소는 PolicyGuard가 DENIED_ORIGIN으로 막는다)

    말은 코드가 만든다. 예: Refused("auth", "로그인 화면은 사진으로 보내지 않아요.")
    그림으로만 된 보안문자(글 단서 없음)는 여기서 못 잡는다. 그다음 그물이 둘 있다:
    mask.js가 요소 속성(id·class·src·alt의 captcha·보안문자)을 보고 Refused를 돌려주고, Eyes.describe가 모델의 kind=captcha를 버린다.
    """
    raise NotImplementedError


def mask_plan(view: dict, known_private: Sequence[str]) -> MaskPlan:
    """
    가릴 것.
      anchors  view["fields"]의 fieldId 전부(검색창·체크 상자 포함. 값이 비어 있어도 가린다: 관찰과 촬영 사이에 사용자가 칠 수 있다)
      private  private_values(본문·제목·팝업 글·항목 이름) ∪ known_private 중 화면 글에 실제로 나오는 것
               (known_private = 금고 값 + 이번 대화에서 청음이 칸에 넣은 값. 이름·주소처럼 규칙이 못 알아보는 것까지 가린다)
      frames   늘 True
    """
    raise NotImplementedError


def wants_picture(view: dict) -> bool:
    """
    "화면 설명해줘"에 글 요약만으로는 모자란 화면인가(사용자가 사진을 말하지 않았을 때의 자동 판단).
    outline.visual(observe.js가 새로 세는 값: 보이는 큰 그림·캔버스 수, 그것이 보이는 영역에서 차지하는 비율)을 본다.
      - 본문 글이 THIN_TEXT_CHARS보다 짧고 큰 그림이 하나 이상, 또는
      - 큰 그림이 보이는 영역의 절반 이상을 덮음(그림으로 올린 공지)
    목표 수행의 단계마다, 페이지를 열 때마다는 부르지 않는다. BrowseSkill.screen만 부른다.
    """
    raise NotImplementedError


def picture_names(view: dict) -> list[str]:
    """사진 설명에 딸려 보낼 '누를 수 있는 것' 이름: outline.items의 name(본문 영역 먼저, 중복·빈 이름 제외, 40개까지)."""
    raise NotImplementedError


def picture_sources(view: dict) -> list[str]:
    """숫자 대조에 쓸 글: 제목, 정리한 본문(digest_page(view).main), 항목 이름. redact하지 않은 원문(check_grounding과 같은 약속)."""
    raise NotImplementedError
