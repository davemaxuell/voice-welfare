"""
GuardedExecutor: 동작 하나가 가드를 지나 효과가 나기까지의 단 하나의 길.

WebExecutionAgent._run(agent.py:499-559)을 그대로 빼낸 것이다. 앱 에이전트가 같은 길을 쓰도록 하나로 둔다
(복사하면 LOG_FAILED·TIMEOUT 재시도 규칙이 두 곳에서 따로 자란다).
순서는 바뀌지 않는다: 가드 검사 → 기록에 '전' 줄(승인 필요 동작은 실패하면 실행하지 않음, LOG_FAILED) → 횟수 올림 → 효과 → 저위험·미승인 TIMEOUT만 한 번 다시 →
기록에 '후' 줄. 중요한 동작(승인받은 것)은 이미 됐을 수 있어 다시 하지 않는다(agent.py:538 주석 그대로).

이 객체가 아는 것은 '어떤 동작인가(dict)'와 '지금 무엇을 보고 있는가(Subject)'뿐이다. 웹인지 앱인지는 Subject가 말한다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from cheongeum.core.execctx import ExecContext


@dataclass(frozen=True)
class Subject:
    """한 동작이 겨누는 곳을 가드와 기록에 알리는 최소한."""

    current_url: str | None  # 웹이면 지금 주소(가드의 등급 근거). 앱이면 None
    host: str  # 기록의 host 칸: 웹은 호스트 이름, 앱은 "app:explorer"
    page_kind: str  # 기록의 pageKind 칸: 웹은 pageId, 앱은 알려진 폴더 id 등


class GuardedExecutor:
    def __init__(
        self,
        *,
        agent_id: str,
        guard: Any,  # PolicyGuard
        adapter: Any,  # execute(action, signal) -> ActionResult 모양 dict
        action_log: Any,  # personal.action_log.ActionLog | None
        subject: Callable[[], Subject],
        before_effect: Callable[[], None] | None = None,
    ) -> None:
        """before_effect: 웹 에이전트의 _acted_since_observe = True 같은, 효과 직전에 부르는 쪽이 하고 싶은 한 줄."""
        raise NotImplementedError

    async def run(
        self,
        action: dict,
        ctx: ExecContext,
        log: list[dict],
        effect: Callable[[], Awaitable[dict]] | None = None,
    ) -> dict | None:
        """
        가드에는 PolicyContext(currentUrl=subject.current_url, stopped=ctx.is_stopped() or ctx.signal.aborted, approvals=ctx.approvals,
        actionsThisTurn=ctx.counter["actions"], grants=ctx.grants)를 싣는다(agent.py:505-513에 grants 한 칸이 더해진 것).
        허락되지 않으면 None(log에 정책 결정이 남는다. agent._failed가 그것을 보고 승인 요청·거절로 가른다).
        허락되면 효과를 하고 ActionResult 모양의 dict를 돌려준다.
        effect: 어댑터의 execute 말고 다른 효과(사진 찍기)를 낼 때. 사진 바이트는 부르는 쪽 클로저가 들고 있고 여기를 지나지 않는다.
        """
        raise NotImplementedError
