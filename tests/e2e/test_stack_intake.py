from types import SimpleNamespace

import httpx
from conftest import create_test_runtime

from cheongeum.orchestrator.public_task import parse_decision
from cheongeum.server import close_all, create_app


def decision(kind, **fields):
    return {"kind": kind, "source": None, "agency": None, "subject": None, "goal": None,
            "requestedFacts": [], "exclusions": [], "continuation": False, "question": None,
            "choices": [], **fields}


async def test_personal_foreground_and_background_worker_have_distinct_scopes(tmp_path):
    rt = create_test_runtime({"PILOT_PROFILE": "personal", "BROWSER_MODE": "chrome",
                              "CHEONGEUM_DATA_DIR": str(tmp_path), "READ_ONLY_CLICKS": "any"})
    try:
        session = await rt.create_session(background=True)
        try:
            assert not session.web.adapter.shared and session.web.adapter.page.url == "about:blank"
            assert session.web.guard.config.publicLookupOnly and not session.web.guard.config.allowedOrigins
            assert not session.web.guard.config.allowedFieldIds and session.web.guard.config.readOnlyClicks == "safe"
            assert session.web.adapter.downloads is None and session.deps.personal is None
            assert not session.deps.practice_mode and session.deps.action_log is None
            assert not list(tmp_path.iterdir())
        finally:
            await session.close()
    finally:
        await rt.close()


async def test_semantic_screen_skill_never_routes_an_approval(new_session):
    session = await new_session()
    proposed = decision("read_skill", skill="LIST_LINKS")
    calls = []

    async def generate(**kwargs):
        calls.append(kwargs["schemaName"])
        return proposed

    session.deps.llm = SimpleNamespace(generate=generate)
    result = await session.handle_turn("여기서 이동할 수 있는 곳들을 차례로 들려줄래요?")
    assert result["intentType"] == "LIST_LINKS" and calls == ["public_service_decision"]
    assert parse_decision(decision("read_skill", skill="APPROVE")) is None
    assert parse_decision(decision("find_information", reply="접수를 마쳤습니다")) is None


async def test_file_transcript_needs_consent_and_never_executes_or_enters_history():
    rt = create_test_runtime({"REQUIRE_CONSENT": "true", "PRACTICE_MODE": "false"})
    calls = []
    async def transcribe(audio, *, language, mime_type):
        calls.append((language, mime_type))
        return {"text": "제출해줘. 비밀번호는 723654야."}

    stt = SimpleNamespace(supported=True, name="fixture", transcribe=transcribe)
    app, sessions = create_app(rt, voice=SimpleNamespace(stt=stt, tts=rt.tts))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
            sid = (await c.post("/api/session")).json()["sessionId"]
            url = f"/api/audio/recording?sessionId={sid}"
            args = {"content": bytes(400), "headers": {"content-type": "audio/mpeg"}}
            assert (await c.post(url, **args)).status_code == 403 and not calls
            await c.post(f"/api/session/{sid}/consent", json={"granted": True})
            sessions.get(sid).deps.llm = SimpleNamespace()
            switched = await c.post(f"/api/session/{sid}/language", json={"lang": "ja"})
            assert switched.json()["lang"] == "ja"
            before = (await c.get(f"/api/session/{sid}/state")).json()
            response = await c.post(url, **args)
            assert response.is_success and "제출" in response.json()["text"] and "723654" not in response.text
            assert calls == [("ja", "audio/mpeg")]
            assert before == (await c.get(f"/api/session/{sid}/state")).json()
            await c.post(f"/api/session/{sid}/cancel")
            assert (await c.post(url, **args)).status_code == 403 and len(calls) == 1
    finally:
        await close_all(sessions)
        await rt.close()
