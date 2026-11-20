# 변경 부분만 보인다. 원본: src/cheongeum/agents/web/browser/__init__.py:566 (observe)
# ExecutionAdapter Protocol(core/actions.py:217)에는 아무것도 더하지 않는다.
# 그림 능력은 perception.screen.ScreenSource를 구조적으로 만족하면 된다.

PICTURE_MASK_SELECTORS = (
    "input, textarea, select, [type=password], iframe",
)  # 값·입력 칸은 DOM 기준으로 가린다. 픽셀 탐지는 하지 않는다.


class PlaywrightExecutionAdapter:
    async def picture(self, scope, masks) -> bytes:
        """현재 페이지의 보이는 영역만 PNG로 찍는다.

        - self.page가 없으면 예외. 공유 Chrome에서는 이 탭만 찍는다(_claimed_pages).
        - style로 #__cheongeum_cursor와 ripple 요소를 숨긴다(cursor.js).
        - mask는 PICTURE_MASK_SELECTORS와 MaskBox(selector) 값의 합집합.
        - scale="css", full_page=False.
        """
        raise NotImplementedError
