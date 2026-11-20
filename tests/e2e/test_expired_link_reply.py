from urllib.parse import parse_qs, urlsplit

import pytest

from conftest import FakeLlm, PORTAL, flat


@pytest.mark.parametrize(("words", "model_answers", "renew"), [
    ("첫 번째 링크 열어줘", {}, False),
    ("Open the first link on this page.", {"translate_in": {"text": "첫 번째 링크 열어줘"}}, False),
    ("Open the first link on this page.", {"translate_in": {"text": "첫 번째 링크 열어줘"}}, True),
    ("뉴스 눌러줘", {}, False),
    ("뉴스로 들어가 볼래", {"intent_plan": {"steps": [flat("FOLLOW_LINK", topic="뉴스")]}}, False),
])
async def test_delayed_reply_cannot_open_a_link_after_the_offer_changed(new_session, words, model_answers, renew):
    session = await new_session()
    await session.handle_turn(f"{PORTAL} 열어줘")
    await session.handle_turn("링크 목록 알려줘")
    original_offer = session.link_offer_id
    assert original_offer
    await session.handle_turn(f"{PORTAL} 열어줘")
    if renew:
        await session.handle_turn("링크 목록 알려줘")
    assert session.link_offer_id != original_offer
    if model_answers:
        session.deps.llm = FakeLlm(model_answers)
    url = session.web.adapter.page.url
    answer = await session.handle_turn(words, from_voice=True, link_offer_id=original_offer)
    assert session.web.adapter.page.url == url
    assert not answer["actions"]
    assert "링크 선택지가 바뀌" in answer["speech"]
    if model_answers:
        assert model_answers.keys() <= {call["schemaName"] for call in session.deps.llm.calls}


async def test_delayed_independent_request_still_opens_its_named_destination(new_session):
    session = await new_session()
    await session.handle_turn(f"{PORTAL} 열어줘")
    await session.handle_turn("링크 목록 알려줘")
    original_offer = session.link_offer_id
    await session.handle_turn(f"{PORTAL} 열어줘")
    assert original_offer and session.link_offer_id != original_offer
    await session.handle_turn("하이코리아 홈페이지 열어줘", from_voice=True, link_offer_id=original_offer)
    assert parse_qs(urlsplit(session.web.adapter.page.url).query) == {"q": ["하이코리아 홈페이지"]}


async def test_delayed_confirmation_does_not_reoffer_an_expired_list(new_session):
    session = await new_session()
    await session.handle_turn(f"{PORTAL} 열어줘")
    await session.handle_turn("링크 목록 알려줘")
    original_offer = session.link_offer_id
    await session.handle_turn("청음 소개해줘")
    assert original_offer and not session.link_offer_id
    assert session.browse.link_choices and session.browse.link_choices.options
    before = session.web.adapter.page.url
    answer = await session.handle_turn("네", from_voice=True, link_offer_id=original_offer)
    assert not answer["actions"] and session.web.adapter.page.url == before
    assert not session.link_offer_id
