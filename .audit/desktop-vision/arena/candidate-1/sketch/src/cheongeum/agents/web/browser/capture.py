"""
[새 파일] 웹 페이지 그림: 가릴 곳을 정하고(이미 관찰한 것에서) Playwright로 가린 채 찍는다.

가릴 곳(MaskPlan)은 청음이 이미 아는 것에서 나온다:
 - 입력 칸 전부: input(hidden·submit·button·image·reset 제외)·textarea·select·[contenteditable]·[role=textbox|combobox|searchbox].
   observe.js가 값을 읽는 바로 그 칸들이라, 이름·전화처럼 '민감 아님'으로 관찰에 들어간 값도 그림에는 나가지 않는다.
 - 개인정보 글: MASK_SCRIPT가 보이는 잎 글 덩어리에 임시 표시(data-cheongeum-mask)를 붙여 글과 함께 돌려주고,
   파이썬이 detect_sensitive(규칙 ∪ 로컬 모델)로 판정한 덩어리만 가린다(판정 규칙은 safety 한 곳).
 - 다른 출처의 끼운 틀(iframe): 안을 읽을 수 없어 개인정보 판정을 못 하므로 통째로 가린다(실패하면 닫힌 쪽).
 - 청음 커서(#__cheongeum_cursor)와 물결: style로 숨긴다(cursor.js의 요소. 그림에 커서가 찍히지 않게).
CAPTCHA 틀(recaptcha·hcaptcha·turnstile·[data-sitekey])이 있으면 MASK_SCRIPT가 알리고, subject.captcha=True가 되어 찍지 않는다.
좌표는 Playwright 안에서만 쓰인다(mask=[locator]). 이 파일 밖으로 나가지 않는다.
"""
from __future__ import annotations

from dataclasses import dataclass

from cheongeum.core.shot import CaptureRefusal, MaskedShot

# 커서·물결 숨김(page.screenshot(style=...))
HIDE_OVERLAY_CSS = "#__cheongeum_cursor, [id^='__cheongeum_ripple'] { visibility: hidden !important; }"

# 페이지 안에서 돈다: {inputs: n, frames: [{tag, crossOrigin}], captcha: bool, texts: [{mark, text}]}
# 입력 칸·다른 출처 틀에는 data-cheongeum-mask="i…"/"f…"를, 글 덩어리에는 "t…"를 붙인다(관찰의 ref와 별개).
MASK_SCRIPT = "/* observe.js와 같은 isVisible 규칙. 글 덩어리는 400개·덩어리당 300자까지. */"


@dataclass(frozen=True)
class MaskPlan:
    """찍을 때 가릴 표시들. 순수 함수 plan_masks가 만든다."""

    marks: tuple[str, ...]
    inputs: int
    personal: int
    frames: int
    captcha: bool


def plan_masks(probe: dict) -> MaskPlan:
    """
    MASK_SCRIPT 결과 → 가릴 표시. 입력·다른 출처 틀은 모두, 글 덩어리는 detect_sensitive(text).hasSecretValue인 것만.
    (순수 함수: 브라우저 없이 시험한다.)
    """
    raise NotImplementedError


async def capture_page(page, plan: MaskPlan) -> MaskedShot | CaptureRefusal:
    """
    page.screenshot(type="png", scale="css", animations="disabled", caret="hide", full_page=False,
                    mask=[page.locator(f'[data-cheongeum-mask="{m}"]') for m in plan.marks], mask_color="#000000",
                    style=HIDE_OVERLAY_CSS, timeout=5000)
    보이는 부분(뷰포트)만 찍는다(다른 창·탭은 찍히지 않는다). 예외·시간 초과면 CaptureRefusal("capture-failed").
    표시를 붙이거나 찾는 데 실패하면 CaptureRefusal("mask-failed")(가리지 못한 그림은 만들지 않는다).
    찍은 뒤 붙였던 data-cheongeum-mask 표시는 지운다.
    공유 크롬의 뒤쪽 탭이면 먼저 bring_to_front(S2 시험 결과에 따라).
    """
    raise NotImplementedError
