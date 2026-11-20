"""승인 필요 조작은 기록 쓰기 실패 시 실행하지 않는다."""
from __future__ import annotations

import pytest

from cheongeum.agents.web.agent import ExecContext, WebExecutionAgent
from cheongeum.agents.web.profile import create_mock_welfare_profile
from cheongeum.core.jsutil import AbortController
from cheongeum.safety import PolicyConfig, PolicyGuard


class _BoomLog:
    def append(self, entry):
        raise OSError("disk full")


class _FakeAdapter:
    def __init__(self):
        self.ran = 0

    async def execute(self, action, signal):
        self.ran += 1
        return {"ok": True, "latencyMs": 1}


@pytest.mark.asyncio
async def test_approval_action_blocked_when_log_fails():
    profile = create_mock_welfare_profile("http://localhost:5174")
    adapter = _FakeAdapter()
    guard = PolicyGuard(
        PolicyConfig(
            allowedOrigins=[profile.origin],
            allowedActionTypes=["click", "navigate", "fill", "press", "select", "check", "read", "focus", "scroll", "back"],
            allowedFieldIds=[],
            secretFieldIds=[],
            maxActionsPerTurn=12,
            safeButtons=[],
        )
    )
    agent = WebExecutionAgent(adapter, guard, profile, action_log=_BoomLog())
    agent._last_view = {"url": f"{profile.origin}/apply.html", "pageId": "mock-welfare"}
    ctl = AbortController()
    ctx = ExecContext(signal=ctl.signal, approvals={"a1"}, is_stopped=lambda: False, trace=lambda *a, **k: None)
    action = {
        "id": "a1",
        "type": "click",
        "risk": "consequential",
        "requiresConfirmation": True,
        "reason": "모의접수",
        "target": {"role": "button", "name": "모의접수"},
    }
    log: list = []
    r = await agent._run(action, ctx, log)
    assert r is not None
    assert r.get("errorCode") == "LOG_FAILED"
    assert adapter.ran == 0
