import asyncio
from urllib.parse import parse_qs, urlsplit

import pytest
from conftest import FakeLlm, PORTAL


@pytest.mark.parametrize(("utterance", "section"), [
    ("2번 눌러줘", "welfare"),
    ("1번 말고 2번 눌러줘", "welfare"),
    ("1번은 누르지 말고 2번을 눌러줘", "welfare"),
    ("첫 링크 눌러줘", "news"),
    ("1번이 뭐였지?", None),
    ("1번?", None),
    ("1번 눌러줄래?", "news"),
    ("1번은 누르지 마", None),
    ("1번이나 2번 눌러줘", None),
])
async def test_listed_links_respect_the_whole_request(new_session, utterance, section):
    s = await new_session()
    await s.handle_turn(f"{PORTAL} 열어줘")
    await s.handle_turn("링크 목록 알려줘")
    before = s.web.adapter.page.url
    s.deps.llm = FakeLlm()
    result = await s.handle_turn(utterance)
    if section:
        assert parse_qs(urlsplit(s.web.adapter.page.url).query) == {"section": [section]}
    else:
        assert s.web.adapter.page.url == before
        assert result["actions"] == []
        if "뭐였지" in utterance:
            assert "뉴스" in result["speech"]


@pytest.mark.parametrize("reply", [
    "네", "그거 눌러줘", "네, 그거 열어줘", "첫 번째 검색 결과 열어줘",
    "네, 화면에 있는 첫 번째 링크가 맞아요",
    ",네화면에있는첫번째링크가맞아요.",
    "예. 첫 검색 결과가 맞습니다.",
    "첫 번째가 맞아요",
    "네, 그 링크 맞아. 화면에 있는 첫 링크가 맞아. 그거 열어줘.",
])
async def test_search_proposes_a_result_and_remembers_it_without_listing(new_session, reply):
    s = await new_session()
    search = await s.handle_turn("하이코리아 홈페이지 열어줘")
    first = "하이코리아 홈페이지 신청 방법"
    assert first in search["speech"]
    await s.handle_turn(reply, from_voice=True)
    url = urlsplit(s.web.adapter.page.url)
    assert url.path == "/external2.html"
    assert parse_qs(url.query) == {"q": [first]}


@pytest.mark.parametrize("reply", [
    "네, 화면에 있는 첫 번째 링크가 맞아요?",
    "네, 화면에 있는 첫 번째 링크가 맞아요?!.",
    "네, 화면에 있는 첫 번째 링크가 맞나요",
    "네, 화면에 있는 첫 번째 링크가 맞나요? 그거 열어줘.",
    "네, 두 번째 링크가 맞아요",
    "네, 첫 번째나 두 번째 링크가 맞아요",
    "아니요, 첫 번째 링크가 맞지 않아요",
    "아니요, 첫 번째 링크가 맞지 않아요. 그거 열어줘.",
    "네, 첫 번째 링크가 맞아요. 열지 마세요.",
    "네, 첫 번째 링크가 맞아요. 날씨 링크도 열어줘.",
    "첫 번째가 맞아요. 지원금도 열어줘.",
    "첫 번째 링크가 맞아요라고 말한 적이 있어요.",
])
async def test_search_confirmation_requires_one_matching_affirmative(new_session, reply):
    s = await new_session()
    await s.handle_turn("하이코리아 홈페이지 열어줘")
    before = s.web.adapter.page.url
    s.deps.llm = FakeLlm({"link_choice": {"index": 1}})
    answer = await s.handle_turn(reply, from_voice=True)
    assert s.web.adapter.page.url == before
    assert answer["actions"] == []


@pytest.mark.parametrize("between", ["링크 목록 알려줘", "청음 소개해줘"])
async def test_ordinal_confirmation_requires_a_live_proposal(new_session, between):
    s = await new_session()
    await s.handle_turn("하이코리아 홈페이지 열어줘")
    await s.handle_turn(between)
    before = s.web.adapter.page.url
    answer = await s.handle_turn("네, 첫 번째 결과가 맞아요", from_voice=True)
    assert s.web.adapter.page.url == before
    assert answer["actions"] == []


@pytest.mark.parametrize("ordinal", ["첫 번째", "두 번째"])
async def test_ordinal_confirmation_cannot_accept_a_replaced_proposal(new_session, ordinal):
    s = await new_session()
    await s.handle_turn("하이코리아 홈페이지 열어줘")
    first_offer = s.link_offer_id
    second = await s.handle_turn("2번?")
    assert "하이코리아 홈페이지 지원 대상" in second["speech"]
    before = s.web.adapter.page.url
    answer = await s.handle_turn(f"네, {ordinal} 링크가 맞아요", from_voice=True, link_offer_id=first_offer)
    assert s.web.adapter.page.url == before
    assert answer["actions"] == []
    assert "선택지가 바뀌었어요" in answer["speech"]


async def test_ordinal_confirmation_cannot_click_a_changed_target(new_session):
    s = await new_session()
    first = "하이코리아 홈페이지 신청 방법"
    await s.handle_turn("하이코리아 홈페이지 열어줘")
    page = s.web.adapter.page
    before = page.url
    await page.get_by_role("link", name=first).evaluate("(el) => el.href = '/external2.html?n=changed'")
    answer = await s.handle_turn("네, 화면에 있는 첫 번째 링크가 맞아요", from_voice=True)
    assert page.url == before
    assert answer["actions"] == []
    assert "바뀌" in answer["speech"]


async def test_changed_link_destination_requires_a_new_choice(new_session):
    s = await new_session()
    await s.handle_turn(f"{PORTAL} 열어줘")
    await s.handle_turn("링크 목록 알려줘")
    page = s.web.adapter.page
    before = page.url
    await page.get_by_role("link", name="뉴스").evaluate("(el) => el.href = '/external2.html?n=changed'")
    answer = await s.handle_turn("1번 눌러줘")
    assert page.url == before
    assert answer["actions"] == []
    assert "바뀌" in answer["speech"]


async def test_foreign_affirmative_uses_the_pending_link_before_public_planning(new_session):
    s = await new_session()
    await s.handle_turn("하이코리아 홈페이지 열어줘")
    s.deps.llm = FakeLlm()
    s._lang = "en"
    await s.handle_turn("yes", from_voice=True)
    assert "/external2.html?" in s.web.adapter.page.url
    assert not any(c["schemaName"] == "translate_in" for c in s.deps.llm.calls)


async def test_information_request_rejects_a_model_generated_click(new_session):
    from conftest import flat
    s = await new_session()
    await s.handle_turn(f"{PORTAL} 열어줘")
    await s.handle_turn("링크 목록 알려줘")
    before = s.web.adapter.page.url
    s.deps.llm = FakeLlm({
        "intent_plan": {"steps": [flat("FOLLOW_LINK", topic="뉴스")]},
        "chat_route": {"route": "web_task", "reply": ""},
    })
    result = await s.handle_turn("첫 항목은 누가 운영하나요?")
    assert s.web.adapter.page.url == before and result["actions"] == []


async def test_result_selection_never_uses_header_links(new_session):
    s = await new_session()
    page = s.web.adapter.page
    await page.route("**/external.html?q=*", lambda route: route.fulfill(
        content_type="text/html; charset=utf-8",
        body='<nav><a href="/external2.html">처음 화면</a></nav><main><h1>검색 결과가 없습니다</h1></main>',
    ))
    await s.handle_turn("하이코리아 홈페이지 열어줘")
    before = page.url
    answer = await s.handle_turn("화면에 있는 첫 링크 눌러줘")
    assert page.url == before and answer["actions"] == []


async def test_search_result_numbers_are_consistent_after_reading_the_list(new_session):
    s = await new_session()
    await s.handle_turn("하이코리아 홈페이지 열어줘")
    listed = await s.handle_turn("링크 목록 알려줘")
    assert "1번 하이코리아 홈페이지 신청 방법" in listed["speech"]
    await s.handle_turn("2번")
    assert parse_qs(urlsplit(s.web.adapter.page.url).query) == {"q": ["하이코리아 홈페이지 지원 대상"]}


async def test_reply_already_queued_cannot_accept_a_new_search_proposal(new_session):
    s = await new_session()
    async with s._lock:
        opening = asyncio.create_task(s.handle_turn("하이코리아 홈페이지 열어줘"))
        reply = asyncio.create_task(s.handle_turn("네"))
        await asyncio.sleep(0)
    opened, answer = await asyncio.gather(opening, reply)
    assert s.web.adapter.page.url == opened["observation"]["url"]
    assert answer["actions"] == []


async def test_questioning_or_leaving_a_proposal_cannot_open_it(new_session):
    s = await new_session()
    await s.handle_turn("하이코리아 홈페이지 열어줘")
    before = s.web.adapter.page.url
    repeat = await s.handle_turn("네?")
    assert s.web.adapter.page.url == before and repeat["actions"] == []
    await s.handle_turn("청음 소개해줘")
    pointer = await s.handle_turn("그거 열어줘")
    assert s.web.adapter.page.url == before and pointer["actions"] == []


@pytest.mark.parametrize(("index", "section"), [(3, "weather"), (900, None), (None, None)])
async def test_flexible_reference_uses_only_an_observed_candidate(new_session, index, section):
    s = await new_session()
    await s.handle_turn(f"{PORTAL} 열어줘")
    await s.handle_turn("링크 목록 알려줘")
    before = s.web.adapter.page.url
    llm = FakeLlm({"link_choice": {"index": index}})
    s.deps.llm = llm
    reply = await s.handle_turn("그 링크들 중에 일기 예보를 볼 수 있는 걸 열어줘")
    calls = [call for call in llm.calls if call["schemaName"] == "link_choice"]
    assert len(calls) == 1 and "날씨" in calls[0]["user"]
    assert "사용자의 주소" not in calls[0]["user"]
    if section:
        assert parse_qs(urlsplit(s.web.adapter.page.url).query) == {"section": [section]}
    else:
        assert s.web.adapter.page.url == before and reply["actions"] == []


async def test_voice_opens_the_named_search_heading_without_reading_the_page(new_session):
    session = await new_session()
    page = session.web.adapter.page
    await page.route("**/external.html?q=*", lambda route: route.fulfill(
        content_type="text/html; charset=utf-8",
        body='''<title>검색 결과</title><header><a href="/">전체</a></header>
                <main id="search"><div id="rso">
                <a href="/external2.html?section=immigration"><h3>하이코리아 홈페이지</h3></a>
                <a href="/external2.html?section=help"><h3>출입국 이용 안내</h3></a>
                </div></main>''',
    ))
    offered = await session.handle_turn("하이코리아 홈페이지 열어줘", from_voice=True)
    assert "하이코리아 홈페이지" in offered["speech"]
    assert urlsplit(page.url).path == "/external.html"
    opened = await session.handle_turn("네, 그 링크 맞아. 화면에 있는 첫 링크가 맞아. 그거 열어줘.", from_voice=True)
    assert opened["intentType"] == "FOLLOW_LINK"
    assert parse_qs(urlsplit(page.url).query) == {"section": ["immigration"]}
