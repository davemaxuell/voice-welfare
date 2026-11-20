"""
agents/web/browser/__init__.py: 바뀌는 곳만. PlaywrightExecutionAdapter(__init__.py:104)에 메서드 하나.

이 어댑터가 MaskedShot을 만드는 두 곳 중 하나다(다른 하나는 agents/desktop/win32.py). 그 밖에서 MaskedShot(...)을 부르면
tests/unit/test_shot_boundary.py가 실패한다. self.page(__init__.py:128)는 이 세션의 탭 하나이므로 '지금 설명하는 창만'이 구조로 지켜진다:
page.screenshot은 그 탭의 보이는 부분(뷰포트)만 찍는다. 전체 페이지·다른 탭·브라우저 바깥 창은 찍을 수 없다.
"""
from __future__ import annotations

from cheongeum.agents.web.shot import ShotPlan
from cheongeum.core.vision import MaskedShot, ShotRefusal


class _PlaywrightExecutionAdapterChanges:
    async def capture(self, plan: ShotPlan) -> MaskedShot | ShotRefusal:
        """
        1) CAPTCHA_SELECTOR가 하나라도 있으면 ShotRefusal("captcha")(찍지 않는다).
        2) 가릴 것 만들기:
             fields = page.locator(MASK_SELECTOR)
             frames = page.locator(FRAME_SELECTOR)
             texts  = [page.get_by_text(anchor) for anchor in plan.text_anchors]
           texts 각각의 count()가 0이면 unmatched += 1.  unmatched가 있으면 찍지 않고 ShotRefusal("unmaskable").
        3) png = await page.screenshot(type="png", scale="css", mask=[fields, frames, *texts], mask_color="#000000",
                                       style=HIDE_OVERLAY_CSS, animations="disabled", caret="hide", timeout=5000)
           (full_page=False: 보이는 부분만. 크기는 보내기 전에 긴 변 1568px로 줄인다.)
        4) 보인 가리기 수를 세어 MaskReport(fields, texts, frames, overlay_hidden=True, unmatched=0)로 적고 MaskedShot(png, meta, report).
        타임아웃·닫힌 탭은 예외를 삼키지 않고 AdapterError("TIMEOUT")로 올려 executor가 ActionResult로 만든다.
        공유 크롬(no_viewport, __init__.py:78)의 뒷 탭에서 멈추는지는 아직 모른다 → 스파이크 S2. 멈추면 bring_to_front 없이 거절("minimized")로 대신한다.
        """
        raise NotImplementedError
