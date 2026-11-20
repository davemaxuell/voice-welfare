"""세션 수명, 같은 탭의 쓰기 권한과 재시도."""

from __future__ import annotations

import asyncio
import hashlib
import secrets
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Awaitable, Callable

if TYPE_CHECKING:
    from cheongeum.orchestrator import SessionOrchestrator

RECOVERY_GRACE_S = 300
WRITER_LEASE_S = 60
EPHEMERAL_LEASE_S = 120
REPLAY_LIMIT = 32


class RequestConflict(Exception):
    pass


@dataclass
class RequestLedger:
    latest: int = 0
    requests: dict[int, tuple[bytes, asyncio.Task]] = field(default_factory=dict)

    async def once(self, key: str | None, payload: bytes, run: Callable[[], Awaitable]):
        if key is None:
            return await run()
        if not key.isascii() or not key.isdecimal() or len(key) > 12 or int(key) < 1:
            raise RequestConflict
        seq = int(key)
        digest = hashlib.sha256(payload).digest()
        record = self.requests.get(seq)
        if record:
            if record[0] != digest:
                raise RequestConflict
            return await asyncio.shield(record[1])
        if seq <= self.latest:
            raise RequestConflict
        while len(self.requests) >= REPLAY_LIMIT:
            completed = next((seq for seq, (_, task) in self.requests.items() if task.done()), None)
            if completed is None:
                raise RequestConflict
            del self.requests[completed]
        self.latest = seq
        task = asyncio.create_task(run())
        self.requests[seq] = (digest, task)
        return await asyncio.shield(task)


@dataclass
class Lease:
    token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    writer: str | None = field(default_factory=lambda: secrets.token_urlsafe(32))
    waiting: bool = False
    previous: tuple[str, str] | None = None
    checkpoint: dict | None = None
    timer: asyncio.TimerHandle | None = None

    def credentials(self) -> dict:
        return {"token": self.token, "writer": self.writer}

    def cancel_timer(self) -> None:
        if self.timer:
            self.timer.cancel()
            self.timer = None


class Sessions:
    """활성 세션을 유지하며, 분리된 세션은 유예 기간 뒤 닫는다."""

    def __init__(self) -> None:
        self._items: dict[str, SessionOrchestrator] = {}
        self.leases: dict[str, Lease] = {}
        self.ephemeral: dict[str, asyncio.TimerHandle] = {}
        self.ledgers: dict[str, RequestLedger] = {}
        self.creating = asyncio.Lock()

    def __len__(self) -> int:
        return len(self._items)

    def get(self, sid: str) -> SessionOrchestrator | None:
        return self._items.get(sid)

    def add(self, session: SessionOrchestrator) -> None:
        self._items[session.id] = session
        self.ledgers[session.id] = RequestLedger()

    def remove(self, sid: str) -> SessionOrchestrator | None:
        lease = self.leases.pop(sid, None)
        if lease:
            lease.cancel_timer()
        timer = self.ephemeral.pop(sid, None)
        if timer:
            timer.cancel()
        self.ledgers.pop(sid, None)
        return self._items.pop(sid, None)

    def values(self) -> list[SessionOrchestrator]:
        return list(self._items.values())

    def clear(self) -> None:
        for sid in list(self._items):
            self.remove(sid)

    def keep_ephemeral(self, sid: str) -> None:
        timer = self.ephemeral.get(sid)
        if timer:
            timer.cancel()
        self.ephemeral[sid] = asyncio.get_running_loop().call_later(EPHEMERAL_LEASE_S, self._expire, sid)

    def enable(self, sid: str) -> Lease:
        lease = self.leases[sid] = Lease()
        self.keep_alive(sid, lease)
        return lease

    def keep_alive(self, sid: str, lease: Lease) -> None:
        lease.cancel_timer()
        lease.timer = asyncio.get_running_loop().call_later(WRITER_LEASE_S, self.detach, sid)

    def detach(self, sid: str) -> None:
        lease = self.leases.get(sid)
        if lease is None or lease.writer is None:
            return
        lease.writer = None
        lease.waiting = False
        lease.previous = None
        lease.checkpoint = self._items[sid].detach_for_recovery()
        self.ledgers[sid] = RequestLedger()
        lease.cancel_timer()
        lease.timer = asyncio.get_running_loop().call_later(RECOVERY_GRACE_S, self._expire, sid)

    def _expire(self, sid: str) -> None:
        session = self.remove(sid)
        if session:
            asyncio.create_task(session.close())

    def recover(self, token: str, attempt: str) -> tuple[str, Lease] | None:
        for sid, lease in self.leases.items():
            if lease.waiting and lease.previous == (token, attempt):
                return sid, lease
            if not secrets.compare_digest(lease.token, token):
                continue
            if lease.writer is not None:
                raise RequestConflict
            lease.previous = (token, attempt)
            lease.token = secrets.token_urlsafe(32)
            lease.writer = secrets.token_urlsafe(32)
            lease.waiting = True
            self.keep_alive(sid, lease)
            return sid, lease
        return None
