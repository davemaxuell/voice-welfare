"""
한 턴 동안 모든 실행 에이전트(웹·앱)가 같이 쓰는 실행 문맥과 결과 상태.

agents/web/agent.py에서 옮겨 온 것이다(근거: agent.py:38 ExecContext, agent.py:63 OutcomeStatus).
웹 에이전트와 앱 에이전트가 서로를 가져오지 않도록 두 에이전트의 아래 단계(core)에 둔다.
옮기는 일은 동작을 바꾸지 않는 기계적 치환(U0)이고, agents/web/__init__.py의 다시 내보내기는 같은 변경에서 지운다.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Callable, Iterator, Literal

from cheongeum.core.jsutil import AbortSignal

# unconfirmed: 승인받은 조작이 시간 안에 답하지 않았고 다시 봐도 됐는지 모른다(저절로 다시 하지 않는다)
OutcomeStatus = Literal[
    "ok",
    "needs-clarification",
    "needs-approval",
    "validation-error",
    "policy-denied",
    "failed",
    "aborted",
    "unconfirmed",
]


@dataclass
class ExecContext:
    signal: AbortSignal
    approvals: set[str]
    is_stopped: Callable[[], bool]
    trace: Callable[..., None]  # trace(phase, agent, note=None)
    counter: dict = field(default_factory=lambda: {"actions": 0})
    # 이번 대화 동안 사용자가 허락해 둔 것. 지금은 "shot"(가린 화면 사진을 OpenAI로 보내도 됨) 하나.
    # 주인은 오케스트레이터의 _grants 하나이고, 여기서는 같은 set을 참조만 한다(approvals와 같은 방식).
    # 멈춤(_stop)이 비운다: 멈춘 뒤 첫 사진은 다시 묻는다.
    grants: set[str] = field(default_factory=set)

    @contextmanager
    def granted(self, ids: list[str]) -> Iterator[None]:
        """이 액션들을 블록 안에서만 승인된 것으로 둔다(PolicyGuard가 approvals를 본다)."""
        self.approvals.update(ids)
        try:
            yield
        finally:
            self.approvals.difference_update(ids)
