"""
[바뀌는 것만] core/actions.py

1. 웹 액션 종류에 "capture" 하나를 더한다(actions.py:16-17의 두 목록). 화면 사진도 PolicyGuard를 지나고,
   조작 기록에 남고, 턴당 조작 횟수에 들어가고, TurnResult.actions에 보인다("로그인 화면에서는 찍지 않았다"를 시험이 본다).
   target·url·value는 쓰지 않는다. ActionTarget(:55)은 그대로다: 좌표는 여전히 계약에 없다.
2. ExecutionAdapter(:217)에 capture를 더한다.
"""
from __future__ import annotations

from typing import Literal, Protocol

from cheongeum.core.jsutil import AbortSignal
from cheongeum.core.picture import MaskPlan, Shot

ACTION_TYPES = ("navigate", "back", "click", "fill", "press", "select", "check", "scroll", "read", "focus", "capture")
ActionType = Literal["navigate", "back", "click", "fill", "press", "select", "check", "scroll", "read", "focus", "capture"]


class ExecutionAdapter(Protocol):
    # ... start, execute, observe, close, bring_to_front 는 그대로 ...

    async def capture(self, plan: MaskPlan, signal: AbortSignal | None = None) -> Shot:
        """
        지금 탭의 보이는 부분만 찍는다(전체 페이지·다른 탭·브라우저 틀은 찍지 않는다).
        plan대로 가린 뒤 Picture.masked로 봉한다. 가릴 글을 화면에서 못 찾았거나 보안문자 단서가 있으면 Refused.
        PolicyGuard를 통과한 capture 액션 안에서만 부른다(호출자는 WebExecutionAgent.capture).
        """
        ...
