import asyncio

import httpx
import pytest
from conftest import create_test_runtime

from cheongeum.personal.guardian import MESSAGE


SETUP = "보호자 김하늘 전화번호 공일공 일이삼사 오육칠팔 등록해줘"
CONTACT = "보호자한테 연락해줘"


async def register(session):
    before = session._personal.guardian()
    prompt = await session.handle_turn(SETUP)
    assert "동의" in prompt["speech"] and "김하늘" in prompt["speech"]
    assert session._personal.guardian() == before
    await session.handle_turn("네")
    assert session._personal.guardian() == {"name": "김하늘", "phone": "01012345678"}
    assert session._personal.vault() == {}


async def test_guardian_setup_preview_and_remove(new_session):
    s = await new_session()
    await register(s)
    prompt = await s.handle_turn(CONTACT)
    assert MESSAGE in prompt["speech"] and "5678" in prompt["speech"] and "모의" in prompt["speech"]
    result = await s.handle_turn("네")
    assert "실제 발송은 하지 않았어요" in result["speech"]
    assert "모의 문자 내용" not in (await s.handle_turn("네"))["speech"]
    await s.handle_turn("보호자 연락처 지워줘")
    await s.handle_turn("네")
    assert s._personal.guardian() is None
    assert "김하늘" not in str(s.export_history())
    assert "01012345678" not in str(s.export_history())


async def test_guardian_waits_for_consent_and_stop(new_session):
    rt = create_test_runtime({"REQUIRE_CONSENT": "true"})
    try:
        s = await new_session(rt)
        assert (await s.handle_turn(SETUP))["semanticAction"] == "consent"
        assert s.dialogue.vault_confirm is None
        await s.consent_to(True)
        await register(s)
        await s.handle_turn(CONTACT)
        await s.handle_turn("멈춰")
        assert (await s.handle_turn("네"))["state"] == "STOPPED"
        assert s.dialogue.vault_confirm is None
    finally:
        await rt.close()


@pytest.mark.parametrize("change", ["contact", "screen", "time"])
async def test_changed_or_expired_guardian_request_requires_fresh_yes(new_session, change):
    s = await new_session()
    s._personal.set_guardian({"name": "김하늘", "phone": "01012345678"})
    s.deps.clock = lambda: 0
    await s.handle_turn(CONTACT)
    if change == "contact":
        s._personal.set_guardian({"name": "박구름", "phone": "01098765432"})
    elif change == "screen":
        await s.web.adapter.page.evaluate("document.title = '새로운 페이지'")
    else:
        s.deps.clock = lambda: 120
    prompt = await s.handle_turn("네")
    assert prompt["state"] == "WAITING_FOR_USER_CONFIRMATION"
    assert "실제 발송은 하지" not in prompt["speech"]
    if change == "contact":
        assert "박구름" in prompt["speech"]
    assert "모의 문자 내용" in (await s.handle_turn("네"))["speech"]


async def test_queued_yes_cannot_approve_a_new_prompt(new_session, monkeypatch):
    s = await new_session()
    await register(s)
    observe = s.web.observe
    waiting, release = asyncio.Event(), asyncio.Event()

    async def slow(ctx):
        waiting.set()
        await release.wait()
        return await observe(ctx)

    monkeypatch.setattr(s.web, "observe", slow)
    asking = asyncio.create_task(s.handle_turn(CONTACT))
    await waiting.wait()
    early_yes = asyncio.create_task(s.handle_turn("네"))
    await asyncio.sleep(0)
    release.set()
    await asking
    assert (await early_yes)["state"] == "WAITING_FOR_USER_CONFIRMATION"
    assert "실제 발송은 하지" in (await s.handle_turn("네"))["speech"]


async def test_sms_mode_requires_fresh_unambiguous_confirmation(new_session, http_mock):
    rt = create_test_runtime({
        "GUARDIAN_SMS_PROVIDER": "solapi", "SOLAPI_API_KEY": "demo", "SOLAPI_API_SECRET": "test",
        "SOLAPI_SENDER_NUMBER": "0212345678",
    })
    try:
        s = await new_session(rt)
        calls = http_mock(lambda req: httpx.Response(200, json={"failedMessageList": [], "groupInfo": {"count": {"registeredSuccess": 1}}}))
        await register(s)
        prompt = await s.handle_turn(CONTACT)
        assert MESSAGE in prompt["speech"] and "모의" not in prompt["speech"]
        await s.handle_turn("응, 보내지 마")
        await s.handle_turn("네")
        assert not calls
        await s.handle_turn(CONTACT)
        reply = await s.handle_turn("보내줘")
        assert "접수됐어요" in reply["speech"]
        await s.handle_turn("네")
        assert len(calls) == 1
    finally:
        await rt.close()


async def test_guardian_endpoint_saves_on_personal_pc_and_refuses_on_shared(tmp_path):
    import httpx
    from pydantic import SecretStr

    from cheongeum.personal.seal import Seal
    from cheongeum.server.app import close_all, create_app
    from cheongeum.server.settings import SettingsInput, SettingsStore

    rt = create_test_runtime({"CHEONGEUM_DATA_DIR": str(tmp_path / "data")})
    rt.seal_factory = lambda: Seal(key=b"e" * 32)
    rt.settings = SettingsStore(tmp_path / "preferences.json", lambda: Seal(key=b"e" * 32))
    rt.settings.save(SettingsInput(apiKey=SecretStr("sk-test"), deviceUse="shared"))
    app, sessions = create_app(rt)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
            contact = {"name": "홍길동", "phone": "010-1122-3344"}
            refused = await c.post("/api/personal/guardian", json=contact)
            assert refused.status_code == 409 and refused.json()["error"] == "NOT_PERSONAL"
            rt.settings.save(SettingsInput(deviceUse="personal"))
            bad = await c.post("/api/personal/guardian", json={"name": "홍길동", "phone": "02-123-4567"})
            assert bad.status_code == 400 and "02-123-4567" not in bad.text
            ok = await c.post("/api/personal/guardian", json=contact)
            assert ok.json() == {"saved": True} and "홍길동" not in ok.text
            assert rt.personal_store().guardian() == {"name": "홍길동", "phone": "01011223344"}
    finally:
        await close_all(sessions)
        await rt.close()
