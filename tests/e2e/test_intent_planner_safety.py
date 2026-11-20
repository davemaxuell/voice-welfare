import asyncio
from unittest.mock import AsyncMock

from conftest import FakeLlm, with_llm


async def test_spoken_secret_never_reaches_planner(new_session):
    s = await new_session()
    await s.handle_turn("로그인하고 싶어")
    fake = FakeLlm()
    with_llm(s, fake)
    response = await s.handle_turn("사과나무")
    assert response["intentType"] == "SECRET_DISCLOSURE"
    assert fake.calls == []


async def test_stop_interrupts_intent_plan_before_routing(new_session, monkeypatch):
    reached = asyncio.Event()
    cancelled = asyncio.Event()

    class WaitingPlanner:
        name = "waiting"

        async def generate(self, *, schemaName, **_):
            if schemaName == "intent_plan":
                reached.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()

    s = await new_session()
    with_llm(s, WaitingPlanner())
    route = AsyncMock(wraps=s._route)
    monkeypatch.setattr(s, "_route", route)
    pending = asyncio.create_task(s.handle_turn("문의사항 눌러줘"))
    try:
        await asyncio.wait_for(reached.wait(), 2)
        assert (await s.handle_turn("멈춰"))["state"] == "STOPPED"
        assert (await asyncio.wait_for(pending, 2))["state"] == "STOPPED"
        await asyncio.wait_for(cancelled.wait(), 2)
        route.assert_not_awaited()
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
