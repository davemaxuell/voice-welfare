"""서버가 제안한 선택지(아바타·대화 창 버튼): 제안한 응답·인계 번호·화면이 그대로일 때만, 말과 같은 길로 실행한다."""
import httpx
import pytest_asyncio
from conftest import PORTAL

from cheongeum.server import close_all, create_app


def keys(result: dict) -> list[str]:
    return [c["key"] for c in result.get("offeredChoices", [])]


async def test_login_handoff_offers_done_and_cancel_and_resumes_the_form(new_session):
    s = await new_session()
    assert keys(await s.handle_turn("장애인연금 신청 도와줘")) == []
    handed = await s.handle_turn("로그인하고 싶어")
    assert handed["state"] == "AUTH_HANDOFF"
    assert [(c["key"], c["label"]) for c in handed["offeredChoices"]] == [("auth-done", "로그인했어요"), ("auth-cancel", "인증 취소")]
    handoff = handed["authHandoff"]["id"]

    still = await s.choose(handed["turnId"], "auth-done", handoff)
    assert still["state"] == "AUTH_HANDOFF" and "아직" in still["speech"]
    assert still["userUtterance"] == "로그인했어요"
    assert await s.choose(handed["turnId"], "auth-done", handoff) is None, "the first offer was used up"
    assert await s.choose(still["turnId"], "auth-done", "other-handoff") is None

    await s.web.adapter.page.goto("http://localhost:5174/apply.html", wait_until="domcontentloaded")
    done = await s.choose(still["turnId"], "auth-done", handoff)
    assert done["intentType"] == "AUTH_DONE" and done["state"] == "APPLICATION_OPEN"
    assert s.dialogue.awaiting == "applicantName"
    assert keys(done) == []


async def test_superseded_handoff_and_cancel(new_session):
    s = await new_session()
    first = await s.handle_turn("로그인하고 싶어")
    cancelled = await s.choose(first["turnId"], "auth-cancel", first["authHandoff"]["id"])
    assert cancelled["authHandoff"]["status"] == "cancelled" and keys(cancelled) == []

    second = await s.handle_turn("로그인하고 싶어")
    third_turn = await s.handle_turn("화면 설명해줘")
    assert third_turn["authHandoff"]["id"] == second["authHandoff"]["id"]
    assert await s.choose(second["turnId"], "auth-done", second["authHandoff"]["id"]) is None, "a later turn superseded the offer"
    assert await s.choose(third_turn["turnId"], "auth-done", first["authHandoff"]["id"]) is None, "old handoff id"
    assert s.dialogue.auth_waiting


async def test_read_main_offer_is_bound_to_the_page_it_was_offered_for(new_session):
    s = await new_session()
    opened = await s.handle_turn(f"{PORTAL} 열어줘")
    assert [(c["key"], c["label"]) for c in opened["offeredChoices"]] == [("read-main", "본문 읽기")]
    read = await s.choose(opened["turnId"], "read-main", None)
    assert read["semanticAction"] == "read-main" and read["userUtterance"] == "본문 읽어줘"

    again = await s.handle_turn(f"{PORTAL} 열어줘")
    await s.web.adapter.page.goto("http://127.0.0.1:5174/external2.html", wait_until="domcontentloaded")
    assert await s.choose(again["turnId"], "read-main", None) is None, "the page changed after the offer"


async def test_no_offer_while_an_approval_is_pending(new_session):
    s = await new_session()
    await s.handle_turn("127.0.0.1:5174/external.html 열어줘")
    asked = await s.handle_turn("이름 칸에 김하늘 써줘")
    assert asked["state"] == "WAITING_FOR_USER_CONFIRMATION" and keys(asked) == []


@pytest_asyncio.fixture
async def api(runtime):
    app, sessions = create_app(runtime)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as client:
        yield client
    await close_all(sessions)


async def test_choice_route_validates_and_reports_expired_offers(api):
    sid = (await api.post("/api/session", json={})).json()["sessionId"]
    turn = (await api.post("/api/turn", json={"sessionId": sid, "text": "로그인하고 싶어", "clientPlatform": "pc"})).json()
    handoff = turn["authHandoff"]["id"]

    bad = await api.post(f"/api/session/{sid}/choice", json={"turnId": turn["turnId"], "key": "submit"})
    assert bad.status_code == 400
    stale = await api.post(f"/api/session/{sid}/choice", json={"turnId": "turn-old", "key": "auth-done", "handoffId": handoff})
    assert stale.status_code == 409 and stale.json()["error"] == "CHOICE_EXPIRED"
    ok = await api.post(f"/api/session/{sid}/choice", json={"turnId": turn["turnId"], "key": "auth-cancel", "handoffId": handoff},
                        headers={"X-Cheongeum-Request": "1"})
    assert ok.status_code == 200 and ok.json()["authHandoff"]["status"] == "cancelled"
    replay = await api.post(f"/api/session/{sid}/choice", json={"turnId": turn["turnId"], "key": "auth-cancel", "handoffId": handoff},
                            headers={"X-Cheongeum-Request": "1"})
    assert replay.json()["turnId"] == ok.json()["turnId"], "a retried request returns its original result"
