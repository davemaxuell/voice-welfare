"""
[새 파일] 실행 에이전트(웹·데스크톱)가 함께 쓰는 턴 문맥과 결과 낱말.

ExecContext와 OutcomeStatus를 agents/web/agent.py(:38, :63)에서 그대로 옮긴다(내용 변화 없음).
agents.desktop이 agents.web을 가져오지 않게 하려는 이동이다. 가져오는 곳은 같은 커밋에서 모두 core.exec로 바꾼다.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Callable, Iterator, Literal

from cheongeum.core.jsutil import AbortSignal

# unconfirmed: 승인받은 조작이 됐는지 다시 봐도 모른다(저절로 다시 하지 않는다)
OutcomeStatus = Literal["ok", "needs-clarification", "needs-approval", "validation-error", "policy-denied", "failed", "aborted", "unconfirmed"]


@dataclass
class ExecContext:
    signal: AbortSignal
    approvals: set[str]
    is_stopped: Callable[[], bool]
    trace: Callable[..., None]  # trace(phase, agent, note=None)
    # 웹·데스크톱 조작을 한 턴에서 함께 센다(턴마다 12번)
    counter: dict = field(default_factory=lambda: {"actions": 0})

    @contextmanager
    def granted(self, ids: list[str]) -> Iterator[None]:
        """이 액션들을 블록 안에서만 승인된 것으로 둔다(PolicyGuard가 approvals를 본다)."""
        raise NotImplementedError
