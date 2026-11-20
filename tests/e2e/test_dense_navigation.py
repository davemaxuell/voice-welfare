import json
import os
from urllib.parse import urlsplit

from conftest import FakeLlm, create_test_runtime, step

from cheongeum.agents.web.agent import ExecContext
from cheongeum.agents.web.autopilot import Autopilot, review_page
from cheongeum.core.jsutil import AbortSignal


async def test_deep_catalog_uses_trusted_clicks_and_the_correct_identically_named_link(tmp_path):
    # Set DENSE_NAV_CHROME=1 to exercise the installed Chrome with its own temporary profile.
    chrome = os.environ.get("DENSE_NAV_CHROME") == "1"
    env = {"PRACTICE_MODE": "true", "VISUAL_CURSOR": "true"}
    if chrome:
        env.update(PILOT_PROFILE="personal", BROWSER_MODE="chrome", HEADLESS="false",
                   CHROME_PROFILE_DIR=str(tmp_path / "chrome"), CHEONGEUM_DATA_DIR=str(tmp_path / "data"))
    rt = create_test_runtime(env)
    passage = "도담 센터의 방문 시간은 오후 네 시까지입니다."
    root = "https://catalog.example.org"
    depth = 5
    try:
        s = await rt.create_session()
        page = s.web.adapter.page
        if chrome:
            assert s.web.adapter.shared and not rt.browser_fallback
        await page.add_init_script("""document.addEventListener('click', e => {
          const a = e.target.closest('a');
          if (a) sessionStorage.setItem('clicks', JSON.stringify(
            [...JSON.parse(sessionStorage.getItem('clicks') || '[]'), [a.pathname, e.isTrusted, e.detail]]));
        }, true)""")

        async def portal(route):
            path = urlsplit(route.request.url).path.strip("/")
            if path == str(depth):
                body = f"<p>{passage}</p>"
            elif path.isdigit():
                n = int(path)
                rows = [f'<li><h3>기타 자료 {i}</h3><a href="/wrong/{i}">자세히 보기</a></li>' for i in range(600)]
                rows += [f'<li><h3>도담 참고 {i}</h3><a href="/wrong/{i}">자세히 보기</a></li>' for i in range(26)]
                rows.append(f'<li><h3>도담 방문 안내</h3><a href="/{n + 1}">자세히 보기</a></li>')
                body = "<ul>" + "".join(rows) + "</ul>"
            else:
                body = "<p>다른 자료예요.</p>"
            await route.fulfill(content_type="text/html; charset=utf-8", body=f"<title>자료 {path}</title><main>{body}</main>")

        await page.route(root + "/**", portal)

        def decide(**request):
            data = json.loads(request["user"])["page"]
            if data["mainText"] == passage:
                return step("answer", answer=passage, evidence=[passage])
            if "linkMatches" not in data:
                return step("find_links", "도담")
            match = next((item for item in data["linkMatches"] if "도담 방문 안내" in item["context"]), None)
            if match:
                assert match["name"] == "자세히 보기"
                return step("click", match["ref"])
            assert data["moreLinks"] and len(data["linkMatches"]) == 24
            return step("more_links")

        pilot = Autopilot(s.web, FakeLlm(fn=decide), search_url=lambda _: root, max_steps=3 * depth + 2)
        ctx = ExecContext(AbortSignal(), set(), lambda: False, lambda *args: None, public_lookup=True)
        result = await pilot.run("도담 방문 시간을 찾아줘", ctx, start_url=root + "/0")
        assert (result.status, result.review_quotes, result.iterations) == ("answered", (passage,), 3 * depth + 2)
        assert result.quote_sources == {passage: [root + f"/{depth}"]}
        assert all(a["policy"]["allowed"] and a["result"]["verified"] for a in result.actions)
        assert await page.evaluate("JSON.parse(sessionStorage.getItem('clicks'))") == [
            [f"/{i}", True, 1] for i in range(1, depth + 1)]
    finally:
        await rt.close()


async def test_replaced_catalog_row_is_rejected_and_never_clicked(new_session):
    s = await new_session()
    page = s.web.adapter.page
    await page.goto("http://localhost:5174/external.html")
    await page.set_content('<main><ul><li><h3>원래 센터</h3><a href="/wrong">자세히 보기</a></li></ul></main>')
    window = await s.web.adapter.control_window("원래 센터")
    item, = window["items"]
    await page.locator("h3").evaluate("el => el.textContent = '다른 센터'")
    ctx = ExecContext(AbortSignal(), set(), lambda: False, lambda *args: None, public_lookup=True)
    out = await s.web.follow_link(item["name"], ctx, matched_control={**item, "url": window["url"]})
    assert out.status == "needs-clarification" and out.actions == []
    assert page.url == window["url"]


async def test_requested_tabs_are_visited_even_when_the_first_page_has_the_answer(new_session):
    s = await new_session()
    root = "https://www.gov.kr"
    start = root + "/guide?private=synthetic-secret"
    deadline = "안내 창구는 금요일까지 운영합니다."
    html = f"""<title>창구 안내</title><main><h1>민원 데스크</h1>
      <div role="tablist"><button role="tab" aria-selected="true">지원대상</button>
      <button role="tab" aria-selected="false">서비스 내용</button></div>
      <p>{deadline}</p></main><script>
      const [a,b] = document.querySelectorAll('button');
      b.onclick=()=>{{a.setAttribute('aria-selected','false');b.setAttribute('aria-selected','true');
        document.querySelector('h1').textContent='서비스 내용 안내';}}
      </script>"""
    await s.web.adapter.page.route(root + "/**", lambda r: r.fulfill(content_type="text/html; charset=utf-8", body=html))
    async def decide(**request):
        data = json.loads(request["user"])
        visited = any("click" in row for row in data["history"])
        return {"action": "answer" if visited else "click", "target": None if visited else "서비스 내용",
                "answer": None, "claims": [] if visited else [{"fact": "other", "passageId": None, "quote": deadline}]}
    model = FakeLlm()
    model.generate = decide
    pilot = Autopilot(s.web, model, search_url=lambda _: root)
    ctx = ExecContext(AbortSignal(), set(), lambda: False, lambda *args: None, public_lookup=True)
    result = await pilot.run("지원대상을 확인하고 서비스 내용을 열어 운영 기한을 알려줘", ctx, start_url=start, site_url=root,
                             requested_facts=("other",), conversation={"requestedSteps": ["지원대상", "서비스 내용"]})
    assert result.status == "answered" and deadline in result.review_quotes
    observed = result.review_pages
    assert [row["selected"] for row in observed] == [["지원대상"], ["서비스 내용"]]
    assert [row["afterActionId"] for row in observed] == [a["action"]["id"] for a in result.actions]
    assert all(row["url"] == root + "/guide" and len(row["urlKey"]) == 64 for row in observed)
    assert "synthetic-secret" not in json.dumps(observed, ensure_ascii=False)


async def test_public_page_proof_omits_form_values_and_protected_screens(new_session):
    s = await new_session()
    page = s.web.adapter.page
    await page.goto("http://localhost:5174/external.html?record=private-record")
    await page.set_content('<title>자료 synthetic-input</title><main><h1>안내</h1>'
                           '<input aria-label="작성자" value="synthetic-input"><p>synthetic-input 자료입니다.</p></main>')
    proof = review_page(await s.web.observe())
    assert proof and all(term not in json.dumps(proof, ensure_ascii=False) for term in ("synthetic-input", "private-record"))
    await page.evaluate("document.querySelector('input').type = 'password'")
    assert review_page(await s.web.observe()) is None
