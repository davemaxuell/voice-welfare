"""'나만 쓰는 개인 PC'를 고르면 개인 금고(봉인)와 평소 쓰는 크롬을 쓴다. 공용 PC면 쓰지 않는다."""
import httpx
from pydantic import SecretStr

from conftest import create_test_runtime
from cheongeum.personal.seal import Seal
from cheongeum.server.app import close_all, create_app
from cheongeum.server.settings import SettingsInput, SettingsStore

KEY = b"c" * 32


def _runtime(tmp_path, **prefs):
    rt = create_test_runtime({"CHEONGEUM_DATA_DIR": str(tmp_path / "data")})
    rt.seal_factory = lambda: Seal(key=KEY)
    rt.settings = SettingsStore(tmp_path / "preferences.json", lambda: Seal(key=KEY))
    if prefs:
        rt.settings.save(SettingsInput(apiKey=SecretStr("sk-test"), **prefs))
    return rt


async def test_personal_pc_choice_opens_a_sealed_store_without_pilot_profile(tmp_path):
    rt = _runtime(tmp_path, deviceUse="personal")
    assert rt.config.pilotProfile == "unidentified" and rt.personal_enabled()
    s = await rt.create_session()
    try:
        assert s.deps.personal is not None and s.deps.personal.persistent
        s.deps.personal.set_guardian({"name": "홍길동", "phone": "01011223344"})
        raw = (tmp_path / "data" / "personal.json").read_bytes()
        assert Seal(key=KEY).is_sealed(raw) and "홍길동".encode() not in raw
    finally:
        await s.close()
        await rt.close()


async def test_shared_pc_choice_has_no_personal_store(tmp_path):
    rt = _runtime(tmp_path, deviceUse="shared")
    s = await rt.create_session()
    try:
        assert not rt.personal_enabled() and s.deps.personal is None
    finally:
        await s.close()
        await rt.close()


async def test_switching_to_shared_drops_the_store_for_new_sessions(tmp_path):
    rt = _runtime(tmp_path, deviceUse="personal")
    first = await rt.create_session()
    assert first.deps.personal is not None
    rt.settings.save(SettingsInput(deviceUse="shared"))
    rt.refresh_services()
    second = await rt.create_session()
    try:
        assert second.deps.personal is None and rt.personal_store() is None
    finally:
        await first.close()
        await second.close()
        await rt.close()


async def test_usual_chrome_is_chosen_only_on_a_personal_pc(tmp_path):
    personal = _runtime(tmp_path / "a", deviceUse="personal", browser="chrome")
    shared = _runtime(tmp_path / "b", deviceUse="shared", browser="chrome")
    try:
        assert personal.browser_mode() == "chrome" and shared.browser_mode() == "chromium"
    finally:
        await personal.close()
        await shared.close()


async def test_usual_chrome_that_cannot_start_falls_back_to_separate_browser(tmp_path):
    rt = _runtime(tmp_path, deviceUse="personal", browser="chrome")

    async def broken():
        raise RuntimeError("크롬 없음")

    rt._get_chrome = broken
    app, sessions = create_app(rt)
    s = await rt.create_session()
    try:
        assert rt.browser_fallback and s.web.adapter.page is not None
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
            assert (await c.get("/api/settings")).json()["browserFallback"] is True
    finally:
        await s.close()
        await close_all(sessions)
        await rt.close()
