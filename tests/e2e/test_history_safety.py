"""
기록 이동(뒤로·불러오기 실패 뒤 되돌아가기)이 양식(POST)을 다시 보내지 않는지, 꼬리말이 사이트 꼬리말인지.
자동화된 크롬은 '양식 다시 제출 확인' 없이 그냥 다시 보낸다. 실제 사이트의 로그인·신청 양식일 수 있다.
"""
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest_asyncio

from cheongeum.agents.web.browser import PlaywrightExecutionAdapter, launch_browser

DEAD = "http://127.0.0.1:9/"


class FormSite:
    def __init__(self) -> None:
        self.posts = 0
        site = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a) -> None:
                pass

            def _page(self, title: str, body: str = "") -> None:
                data = f"<!doctype html><title>{title}</title><body><main><h1>{title}</h1>{body}</main></body>".encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:
                if self.path == "/form":
                    return self._page("양식", '<form method="post" action="/submit"><input name="q" value="x"><button id="go">보내기</button></form>')
                return self._page(self.path.strip("/") or "처음")

            def do_POST(self) -> None:
                site.posts += 1
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                # 결과 화면에 다음 양식이 또 있다(공공 누리집은 form.submit()으로 화면을 넘기곤 한다)
                return self._page("보냄", '<form method="post" action="/submit2"><input name="r" value="y"><button id="go2">다음</button></form>')

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest_asyncio.fixture
async def site_and_adapter():
    site = FormSite()
    browser = await launch_browser(headless=True)
    adapter = PlaywrightExecutionAdapter(browser=browser, allowed_origins=[], read_only_web=True)
    await adapter.start()
    yield site, adapter
    await browser.close()
    site.server.shutdown()


def act(type_: str, **p) -> dict:
    act.n = getattr(act, "n", 0) + 1
    return {"id": f"h{act.n}", "type": type_, "risk": "low", **p}


async def submit_form(site: FormSite, adapter: PlaywrightExecutionAdapter) -> None:
    await adapter.execute(act("navigate", url=f"{site.url}/form"))
    await adapter.page.click("#go")
    await adapter.page.wait_for_url("**/submit")
    assert site.posts == 1


async def test_back_onto_a_form_result_does_not_send_the_form_again(site_and_adapter):
    site, adapter = site_and_adapter
    await submit_form(site, adapter)
    await adapter.execute(act("navigate", url=f"{site.url}/other"))
    r = await adapter.execute(act("back"))
    assert site.posts == 1
    assert r["errorCode"] == "RESUBMIT_BLOCKED"
    assert adapter.page.url == f"{site.url}/other"


async def test_back_through_ordinary_pages_still_works(site_and_adapter):
    site, adapter = site_and_adapter
    await adapter.execute(act("navigate", url=f"{site.url}/a"))
    await adapter.execute(act("navigate", url=f"{site.url}/b"))
    r = await adapter.execute(act("back"))
    assert r["ok"]
    assert adapter.page.url == f"{site.url}/a"


async def test_failed_load_after_a_form_result_does_not_send_the_form_again(site_and_adapter):
    site, adapter = site_and_adapter
    await submit_form(site, adapter)
    r = await adapter.execute(act("navigate", url=DEAD))
    assert r["errorCode"] == "NAVIGATION_FAILED"
    assert site.posts == 1
    assert adapter.page.url == f"{site.url}/submit"


async def test_failed_reload_of_the_current_page_does_not_jump_further_back(site_and_adapter):
    site, adapter = site_and_adapter
    other = FormSite()
    await adapter.execute(act("navigate", url=f"{site.url}/a"))
    await adapter.execute(act("navigate", url=f"{other.url}/x"))
    other.server.shutdown()
    other.server.server_close()
    r = await adapter.execute(act("navigate", url=f"{other.url}/x"))
    assert r["errorCode"] == "NAVIGATION_FAILED"
    assert adapter.page.url != f"{site.url}/a"


async def test_back_still_works_after_a_failed_load(site_and_adapter):
    site, adapter = site_and_adapter
    await adapter.execute(act("navigate", url=f"{site.url}/a"))
    await adapter.execute(act("navigate", url=f"{site.url}/b"))
    await adapter.execute(act("navigate", url=DEAD))
    assert adapter.page.url == f"{site.url}/b"
    r = await adapter.execute(act("back"))
    assert r["ok"], r
    assert adapter.page.url == f"{site.url}/a"


async def test_back_between_two_form_results_sends_neither_again(site_and_adapter):
    site, adapter = site_and_adapter
    await submit_form(site, adapter)
    await adapter.page.click("#go2")
    await adapter.page.wait_for_url("**/submit2")
    assert site.posts == 2
    r = await adapter.execute(act("back"))
    assert site.posts == 2
    assert r["errorCode"] == "RESUBMIT_BLOCKED"
    assert not adapter.page.url.startswith("chrome-error://")


async def test_footer_text_is_the_site_footer_not_article_footers(site_and_adapter):
    _, adapter = site_and_adapter
    cards = "".join(f"<article><h2>소식 {i}</h2><p>내용</p><footer><p>작성일 2025-01-{i:02d} 조회수 {100 + i}</p></footer></article>" for i in range(1, 31))
    await adapter.page.set_content(
        f"<title>소식</title><main><h1>소식 목록</h1>{cards}</main><footer><p>(우)54870 전주시 기지로 180</p><p>대표번호 국번없이 1355</p></footer>"
    )
    footer = (await adapter.observe())["outline"]["footerText"]
    assert "대표번호 국번없이 1355" in footer
    assert "조회수" not in footer
