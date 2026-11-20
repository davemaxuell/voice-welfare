import socket
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import pytest

from cheongeum.practice_site import ensure_mock_site, start_mock_site


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def other_checkout_server(port: int, directory) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", port), partial(SimpleHTTPRequestHandler, directory=str(directory)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_starts_its_own_site_then_reuses_it():
    port = free_port()
    site = ensure_mock_site(port, wait_s=5)
    try:
        assert site is not None
        assert ensure_mock_site(port, wait_s=5) is None
    finally:
        site.close()


def test_does_not_reuse_another_checkouts_server(tmp_path):
    port = free_port()
    other = other_checkout_server(port, tmp_path)
    try:
        with pytest.raises(RuntimeError):
            ensure_mock_site(port, wait_s=1)
    finally:
        other.shutdown()
        other.server_close()


def test_cannot_share_a_port_another_server_holds(tmp_path):
    # 윈도의 SO_REUSEADDR였다면 이 바인드가 성공해 두 서버가 한 포트를 나눠 가졌다
    port = free_port()
    other = other_checkout_server(port, tmp_path)
    try:
        with pytest.raises(OSError):
            start_mock_site(port)
    finally:
        other.shutdown()
        other.server_close()


def test_takes_the_port_once_the_other_server_stops(tmp_path):
    port = free_port()
    other = other_checkout_server(port, tmp_path)

    def stop() -> None:
        other.shutdown()
        other.server_close()

    threading.Timer(1.0, stop).start()
    site = ensure_mock_site(port, wait_s=15)
    try:
        assert site is not None
    finally:
        site.close()
