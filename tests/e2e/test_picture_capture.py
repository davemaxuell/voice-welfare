"""
화면 사진 찍기(어댑터 capture): 입력 칸·개인정보 글·내장 문서는 검게 가려지고, 청음의 커서는 찍히지 않고,
로그인 화면은 찍지 않는다. 사진의 점 색은 페이지 안 canvas로 읽는다(새 의존성 없음).
확인용 화면(picture.html)의 글자색은 순검정이 아니어서, 사진에서 순검정은 가린 자리뿐이다.
"""
import base64

import pytest_asyncio

from cheongeum.agents.web.browser import PlaywrightExecutionAdapter, cursor_script, launch_browser
from cheongeum.agents.web.shot import ShotRefusal, plan_shot
from cheongeum.core.picture import Picture

MOCK = "http://localhost:5174"
BLACK = [0, 0, 0]
WHITE = [255, 255, 255]
MARKS = "[data-cheongeum-shot]"

READ_PIXELS = """async ({ url, points }) => {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)));
}"""


@pytest_asyncio.fixture
async def adapter():
    browser = await launch_browser(headless=True)
    a = PlaywrightExecutionAdapter(browser=browser, allowed_origins=[MOCK])
    await a.start()
    yield a
    await browser.close()


async def open_page(adapter, path: str) -> None:
    r = await adapter.execute({"id": "open", "type": "navigate", "url": f"{MOCK}{path}", "risk": "low"})
    assert r["ok"], r


async def shoot(adapter):
    view = await adapter.observe()
    plan = plan_shot(view)
    if isinstance(plan, ShotRefusal):
        return plan
    return await adapter.capture(plan, (view.get("outline") or {}).get("mainText") or "")


async def center(adapter, selector: str) -> list[int]:
    box = await adapter.page.locator(selector).bounding_box()
    return [round(box["x"] + box["width"] / 2), round(box["y"] + box["height"] / 2)]


async def colors(adapter, url: str, points: list[list[int]]) -> list[list[int]]:
    return await adapter.page.evaluate(READ_PIXELS, {"url": url, "points": points})


async def test_personal_details_inputs_and_frames_are_black(adapter):
    await open_page(adapter, "/picture.html")
    await adapter.page.fill("#memo", "홍길동 010-1234-5678")
    picture = await shoot(adapter)
    assert isinstance(picture, Picture)
    assert (picture.source, picture.width, picture.height) == ("web", 1100, 860)

    hidden = [await center(adapter, s) for s in ("#memo", "#rrn", "#account", "#frame")]
    assert await colors(adapter, picture.data_url(), hidden) == [BLACK] * 4

    kept = await colors(adapter, picture.data_url(), [await center(adapter, s) for s in ("#plain", "#office", "#notice")])
    assert BLACK not in kept
    assert picture.masks.inputs == 1
    assert picture.masks.frames == 1
    assert picture.masks.blocks == 2
    assert picture.masks.cursorHidden is False


async def test_the_page_is_left_unmarked(adapter):
    await open_page(adapter, "/picture.html")
    assert isinstance(await shoot(adapter), Picture)
    assert await adapter.page.locator(MARKS).count() == 0


async def test_cursor_overlay_is_not_in_the_picture(adapter):
    await open_page(adapter, "/picture.html")
    spot = [800, 300]
    sample = [spot[0] + 2, spot[1] + 4]
    await adapter.page.evaluate(cursor_script(spot[0], spot[1], "move"))
    await adapter.page.wait_for_timeout(700)

    plain = "data:image/png;base64," + base64.b64encode(await adapter.page.screenshot(scale="css")).decode("ascii")
    assert await colors(adapter, plain, [sample]) != [WHITE], "커서가 그 자리에 보이지 않아 시험이 아무것도 확인하지 못합니다"

    picture = await shoot(adapter)
    assert await colors(adapter, picture.data_url(), [sample]) == [WHITE]
    assert picture.masks.cursorHidden is True
    assert await adapter.page.locator("#__cheongeum_cursor svg").first.is_visible()


async def test_login_page_is_refused_before_capture(adapter):
    await open_page(adapter, "/login.html")
    refusal = await shoot(adapter)
    assert isinstance(refusal, ShotRefusal)
    assert refusal.reason == "login"


async def test_password_field_that_appears_after_planning_is_refused(adapter):
    await open_page(adapter, "/picture.html")
    plan = plan_shot(await adapter.observe())
    await open_page(adapter, "/login.html")
    refusal = await adapter.capture(plan, "")
    assert isinstance(refusal, ShotRefusal)
    assert refusal.reason == "password"
    assert await adapter.page.locator(MARKS).count() == 0


async def test_secret_in_main_text_that_no_block_holds_is_refused(adapter):
    await open_page(adapter, "/picture.html")
    view = await adapter.observe()
    refusal = await adapter.capture(plan_shot(view), view["outline"]["mainText"] + "\n계좌번호 999-888-777666")
    assert isinstance(refusal, ShotRefusal)
    assert refusal.reason == "unmaskable"


async def test_new_auth_screen_on_the_same_url_is_refused_before_capture(adapter, monkeypatch):
    await open_page(adapter, "/picture.html")
    view = await adapter.observe()
    await adapter.page.evaluate("document.title = '본인인증'")
    async def unexpected(**kwargs):
        raise AssertionError("called screenshot on an authentication screen")

    monkeypatch.setattr(adapter.page, "screenshot", unexpected)
    result = await adapter.capture(plan_shot(view), view["outline"]["mainText"])
    assert result.reason == "verification"


async def test_mutation_during_screenshot_discards_bytes_and_cleans_up(adapter, monkeypatch):
    await open_page(adapter, "/picture.html")
    original = adapter.page.screenshot

    async def changing_page(**kwargs):
        await adapter.page.locator("#plain").evaluate("(el) => el.textContent = '새로 표시된 글'")
        return await original(**kwargs)

    monkeypatch.setattr(adapter.page, "screenshot", changing_page)
    result = await shoot(adapter)
    assert isinstance(result, ShotRefusal) and result.reason == "changed"
    assert await adapter.page.locator(MARKS).count() == 0


async def test_single_png_contains_both_ends_and_masks_below_the_fold(adapter):
    await open_page(adapter, "/picture.html")
    page = adapter.page
    await page.set_content("""<body style="margin:0"><header style="height:50px;background:#da1234"></header>
        <div style="height:1800px"></div><input id="field" value="개인 메모"><p id="email">qa@example.test</p>
        <p id="phone">010-1234-5678</p><iframe id="embed" srcdoc="<p>내장 문서</p>"></iframe>
        <footer style="height:90px;background:#1256da"></footer></body>""")
    await page.evaluate("scrollTo(0, 700)")
    original = await page.evaluate("scrollY")
    height = await page.evaluate("document.documentElement.scrollHeight")
    hidden = await page.locator("#field,#email,#phone,#embed").evaluate_all(
        "(els) => els.map(e => { const b=e.getBoundingClientRect(); return [Math.floor(b.x+b.width/2),Math.floor(b.y+scrollY+b.height/2)]; })"
    )
    picture = await shoot(adapter)
    assert isinstance(picture, Picture)
    assert picture.height == height > 2 * 860
    assert await colors(adapter, picture.data_url(), [[2, 5], [2, height - 5], *hidden]) == [
        [218, 18, 52], [18, 86, 218], *([BLACK] * 4)
    ]
    assert await page.evaluate("scrollY") == original
