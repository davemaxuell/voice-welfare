"""첫 실행 설정 화면(웹 UI): 키보드만으로 끝까지 갈 수 있고, 녹음한 문장과 화면 글이 같다."""
import asyncio
import io
import json
import wave

import pytest
import pytest_asyncio
import uvicorn
from playwright.async_api import expect

from conftest import create_test_runtime
from cheongeum.agents.web.browser import launch_browser
from cheongeum.personal.seal import Seal
from cheongeum.server import close_all, create_app
from cheongeum.server.app import mount_web_ui
from cheongeum.server.settings import SettingsStore
from test_web_ui import free_port


def _silence() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\0\0" * 400)
    return buf.getvalue()


SILENCE = _silence()


@pytest_asyncio.fixture
async def first_run_ui(tmp_path, request):
    """설정 파일을 tmp에 둔 실제 서버. param으로 미리 쓸 설정 파일 내용을 줄 수 있다."""
    path = tmp_path / "preferences.json"
    preset = getattr(request, "param", None)
    if preset:
        path.write_text(json.dumps(preset), encoding="utf-8")
    rt = create_test_runtime({"REQUIRE_CONSENT": "true", "CHEONGEUM_DATA_DIR": str(tmp_path / "data")})
    rt.seal_factory = lambda: Seal(key=b"d" * 32)
    rt.settings = SettingsStore(path, lambda: Seal(key=b"d" * 32))
    rt.refresh_services()  # 실제 앱처럼 저장된 키로 음성을 켠다
    app, sessions = create_app(rt)
    mount_web_ui(app)
    port = free_port()
    # 끝낼 때 재생 중이던 소리 연결을 무한정 기다리지 않는다
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="off",
                                           timeout_graceful_shutdown=5))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    yield SimpleRun(f"http://127.0.0.1:{port}/", path, rt)
    server.should_exit = True
    await task
    await close_all(sessions)
    await rt.close()


class SimpleRun:
    def __init__(self, url, path, rt):
        self.url, self.path, self.rt = url, path, rt

    def saved(self) -> dict:
        return json.loads(self.path.read_text(encoding="utf-8"))


@pytest_asyncio.fixture
async def page():
    browser = await launch_browser(headless=True)
    ctx = await browser.new_context(locale="ko-KR")
    p = await ctx.new_page()
    yield p
    await browser.close()


async def mock_voice(page, check="ok", spoken=None, delay_ms=0):
    """키 확인 결과를 정하고, 음성 합성은 짧은 무음으로 바꾼다(spoken에 말한 문장을 모은다)."""
    async def check_key(route):
        await route.fulfill(json={"result": check})

    async def speak(route):
        if spoken is not None:
            spoken.append(json.loads(route.request.post_data or "{}").get("text", ""))
        if delay_ms:
            await asyncio.sleep(delay_ms / 1000)
        await route.fulfill(body=SILENCE, content_type="audio/wav")

    async def clip(route):
        await route.fulfill(body=SILENCE, content_type="audio/wav")

    await page.route("**/api/settings/check-key", check_key)
    await page.route("**/api/audio/speak", speak)
    await page.route("**/setup-audio/*/*.mp3", clip)  # 녹음 파일이 있는지는 test_setup_clips가 본다


def step(page, name):
    return page.locator(f'#first-run [data-step="{name}"]')


async def answer(page, key, then):
    await page.keyboard.press(key)
    await expect(step(page, then)).to_be_visible()
    await page.wait_for_timeout(300)  # 단계가 바뀐 직후의 입력은 받지 않는다


async def to_key_step(page, who="1"):
    await expect(step(page, "language")).to_be_visible()
    await page.wait_for_timeout(300)
    await answer(page, "1", "who")
    await answer(page, who, "key")


async def test_user_alone_finishes_stage1_with_keys_only(first_run_ui, page):
    await mock_voice(page)
    await page.goto(first_run_ui.url)
    await to_key_step(page)
    await expect(page.locator("#first-run-key")).to_be_focused()
    await page.keyboard.type("sk-test-alone")
    await answer(page, "Enter", "pc")
    await answer(page, "1", "sound")
    saved = first_run_ui.saved()
    assert saved["preferences"]["deviceUse"] == "personal" and saved["preferences"]["browser"] == "separate"
    assert saved["preferences"]["language"] == "ko" and saved["firstRun"] == "stage2"
    assert "sk-test-alone" not in first_run_ui.path.read_text(encoding="utf-8")


async def test_wrong_key_stays_on_key_step_with_reason(first_run_ui, page):
    await mock_voice(page, check="invalid")
    await page.goto(first_run_ui.url)
    await to_key_step(page)
    await page.keyboard.type("sk-wrong")
    await page.keyboard.press("Enter")
    await expect(page.locator("#first-run-live")).to_contain_text("키가 맞지 않아요")
    await expect(step(page, "key")).to_be_visible()
    await expect(page.locator("#first-run-key")).to_be_focused()
    assert not first_run_ui.path.exists()


async def test_double_key_press_answers_one_step(first_run_ui, page):
    await mock_voice(page)
    await page.goto(first_run_ui.url)
    await expect(step(page, "language")).to_be_visible()
    await page.wait_for_timeout(300)
    await page.keyboard.press("1")
    await page.keyboard.press("1")
    await expect(step(page, "who")).to_be_visible()
    await page.wait_for_timeout(400)
    await expect(step(page, "who")).to_be_visible()
    await expect(step(page, "key")).to_be_hidden()


async def test_each_choice_step_moves_focus_to_its_heading_and_reads_the_clip_text(first_run_ui, page):
    await mock_voice(page)
    await page.goto(first_run_ui.url)
    await expect(step(page, "language")).to_be_visible()
    await page.wait_for_timeout(300)
    await answer(page, "1", "who")
    await expect(step(page, "who").locator("h2")).to_be_focused()
    await expect(page.locator("#first-run-live")).to_have_text("지금 누가 설정하고 계세요? 사용하실 분 본인이면 1번, 가족이나 복지관 직원이면 2번.")


async def test_esc_goes_back_one_step(first_run_ui, page):
    await mock_voice(page)
    await page.goto(first_run_ui.url)
    await expect(step(page, "language")).to_be_visible()
    await page.wait_for_timeout(300)
    await answer(page, "1", "who")
    await answer(page, "Escape", "language")


async def test_helper_path_saves_extras_then_hands_over(first_run_ui, page):
    await mock_voice(page)
    await page.goto(first_run_ui.url)
    await to_key_step(page, who="2")
    await expect(page.get_by_role("link", name="키 받는 방법")).to_be_visible()
    await page.keyboard.type("sk-test-helper")
    await answer(page, "Enter", "pc")
    await answer(page, "1", "browser")
    await answer(page, "1", "guardian")
    await page.locator("#first-run-guardian-name").fill("홍길동")
    await page.locator("#first-run-guardian-phone").fill("010-1122-3344")
    await answer(page, "Enter", "handover")
    saved = first_run_ui.saved()
    assert saved["preferences"]["browser"] == "chrome" and saved["preferences"]["deviceUse"] == "personal"
    assert first_run_ui.rt.personal_store().guardian() == {"name": "홍길동", "phone": "01011223344"}
    await answer(page, "Enter", "sound")


async def test_shared_pc_skips_browser_and_guardian(first_run_ui, page):
    await mock_voice(page)
    await page.goto(first_run_ui.url)
    await to_key_step(page, who="2")
    await page.keyboard.type("sk-test-helper")
    await answer(page, "Enter", "pc")
    await answer(page, "2", "handover")
    assert first_run_ui.saved()["preferences"]["deviceUse"] == "shared"
    assert first_run_ui.rt.personal_store() is None


async def test_guardian_can_be_skipped(first_run_ui, page):
    await mock_voice(page)
    await page.goto(first_run_ui.url)
    await to_key_step(page, who="2")
    await page.keyboard.type("sk-test-helper")
    await answer(page, "Enter", "pc")
    await answer(page, "1", "browser")
    await answer(page, "2", "guardian")
    await page.get_by_role("button", name="건너뛰기").click()
    await expect(step(page, "handover")).to_be_visible()
    assert first_run_ui.saved()["preferences"]["browser"] == "separate"
    assert first_run_ui.rt.personal_store().guardian() is None


def _stage2_file():
    """1단계를 저장한 뒤 앱을 닫은 상태: 키는 봉인돼 있고 firstRun은 stage2."""
    import base64

    from cheongeum.server.settings import Preferences

    sealed = base64.b64encode(Seal(key=b"d" * 32).seal(b"sk-test-stage2")).decode("ascii")
    prefs = Preferences(deviceUse="personal").model_dump()
    return {"preferences": prefs, "credential": sealed, "lastService": None, "firstRun": "stage2"}


@pytest.mark.parametrize("first_run_ui", [_stage2_file()], indirect=True)
async def test_reopening_in_stage2_resumes_at_sound_check(first_run_ui, page):
    spoken = []
    await mock_voice(page, spoken=spoken)
    await page.goto(first_run_ui.url)
    await expect(step(page, "sound")).to_be_visible()
    await expect(step(page, "language")).to_be_hidden()
    for _ in range(50):
        if "제 목소리가 들리시면 Enter를 눌러 주세요." in spoken:
            break
        await page.wait_for_timeout(100)
    assert "제 목소리가 들리시면 Enter를 눌러 주세요." in spoken


@pytest.mark.parametrize("first_run_ui", [_stage2_file()], indirect=True)
async def test_speed_keys_change_and_save_speed_then_consent(first_run_ui, page):
    spoken = []
    await mock_voice(page, spoken=spoken)
    await page.goto(first_run_ui.url)
    await expect(step(page, "sound")).to_be_visible()
    await page.wait_for_timeout(300)
    await answer(page, "Enter", "speed")
    await page.keyboard.press("3")
    await expect(page.locator("#first-run-live")).to_contain_text("1.6")
    await page.wait_for_timeout(300)
    await page.keyboard.press("2")
    await expect(page.locator("#consent-panel")).to_be_visible()
    await expect(page.locator("#first-run")).to_be_hidden()
    assert first_run_ui.saved()["preferences"]["speed"] == 1.6


@pytest.mark.parametrize("first_run_ui", [_stage2_file()], indirect=True)
async def test_three_replays_show_the_sound_help(first_run_ui, page):
    await mock_voice(page)
    await page.goto(first_run_ui.url)
    await expect(step(page, "sound")).to_be_visible()
    for _ in range(3):
        await page.wait_for_timeout(300)
        await page.keyboard.press(" ")
    await expect(step(page, "sound")).to_contain_text("스피커 연결과 소리 크기")



def _done_file():
    """설정을 이미 마친 PC(firstRun done): 평소처럼 동의 화면부터."""
    data = _stage2_file()
    data["firstRun"] = "done"
    return data


async def _consent(page):
    hear = page.get_by_role("button", name="안내 듣고 시작하기 (Enter)")
    await expect(hear).to_be_enabled(timeout=15000)
    await hear.click()
    await page.get_by_role("button", name="동의하고 시작 (Enter)").click()
    await expect(page.locator("#consent-panel")).to_be_hidden()


@pytest.mark.parametrize("first_run_ui", [_done_file()], indirect=True)
async def test_intro_replay_shows_a_card_per_line_and_esc_skips(first_run_ui, page):
    spoken = []
    await mock_voice(page, spoken=spoken, delay_ms=600)
    await page.goto(first_run_ui.url)
    await _consent(page)
    box = page.get_by_label("명령 입력 (말하듯이 입력하세요)")
    await box.fill("청음 소개 다시 해줘")
    await box.press("Enter")
    card = page.locator("#intro-card")
    await expect(card).to_be_visible()
    await expect(page.locator("#intro-text")).to_have_text("반가워요! 저는 청음이에요.")
    await expect(card.locator("img")).to_have_attribute("src", "/avatar/poses/ready.webp")
    await page.keyboard.press("Escape")
    await expect(card).to_be_hidden()
    await page.wait_for_timeout(500)
    assert "그럼 같이 시작해 볼까요?" not in spoken


@pytest.mark.parametrize("first_run_ui", [_done_file()], indirect=True)
async def test_setup_restart_opens_the_wizard(first_run_ui, page):
    await mock_voice(page)
    await page.goto(first_run_ui.url)
    await _consent(page)
    box = page.get_by_label("명령 입력 (말하듯이 입력하세요)")
    await box.fill("설정 다시 해줘")
    await box.press("Enter")
    await expect(step(page, "language")).to_be_visible()
