"""서버 음성(TTS)도 말 빠르기 설정을 따른다: 웹 화면이 /api/audio/speak에 설정값(rate)을 함께 보낸다."""
import asyncio
import socket
from types import SimpleNamespace

import pytest_asyncio
import uvicorn
from conftest import create_test_runtime
from playwright.async_api import expect

from cheongeum.agents.web.browser import launch_browser
from cheongeum.server import close_all, create_app
from cheongeum.server.app import mount_web_ui


class _Tts:
    name = "fake-server-tts"
    supported = True

    async def synthesize(self, text, *, language, signal=None, pace=None):
        return {"audio": bytes([0xFF, 0xF3]), "mimeType": "audio/mpeg"}


@pytest_asyncio.fixture
async def ui_with_server_voice():
    rt = create_test_runtime({"REQUIRE_CONSENT": "true"})
    app, sessions = create_app(rt, voice=SimpleNamespace(stt=rt.stt, tts=_Tts()))
    mount_web_ui(app)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    browser = await launch_browser(headless=True)
    page = await (await browser.new_context(locale="ko-KR")).new_page()
    yield page, f"http://127.0.0.1:{port}/"
    await browser.close()
    server.should_exit = True
    await task
    await close_all(sessions)
    await rt.close()


async def test_saved_slow_rate_reaches_the_server_voice(ui_with_server_voice):
    page, url = ui_with_server_voice
    rates: list = []
    page.on("request", lambda req: rates.append((req.post_data_json or {}).get("rate")) if req.url.endswith("/api/audio/speak") else None)
    await page.goto(url)
    hear = page.get_by_role("button", name="안내 듣고 시작하기 (Enter)")
    await expect(hear).to_be_enabled(timeout=15000)
    await hear.click()
    await page.get_by_role("button", name="동의하고 시작 (Enter)").click()
    box = page.get_by_label("명령 입력 (말하듯이 입력하세요)")
    await box.fill("천천히 말해줘")
    await box.press("Enter")
    for _ in range(150):
        if 0.9 in rates:
            break
        await asyncio.sleep(0.1)
    assert 0.9 in rates, rates
    # 첫 안내에는 기본 속도에 짧은 안내용 가속을 적용한다.
    assert rates[0] == 1.25 * 1.12
