import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import uvicorn
from playwright.async_api import expect

from conftest import FakeLlm, create_test_runtime, with_llm
from test_web_ui import free_port, page
from cheongeum.server.app import close_all, create_app, mount_web_ui
from cheongeum.server.settings import SettingsInput, SettingsStore
from cheongeum.server.workflow_store import DIMENSIONS
from cheongeum.server.workflows import Workflows


def plan(kind, *, question="기초연금 신청 서류"):
    return dict(kind=kind, goal=question, source="welfare", subject="기초연금", agency="복지로",
                requestedFacts=["documents"], exclusions=[], continuation=False, question=None, choices=[])


async def test_conversation_delegation_explicit_notes_and_isolated_research(tmp_path, monkeypatch):
    runtime = create_test_runtime()
    runtime.settings = SettingsStore(tmp_path / "preferences.json")
    runtime.settings.save(SettingsInput(deviceUse="personal"))
    embed = AsyncMock(return_value=[1, *([0]*(DIMENSIONS - 1))])
    runtime.embedding = SimpleNamespace(embed=embed, model="text-embedding-3-small")
    runtime.moderation = None
    checked = {"title": "복지로 공식 자료", "lastCheckedAt": "2026-11-19", "url": "https://www.bokjiro.go.kr/"}
    service = {"servId": "fixture", "servNm": "기초연금", "summary": "검증용 제도", "dataOrigin": "official-api",
               "documents": "신청서와 신분증을 준비합니다.", "source": checked}
    monkeypatch.setattr(runtime.welfare_provider, "find_service", AsyncMock(return_value=service))
    create = runtime.create_session
    decisions = []
    async def new_session(*, background=False):
        session = await create(background=background)
        def model(**args):
            if args["schemaName"] == "public_service_decision":
                decisions.append((background, json.loads(args["user"])))
                if background:
                    assert "delegate_research" not in args["schema"]["properties"]["kind"]["enum"]
                    assert "already confirmed" in args["system"]
                return plan("find_information" if background else "delegate_research")
        with_llm(session, FakeLlm(fn=model))
        if background:
            def check_coverage(**args):
                assert args["schemaName"] == "public_research_coverage"
                assert json.loads(args["user"]) == {"question": "기초연금 신청 서류", "evidence": service["documents"]}
                return {"coverage": "all", "checks": [{"request": "신청 서류", "quote": service["documents"]}]}
            session.deps.web_llm = FakeLlm(fn=check_coverage)
        return session
    monkeypatch.setattr(runtime, "create_session", new_session)
    app, sessions = create_app(runtime)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
            sid = (await client.post("/api/session")).json()["sessionId"]
            session = sessions.get(sid)
            base = f"/api/session/{sid}/workspace"
            assert (await client.post(base+"/notes", json={"text": "Prefer English"})).status_code == 400
            assert (await client.post(base+"/notes", json={"text": "name@example.kr", "consent": True})).status_code == 400
            embed.assert_not_awaited()
            note = (await client.post(base+"/notes", json={"text": "안내는 쉬운 말로", "consent": True})).json()["id"]
            r = await session.handle_turn("기초연금 서류는 배경에서 조사해 줘", from_voice=True)
            assert r["pendingConfirmation"]["kind"] == "public-research"
            assert decisions[-1][1]["savedNotes"] == ["안내는 쉬운 말로"]
            assert not (await client.get(base)).json()["jobs"]
            await session.confirm(False, r["pendingConfirmation"]["actionId"])
            assert not (await client.get(base)).json()["jobs"]
            r = await session.handle_turn("기초연금 서류는 배경에서 조사해 줘")
            assert r["pendingConfirmation"]["kind"] == "public-research"
            await session.confirm(True, r["pendingConfirmation"]["actionId"])
            async with asyncio.timeout(20):
                while True:
                    jobs = (await client.get(base)).json()["jobs"]
                    if jobs and jobs[0]["state"] not in ("queued", "running"):
                        break
                    await asyncio.sleep(.05)
            assert jobs[0]["state"] == "completed" and jobs[0]["prompt"] == "기초연금 신청 서류"
            assert jobs[0]["result"]["sources"][0]["url"] == checked["url"]
            assert "savedNotes" not in decisions[-1][1] and decisions[-1][0]
            assert (await client.post(base+"/notes/search", json={"text":"English"})).json()["notes"][0]["id"] == note
            assert (await client.delete(base+"/notes/"+note)).json()["deleted"]
            embed.reset_mock()
            assert not await session.deps.recall_notes("장학금 준비 서류")
            embed.assert_not_awaited()
            runtime.settings.save(SettingsInput(deviceUse="shared"))
            assert (await client.get(base)).status_code == 403
    finally:
        await app.state.workflows.close()
        await close_all(sessions)
        await runtime.close()


async def test_restart_without_foreground_session_then_cancel_running_job(tmp_path):
    gate = asyncio.Event()
    class WorkerSession:
        async def research_public(self, text, lang):
            gate.set()
            await asyncio.Event().wait()
        def cancel(self):
            pass
        async def close(self):
            pass
    runtime = SimpleNamespace(settings=SettingsStore(tmp_path / "preferences.json"), config=SimpleNamespace(pilotProfile="personal"),
                              create_session=AsyncMock(return_value=WorkerSession()))
    runtime.settings.save(SettingsInput(deviceUse="personal"))
    prior = Workflows(runtime)
    store = await prior.store()
    job = store.enqueue(str(uuid4()), "정부24 발급 서류", "ko")
    restarted = Workflows(runtime)
    try:
        await restarted.reconfigure()
        await asyncio.wait_for(gate.wait(), 5)
        runtime.create_session.assert_awaited_once_with(background=True)
        assert await restarted.cancel(store, job)
        assert store.jobs()[0]["state"] == "cancelled"
    finally:
        await restarted.close()


async def test_workspace_panel_save_recall_and_forget_through_installed_ui(tmp_path, page):
    runtime = create_test_runtime()
    runtime.settings = SettingsStore(tmp_path / "preferences.json")
    runtime.settings.save(SettingsInput(deviceUse="personal", language="en"))
    runtime.settings.set_first_run("done")
    app, sessions = create_app(runtime)
    mount_web_ui(app)
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, lifespan="off", log_level="warning"))
    serve = asyncio.create_task(server.serve())
    try:
        async with asyncio.timeout(10):
            while not server.started:
                await asyncio.sleep(.05)
        await page.goto(f"http://127.0.0.1:{port}")
        await page.locator("#workflow-title").click()
        await expect(page.locator("#workflow-title")).to_have_text("Research and saved notes")
        await page.locator("#note-input").fill("Scholarship paperwork")
        await page.locator("#note-consent").check()
        await page.locator("#note-add").click()
        await expect(page.locator("#note-list")).to_contain_text("Scholarship paperwork")
        await page.reload()
        await page.locator("#workflow-title").click()
        await page.locator("#note-input").fill("Scholarship")
        await page.locator("#note-search").click()
        await expect(page.locator("#note-list")).to_contain_text("Scholarship paperwork")
        await page.locator("#note-list").get_by_role("button", name="Delete").click()
        await expect(page.locator("#note-list > li")).to_have_count(0)
    finally:
        server.should_exit = True
        await serve
        await app.state.workflows.close()
        await close_all(sessions)
        await runtime.close()
