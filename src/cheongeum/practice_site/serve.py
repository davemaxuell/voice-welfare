"""
접근성 있는 모의 복지 신청 사이트(모의 신청·실제 제출 아님)와 테스트용 합성 외부 포털을 띄운다.
같은 서버를 127.0.0.1로 열면 출처가 달라 "외부(read-only) 사이트"로 취급된다 — 읽기 전용 동작은 이것으로 테스트한다.
그래서 IPv4(127.0.0.1)와 IPv6(::1, 가능할 때) 양쪽에서 듣는다.
"""
from __future__ import annotations

import argparse
import errno
import hashlib
import os
import socket
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from typing import Literal

import httpx

SITE_DIR = Path(str(resources.files(__package__).joinpath("site")))
CHECKOUT_HEADER = "X-Ieum-Checkout"
CHECKOUT_ID = hashlib.sha1(str(SITE_DIR.resolve()).encode()).hexdigest()[:12]
PortState = Literal["free", "ours", "other"]
# 다른 체크아웃의 서버가 포트를 놓을 때까지 기다리는 시간(초). MOCK_SITE_WAIT_S로 바꾼다.
DEFAULT_WAIT_S = 120
_IN_USE = {errno.EADDRINUSE, errno.EACCES, 10048, 10013}  # 10048·10013: 윈도 WSAEADDRINUSE·WSAEACCES


class _Handler(SimpleHTTPRequestHandler):
    # 윈도 레지스트리가 .js를 text/plain으로 알려 주는 경우가 있어 모듈 스크립트가 막히지 않게 직접 정한다.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".json": "application/json",
        ".svg": "image/svg+xml",
    }

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header(CHECKOUT_HEADER, CHECKOUT_ID)
        super().end_headers()

    def log_message(self, format: str, *args) -> None:  # noqa: A002 — 요청 로그는 남기지 않는다(검색어 등 포함 가능)
        return


class _Server(ThreadingHTTPServer):
    # 윈도의 SO_REUSEADDR는 다른 프로세스가 듣고 있는 포트에도 붙어 버린다(두 서버가 5174를 나눠 가짐). 윈도에서는 독점으로 묶는다.
    allow_reuse_address = not hasattr(socket, "SO_EXCLUSIVEADDRUSE")

    def server_bind(self) -> None:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class _V6Server(_Server):
    address_family = socket.AF_INET6


class MockSite:
    def __init__(self, port: int = 5174) -> None:
        self.port = port
        self._servers: list[ThreadingHTTPServer] = []
        self._threads: list[threading.Thread] = []

    def start(self) -> "MockSite":
        handler = partial(_Handler, directory=str(SITE_DIR))
        self._servers.append(_Server(("127.0.0.1", self.port), handler))
        self.port = self._servers[0].server_port  # port 0 selects a free port on this computer
        try:
            self._servers.append(_V6Server(("::1", self.port), handler))
        except OSError as e:
            if e.errno in _IN_USE:  # ::1은 다른 서버 차지 → localhost가 그쪽으로 갈 수 있다
                self._servers.pop().server_close()
                raise
            # IPv6 없음
        for srv in self._servers:
            srv.daemon_threads = True
            t = threading.Thread(target=srv.serve_forever, name=f"mock-site-{srv.server_address[0]}", daemon=True)
            t.start()
            self._threads.append(t)
        return self

    def close(self) -> None:
        for srv in self._servers:
            srv.shutdown()
            srv.server_close()
        self._servers.clear()


def start_mock_site(port: int = 5174) -> MockSite:
    """테스트/평가 스크립트에서 모의 사이트를 띄운다."""
    return MockSite(port).start()


def is_reachable(url: str, timeout: float = 1.5) -> bool:
    try:
        return httpx.get(url, timeout=timeout).is_success
    except httpx.HTTPError:
        return False


def port_state(port: int) -> PortState:
    try:
        # trust_env=False: 시스템 프록시가 127.0.0.1 요청을 대신 받으면 남의 서버로 보인다
        r = httpx.get(f"http://127.0.0.1:{port}/", timeout=1.5, trust_env=False)
    except httpx.HTTPError:
        return "free"
    return "ours" if r.headers.get(CHECKOUT_HEADER) == CHECKOUT_ID else "other"


def ensure_mock_site(port: int = 5174, wait_s: float | None = None) -> MockSite | None:
    """
    테스트·평가 스크립트용: 이 체크아웃의 모의 사이트가 이미 떠 있으면 그대로 쓰고(None), 포트가 비어 있으면 띄운다.
    다른 체크아웃의 서버가 포트를 쓰고 있으면 끝날 때까지 기다린다.
    """
    wait_s = float(os.environ.get("MOCK_SITE_WAIT_S") or DEFAULT_WAIT_S) if wait_s is None else wait_s
    deadline = time.monotonic() + wait_s
    told = False
    while True:
        state = port_state(port)
        if state == "ours":
            return None
        if state == "free":
            try:
                return start_mock_site(port)
            except OSError as e:
                if e.errno not in _IN_USE:
                    raise
        elif not told:
            print(f"[mock] 포트 {port}를 다른 작업 트리의 모의 사이트가 쓰고 있어 끝날 때까지 기다립니다(최대 {int(wait_s)}초).", file=sys.stderr, flush=True)
            told = True
        if time.monotonic() > deadline:
            raise RuntimeError(
                f"포트 {port}를 다른 작업 트리의 모의 사이트가 쓰고 있습니다. 그쪽 테스트·cheongeum-server·데스크톱 앱을 끝내거나, "
                "MOCK_SITE_WAIT_S(초)로 더 기다리게 하세요."
            )
        time.sleep(2)


def main() -> None:
    parser = argparse.ArgumentParser(description="청음 모의 복지 신청 사이트")
    parser.add_argument("--port", type=int, default=5174)
    args = parser.parse_args()
    site = start_mock_site(args.port)
    print(f"[mock] http://localhost:{args.port}  (외부 포털 테스트: http://127.0.0.1:{args.port}/external.html)")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        site.close()


if __name__ == "__main__":
    main()
