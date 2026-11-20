"""
[새 파일 · U0에서 agents/web/agent.py:37-63에서 옮김]
실행 문맥: 한 턴 동안 모든 실행 에이전트(웹·데스크톱)가 함께 쓰는 멈춤 신호·승인·기록·조작 횟수와 결과 상태.
데스크톱 에이전트가 agents.web을 가져오지 않도록 core로 옮긴다. 옮긴 뒤 부르는 곳(autopilot, skills/*, speech/screen,
orchestrator)은 모두 여기서 가져온다. agents/web/__init__.py는 지금처럼 ExecContext를 다시 내보내지 않는다(같은 단위에서 옮김).
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field as dc_field
from typing import Callable, Iterator, Literal

from cheongeum.core.jsutil import AbortSignal

# unconfirmed: 승인받은 조작이 시간 안에 답하지 않았고 다시 봐도 됐는지 모른다(저절로 다시 하지 않는다)
OutcomeStatus = Literal["ok", "needs-clarification", "needs-approval", "validation-error", "policy-denied", "failed", "aborted", "unconfirmed"]


@dataclass
class ExecContext:
    """
    한 턴의 실행 문맥. counter는 웹·데스크톱 조작을 함께 센다(턴당 한도는 표면과 상관없이 하나).
    approvals는 세션이 가진 집합을 그대로 가리킨다(granted 블록 안에서만 승인 ID가 들어 있다).
    """

    signal: AbortSignal
    approvals: set[str]
    is_stopped: Callable[[], bool]
    trace: Callable[..., None]  # trace(phase, agent, note=None)
    counter: dict = dc_field(default_factory=lambda: {"actions": 0})

    @contextmanager
    def granted(self, ids: list[str]) -> Iterator[None]:
        """이 액션들을 블록 안에서만 승인된 것으로 둔다(PolicyGuard·DesktopGuard가 approvals를 본다)."""
        raise NotImplementedError


@dataclass(frozen=True)
class Rechecked:
    """
    승인 문(SessionOrchestrator._approve)이 표면별 주인(웹·데스크톱)에게서 받는 재확인 결과.
    fingerprint = 지금 화면으로 다시 만든 지문, changed = 물을 때와 달라진 것을 말하는 문장(같으면 None),
    state = 바뀌었을 때 돌아갈 세션 상태, extra = 초안에 붙일 관찰(웹 {'view': …}, 데스크톱 {'desktop': …}).
    """

    fingerprint: dict
    changed: str | None
    state: str
    extra: dict
