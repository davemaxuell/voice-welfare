import asyncio

import pytest
from conftest import FakeLlm


SAVE = "내 이름은 박하늘이라고 저장해줘"
DELETE = "내 정보 지워줘"


@pytest.mark.parametrize("reply", ["네, 지우지 마세요", "네이버 열어줘", "저장해"])
async def test_delete_needs_assent_to_this_operation(new_session, reply):
    session = await new_session()
    await session.web.adapter.page.route("https://**/*", lambda route: route.fulfill(
        content_type="text/html", body="<title>Test</title><main>Test</main>"))
    await session.handle_turn(SAVE)
    await session.handle_turn("응")
    await session.handle_turn(DELETE)
    result = await session.handle_turn(reply)
    assert session._personal.vault() == {"name": "박하늘"}
    if reply == "네이버 열어줘":
        assert result["semanticAction"] == "open-site"


async def test_queued_yes_cannot_answer_a_vault_question_created_while_waiting(new_session):
    session = await new_session()
    async with session._lock:
        question = asyncio.create_task(session.handle_turn(SAVE))
        early_reply = asyncio.create_task(session.handle_turn("응"))
        await asyncio.sleep(0)
    await question
    await early_reply
    assert session._personal.vault() == {}
    await session.handle_turn("응")
    assert session._personal.vault() == {"name": "박하늘"}


async def test_original_language_controls_vault_consent(new_session):
    session = await new_session()
    translator = FakeLlm(answers={"translate_in": {"text": "좋아"}})
    session.deps.llm = translator
    await session.handle_turn(SAVE)
    await session.set_language("en")
    await session.handle_turn("I have another question")
    assert session._personal.vault() == {}

    await session.handle_turn(SAVE)
    await session.set_language("en")
    await session.handle_turn("yes")
    assert session._personal.vault() == {"name": "박하늘"}


async def test_foreign_correction_can_change_tasks_during_vault_confirmation(new_session):
    session = await new_session()
    await session.web.adapter.page.route("https://**/*", lambda route: route.fulfill(
        content_type="text/html", body="<title>Gov24</title><main>Gov24</main>"))
    session.deps.llm = FakeLlm(answers={"translate_in": {"text": "정부24 열어줘"}})
    await session.handle_turn(SAVE)
    await session.set_language("en")
    result = await session.handle_turn("No, open Gov24 instead")
    assert result["semanticAction"] == "open-site"
    assert session._personal.vault() == {}
