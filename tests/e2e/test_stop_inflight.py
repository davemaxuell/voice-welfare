"""
멈춤과 열리던 화면: 응답을 기다리는 중에 멈추면 그 화면은 열리지 않고, 있던 화면이 그대로 남는다.
응답이 이미 들어와 화면이 바뀐 뒤(막을 수 없음)에 멈췄으면 더 불러오지 않고, 다시 시작할 때 화면이 바뀌었다고 말한다.
멈춤 대답은 하던 일이 있었는데 '대기 중인 작업이 없다'고 하지 않는다.
"""
import asyncio
import threading
import time
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import pytest_asyncio

FIRST = '<title>첫 화면</title><body><main><h1>첫 화면</h1><p>먼저 열린 화면입니다.</p><a href="/held">늦는 안내</a></main></body>'
LATE = "<title>늦은 화면</title><body><main><h1>늦은 화면</h1><p>뒤늦게 온 화면입니다.</p></main></body>"
# 머리와 첫 글은 바로 보내고(화면이 바뀜) 나머지는 붙잡아 둔다
PARTIAL_HEAD = "<!doctype html><title>반쯤 열린 화면</title><body><main><h1>반쯤 열린 화면</h1><p>먼저 온 글입니다.</p>" + " " * 2048
NO_PENDING = "대기 중인 브라우저 작업은 없습니다"


class HeldSite:
    """/held는 응답 전체를, /partial은 응답의 뒷부분을 release 때까지 붙잡는다."""

    def __init__(self) -> None:
        self.hits: Counter = Counter()
        self.arrived = threading.Event()
        self.release = threading.Event()
        self.answered = threading.Event()
        site = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a) -> None:
                pass

            def do_GET(self) -> None:
                path = self.path.split("?")[0]
                site.hits[path] += 1
                try:
                    if path == "/partial":
                        self._head()
                        self.wfile.write(PARTIAL_HEAD.encode())
                        self.wfile.flush()
                        site.arrived.set()
                        site.release.wait(30)
                        self.wfile.write("<p>늦게 온 글입니다.</p></main></body>".encode())
                    else:
                        if path == "/held":
                            site.arrived.set()
                            site.release.wait(30)
                        body = f"<!doctype html>{LATE if path == '/held' else FIRST}".encode()
                        self._head(len(body))
                        self.wfile.write(body)
                except OSError:
                    pass  # 브라우저가 요청을 끊었다
                finally:
                    if path in ("/held", "/partial"):
                        site.answered.set()

            def _head(self, length: int | None = None) -> None:
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                if length is not None:
                    self.send_header("Content-Length", str(length))
                self.end_headers()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.host = f"127.0.0.1:{self.server.server_port}"
        self.url = f"http://{self.host}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    async def reached(self, event: threading.Event, what: str) -> None:
        deadline = time.monotonic() + 10
        while not event.is_set():
            assert time.monotonic() < deadline, f"{what} 안 됨"
            await asyncio.sleep(0.01)

    async def let_go(self) -> None:
        """붙잡은 응답을 보내고, 크롬이 받은 문서를 화면에 올릴 틈을 준다."""
        self.release.set()
        await self.reached(self.answered, "붙잡은 응답 보내기")
        await asyncio.sleep(0.7)


@pytest_asyncio.fixture
async def held_site():
    site = HeldSite()
    yield site
    site.release.set()
    site.server.shutdown()


async def opened_first(new_session, site: HeldSite):
    s = await new_session()
    r = await s.handle_turn(f"{site.host}/first 열어줘")
    assert r["observation"]["url"] == f"{site.url}/first"
    return s


async def stop_by(s, how: str) -> dict:
    return s.cancel() if how == "button" else await asyncio.wait_for(s.handle_turn("멈춰"), 5)


@pytest.mark.parametrize("how", ["button", "voice"])
async def test_stop_before_the_page_answers_keeps_the_screen_that_was_open(held_site, new_session, how):
    s = await opened_first(new_session, held_site)
    opening = asyncio.create_task(s.handle_turn(f"{held_site.host}/held 열어줘"))
    await held_site.reached(held_site.arrived, "늦는 화면 요청")
    stopped = await stop_by(s, how)
    assert stopped["state"] == "STOPPED"
    assert NO_PENDING not in stopped["speech"]
    assert "멈췄" in stopped["speech"] and "다시 시작" in stopped["speech"]
    assert "바뀌었" not in stopped["speech"]
    assert (await asyncio.wait_for(opening, 5))["state"] == "STOPPED"
    await held_site.let_go()
    assert s.web.adapter.page.url == f"{held_site.url}/first"
    resumed = await s.handle_turn("다시 시작해줘")
    assert resumed["observation"]["url"] == f"{held_site.url}/first"
    assert "첫 화면" in resumed["speech"]
    assert "늦은 화면" not in resumed["speech"]
    assert "바뀌었" not in resumed["speech"]
    assert held_site.hits["/held"] == 1


async def test_stop_drops_what_was_queued_behind_the_page_that_was_opening(held_site, new_session):
    s = await opened_first(new_session, held_site)
    opening = asyncio.create_task(s.handle_turn(f"{held_site.host}/held 열어줘"))
    await held_site.reached(held_site.arrived, "늦는 화면 요청")
    queued = asyncio.create_task(s.handle_turn("화면 설명해줘"))
    await asyncio.sleep(0.05)
    assert s.cancel()["state"] == "STOPPED"
    assert (await asyncio.wait_for(opening, 5))["state"] == "STOPPED"
    dropped = await asyncio.wait_for(queued, 5)
    assert dropped["state"] == "STOPPED"
    assert dropped["actions"] == []
    assert "실행하지 않았습니다" in dropped["speech"]
    await held_site.let_go()
    assert s.web.adapter.page.url == f"{held_site.url}/first"
    blocked = await s.handle_turn("화면 설명해줘")
    assert blocked["state"] == "STOPPED"
    assert blocked["actions"] == []
    assert held_site.hits["/held"] == 1


async def test_stop_after_a_link_was_pressed_keeps_the_screen_that_was_open(held_site, new_session):
    s = await opened_first(new_session, held_site)
    pressing = asyncio.create_task(s.handle_turn("늦는 안내 눌러줘"))
    await held_site.reached(held_site.arrived, "늦는 화면 요청")
    stopped = s.cancel()
    assert NO_PENDING not in stopped["speech"]
    assert (await asyncio.wait_for(pressing, 10))["state"] == "STOPPED"
    await held_site.let_go()
    assert s.web.adapter.page.url == f"{held_site.url}/first"
    resumed = await s.handle_turn("다시 시작해줘")
    assert resumed["observation"]["url"] == f"{held_site.url}/first"
    assert "늦은 화면" not in resumed["speech"]


async def test_stop_after_the_page_already_changed_says_so_on_resume(held_site, new_session):
    s = await opened_first(new_session, held_site)
    opening = asyncio.create_task(s.handle_turn(f"{held_site.host}/partial 열어줘"))
    await held_site.reached(held_site.arrived, "반쯤 열린 화면 요청")
    while s.web.adapter.page.url != f"{held_site.url}/partial":
        assert not opening.done(), "화면이 바뀌기 전에 턴이 끝남"
        await asyncio.sleep(0.01)
    stopped = s.cancel()
    assert stopped["state"] == "STOPPED"
    assert NO_PENDING not in stopped["speech"]
    # 멈춤 답에서 바로 알린다(주인 결정 2026-11-19): 되돌리지 않고 바뀐 사실을 말한다
    assert "바뀌었어요" in stopped["speech"]
    assert (await asyncio.wait_for(opening, 5))["state"] == "STOPPED"
    await held_site.let_go()
    # 이미 바뀐 화면은 되돌리지 않는다(멈춘 뒤에 또 움직이지 않음). 대신 더 불러오지 않는다.
    assert s.web.adapter.page.url == f"{held_site.url}/partial"
    assert "늦게 온 글" not in await s.web.adapter.page.inner_text("body")
    resumed = await s.handle_turn("다시 시작해줘")
    assert resumed["observation"]["url"] == f"{held_site.url}/partial"
    assert resumed["speech"].startswith("다시 시작합니다. 멈추는 사이에 화면이 바뀌었어요.")
    assert "반쯤 열린 화면" in resumed["speech"]
    assert held_site.hits == Counter({"/first": 1, "/partial": 1})
