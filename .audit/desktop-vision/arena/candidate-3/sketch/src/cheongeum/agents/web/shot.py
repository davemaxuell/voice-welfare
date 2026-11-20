"""
웹 화면 사진의 '가릴 것'과 '아예 안 찍을 것'을 관찰(Observation)에서 정한다. 순수 함수(브라우저를 부르지 않는다).

가리기의 근거는 청음이 이미 아는 화면이다:
  - 입력 칸 전부(typed 이름·전화번호·비밀번호·인증번호가 화면에 그대로 있다): MASK_SELECTOR. 비어 있는 칸도 덮는다(검은 상자 = '입력 칸').
  - 민감한 줄: outline.mainText·dialogs·notices·errors·status의 줄 하나씩 detect_sensitive(privacy.py:138). 한 줄 단위로 가리므로
    welfare 쪽 '주민등록번호 … 숫자' 꼴 안내(redact_text가 본문을 통째로 잘라 버리는 것, privacy.py:117)가 있어도 그 한 줄만 가려진다.
  - 안을 볼 수 없는 액자(iframe: 보안문자·결제·내장 뷰어, observe.js는 iframe에 들어가지 않는다): FRAME_SELECTOR 전부를 통째로.
  - 청음 자신의 가상 커서(cursor.js:18)는 스타일로 숨긴다(HIDE_OVERLAY_CSS).
불변식: '가려야 할 줄이 화면에서 찾아지지 않으면 찍지 않는다'(MaskReport.unmatched > 0 → ShotRefusal("unmaskable")).
이 불변식은 어댑터가 지킨다. 찾지 못한 줄이 있는데 찍어서 새는 길이 없다.

사진 길에서 빼는 화면: 로그인·본인인증(auth_page_kind, auth_page.py:55), 접속 차단·보안문자(digest.BLOCKED, digest.py:17),
그리고 DOM에 보안문자 요소가 있는 화면(CAPTCHA_SELECTOR, 어댑터가 센다). 글 길에는 이미 blocked_speech가 있어 그대로 쓴다.
"""
from __future__ import annotations

from dataclasses import dataclass

from cheongeum.core.vision import ScreenFacts, ShotRefusal

# 이름이 바뀌어도 되도록 접두어로: cursor.js 이름이 지금 바뀌는 중이다(__MODE__ 리팩터, 커밋 전).
HIDE_OVERLAY_CSS = '[id^="__cheongeum"], [class^="__cheongeum"] { display: none !important; }'
MASK_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"]'
FRAME_SELECTOR = "iframe, frame, embed, object"
CAPTCHA_SELECTOR = (
    '[id*="captcha" i], [class*="captcha" i], [name*="captcha" i], [src*="captcha" i], [alt*="captcha" i], '
    '[alt*="보안문자"], [alt*="자동입력방지"], [id*="g-recaptcha"], [class*="g-recaptcha"], [class*="h-captcha"]'
)
# 줄의 앞쪽만 찾는 글로 쓴다(긴 줄은 화면에서 여러 요소로 쪼개져 있을 수 있다). 짧은 줄은 그대로.
TEXT_ANCHOR_CHARS = 40
MAX_TEXT_MASKS = 40  # 이보다 많은 줄이 민감하면 그 화면은 사진으로 보내지 않는다(가리기가 화면 대부분을 덮는다)


@dataclass(frozen=True)
class ShotPlan:
    """어댑터가 실행하는 가리기 계획. 화면 글 자체는 담지 않고 찾을 앞부분(앵커)만 담는다."""

    text_anchors: tuple[str, ...]
    # 필드·액자는 항상 가린다(계획에 켜고 끄는 칸이 없다: 끄는 길이 없어야 새지 않는다)


def plan_shot(view: dict) -> ShotPlan | ShotRefusal:
    """
    관찰에서 계획을 만든다. 사진 길에서 뺄 화면이면 ShotRefusal(이유)를 돌려준다.
    순서: digest.BLOCKED → "blocked", auth_page_kind != "other" → "login"|"verification",
         민감한 줄이 MAX_TEXT_MASKS보다 많으면 "unmaskable", 그 밖에는 ShotPlan.
    """
    raise NotImplementedError


def facts_from_view(view: dict) -> ScreenFacts:
    """
    관찰 → ScreenFacts. digest_page(digest.py)의 정리한 본문(검증 근거), outline.items의 이름(pressables), outline.media, 막힌 화면 종류.
    subject는 site_label(sites.py:140)이 말할 이름. 모든 글은 원문 그대로 담는다(모델에 넘길 때 Sight가 redact_text를 건다).
    (알려진 버그: auth_page._view_haystack이 view.get("mainText")를 읽는데 mainText는 view["outline"] 안에 있다, auth_page.py:36.
     사진 길의 본인인증 판별이 이 함수에 기대므로 U3 전에 한 줄 고친다.)
    """
    raise NotImplementedError
