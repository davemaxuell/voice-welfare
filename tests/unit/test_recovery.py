import asyncio
import uuid
from types import SimpleNamespace

import pytest

from cheongeum.server import recovery


async def test_dropped_response_replays_inflight_operation_once():
    ledger = recovery.RequestLedger()
    entered = asyncio.Event()
    finish = asyncio.Event()
    effects = []

    async def work():
        entered.set()
        await finish.wait()
        effects.append("synthetic field write")
        return {"ok": True}

    dropped = asyncio.create_task(ledger.once("1", b"same operation", work))
    await entered.wait()
    dropped.cancel()
    with pytest.raises(asyncio.CancelledError):
        await dropped
    with pytest.raises(recovery.RequestConflict):
        await ledger.once("1", b"different operation", work)
    finish.set()
    assert await ledger.once("1", b"same operation", work) == {"ok": True}
    assert effects == ["synthetic field write"]


async def test_detached_grace_expires_and_restart_cannot_recover(monkeypatch):
    monkeypatch.setattr(recovery, "RECOVERY_GRACE_S", 0)
    closed = asyncio.Event()

    async def close():
        closed.set()

    sessions = recovery.Sessions()
    session = SimpleNamespace(id="synthetic", close=close, detach_for_recovery=lambda: {"state": "IDLE"})
    sessions.add(session)
    token = sessions.enable(session.id).token
    attempt = str(uuid.uuid4())
    assert recovery.Sessions().recover(token, attempt) is None
    sessions.detach(session.id)
    await asyncio.wait_for(closed.wait(), 1)
    assert sessions.recover(token, attempt) is None
