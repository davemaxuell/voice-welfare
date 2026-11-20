"""
시연용 가상 커서: 초점만 옮길 때(승인·입력을 기다리는 때)와 누를 때 모양이 다르고,
페이지가 읽는 내용과 클릭을 방해하지 않는다.
"""
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest_asyncio

from cheongeum.agents.web.browser import PlaywrightExecutionAdapter, launch_browser

PAGE = (
    "<!doctype html><title>처음</title><body><main><h1>안내</h1>"
    "<button id=go style='margin:80px 0 0 120px;width:160px;height:48px' onclick=\"document.title='눌림'\">신청하기</button>"
    "</main></body>"
).encode()
BUTTON = {"role": "button", "name": "신청하기"}
CURSOR = "document.getElementById('__cheongeum_cursor')"


def act(type_: str, **p) -> dict:
    act.n = getattr(act, "n", 0) + 1
    return {"id": f"c{act.n}", "type": type_, "risk": "low", **p}


@pytest_asyncio.fixture
async def adapter():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a) -> None:
            pass

        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(PAGE)))
            self.end_headers()
            self.wfile.write(PAGE)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    browser = await launch_browser(headless=True)
    a = PlaywrightExecutionAdapter(browser=browser, allowed_origins=[], read_only_web=True, visual_cursor=True)
    await a.start()
    await a.execute(act("navigate", url=f"http://127.0.0.1:{server.server_port}/"))
    yield a
    await browser.close()
    server.shutdown()


async def cursor_state(page) -> dict:
    return await page.evaluate(
        f"""() => {{
            const c = {CURSOR};
            const r = document.getElementById('go').getBoundingClientRect();
            const b = c.querySelector('.bubble');
            return {{
                mode: c.dataset.mode,
                bubble: getComputedStyle(b).display,
                dx: parseFloat(c.style.left) - (r.left + r.width / 2),
                dy: parseFloat(c.style.top) - (r.top + r.height / 2),
                hidden: c.getAttribute('aria-hidden'),
                over: document.elementFromPoint(parseFloat(c.style.left), parseFloat(c.style.top)).id,
            }};
        }}"""
    )


async def test_waiting_shows_the_bubble_and_the_click_clears_it(adapter):
    page = adapter.page
    r = await adapter.execute(act("focus", target=BUTTON))
    assert r["ok"]
    waiting = await cursor_state(page)
    assert waiting["mode"] == "wait"
    assert waiting["bubble"] == "flex"
    assert (round(waiting["dx"]), round(waiting["dy"])) == (0, 0)

    r = await adapter.execute(act("click", target=BUTTON))
    assert r["ok"]
    assert await page.title() == "눌림"
    pressed = await cursor_state(page)
    assert pressed["mode"] == "click"
    assert pressed["bubble"] == "none"


async def test_cursor_does_not_get_in_the_way(adapter):
    await adapter.page.get_by_role("button", name=BUTTON["name"]).focus()
    before = await adapter.observe()
    await adapter.execute(act("focus", target=BUTTON))
    state = await cursor_state(adapter.page)
    assert state["hidden"] == "true"
    assert state["over"] == "go"
    after = await adapter.observe()
    assert after["outline"] == before["outline"]
