"""
조작 직전·직후 행동 기록(암호화, 해시 체인, 30일).
승인 필요 조작은 기록 쓰기가 실패하면 실행하지 않는다.
"""
from __future__ import annotations

import hashlib
import json
from threading import RLock
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from cheongeum.core.jsutil import jdumps
from cheongeum.personal.seal import Seal
from cheongeum.personal.atomic import write_private

KEEP_DAYS = 30
GENESIS = "0" * 64


class ActionLog:
    """경로가 없으면 메모리만. Seal이 있으면 파일은 봉인된 JSON 배열."""

    def __init__(self, path: str | None = None, seal: Seal | None = None) -> None:
        self.path = path
        self._seal = seal
        self._rows: list[dict] = []
        self._prev = GENESIS
        self._lock = RLock()
        if path and Path(path).exists():
            self._load()

    def _load(self) -> None:
        assert self.path
        raw = Path(self.path).read_bytes()
        try:
            if self._seal and self._seal.is_sealed(raw):
                text = self._seal.open(raw).decode("utf-8")
            else:
                text = raw.decode("utf-8")
            data = json.loads(text)
            self._rows = list(data.get("rows") or [])
            self._prev = data.get("prev") or (self._rows[-1]["hash"] if self._rows else GENESIS)
            self._prune_locked()
        except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
            self._rows = []
            self._prev = GENESIS

    def _prune_locked(self) -> None:
        cutoff = (date.today() - timedelta(days=KEEP_DAYS)).isoformat()
        self._rows = [r for r in self._rows if (r.get("day") or "") >= cutoff]
        self._prev = self._rows[-1]["hash"] if self._rows else GENESIS

    def _flush(self) -> None:
        if not self.path:
            return
        payload = jdumps({"prev": self._prev, "rows": self._rows}, indent=2).encode("utf-8")
        blob = self._seal.seal(payload) if self._seal else payload
        write_private(Path(self.path), blob)

    def append(self, entry: dict) -> dict:
        """한 줄 추가. entry는 코드가 만든 요약만(페이지 원문·비밀값 금지). 실패하면 예외."""
        with self._lock:
            return self._append(entry)

    def _append(self, entry: dict) -> dict:
        day = date.today().isoformat()
        at = datetime.now(timezone.utc).isoformat()
        # 라벨은 호출 쪽에서 이미 비식별화한다(personal → safety 가져오기 금지)
        label = str(entry.get("label") or "")[:120]
        row = {
            "seq": (self._rows[-1]["seq"] + 1) if self._rows else 1,
            "day": day,
            "at": at,
            "host": entry.get("host") or "",
            "pageKind": entry.get("pageKind") or "",
            "actionType": entry.get("actionType") or "",
            "label": label,
            "approvalId": entry.get("approvalId"),
            "phase": entry.get("phase") or "before",
            "ok": entry.get("ok"),
            "prev": self._prev,
        }
        if row["phase"] == "refused":
            row["reasonCode"] = entry["reasonCode"]
            row["actor"] = entry["actor"]
        body = json.dumps({k: v for k, v in row.items() if k != "prev"}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        row["hash"] = hashlib.sha256((self._prev + body).encode("utf-8")).hexdigest()
        self._rows.append(row)
        self._prev = row["hash"]
        try:
            self._flush()
        except Exception:
            self._rows.pop()
            self._prev = row["prev"]
            raise
        return row

    def recent(self, n: int = 5, day: str | None = None) -> list[dict]:
        with self._lock:
            rows = list(self._rows)
        if day:
            rows = [r for r in rows if r.get("day") == day]
        return rows[-n:]

    def speak_recent(self, n: int = 5) -> str:
        """오늘 한 일을 짧게 읽어 줄 문장."""
        today = date.today().isoformat()
        rows = [r for r in self.recent(n * 2, day=today) if r.get("phase") == "before"][-n:]
        if not rows:
            return "오늘 기록된 조작이 없어요."
        parts = []
        for i, r in enumerate(rows, 1):
            label = r.get("label") or r.get("actionType") or "조작"
            host = r.get("host") or ""
            where = f", {host}" if host else ""
            parts.append(f"{i}. {label}{where}")
        return f"오늘 한 일 {len(parts)}건이에요. " + ". ".join(parts) + "."

