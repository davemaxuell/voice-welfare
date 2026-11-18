"""비식별 이벤트 로그(PRD §11-6): 텍스트·값을 담지 않는다."""
from __future__ import annotations

from collections import deque
from typing import Protocol


class EventSink(Protocol):
    def record(self, event: dict) -> None: ...


class InMemoryEventLog:
    """비식별 이벤트만 받는다(발화·입력값 없음)."""

    def __init__(self, limit: int = 5000) -> None:
        self._events: deque[dict] = deque(maxlen=limit)

    def record(self, event: dict) -> None:
        self._events.append(event)

    def all(self) -> list[dict]:
        return list(self._events)
