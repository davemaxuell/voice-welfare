"""
Agent A의 짝(앱 쪽): 이름 붙은 동작으로 앱을 열고 조작한다. 웹의 WebExecutionAgent(agent.py:140)와 같은 틀이다.

모든 조작은 GuardedExecutor(safety/executor.py)를 지난다: PolicyGuard.check → 기록 전 → 효과(AppAdapter.execute) → 기록 후 → 재관찰.
이 에이전트가 하는 일: 사용자 말(이름)을 표와 파일 시스템에서 다시 찾아 AppAction을 만들고, 결과를 AppOutcome으로 정리한다.
하지 않는 일: 말을 해석하지 않는다(understanding의 일), 사용자에게 묻지 않는다(AppSkill의 일).
화면(폴더 이름·항목 이름)은 비신뢰 데이터다: 어느 LLM에도 보내지 않는다(이 클래스는 LLM을 받지 않는다).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from cheongeum.agents.desktop.adapter import AppAdapter
from cheongeum.core.execctx import ExecContext, OutcomeStatus
from cheongeum.core.vision import MaskedShot, ShotRefusal
from cheongeum.safety.executor import GuardedExecutor


@dataclass
class AppOutcome:
    """WebOutcome(agent.py:67)의 짝. 앱에 없는 칸(effect, revealed, focused)은 두지 않는다."""

    status: OutcomeStatus
    actions: list[dict]
    view: dict | None = None  # WindowView 모양
    message: str | None = None
    # 이름이 여럿 맞았을 때 후보(읽어 주고 되묻는다)
    candidates: list[str] | None = None
    # needs-approval: 사용자에게 묻고 승인받으면 그대로 실행할 AppAction
    pending: dict | None = None
    # 창을 따라가게 했는가(최선): 말하지는 않고 시험·기록이 본다
    window_followed: bool = False


class DesktopAgent:
    id = "desktop-navigation-and-execution"  # AGENT_IDS.desktop

    def __init__(self, adapter: AppAdapter, guard: Any, action_log: Any = None) -> None:
        """guard는 웹과 같은 PolicyGuard 하나(문이 둘이 아니다). action_log는 웹과 같은 ActionLog 하나(봉인된 한 줄 목록)."""
        self.adapter = adapter
        self._exec: GuardedExecutor  # subject()는 Subject(None, "app:explorer", 알려진 폴더 id)
        self._last_view: dict | None = None

    @property
    def current_view(self) -> dict | None:
        return self._last_view

    async def observe(self, ctx: ExecContext | None = None) -> dict:
        """지금 모습. 웹의 observe(agent.py:443)와 같이 마지막 모습을 기억한다."""
        raise NotImplementedError

    async def launch(self, app_id: str, ctx: ExecContext) -> AppOutcome:
        """앱 열기. 이미 떠 있으면 앞으로(두 번 말해도 창이 둘이 되지 않는다). tier none인 앱은 가드 앞에서 정직하게 '아직 못 해요'(AppSkill이 말함)."""
        raise NotImplementedError

    async def open_item(self, spoken: str, ctx: ExecContext) -> AppOutcome:
        """
        말한 이름을 (1) 알려진 폴더 이름이면 place로, (2) 아니면 지금 폴더 안 항목으로 locate해 'open' 동작을 만든다.
        여럿이면 candidates로 되묻고 실행하지 않는다. 없으면 needs-clarification. 파일이면 risk=sensitive라 가드가 NEEDS_CONFIRMATION → needs-approval(2차).
        folder는 이 에이전트가 지금 보는 폴더에서 채운다(말에서 오지 않는다).
        """
        raise NotImplementedError

    async def up(self, ctx: ExecContext) -> AppOutcome: ...

    async def back(self, ctx: ExecContext) -> AppOutcome: ...

    async def list_view(self, ctx: ExecContext) -> AppOutcome:
        """다시 읽기. 'list' 동작을 지나 기록에 남는다."""
        raise NotImplementedError

    async def capture(self, ctx: ExecContext) -> MaskedShot | ShotRefusal:
        """[3차] ShotSource. 이 창 하나만(PrintWindow), UIA 편집 상자를 가린 뒤. 앱 표의 picture_ok가 True인 앱만. 지금은 ShotRefusal("no-tier")."""
        raise NotImplementedError
