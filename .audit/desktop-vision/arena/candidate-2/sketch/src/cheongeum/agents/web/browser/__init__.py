"""
[바뀌는 것만] agents/web/browser/__init__.py — 메서드 하나와 스크립트 파일 하나(mask.js).
"""
from __future__ import annotations

from cheongeum.core.jsutil import AbortSignal
from cheongeum.core.picture import MaskPlan, Shot

# mask.js: observe.js처럼 페이지 안에서 도는 스크립트 두 개(붙이기·떼기). 같은 폴더에 둔다.
#
#   MASK_ON(plan) → {"hidden": n, "kinds": [...], "unlocated": [...], "blockers": [...]}
#     1. plan.anchors의 칸: [id=..], [data-cheongeum-id=..] (어댑터가 칸을 찾는 것과 같은 선택자, __init__.py:494)
#        + 관찰에 안 잡힌 것까지 input, textarea, select, [contenteditable] 전부에 data-cheongeum-mask를 붙인다.
#     2. plan.frames: iframe, embed, object 전부에 붙인다(교차 출처 틀은 속을 볼 수 없다. 통째로).
#     3. plan.private의 글마다 TreeWalker로 그 글이 든 글 노드를 찾아 가장 가까운 요소에 붙인다.
#        하나도 못 찾은 글은 unlocated에 담는다(이미지 속 글일 수 있다 → 찍지 않는다).
#     4. 보안문자 단서: id·class·name·src·alt·title에 captcha|recaptcha|hcaptcha|turnstile|보안문자|자동입력이 든
#        보이는 요소가 있으면 blockers에 담는다 → 찍지 않는다(가리고 찍지도 않는다: 그 화면은 사용자가 직접 풀 화면이다).
#   MASK_OFF() → data-cheongeum-mask를 모두 뗀다(화면은 원래대로. 글·모양을 바꾸지 않는 속성 하나뿐이다).

# 사진에 찍히면 안 되는 청음 자신의 덧그림(가상 커서와 물결, cursor.js:18-45)
_HIDE_OVERLAYS = "#__cheongeum_cursor, [id^='__cheongeum_']{visibility:hidden !important}"


class PlaywrightExecutionAdapter:
    # ... 기존 메서드는 그대로 ...

    async def capture(self, plan: MaskPlan, signal: AbortSignal | None = None) -> Shot:
        """
        지금 탭(self.page, :128)의 보이는 부분을 가리고 찍는다.

          report = await page.evaluate(MASK_ON, plan)
          try:
              if report["blockers"]: return Refused("blocked", ...)
              if report["unlocated"]: return Refused("private", "가려야 할 개인정보를 화면에서 찾지 못해 사진을 찍지 않았어요.")
              png = await page.screenshot(
                  type="png", full_page=False, scale="css", animations="disabled", caret="hide",
                  mask=[page.locator("[data-cheongeum-mask]")], mask_color="#000000",
                  style=_HIDE_OVERLAYS, timeout=self.action_timeout,
              )
              return Picture.masked(png, width=..., height=..., surface="pc", mask=MaskReport(report["hidden"], tuple(report["kinds"])))
          finally:
              await page.evaluate(MASK_OFF)      # 실패해도 표시는 떼어 낸다

        찍는 것은 이 탭뿐이다. 브라우저 틀·다른 탭·다른 창은 Playwright가 찍지 않는다.
        시간 초과·닫힌 탭은 Refused("failed"). 멈춤 신호(signal)가 오면 사진을 버리고 Refused("failed").
        """
        raise NotImplementedError
