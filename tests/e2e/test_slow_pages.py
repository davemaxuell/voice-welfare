"""
느린 누리집: 응답은 바로 오지만 막는 스크립트 때문에 화면 글(DOMContentLoaded)이 늦게 끝난다(복지로 첫 방문은 약 10초).
그런 화면은 '열지 못함'이 아니라 '열리는 중'이다. 열었다고 하고, 실패한 뒤 되돌아갈 때도 빈 화면으로 보내지 않는다.
"""
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest_asyncio

from cheongeum.agents.web.browser import PlaywrightExecutionAdapter, launch_browser

DEAD = "http://127.0.0.1:9/"
SCRIPT_DELAY_S = 3


class SlowSite:
    def __init__(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a) -> None:
                pass

            def do_GET(self) -> None:
                if self.path == "/slow.js":
                    time.sleep(SCRIPT_DELAY_S)
                    body, kind = b"document.title = document.title;", "application/javascript"
                else:
                    page = f'<!doctype html><title>느린 화면</title><body><main><h1>느린 화면</h1><p>본문입니다.</p></main><script src="/slow.js"></script></body>'
                    body, kind = page.encode(), "text/html; charset=utf-8"
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest_asyncio.fixture
async def slow_site_and_adapter():
    site = SlowSite()
    browser = await launch_browser(headless=True)
    adapter = PlaywrightExecutionAdapter(browser=browser, allowed_origins=[], read_only_web=True, navigation_timeout_ms=1000)
    await adapter.start()
    yield site, adapter
    await browser.close()
    site.server.shutdown()


def nav(url: str, n: list = [0]) -> dict:
    n[0] += 1
    return {"id": f"s{n[0]}", "type": "navigate", "url": url, "risk": "low"}


async def test_a_page_that_answers_but_builds_slowly_counts_as_opened(slow_site_and_adapter):
    site, adapter = slow_site_and_adapter
    r = await adapter.execute(nav(f"{site.url}/page"))
    assert r["ok"], r
    assert adapter.page.url == f"{site.url}/page"


async def test_failed_load_returns_to_a_slow_previous_page_not_a_blank_one(slow_site_and_adapter):
    site, adapter = slow_site_and_adapter
    await adapter.execute(nav(f"{site.url}/page"))
    r = await adapter.execute(nav(DEAD))
    assert r["errorCode"] == "NAVIGATION_FAILED"
    assert adapter.page.url == f"{site.url}/page"
