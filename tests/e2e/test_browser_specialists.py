import json
from unittest.mock import AsyncMock

import pytest

from conftest import FakeLlm, scripted, step, with_llm


PORTAL = "http://127.0.0.1:5174/external.html"
GOAL = "127.0.0.1:5174/external.html에서 장애인연금 안내 기사 내용 알려줘"
ANSWER = step("answer", None, "두 번째 페이지라는 안내 기사예요.", ["두 번째 페이지입니다"])
LINK = "장애인연금 안내"


@pytest.mark.parametrize("path", ["approve", "reject", "changed", "ambiguous", "invented"])
async def test_visual_recovery_requires_consent_and_a_stable_unique_control(new_session, path):
    s = await new_session()
    missing = step("click", "장애인연금 이미지 메뉴")
    scripted(s, [step("open_url", PORTAL), missing, missing, ANSWER])
    s.deps.vision_llm = model = AsyncMock()

    async def choose(**kw):
        assert kw["schemaName"] == "visual_navigation_control"
        options = json.loads(kw["user"])["controls"]
        assert LINK in options and "보내기" not in options
        if path == "ambiguous":
            await s.web.adapter.page.get_by_text(LINK, exact=True).first.evaluate(
                "a => a.after(a.cloneNode(true))")
        return {"control": "로그인" if path == "invented" else LINK}

    model.see.side_effect = choose
    first = await s.handle_turn(GOAL)
    assert first["state"] == "WAITING_FOR_USER_CONFIRMATION"
    assert first["pendingConfirmation"]["kind"] == "visual-navigation"
    assert all(a["action"]["type"] != "capture" for a in first["actions"])
    model.see.assert_not_awaited()
    if path == "changed":
        await s.web.adapter.page.get_by_text(LINK, exact=True).first.evaluate("a => a.href = '/elsewhere'")
    result = await s.confirm(path != "reject", first["pendingConfirmation"]["actionId"])
    actions = result["actions"]
    if path == "approve":
        assert result["speech"] == ANSWER["answer"]
        assert [a["action"]["type"] for a in actions] == ["capture", "click"]
        assert actions[1]["result"]["verified"]
    else:
        assert all(a["action"]["type"] != "click" for a in actions)
    assert model.see.await_count == int(path not in ("changed", "reject"))
    assert not result.get("pendingConfirmation")


@pytest.mark.parametrize("repair", [True, False])
async def test_two_grounding_failures_escalate_once_and_reverify(new_session, repair):
    s = await new_session()
    bad = step("answer", None, "기간은 399일이에요.", ["이런 안내는 본문에 없어요"])
    scripted(s, [step("open_url", PORTAL), step("click", LINK), bad, bad, bad])
    s.deps.recovery_llm = reviewer = FakeLlm({"browse_step": ANSWER if repair else bad})
    result = await s.handle_turn(GOAL)
    assert len(reviewer.calls) == 1
    history = json.loads(reviewer.calls[0]["user"])["history"]
    assert sum("검증 실패" in h for h in history) == 2
    assert "399" not in result["speech"]
    assert (result["speech"] == ANSWER["answer"]) == repair


async def test_routine_verified_request_skips_specialists(new_session):
    s = await new_session()
    scripted(s, [step("open_url", PORTAL), step("click", LINK), ANSWER])
    s.deps.recovery_llm = reviewer = FakeLlm()
    s.deps.vision_llm = model = AsyncMock()
    result = await s.handle_turn(GOAL)
    assert result["speech"] == ANSWER["answer"] and not reviewer.calls
    model.see.assert_not_awaited()


async def test_public_visual_continuation_keeps_prior_cited_passage(new_session):
    s = await new_session()
    documents = "방문 신청자는 신분증과 신청서를 지참합니다."
    fee = "방문 신청 수수료는 400원입니다."
    link = "방문 안내"
    pages = []

    def reason(**kw):
        if kw["schemaName"] == "public_service_decision":
            return {"kind": "find_information", "source": "browser", "agency": "정부24", "subject": "주민등록등본",
                    "goal": "등본 방문 발급 서류와 수수료 확인", "requestedFacts": ["documents", "amount"],
                    "exclusions": [], "continuation": False, "question": None, "choices": []}
        if kw["schemaName"] == "public_browse_step":
            data = json.loads(kw["user"])
            pages.append(data["missingFacts"])
            if len(pages) <= 2:
                return {"action": "click", "target": "수수료 메뉴", "claims": [{"fact": "documents", "quote": documents}]}
            return {"action": "answer", "claims": [{"fact": "amount", "quote": fee}]}
        return None

    with_llm(s, FakeLlm(fn=reason))
    s.deps.vision_llm = AsyncMock()
    s.deps.vision_llm.see.return_value = {"control": link}

    async def portal(route):
        body = fee if route.request.url.endswith("/fees") else f"{documents}<a href='/fees'>{link}</a>"
        await route.fulfill(content_type="text/html; charset=utf-8", body=f"<title>정부24</title><main><p>{body}</p></main>")

    await s.web.adapter.page.route("https://www.gov.kr/**", portal)
    first = await s.handle_turn("정부24에서 등본 방문 발급 서류와 수수료를 찾아줘")
    resumed = await s.confirm(True, first["pendingConfirmation"]["actionId"])
    assert pages == [["documents", "amount"], ["amount"], ["amount"]]
    assert documents in resumed["speech"] and fee in resumed["speech"]
    assert len(resumed["sources"]) == 2
    assert [a["action"]["type"] for a in resumed["actions"]] == ["capture", "click"]


async def test_observed_passages_preserve_conditions_and_split_unrelated_footer_entries(new_session):
    session = await new_session()
    page = session.web.adapter.page
    await page.set_content("""
        <main><dl><dt>절차</dt><dd><ul><li>온라인 신청</li><li>가구원동의<br>(배우자)
        <p>해당자는 서류 제출</p></li></ul></dd></dl></main>
        <footer><address>사무실 위치</address><ul><li>전산 문의 <a href="tel:1234">1234</a></li>
        <li>제도 문의 5678</li></ul><p>이용약관</p></footer>""")
    outline = (await session.web.adapter.observe())["outline"]
    assert "온라인 신청 가구원동의 (배우자) 해당자는 서류 제출" in outline["mainText"]
    assert outline["footerText"].splitlines() == ["사무실 위치", "전산 문의 1234", "제도 문의 5678", "이용약관"]
