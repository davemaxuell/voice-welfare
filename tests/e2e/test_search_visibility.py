"""즉시 자료 검색과 사용자가 지켜보는 웹 검색은 브라우저 상태를 따로 다룬다."""
import asyncio
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from playwright.async_api import Browser

from conftest import FakeLlm, create_test_runtime, with_llm
from cheongeum.agents.web.browser import launch_browser


QUESTION = "우리나라 어린이날이 언제인지 알려줘."
VISIBLE = "정부24에서 어린이날 날짜를 검색하는 화면을 직접 보여줘."
GOAL = "대한민국 어린이날 날짜"
FACT = "어린이날은 5월 5일입니다."
SOURCE = {"title": "공휴일 안내", "url": "https://www.gov.kr/", "lastCheckedAt": "2026-11-20"}


def lookup(mode):
    return {"kind": "find_information", "searchMode": mode, "source": "browser",
            "agency": "정부24" if mode == "visible" else None, "subject": "어린이날",
            "goal": GOAL, "requestedFacts": ["dates"], "exclusions": [],
            "continuation": False, "question": None, "choices": [], "skill": None, "reply": None}


@pytest_asyncio.fixture
async def desktop(monkeypatch):
    # 창을 보여 주는 실제 설정을 사용하되, 테스트 중에는 같은 Chromium을 창 없이 띄운다.
    async def start_browser(headless, slow_mo_ms):
        assert headless is False
        return await launch_browser(True, slow_mo_ms)

    launches = AsyncMock(side_effect=start_browser)
    monkeypatch.setattr("cheongeum.server.runtime.launch_browser", launches)
    rt = create_test_runtime({"PRACTICE_MODE": "false", "REQUIRE_CONSENT": "true", "HEADLESS": "false"})
    try:
        session = await rt.create_session()
        try:
            await session.consent_to(True)
            launches.assert_not_awaited()
            yield session, launches
        finally:
            await session.close()
    finally:
        await rt.close()


async def test_answer_first_then_show_on_request_and_keep_the_page(desktop, monkeypatch):
    session, launches = desktop
    quiet = AsyncMock(return_value={"speech": FACT, "sources": [SOURCE]})
    session.deps.quiet_search = quiet
    session.deps.delegate_research = AsyncMock()
    model = FakeLlm({"public_service_decision": lookup("quiet"),
                     "public_browse_step": {"action": "answer", "target": None, "answer": None,
                                            "claims": [{"fact": "dates", "quote": FACT}]}})
    with_llm(session, model)
    first = await session.handle_turn(QUESTION, from_voice=True)
    assert FACT in first["speech"] and first["sources"][0]["url"] == SOURCE["url"]
    assert not first["actions"] and not first.get("pendingConfirmation")
    task, language, signal = quiet.await_args.args
    assert task.goal == GOAL and language == "ko" and not signal.aborted
    launches.assert_not_awaited()

    new_context = Browser.new_context

    async def with_portal(browser, **kwargs):
        context = await new_context(browser, **kwargs)
        await context.route("https://www.gov.kr/**", lambda route: route.fulfill(
            content_type="text/html; charset=utf-8", body=f"<title>공휴일 안내</title><main><p>{FACT}</p></main>"))
        return context

    monkeypatch.setattr(Browser, "new_context", with_portal)
    model.answers["public_service_decision"] = lookup("visible")
    shown = await session.handle_turn(VISIBLE)
    launches.assert_awaited_once()
    quiet.assert_awaited_once()
    assert shown["observation"]["url"].startswith(SOURCE["url"]) and FACT in shown["speech"]
    page = session.web.adapter.page
    await page.evaluate("window.lookupMarker = 'keep this document'")

    model.answers["public_service_decision"] = lookup("quiet")
    final = await session.handle_turn(QUESTION)
    assert FACT in final["speech"] and not final["actions"]
    assert quiet.await_count == 2
    assert session.web.adapter.page is page
    assert await page.evaluate("window.lookupMarker") == "keep this document"
    session.deps.delegate_research.assert_not_awaited()


@pytest.mark.parametrize("configured", [True, False])
async def test_quiet_search_unavailable_stays_in_conversation(desktop, configured):
    session, launches = desktop
    with_llm(session, FakeLlm({"public_service_decision": lookup("quiet")}))
    session.deps.quiet_search = AsyncMock(side_effect=TimeoutError) if configured else None
    reply = await session.handle_turn(QUESTION)
    assert reply["speech"] and not reply["sources"] and not reply["actions"]
    assert not reply.get("pendingConfirmation")
    launches.assert_not_awaited()


async def test_stop_discards_late_silent_search_answer(desktop):
    session, launches = desktop
    with_llm(session, FakeLlm({"public_service_decision": lookup("quiet")}))
    started = asyncio.Event()

    async def slow_search(task, language, signal):
        started.set()
        await signal.wait()
        return {"speech": FACT, "sources": [SOURCE]}

    session.deps.quiet_search = slow_search
    work = asyncio.create_task(session.handle_turn(QUESTION))
    try:
        await asyncio.wait_for(started.wait(), 5)
        session.cancel()
        result = await asyncio.wait_for(work, 5)
        assert result["state"] == "STOPPED" and FACT not in result["speech"] and not result["sources"]
        launches.assert_not_awaited()
    finally:
        if not work.done():
            work.cancel()
            await asyncio.gather(work, return_exceptions=True)
