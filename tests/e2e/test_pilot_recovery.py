"""개인 탭 재접속, 승인 재시도와 공용 세션 경계."""

import asyncio
from uuid import uuid4

import httpx
from conftest import PORTAL, create_test_runtime

from cheongeum.server import close_all, create_app
from cheongeum.server.runtime import load_config


async def test_recovered_stopped_session_requires_current_writer_and_stop_generation():
    runtime = create_test_runtime({"PILOT_PROFILE": "personal", "REQUIRE_CONSENT": "true"})
    app, sessions = create_app(runtime)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
            original = (await client.post("/api/session", json={"recovery": True})).json()
            sid = original["sessionId"]
            path = f"/api/session/{sid}"
            old = {"x-cheongeum-writer": original["writer"]}
            first = (await client.post(f"{path}/cancel", headers=old)).json()["stopGeneration"]
            await client.post(f"{path}/detach", headers=old)
            new = (await client.post("/api/session/recover", json={"token": original["token"], "attempt": str(uuid4())})).json()
            writer = {"x-cheongeum-writer": new["writer"]}
            token = {"stopGeneration": new["checkpoint"]["stopGeneration"]}
            assert token["stopGeneration"] > first and new["checkpoint"]["state"] == "STOPPED"
            assert (await client.post(f"{path}/wake", headers=writer, json=token)).status_code == 409
            resumed = (await client.post(f"{path}/resume", headers=writer)).json()
            assert resumed["stopGeneration"] == token["stopGeneration"] and resumed["state"] == "STOPPED"
            assert (await client.post(f"{path}/wake", headers=old, json=token)).status_code == 409
            assert (await client.post(f"{path}/wake", headers=writer, json={"stopGeneration": first})).status_code == 409
            assert (await client.post(f"{path}/wake", headers=writer, json=token)).json() == {"state": "IDLE"}
            assert sessions.get(sid).consent_status == "pending"
    finally:
        await close_all(sessions)
        await runtime.close()


async def test_recovery_rotates_writer_and_revalidates_before_fresh_approval():
    runtime = create_test_runtime({"PILOT_PROFILE": "personal"})
    app, sessions = create_app(runtime)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
            original = (await client.post("/api/session", json={"recovery": True})).json()
            sid = original["sessionId"]
            path = f"/api/session/{sid}"
            old = {"x-cheongeum-writer": original["writer"]}

            async def turn(text, headers=old):
                return (await client.post("/api/turn", headers=headers, json={"sessionId": sid, "text": text})).json()

            await turn(f"{PORTAL} 열어줘")
            first = (await turn("이름 칸에 김하늘 써줘"))["pendingConfirmation"]
            assert first["kind"] == "field-entry"
            assert (await client.post(f"{path}/detach", headers=old)).status_code == 200
            assert (await client.get(f"{path}/state", headers=old)).status_code == 409
            first_attempt = {"token": original["token"], "attempt": str(uuid4())}
            contenders = await asyncio.gather(
                client.post("/api/session/recover", json=first_attempt),
                client.post("/api/session/recover", json={**first_attempt, "attempt": str(uuid4())}),
            )
            assert sorted(response.status_code for response in contenders) == [200, 404]
            winner = next(response.json() for response in contenders if response.status_code == 200)
            assert winner["token"] != original["token"] and winner["writer"] != original["writer"]
            assert winner["checkpoint"]["approvalKind"] == "field-entry"
            assert "김하늘" not in str(winner["checkpoint"])
            new = {"x-cheongeum-writer": winner["writer"]}
            assert (await client.get(f"{path}/state", headers=new)).status_code == 409
            assert (await client.post(f"{path}/resume", headers=new)).status_code == 200
            assert not (await client.get(f"{path}/state", headers=new)).json().get("pendingConfirmation")
            current = (await turn("이름 칸에 김하늘 써줘", new))["pendingConfirmation"]
            assert current["actionId"] != first["actionId"]
            stale = await client.post(f"{path}/confirm", headers=new, json={"approve": True, "actionId": first["actionId"]})
            assert not stale.json()["actions"]
            body = {"approve": True, "actionId": current["actionId"]}
            headers = {**new, "x-cheongeum-request": "1"}
            # 응답을 잃은 클라이언트가 같은 요청을 보낼 때 완료 결과를 돌려준다.
            work_page = sessions.get(sid).web.adapter.page
            await work_page.evaluate("window.pilotEntries = 0; document.addEventListener('input', () => window.pilotEntries++);")
            first_response = await client.post(f"{path}/confirm", headers=headers, json=body)
            retry = await client.post(f"{path}/confirm", headers=headers, json=body)
            assert retry.json() == first_response.json()
            assert await work_page.evaluate("window.pilotEntries") == 1
            assert len([a for a in retry.json()["actions"] if a.get("result", {}).get("ok")]) == 1
            assert (await client.post(f"{path}/confirm", headers=headers, json={**body, "approve": False})).status_code == 409
            assert (await client.post(f"{path}/cancel", headers=new)).json()["state"] == "STOPPED"
            assert (await client.delete(path, headers=new)).status_code == 200
            assert (await client.post("/api/session/recover", json={"token": winner["token"], "attempt": str(uuid4())})).status_code == 404
    finally:
        await close_all(sessions)
        await runtime.close()


async def test_shared_profiles_isolate_personal_state_and_preserve_three_active_sessions():
    runtime = create_test_runtime({"PILOT_PROFILE": "shared", "CHEONGEUM_DATA_DIR": "unused", "BROWSER_MODE": "chrome"})
    assert runtime.config.dataDir is None and runtime.config.browserMode == "chromium"
    assert load_config({}).pilotProfile == "unidentified"
    app, sessions = create_app(runtime)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
            assert (await client.post("/api/session", json={"recovery": True})).status_code == 403
            started = await asyncio.gather(*(client.post("/api/session") for _ in range(4)))
            assert sorted(r.status_code for r in started) == [200, 200, 200, 409]
            ids = [r.json()["sessionId"] for r in started if r.status_code == 200]
            assert len({id(sessions.get(sid)._personal) for sid in ids}) == 3
            for sid in ids:
                assert (await client.get(f"/api/session/{sid}/state")).status_code == 200
    finally:
        await close_all(sessions)
        await runtime.close()
