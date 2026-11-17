"""
접근성 있는 모의 복지 신청 사이트(모의 신청·실제 제출 아님)와 테스트용 합성 외부 포털을 띄운다.
같은 서버를 127.0.0.1로 열면 출처가 달라 "외부(read-only) 사이트"로 취급된다 — 읽기 전용 동작은 이것으로 테스트한다.
그래서 IPv4(127.0.0.1)와 IPv6(::1, 가능할 때) 양쪽에서 듣는다.
"""
from __future__ import annotations

import argparse
import socket
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path

import httpx

SITE_DIR = Path(str(resources.files(__package__).joinpath("site")))


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
        super().end_headers()

    def log_message(self, format: str, *args) -> None:  # noqa: A002 — 요청 로그는 남기지 않는다(검색어 등 포함 가능)
        return


class _V6Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6


class MockSite:
    def __init__(self, port: int = 5174) -> None:
        self.port = port
        self._servers: list[ThreadingHTTPServer] = []
        self._threads: list[threading.Thread] = []

    def start(self) -> "MockSite":
        handler = partial(_Handler, directory=str(SITE_DIR))
        self._servers.append(ThreadingHTTPServer(("127.0.0.1", self.port), handler))
        try:
            self._servers.append(_V6Server(("::1", self.port), handler))
        except OSError:
            pass  # IPv6 없음
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


def main() -> None:
    parser = argparse.ArgumentParser(description="이음 모의 복지 신청 사이트")
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
