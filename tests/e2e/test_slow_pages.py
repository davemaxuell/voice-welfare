"""
느린 누리집: 응답은 바로 오지만 막는 스크립트 때문에 화면 글(DOMContentLoaded)이 늦게 끝난다(복지로 첫 방문은 약 10초).
그런 화면은 '열지 못함'이 아니라 '열리는 중'이다. 열었다고 하고, 실패한 뒤 되돌아갈 때도 빈 화면으로 보내지 않는다.
검색 결과처럼 틀이 먼저 뜨고 내용을 나중에 받아 오는 화면은 내용이 올 때까지 기다리고, 못 기다렸으면 다 열렸다고 하지 않는다.
"""
import asyncio
import json
import threading
import time
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest_asyncio
from conftest import MOCK_URL

from cheongeum.agents.web import agent as agent_module
from cheongeum.agents.web import browser as browser_module
from cheongeum.agents.web.browser import PlaywrightExecutionAdapter, launch_browser

DEAD = "http://127.0.0.1:9/"
DATA_DELAY_S = 2
RESULT = "기초연금 신청 방법은 주민센터와 국민연금공단에서 안내합니다."

PAGES = {
    "/page": '<title>느린 화면</title><body><main><h1>느린 화면</h1><p>본문입니다.</p></main><script src="/slow.js"></script></body>',
    "/home": '<title>늦는 누리집</title><body><main><h1>늦는 누리집</h1><form action="/results"><input type="search" name="q" aria-label="검색어"><button>검색</button></form></main></body>',
    # 검색을 양식(POST)으로 보낸다(복지로 통합검색)
    "/post-home": '<title>양식 검색 누리집</title><body><main><h1>양식 검색 누리집</h1><form method="post" action="/results"><input type="search" name="q" aria-label="검색어"><button>검색</button></form></main></body>',
    "/no-search": '<title>검색</title><main><input type="search"><p>첫 화면입니다.</p></main>',
    "/inline": '<title>검색</title><main><input type="search" onkeydown="if(event.key===\'Enter\') document.querySelector(\'p\').textContent=\'일치하는 결과가 없습니다.\'"><p>검색할 수 있습니다.</p></main>',
    # 틀(메뉴·제목)이 먼저 뜨고 결과는 따로 받아 와서 채운다(복지로 통합검색)
    "/results": '<title>검색 결과</title><body><nav><a href="/home">처음</a> <a href="/notice">공지사항</a></nav><main><h1>검색 결과</h1><div id="list"></div></main>'
    "<script>fetch('/data').then((r) => r.json()).then((d) => { document.getElementById('list').innerHTML = '<p>' + d.text + '</p>'; });</script></body>",
}


class SlowSite:
    def __init__(self) -> None:
        hits: Counter = Counter()
        self.hits = hits
        self.script_requested = threading.Event()
        self.release_script = threading.Event()
        gate, requested = self.release_script, self.script_requested

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a) -> None:
                pass

            def do_GET(self) -> None:
                path = self.path.split("?")[0]
                hits[path] += 1
                cache = "no-store"
                if path == "/slow.js":
                    requested.set()
                    gate.wait(60)
                    body, kind = b"document.title = document.title;", "application/javascript"
                elif path == "/lib.js":
                    body, kind, cache = b"window.lib = 1;", "application/javascript", "max-age=3600"
                elif path == "/data":
                    time.sleep(DATA_DELAY_S)
                    body, kind = json.dumps({"text": RESULT}).encode(), "application/json"
                else:
                    page = PAGES.get(path) or f'<title>빠른 화면</title><body><main><h1>빠른 화면</h1><p>{path}</p></main><script src="/lib.js"></script></body>'
                    body, kind = f"<!doctype html>{page}".encode(), "text/html; charset=utf-8"
                self._send(body, kind, cache)

            def do_POST(self) -> None:
                path = self.path.split("?")[0]
                hits[f"POST {path}"] += 1
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                self._send(f"<!doctype html>{PAGES['/results']}".encode(), "text/html; charset=utf-8", "no-store")

            def _send(self, body: bytes, kind: str, cache: str) -> None:
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", cache)
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # A test can navigate away while its script is held.

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.host = f"127.0.0.1:{self.server.server_port}"
        self.url = f"http://{self.host}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest_asyncio.fixture
async def slow_site_and_adapter(monkeypatch):
    site = SlowSite()
    browser = await launch_browser(headless=True)
    adapter = PlaywrightExecutionAdapter(browser=browser, allowed_origins=[], read_only_web=True, navigation_timeout_ms=15_000)
    await adapter.start()
    # Establishing a real Chromium connection may take seconds on a busy CI host.
    # Only shorten the budget for waiting on DOMContentLoaded after commit.
    real_wait = adapter.page.wait_for_load_state
    async def wait_for_state(state=None, *, timeout=None):
        if state == "domcontentloaded" and timeout == adapter.navigation_timeout:
            timeout = 500
        await real_wait(state, timeout=timeout)
    monkeypatch.setattr(adapter.page, "wait_for_load_state", wait_for_state)
    yield site, adapter
    site.release_script.set()
    await browser.close()
    site.server.shutdown()


@pytest_asyncio.fixture
async def slow_site():
    site = SlowSite()
    yield site
    site.release_script.set()
    site.server.shutdown()


def act(type_: str, n: list = [0], **p) -> dict:
    n[0] += 1
    return {"id": f"s{n[0]}", "type": type_, "risk": "low", **p}


def nav(url: str) -> dict:
    return act("navigate", url=url)


async def test_a_page_that_answers_but_builds_slowly_counts_as_opened(slow_site_and_adapter):
    site, adapter = slow_site_and_adapter
    page = adapter.page
    url = f"{site.url}/page"
    async with asyncio.timeout(25):
        r = await adapter.execute(nav(url))
        assert r["ok"] and r["verified"], r
        assert page.url == url
        assert await asyncio.to_thread(site.script_requested.wait, 5)
        assert await page.evaluate("document.readyState") == "loading"
    site.release_script.set()
    await page.wait_for_load_state("domcontentloaded", timeout=10_000)


async def test_failed_load_returns_to_a_slow_previous_page_not_a_blank_one(slow_site_and_adapter):
    site, adapter = slow_site_and_adapter
    await adapter.execute(nav(f"{site.url}/page"))
    r = await adapter.execute(nav(DEAD))
    assert r["errorCode"] == "NAVIGATION_FAILED"
    assert adapter.page.url == f"{site.url}/page"


async def test_back_onto_a_slow_page_is_done_when_the_page_answers(slow_site_and_adapter):
    site, adapter = slow_site_and_adapter
    await adapter.execute(nav(f"{site.url}/page"))
    await adapter.execute(nav(f"{site.url}/fast"))
    r = await adapter.execute(act("back"))
    assert r["ok"], r
    assert adapter.page.url == f"{site.url}/page"


async def test_files_stay_cached_from_one_page_to_the_next(slow_site_and_adapter):
    site, adapter = slow_site_and_adapter
    await adapter.execute(nav(f"{site.url}/fast"))
    await adapter.execute(nav(f"{site.url}/fast2"))
    assert site.hits["/fast"] == site.hits["/fast2"] == 1
    assert site.hits["/lib.js"] == 1


async def test_returning_from_a_popup_restores_the_openers_pending_search(slow_site_and_adapter):
    site, adapter = slow_site_and_adapter
    opener = adapter.page
    await opener.goto(f"{site.url}/fast")
    started, release = asyncio.Event(), asyncio.Event()

    async def held(route):
        started.set()
        await release.wait()
        await route.fulfill(json={})

    await opener.route("**/held", held)
    try:
        await opener.evaluate("void fetch('/held')")
        await asyncio.wait_for(started.wait(), 5)
        assert (await adapter.observe()).get("loading")
        async with opener.expect_popup() as opened:
            await opener.evaluate("window.open('/fast2'); void 0")
        popup = await opened.value
        await popup.wait_for_load_state("load")
        assert (await adapter.observe())["url"] == popup.url
        assert not (await adapter.observe()).get("loading")
        await popup.close()
        assert (await adapter.observe())["url"] == opener.url
        assert (await adapter.observe()).get("loading")
    finally:
        release.set()


async def test_the_adapter_opens_web_addresses_only(slow_site_and_adapter, tmp_path):
    site, adapter = slow_site_and_adapter
    secret = tmp_path / "secret.txt"
    secret.write_text("비밀", encoding="utf-8")
    opened = await adapter.execute(nav(f"{site.url}/fast"))
    assert opened["ok"] and opened["verified"], opened
    r = await adapter.execute(nav(secret.as_uri()))
    assert not r["ok"]
    assert adapter.page.url == f"{site.url}/fast"


async def test_bokjiro_does_not_call_a_pending_result_a_completed_search(new_session, monkeypatch):
    monkeypatch.setattr(browser_module, "FETCH_FRESH_S", 0.1)
    monkeypatch.setattr(agent_module, "SEARCH_SETTLE_MS", 300)
    s = await new_session()
    ready = asyncio.Event()
    endpoint = "/ssis-tbu/TWZZ01000M/twatzzza/intgSearch/selectTwzzIntgSearchList.do"

    async def serve(route):
        if endpoint in route.request.url:
            await ready.wait()
            await route.fulfill(json={"text": RESULT})
        elif "/results" in route.request.url:
            await route.fulfill(content_type="text/html; charset=utf-8", body=PAGES["/results"].replace("/data", endpoint))
        else:
            await route.fulfill(content_type="text/html; charset=utf-8", body=PAGES["/home"])

    await s.web.adapter.page.route("https://www.bokjiro.go.kr/**", serve)
    try:
        r = await s.handle_turn("복지로에서 기초연금 검색해줘")
        assert "아직 다 열리지 않았어요" in r["speech"]
        assert "검색했어요" not in r["speech"]
    finally:
        ready.set()
    assert RESULT in (await s.handle_turn("본문 읽어줘"))["speech"]


async def test_search_waits_for_results_that_come_after_the_page(slow_site, new_session):
    s = await new_session()
    await s.handle_turn(f"{slow_site.host}/home 열어줘")
    r = await s.handle_turn("기초연금 검색해줘")
    assert r["semanticAction"] == "search"
    assert RESULT in r["speech"]


async def test_search_does_not_announce_success_on_an_unchanged_page(slow_site, new_session):
    s = await new_session()
    await s.handle_turn(f"{slow_site.host}/no-search 열어줘")
    r = await s.handle_turn("기초연금 검색해줘")
    assert "검색했어요" not in r["speech"]
    assert "확인하지 못했" in r["speech"]
    assert r["observation"]["url"] == f"{slow_site.url}/no-search"


async def test_an_inline_empty_result_is_a_completed_search(slow_site, new_session):
    s = await new_session()
    await s.handle_turn(f"{slow_site.host}/inline 열어줘")
    r = await s.handle_turn("기초연금 검색해줘")
    assert "검색했어요" in r["speech"]
    assert "일치하는 결과가 없습니다" in r["speech"]


async def test_search_says_results_are_not_in_yet_and_reading_waits_for_them(slow_site, new_session, monkeypatch):
    monkeypatch.setattr(agent_module, "SEARCH_SETTLE_MS", 300, raising=False)
    s = await new_session()
    await s.handle_turn(f"{slow_site.host}/home 열어줘")
    r = await s.handle_turn("기초연금 검색해줘")
    assert "아직 다 열리지 않았어요" in r["speech"]
    assert RESULT not in r["speech"]
    read = await s.handle_turn("본문 읽어줘")
    assert RESULT in read["speech"]


async def test_back_onto_a_page_that_fetches_its_content_describes_that_content(slow_site, new_session):
    s = await new_session()
    await s.handle_turn(f"{slow_site.host}/results 열어줘")
    await s.handle_turn(f"{slow_site.host}/fast 열어줘")
    r = await s.handle_turn("뒤로 가줘")
    assert r["semanticAction"] == "back"
    assert r["observation"]["url"] == f"{slow_site.url}/results"
    assert "아직 다 열리지 않았어요" not in r["speech"]
    assert RESULT in r["speech"]


async def test_back_to_results_of_a_form_search_runs_that_search_again(slow_site, new_session):
    s = await new_session()
    await s.handle_turn(f"{slow_site.host}/post-home 열어줘")
    searched = await s.handle_turn("기초연금 검색해줘")
    assert RESULT in searched["speech"]
    await s.handle_turn("공지사항 눌러줘")
    r = await s.handle_turn("뒤로 가줘")
    assert r["semanticAction"] == "back"
    assert r["observation"]["url"] == f"{slow_site.url}/results"
    assert "'기초연금'" in r["speech"]
    assert RESULT in r["speech"]
    # 기록의 양식은 다시 보내지 않고, 검색창에 새로 한 번 검색했다
    assert slow_site.hits["POST /results"] == 2
    # 기록도 처음 → 검색 화면 → 결과 순서 그대로: 결과 뒤에 봤던 화면이 끼어들지 않는다
    home = await s.handle_turn("뒤로 가줘")
    assert home["observation"]["url"] == f"{slow_site.url}/post-home"
    start = await s.handle_turn("뒤로 가줘")
    assert start["observation"]["url"].startswith(MOCK_URL)


async def test_back_onto_some_other_form_result_stays_and_does_not_say_try_again(slow_site, new_session):
    s = await new_session()
    await s.handle_turn(f"{slow_site.host}/post-home 열어줘")
    await s.handle_turn("검색 버튼 눌러줘")
    await s.handle_turn("공지사항 눌러줘")
    r = await s.handle_turn("뒤로 가줘")
    assert slow_site.hits["POST /results"] == 1
    assert r["observation"]["url"] == f"{slow_site.url}/notice"
    assert "다시 보내지 않도록" in r["speech"]
    assert "다시 시도" not in r["speech"]
