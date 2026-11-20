"""첫 실행 설정: 키는 꼭 있어야 하고, 설정을 어디까지 했는지 기억한다."""
import json

import httpx
import pytest
from pydantic import SecretStr

from conftest import create_test_runtime
from cheongeum.personal.seal import Seal
from cheongeum.server.app import close_all, create_app
from cheongeum.server.settings import Preferences, SettingsInput, SettingsStore


def _store(path):
    return SettingsStore(path, lambda: Seal(key=b"a" * 32))


def test_first_save_starts_setup_progress_at_stage2(tmp_path):
    store = _store(tmp_path / "preferences.json")
    store.save(SettingsInput(apiKey=SecretStr("sk-test"), deviceUse="personal"))
    assert store.first_run == "stage2"
    assert _store(tmp_path / "preferences.json").first_run == "stage2"


def test_settings_file_from_before_this_feature_counts_as_done(tmp_path):
    path = tmp_path / "preferences.json"
    old = Preferences().model_dump(exclude={"browser"})
    path.write_text(json.dumps({"preferences": old, "credential": "", "lastService": None}), encoding="utf-8")
    store = SettingsStore(path)
    assert store.completed and store.first_run == "done"


def test_set_first_run_survives_reload_and_rejects_unknown_steps(tmp_path):
    path = tmp_path / "preferences.json"
    store = _store(path)
    store.save(SettingsInput(apiKey=SecretStr("sk-test"), language="en", speed=1.6, deviceUse="personal"))
    store.set_first_run("intro")
    again = _store(path)
    assert again.first_run == "intro" and again.key == "sk-test"
    assert again.preferences.language == "en" and again.preferences.speed == 1.6
    with pytest.raises(ValueError):
        again.set_first_run("nope")
    assert _store(path).first_run == "intro"


def test_browser_choice_is_kept_on_personal_pc_and_forced_to_separate_on_shared(tmp_path):
    store = _store(tmp_path / "preferences.json")
    store.save(SettingsInput(apiKey=SecretStr("sk-test"), browser="chrome", deviceUse="personal"))
    assert store.preferences.browser == "chrome"
    store.save(SettingsInput(browser="chrome", deviceUse="shared"))
    assert store.preferences.browser == "separate"


async def test_saving_without_any_key_is_refused(tmp_path):
    path = tmp_path / "preferences.json"
    rt = create_test_runtime()
    rt.settings = _store(path)
    app, sessions = create_app(rt)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
            health = (await c.get("/api/health")).json()
            assert health["setupRequired"] and health["firstRun"] == "stage2"
            if health["stt"]["supported"]:
                pytest.skip("이 실행 환경은 .env 키로 음성이 켜져 있다")
            r = await c.post("/api/settings", json={"deviceUse": "personal"})
            assert r.status_code == 400 and r.json()["error"] == "KEY_REQUIRED" and not path.exists()
            assert (await c.post("/api/settings", json={"apiKey": "sk-test", "deviceUse": "personal"})).is_success
    finally:
        await close_all(sessions)
        await rt.close()
