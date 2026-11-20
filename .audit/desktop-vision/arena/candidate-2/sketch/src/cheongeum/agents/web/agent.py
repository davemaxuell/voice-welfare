"""
[바뀌는 것만] agents/web/agent.py
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Sequence

from cheongeum.core.exec import ExecContext, OutcomeStatus  # 옮겨 감(이 파일의 :38, :63에서)
from cheongeum.core.picture import Shot


@dataclass
class WebOutcome:
    status: OutcomeStatus
    actions: list[dict]
    # ... 기존 칸(agent.py:70-87)은 그대로 ...
    # capture: 가린 사진, 또는 찍지 않은 까닭. status는 Picture면 "ok", Refused("policy")면 "policy-denied", 그 밖의 Refused는 "ok".
    shot: Shot | None = None


class WebExecutionAgent:
    def __init__(
        self,
        adapter: Any,
        guard: Any,
        profile: Any,
        action_log: Any = None,
        # 사진에서 가릴 금고 값. 런타임이 꽂는다(personal을 가져오지 않는다).
        # 여기에 이 에이전트가 이번 세션에서 칸에 넣은 값(fill이 성공할 때 self._typed에 모은다)을 합쳐 mask_plan에 준다.
        known_private: Callable[[], Sequence[str]] = lambda: (),
    ) -> None:
        raise NotImplementedError

    async def capture(self, ctx: ExecContext) -> WebOutcome:
        """
        지금 화면을 가리고 찍는다. 이 메서드가 웹 사진의 유일한 길이다.

          view = await self.observe(ctx)                       # 가림은 방금 본 화면에서 나온다
          if (no := picture_refusal(view)): return WebOutcome("ok", [], view=view, shot=no)      # 브라우저를 건드리지 않음
          plan = mask_plan(view, self._known_private())
          action = self._action(type="capture", reason="화면을 사진으로 설명")
          r = await self._run(action, ctx, log, perform=lambda: self._take(plan, ctx, box))     # PolicyGuard → 조작 기록 → 촬영
          → 허용 안 됨: WebOutcome("policy-denied", log, view=view, shot=Refused("policy", ...))
          → box의 Shot을 담아 WebOutcome("ok", log, view=view, shot=...)

        다시 하지 않는다: 촬영 TIMEOUT은 Refused("failed")로 돌려준다(화면이 바뀐 뒤의 사진은 가림이 맞지 않는다).
        """
        raise NotImplementedError

    async def _run(
        self, action: dict, ctx: ExecContext, log: list[dict], perform: Callable[[], Awaitable[dict]] | None = None
    ) -> dict | None:
        """
        몸통은 safety.run.guarded_run으로 옮긴다. 여기 남는 것은 웹에만 있는 것:
          decide  = lambda a: self.guard.check(a, PolicyContext(currentUrl=..., stopped=..., approvals=..., actionsThisTurn=...))
          perform = perform or (lambda: self.adapter.execute(action, ctx.signal))
          where   = Where(host=_host_of(url), kind=pageId)
          self._acted_since_observe = True (허용됐을 때)
        """
        raise NotImplementedError
