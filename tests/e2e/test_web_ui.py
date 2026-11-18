"""웹 UI(바닐라 JS) E2E: 실제 서버(API + 정적 UI)를 띄우고 Chromium으로 화면을 조작한다."""
import asyncio
import socket

import pytest_asyncio
import uvicorn
from conftest import create_test_runtime
from playwright.async_api import expect

from cheongeum.agents.web.browser import launch_browser
from cheongeum.server import close_all, create_app
from cheongeum.server.app import mount_web_ui


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest_asyncio.fixture(scope="module")
async def ui_url():
    rt = create_test_runtime({"REQUIRE_CONSENT": "true"})
    app, sessions = create_app(rt)
    mount_web_ui(app)
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    yield f"http://127.0.0.1:{port}/"
    server.should_exit = True
    await task
    await close_all(sessions)
    await rt.close()


@pytest_asyncio.fixture
async def page():
    browser = await launch_browser(headless=True)
    ctx = await browser.new_context(locale="ko-KR")
    p = await ctx.new_page()
    yield p
    await browser.close()


async def test_consent_then_text_command(ui_url, page):
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    await page.goto(ui_url)
    hear = page.get_by_role("button", name="안내 듣고 시작하기 (Enter)")
    await expect(hear).to_be_enabled(timeout=15000)
    await expect(hear).to_be_focused()
    await hear.click()
    yes = page.get_by_role("button", name="동의하고 시작 (Enter)")
    await expect(yes).to_be_visible()
    await yes.click()
    await expect(page.locator("#consent-panel")).to_be_hidden()
    await expect(page.locator("#log")).to_contain_text("동의해 주셔서 감사합니다")

    box = page.get_by_label("명령 입력 (말하듯이 입력하세요)")
    await box.fill("장애인연금 신청 도와줘")
    await box.press("Enter")
    await expect(page.locator("#st-state")).to_have_text("신청서 작성 중", timeout=20000)
    await expect(page.locator("#st-step")).to_contain_text("1/3")
    await expect(box).to_have_value("")  # 원문이 입력창에 남지 않음
    await expect(page.locator("#fields")).to_contain_text("성명")

    await box.fill("이름은 김하늘")
    await box.press("Enter")
    await expect(page.locator("#fields")).to_contain_text("입력됨: 김하늘", timeout=20000)
    await expect(page.locator("#actions")).to_contain_text("성공")
    assert errors == []


async def test_decline_and_high_contrast(ui_url, page):
    await page.goto(ui_url)
    await expect(page.get_by_role("button", name="안내 듣고 시작하기 (Enter)")).to_be_enabled(timeout=15000)
    await page.get_by_role("button", name="안내 듣고 시작하기 (Enter)").click()
    await page.keyboard.press("Escape")
    await expect(page.locator("#log")).to_contain_text("복지 제도 질문에만 답할게요")
    await expect(page.get_by_role("button", name="대화 시작 (Enter)")).to_be_disabled()
    await page.get_by_role("button", name="고대비 꺼짐").click()
    await expect(page.locator("#app")).to_have_class("app high-contrast")
