"""
agents/web/agent.py: 바뀌는 곳만. WebExecutionAgent(agent.py:140)에 둘.

  1) _run(agent.py:499-559)의 몸은 safety/executor.GuardedExecutor.run으로 옮기고, _run은 한 줄 위임이 된다(앱 에이전트와 같은 길을 쓰려고).
     ExecContext·OutcomeStatus는 core/execctx.py로 옮겨 가 있다(agent.py:38, :63).
  2) capture: 화면 사진 찍기. ShotSource(core/vision.py)를 만족한다.
"""
from __future__ import annotations

from typing import Any

from cheongeum.agents.web.shot import plan_shot
from cheongeum.core.execctx import ExecContext
from cheongeum.core.vision import MaskedShot, ShotRefusal
from cheongeum.safety.executor import GuardedExecutor, Subject


class _WebExecutionAgentChanges:
    adapter: Any
    _last_view: dict | None
    _exec: GuardedExecutor

    def _init_executor(self) -> None:
        """__init__ 끝에서 한 번. subject()는 지금 보는 화면에서 만든다(웹 호스트·pageId), before_effect는 _acted_since_observe = True."""
        raise NotImplementedError

    async def _run(self, action: dict, ctx: ExecContext, log: list[dict]) -> dict | None:
        return await self._exec.run(action, ctx, log)  # 이전 본문은 GuardedExecutor.run으로. 동작은 그대로.

    async def capture(self, ctx: ExecContext) -> MaskedShot | ShotRefusal:
        """
        가린 화면 사진 한 장. 가드·기록·횟수 제한을 모두 지난다.
          view = self._last_view (없으면 observe) → plan = plan_shot(view)   (ShotRefusal이면 그대로 돌려줌: 찍지 않았으니 가드도 부르지 않는다)
          action = self._action(type="capture", reason="가린 화면 사진 찍기", risk="sensitive")
          shots: list = []
          async def take() -> dict:          # 효과: 어댑터가 사진을 찍어 클로저에 담고, ActionResult 모양만 돌려준다
              shot = await self.adapter.capture(plan); shots.append(shot)
              return {"actionId": action["id"], "ok": isinstance(shot, MaskedShot), "verified": True, "latencyMs": ...}
          r = await self._exec.run(action, ctx, log, effect=take)
          r is None → log[-1]["policy"]["code"]로 가른다:
              NEEDS_CONFIRMATION: 허락 없이 불렀다는 뜻이라 부르는 쪽 실수다(advise가 "ask"를 냈어야 한다) → ValueError. 새는 길이 아니라 시끄러운 실패다.
              그 밖(DENIED_ORIGIN 등 등급 none, DENIED_STOPPED): ShotRefusal("no-tier" | "stopped")
          return shots[0]
        사진은 어느 로그·결과·TurnResult에도 실리지 않는다. ActionLog에는 '화면 사진 찍기' 전·후 줄만 남는다(label은 코드가 만든 reason).
        """
        raise NotImplementedError
