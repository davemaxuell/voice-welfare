"""
[바뀌는 부분만] core/actions.py (+ agents/web/browser/observe.js)

'글이 적은 화면'을 알려면 그림이 얼마나 있는지 알아야 하는데 observe.js는 지금 그림을 세지 않는다.
outline에 media를 더한다. _Loose 모델은 모르는 키를 버리므로(actions.py:49-52) 모델에 칸을 적어야 남는다.
ActionTarget·Action·ActionType은 바꾸지 않는다(좌표 없음, 데스크톱 동작은 core/desktop.py의 형제 계약).

observe.js(result.outline에 더함):
    media: { images: 보이는 <img>·[role=img] 중 120×80px 이상 수, frames: 보이는 iframe 수, canvases: 보이는 canvas·큰 svg 수 }

ExecutionAdapter Protocol(actions.py:217)에 두 메서드를 더한다(PlaywrightExecutionAdapter만 구현):
    async def probe_masks(self) -> dict          # MASK_SCRIPT 결과
    async def capture(self, plan) -> MaskedShot | CaptureRefusal
"""
from __future__ import annotations

from typing import Optional

from pydantic import Field


class Media:  # (_Loose)
    images: int = Field(ge=0)
    frames: int = Field(ge=0)
    canvases: int = Field(ge=0)


class ScreenOutline:  # (_Loose) 지금 칸 그대로 + 아래 한 칸
    media: Optional[Media] = None


def visuals(view: dict) -> int:
    """choose_source의 visuals = media.images + frames + canvases(없으면 0). agents/web/digest.py에 둔다."""
    raise NotImplementedError
