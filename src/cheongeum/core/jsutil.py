"""
TypeScript 원본과 같은 동작을 내기 위한 작은 도우미 모음.

- 정규식: JS의 \\b·\\w는 ASCII 기준이지만 Python(regex 모듈)은 유니코드 기준이라 한글 옆에서 경계가 달라진다.
  원본의 \\b 자리에는 B(ASCII 경계)를 쓴다. 가변 길이 lookbehind 등 JS 문법을 그대로 쓰려고 `regex` 모듈을 쓴다.
- JSON: JSON.stringify와 같은 간결한 출력(한글 그대로).
- URL: new URL(...)처럼 잘못된 주소면 예외, origin/host/pathname/searchParams 제공.
- AbortController: 멈춤 요청을 진행 중인 작업에 알린다.
"""
from __future__ import annotations

import asyncio
import json
import math
import time
import uuid as _uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, TypeVar
from urllib.parse import parse_qs, quote, urljoin, urlsplit

import regex

T = TypeVar("T")

# JS의 ASCII 단어 경계(\b)
B = r"(?:(?<![A-Za-z0-9_])(?=[A-Za-z0-9_])|(?<=[A-Za-z0-9_])(?![A-Za-z0-9_]))"


def rx(pattern: str, flags: int = 0) -> regex.Pattern:
    """JS 정규식 원문을 그대로 컴파일(regex 모듈, VERSION0 = re 호환)."""
    return regex.compile(pattern, flags)


I = regex.IGNORECASE


def jdumps(obj: Any, indent: int | None = None) -> str:
    """JSON.stringify(obj) — 한글은 그대로, 공백 없이."""
    if indent is not None:
        return json.dumps(obj, ensure_ascii=False, indent=indent)
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def compact(d: dict) -> dict:
    """값이 None인 키를 뺀다(JS의 undefined 속성처럼)."""
    return {k: v for k, v in d.items() if v is not None}


def now_ms() -> int:
    return int(time.time() * 1000)


def now_iso() -> str:
    """new Date().toISOString()"""
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


KST = timezone(timedelta(hours=9))


def today_iso(now: datetime | None = None) -> str:
    """오늘 날짜(한국 시각). 사용자는 한국에 있으므로 UTC 날짜를 쓰면 아침 9시 전에 어제 날짜를 말한다."""
    return (now or datetime.now(timezone.utc)).astimezone(KST).date().isoformat()


def js_round(x: float) -> int:
    """Math.round (0.5는 올림)"""
    return math.floor(x + 0.5)


def uuid() -> str:
    return str(_uuid.uuid4())


def encode_uri_component(s: str) -> str:
    return quote(s, safe="-_.!~*'()")


def nz(v: Any, default: Any) -> Any:
    """JS의 ?? 연산자"""
    return default if v is None else v


def uniq(items) -> list:
    """[...new Set(items)] — 넣은 순서 유지"""
    return list(dict.fromkeys(items))


# ---------------------------------------------------------------- URL

_DEFAULT_PORTS = {"http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21}
_SPECIAL = set(_DEFAULT_PORTS) | {"file"}


@dataclass
class Url:
    href: str
    protocol: str  # 'http:'
    hostname: str
    port: str  # '' = 기본 포트
    pathname: str
    search: str
    query: dict[str, list[str]]

    @property
    def host(self) -> str:
        return f"{self.hostname}:{self.port}" if self.port else self.hostname

    @property
    def origin(self) -> str:
        scheme = self.protocol[:-1]
        if scheme not in _DEFAULT_PORTS:
            return "null"
        return f"{self.protocol}//{self.host}"

    def param(self, name: str) -> str | None:
        """searchParams.get(name)"""
        v = self.query.get(name)
        return v[0] if v else None


def parse_url(url: str, base: str | None = None) -> Url:
    """new URL(url[, base]). 형식이 잘못되면 ValueError."""
    if not isinstance(url, str):
        raise ValueError("invalid url")
    raw = url.strip()
    if base is not None:
        raw = urljoin(base, raw)
    parts = urlsplit(raw)
    scheme = parts.scheme.lower()
    if not scheme or not regex.match(r"^[a-z][a-z0-9+.-]*$", scheme):
        raise ValueError(f"invalid url: {url!r}")
    if scheme in _SPECIAL and scheme != "file" and not parts.hostname:
        raise ValueError(f"invalid url: {url!r}")
    if regex.search(r"\s", parts.netloc):
        raise ValueError(f"invalid url: {url!r}")
    hostname = (parts.hostname or "").lower()
    try:
        port_num = parts.port
    except ValueError as e:
        raise ValueError(f"invalid url: {url!r}") from e
    port = "" if port_num is None or _DEFAULT_PORTS.get(scheme) == port_num else str(port_num)
    if parts.hostname and ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"
    pathname = parts.path or ("/" if scheme in _SPECIAL else "")
    search = f"?{parts.query}" if parts.query else ""
    return Url(
        href=raw,
        protocol=f"{scheme}:",
        hostname=hostname,
        port=port,
        pathname=pathname,
        search=search,
        query=parse_qs(parts.query, keep_blank_values=True),
    )


def try_url(url: str | None) -> Url | None:
    if not url:
        return None
    try:
        return parse_url(url)
    except ValueError:
        return None


def is_valid_url(url: str) -> bool:
    return try_url(url) is not None


# ---------------------------------------------------------------- AbortController


class AbortError(Exception):
    pass


class AbortSignal:
    def __init__(self) -> None:
        self.aborted = False
        self._event: asyncio.Event | None = None
        self._listeners: list = []

    def _ev(self) -> asyncio.Event:
        if self._event is None:
            self._event = asyncio.Event()
            if self.aborted:
                self._event.set()
        return self._event

    def _abort(self) -> None:
        if self.aborted:
            return
        self.aborted = True
        if self._event is not None:
            self._event.set()
        for cb in list(self._listeners):
            try:
                cb()
            except Exception:  # noqa: BLE001
                pass

    def add_listener(self, cb) -> None:
        self._listeners.append(cb)

    async def wait(self) -> None:
        await self._ev().wait()


class AbortController:
    def __init__(self) -> None:
        self.signal = AbortSignal()

    def abort(self) -> None:
        self.signal._abort()


async def race_abort(work: Awaitable[T], signal: AbortSignal | None, error: Exception | None = None) -> T:
    """작업과 중단 신호 중 먼저 오는 것. 중단되면 error(기본 AbortError)를 던진다."""
    task = asyncio.ensure_future(work)
    if signal is None:
        return await task
    if signal.aborted:
        task.cancel()
        raise error or AbortError()
    waiter = asyncio.ensure_future(signal.wait())
    try:
        done, _ = await asyncio.wait({task, waiter}, return_when=asyncio.FIRST_COMPLETED)
    except asyncio.CancelledError:
        task.cancel()
        raise
    finally:
        waiter.cancel()
    if task in done:
        return task.result()
    task.cancel()
    raise error or AbortError()
