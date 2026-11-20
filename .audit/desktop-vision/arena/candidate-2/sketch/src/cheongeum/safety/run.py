"""
[새 파일] 지킨 실행 한 번: 판정 → 조작 기록(직전) → 실행 → 조작 기록(직후).

WebExecutionAgent._run(agents/web/agent.py:499-559)의 몸통을 그대로 옮긴 것이다. 웹과 데스크톱이 이 함수 하나를 쓴다.
따로 베껴 두면 "승인된 조작은 기록을 못 남기면 실행하지 않는다", "중요한 조작은 TIMEOUT이어도 다시 하지 않는다" 같은
규칙이 한쪽에서만 고쳐진다.

옮긴 뒤 WebExecutionAgent._run은 이 함수를 부르는 몇 줄이 된다(동작 변화 없음: tests/unit/test_action_log_guard.py가 그대로 통과해야 한다).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from cheongeum.core.exec import ExecContext

MAX_TIMEOUT_RETRIES = 1


@dataclass(frozen=True)
class Where:
    """조작 기록에 적을 자리. 웹: host=호스트 이름, kind=pageId. 데스크톱: host="app:explorer", kind=장소 id("downloads") 또는 ""."""

    host: str
    kind: str


async def guarded_run(
    action: dict,
    ctx: ExecContext,
    log: list[dict],
    *,
    agent: str,
    decide: Callable[[dict], dict],
    perform: Callable[[], Awaitable[dict]],
    where: Where,
    label: str,
    action_log: Any = None,
) -> dict | None:
    """
    decide(action) = PolicyGuard.check 또는 check_desk에 문맥을 묶은 것. perform() = 어댑터 호출(ActionResult dict).
    label = 조작 기록에 적을 대상 이름(부르는 쪽이 redact_text를 거쳐 준다).

    약속(지금의 _run과 같다)
      - log에 {"agent", "action", "policy"}를 붙이고, 허용되지 않으면 perform을 부르지 않고 None.
      - 직전 기록 쓰기가 실패했고 승인이 필요했던 조작이면 실행하지 않고 {"ok": False, "errorCode": "LOG_FAILED"}.
      - ctx.counter["actions"]를 하나 올린다.
      - TIMEOUT은 action["risk"] == "low"이고 판정이 APPROVED가 아닐 때만 한 번 다시 한다.
      - 직후 기록 쓰기 실패는 삼킨다(이미 실행됨).
    """
    raise NotImplementedError
