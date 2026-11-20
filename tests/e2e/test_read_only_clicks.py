import pytest

from conftest import scripted, step

PORTAL = "127.0.0.1:5174/portal2.html"


async def ask_change(session):
    await session.handle_turn(f"{PORTAL} 열어줘")
    result = await session.handle_turn("검색 조건 변경 눌러줘")
    assert result["state"] == "WAITING_FOR_USER_CONFIRMATION"
    assert "검색 조건 변경" in result["speech"] and "누를까요" in result["speech"]
    assert await session.web.adapter.page.is_hidden("#filter-panel")
    return session.dialogue.approval["action"]["id"]


async def test_ask_tier_button_presses_after_yes(new_session):
    session = await new_session()
    action_id = await ask_change(session)
    result = await session.handle_turn("눌러")
    assert await session.web.adapter.page.is_visible("#filter-panel")
    assert [a["action"]["id"] for a in result["actions"] if a["policy"]["code"] == "APPROVED"] == [action_id]
    assert session.dialogue.approval is None


@pytest.mark.parametrize("answer", ["거절", "눌러"])
async def test_ask_tier_decline_or_target_change_never_clicks(new_session, answer):
    session = await new_session()
    await ask_change(session)
    if answer == "눌러":
        await session.web.adapter.page.locator("#filter-change").evaluate("el => el.textContent = '검색 조건 초기화'")
    result = await session.handle_turn(answer)
    if answer == "눌러":
        assert "누르지 않았어요" in result["speech"]
    assert await session.web.adapter.page.is_hidden("#filter-panel")
    assert session.dialogue.approval is None


async def test_hard_tier_still_refused(new_session):
    session = await new_session()
    await session.handle_turn("127.0.0.1:5174/external.html 열어줘")
    result = await session.handle_turn("보내기 눌러줘")
    assert "직접 눌러 주세요" in result["speech"]
    assert result["state"] != "WAITING_FOR_USER_CONFIRMATION"
    assert all(not (a.get("result") or {}).get("ok") for a in result["actions"])


@pytest.mark.parametrize("reply", ["아니, 눌러", "응 그리고 본문 읽어줘"])
async def test_offline_partial_approval_never_clicks(new_session, reply):
    session = await new_session()
    await ask_change(session)
    await session.handle_turn(reply)
    assert await session.web.adapter.page.is_hidden("#filter-panel")


async def test_ask_tier_does_not_follow_an_approval_to_another_record(new_session):
    session = await new_session()
    await ask_change(session)
    await session.web.adapter.page.evaluate("history.pushState({}, '', '?item=2#details')")
    result = await session.handle_turn("눌러")
    assert "화면 주소가 바뀌었어요" in result["speech"]
    assert await session.web.adapter.page.is_hidden("#filter-panel")
    assert session.dialogue.approval is None


async def test_unrestricted_goal_pauses_at_generic_control(new_session):
    session = await new_session()
    scripted(session, [step("open_url", PORTAL), step("click", "보조기기 체험관 둘러보기")])
    result = await session.handle_turn(f"{PORTAL}에서 보조기기 체험관 찾아줘")
    assert result["state"] == "WAITING_FOR_USER_CONFIRMATION"
    assert "보조기기 체험관 둘러보기" in result["speech"]
    assert session.web.adapter.page.url.endswith("portal2.html")


async def test_approved_ask_click_does_not_retry_after_timeout(new_session, monkeypatch):
    session = await new_session()
    action_id = await ask_change(session)
    execute = session.web.adapter.execute
    attempts = []

    async def timeout(action, signal=None):
        if action["type"] == "click":
            attempts.append(action["id"])
            return {"actionId": action["id"], "ok": False, "verified": False, "latencyMs": 0, "errorCode": "TIMEOUT"}
        return await execute(action, signal)

    monkeypatch.setattr(session.web.adapter, "execute", timeout)
    await session.handle_turn("눌러")
    assert attempts == [action_id]
    assert await session.web.adapter.page.is_hidden("#filter-panel")
