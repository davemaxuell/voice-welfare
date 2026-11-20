import asyncio

import pytest
from conftest import FakeLlm, Gate, scripted, step

PORTAL = "http://127.0.0.1:5174/external.html"
MOCK = "http://localhost:5174"


async def test_goal_intent_by_rules(new_session):
    s = await new_session()
    scripted(s, [step("answer", None, "테스트 답")])
    r = await s.handle_turn("네이버에서 오늘 뉴스 알려줘")
    assert r["intentType"] == "GOAL"
    assert r["semanticAction"] == "goal"


async def test_open_click_answer(new_session):
    s = await new_session()
    seen = scripted(s, [step("open_url", PORTAL), step("click", "장애인연금 안내"), step("answer", None, "두 번째 페이지라는 안내 기사예요.", ["두 번째 페이지입니다"])])
    r = await s.handle_turn("127.0.0.1:5174/external.html에서 장애인연금 안내 기사 내용 알려줘")
    assert r["speech"] == "두 번째 페이지라는 안내 기사예요."
    assert "안내 기사" in r["observation"]["title"]
    assert all(a["policy"]["code"] == "ALLOWED_READ_ONLY" for a in r["actions"])
    # LLM은 실제 화면 목록을 보고 결정한다
    assert any(x["name"] == "장애인연금 안내" for x in seen[1]["page"]["items"])
    assert len([t for t in r["trace"] if (t.get("note") or "").startswith("자율")]) >= 3


async def test_answers_a_contact_number_from_the_footer(new_session):
    s = await new_session()
    seen = scripted(s, [step("open_url", PORTAL), step("answer", None, "대표번호는 국번없이 1234예요.", ["대표번호 국번없이 1234"])])
    r = await s.handle_turn("127.0.0.1:5174/external.html에서 고객센터 전화번호 찾아줘")
    assert "대표번호 국번없이 1234" in seen[1]["page"]["footer"]
    assert r["speech"] == "대표번호는 국번없이 1234예요."


async def test_footer_numbers_do_not_back_an_answer_that_quotes_elsewhere(new_session):
    # 꼬리말의 번호·연도는 꼬리말을 근거로 든 답에서만 근거가 된다(지어낸 숫자를 꼬리말 숫자로 통과시키지 않음).
    s = await new_session()
    made_up = "올해 기초급여 기준액은 1234원으로 조정되었어요."
    scripted(s, [step("open_url", PORTAL), step("answer", None, made_up, ["올해 장애인연금 기초급여 기준액이 조정되었습니다"])])
    r = await s.handle_turn("127.0.0.1:5174/external.html에서 기초급여 기준액 알려줘")
    assert r["speech"] != made_up
    assert "확실한 답을 확인하지 못했어요" in r["speech"]


async def test_uses_search_box(new_session):
    s = await new_session()
    scripted(s, [step("open_url", PORTAL), step("search", "기초연금"), step("answer", None, "첫 결과는 기초연금 신청 방법이에요.", ["기초연금 신청 방법"])])
    r = await s.handle_turn("127.0.0.1:5174/external.html에서 기초연금 찾아서 알려줘")
    assert "'기초연금' 검색 결과" in r["observation"]["title"]
    assert "기초연금 신청 방법" in r["speech"]


async def test_policy_guard_blocks_action_button(new_session):
    s = await new_session()
    scripted(s, [step("open_url", PORTAL), step("click", "보내기"), step("fail", None, "그 버튼은 누를 수 없어요.")])
    r = await s.handle_turn("127.0.0.1:5174/external.html에서 의견 보내는 곳 찾아줘")
    assert [a for a in r["actions"] if (a["action"].get("target") or {}).get("name") == "보내기" and (a.get("result") or {}).get("ok")] == []
    assert "의견이 전송됨" not in (r.get("observation") or {}).get("title", "")
    assert any("안전 규칙으로 막힘" in (t.get("note") or "") for t in r["trace"])


async def test_stops_when_looping(new_session):
    s = await new_session()
    scripted(s, [step("open_url", PORTAL), step("read_more"), step("read_more"), step("read_more"), step("read_more")])
    r = await s.handle_turn("127.0.0.1:5174/external.html에서 끝까지 읽어서 알려줘")
    assert "맴돌고 있어서 멈췄어요" in r["speech"]


async def test_rejects_answer_without_visit(new_session):
    s = await new_session()
    scripted(
        s,
        [step("answer", None, "메뉴가 없어요."), step("open_url", PORTAL), step("answer", None, "포털에는 뉴스·복지·날씨 메뉴가 있어요.", ["뉴스", "복지 소식"])],
    )
    r = await s.handle_turn("127.0.0.1:5174/external.html에서 메뉴 뭐 있는지 알려줘")
    assert r["speech"] == "포털에는 뉴스·복지·날씨 메뉴가 있어요."
    assert any("사이트를 열어 보지 않고 답함" in (t.get("note") or "") for t in r["trace"])


@pytest.mark.parametrize(("name", "question"), [
    ("기초연금", "기초연금 신청 방법 찾아줘"),
    ("장애인연금", "장애인연금을 어떻게 신청하는지 알려줘"),
])
async def test_bokjiro_goal_reads_the_named_programs_catalog_page(new_session, name, question):
    s = await new_session()
    catalog = await s.deps.welfare.provider.catalog()
    url = next(row["detailUrl"] for row in catalog if row["servNm"] == name)
    quote = "가까운 읍면동 주민센터에 방문하여 신청합니다."
    await s.web.adapter.page.route(url, lambda route: route.fulfill(
        content_type="text/html; charset=utf-8", body=f"<title>{name} 상세</title><main>{quote}</main>"
    ))
    seen = scripted(s, [step("answer", None, quote, [quote])])
    r = await s.handle_turn(f"복지로에서 {question}")
    assert seen[0]["page"]["url"] == url
    # 근거가 있던 화면을 출처로 남기고, 이름 있는 사이트면 짧게 말한다
    assert r["speech"] == f"{quote} 복지로 화면에서 확인했어요."
    assert r["sources"][0]["url"] == url
    assert any("근거 확인" in (t.get("note") or "") for t in r["trace"])


async def test_named_site_goal_cannot_use_another_sites_evidence(new_session):
    s = await new_session()
    quote = "상담은 보건복지상담센터에서 받을 수 있습니다"
    scripted(s, [step("open_url", PORTAL), step("answer", None, quote, [quote])])
    r = await s.handle_turn("복지로에서 상담 어디서 받는지 알려줘")
    assert r["speech"] != quote
    assert not any("근거 확인" in (t.get("note") or "") for t in r["trace"])


async def test_visiting_the_requested_site_does_not_validate_off_site_quotes(new_session):
    s = await new_session()
    quote = "상담은 보건복지상담센터에서 받을 수 있습니다"
    scripted(s, [step("open_url", MOCK), step("open_url", PORTAL), step("answer", None, quote, [quote])])
    r = await s.handle_turn(f"{MOCK}에서 상담 어디서 받는지 알려줘")
    assert r["intentType"] == "GOAL"
    assert any("근거 부족" in (t.get("note") or "") for t in r["trace"])
    assert r["speech"] != quote


async def test_rewrites_non_korean_answer(new_session):
    s = await new_session()
    scripted(
        s,
        [
            step("open_url", PORTAL),
            step("answer", None, "国民年金服务热线是保健福利咨询中心"),
            step("answer", None, "상담은 보건복지상담센터에서 받을 수 있어요.", ["상담은 보건복지상담센터에서 받을 수 있습니다"]),
        ],
    )
    r = await s.handle_turn("127.0.0.1:5174/external.html에서 상담 어디서 받는지 찾아줘")
    assert r["speech"] == "상담은 보건복지상담센터에서 받을 수 있어요."


async def test_few_hanja_allowed(new_session):
    s = await new_session()
    scripted(s, [step("open_url", PORTAL), step("answer", None, "복지 소식 기사가 있어요. 與 관련 소식은 없어요.", ["복지 소식"])])
    r = await s.handle_turn("127.0.0.1:5174/external.html에서 무슨 글 있는지 알려줘")
    assert r["speech"] == "복지 소식 기사가 있어요. 與 관련 소식은 없어요."


async def test_verifier_rejects_invented_evidence_and_numbers(new_session):
    s = await new_session()
    scripted(
        s,
        [
            step("open_url", PORTAL),
            # 화면에 없는 전화번호를 지어냄(근거 문장도 화면에 없음)
            step("answer", None, "상담 전화는 1355번이에요.", ["상담 전화 1355"]),
            # 근거는 맞지만 숫자는 화면에 없음
            step("answer", None, "보건복지상담센터 129에서 상담받을 수 있어요.", ["상담은 보건복지상담센터에서 받을 수 있습니다"]),
            step("answer", None, "상담은 보건복지상담센터에서 받을 수 있어요.", ["상담은 보건복지상담센터에서 받을 수 있습니다"]),
        ],
    )
    r = await s.handle_turn("127.0.0.1:5174/external.html에서 상담 전화번호 찾아줘")
    assert r["speech"] == "상담은 보건복지상담센터에서 받을 수 있어요."
    notes = [t.get("note") or "" for t in r["trace"] if t["agent"] == "answer-verifier"]
    assert len([n for n in notes if n.startswith("근거 부족")]) == 2
    assert any("근거에 없는 숫자: 129" in n for n in notes)


async def test_verifier_gives_up_honestly(new_session):
    s = await new_session()
    scripted(s, [step("open_url", PORTAL), step("answer", None, "고객센터는 1588-0000이에요.", None)])
    r = await s.handle_turn("127.0.0.1:5174/external.html에서 고객센터 번호 찾아줘")
    assert "추측해서 말씀드리지 않을게요" in r["speech"]
    assert "1588" not in r["speech"]


async def test_llm_gets_digested_page(new_session):
    s = await new_session()
    seen = scripted(s, [step("open_url", PORTAL), step("answer", None, "복지 소식 기사가 있어요.", ["복지 소식"])])
    await s.handle_turn("127.0.0.1:5174/external.html에서 무슨 글 있는지 알려줘")
    page = seen[1]["page"]
    menu = [x["name"] for x in page["items"] if x["kind"] == "menu"]
    assert {"뉴스", "복지", "날씨"} <= set(menu)
    assert next(x for x in page["items"] if x["kind"] == "link")["name"] == "장애인연금 안내"
    # 같은 이름 링크('자세히 보기' 3개)는 한 번만
    assert len([x for x in page["items"] if x["name"] == "자세히 보기"]) == 1
    assert "복지 소식" in page["mainText"]


def goal_mode(s, steps: list[dict]) -> None:
    """자유 대화가 목표 수행(web_task)으로 가고, 목표 수행은 정해진 행동을 내놓는 가짜 LLM."""
    state = {"i": 0}

    def fn(*, system, user, schemaName, schema):
        if schemaName == "chat_route":
            return {"route": "web_task", "reply": "", "searchQuery": None, "language": None}
        if schemaName != "browse_step":
            return None
        out = steps[min(state["i"], len(steps) - 1)]
        state["i"] += 1
        return out

    s.deps.llm = FakeLlm(fn=fn)


async def fill_to_review_step(s) -> None:
    for said in ["장애인연금 신청 도와줘", "이름은 김하늘", "주소는 부산광역시 예시구 예시로 10", "다음", "다음"]:
        await s.handle_turn(said)
    assert s.web.current_view["step"]["index"] == 3


async def test_goal_mode_asks_aloud_before_mock_submit(new_session):
    s = await new_session()
    await fill_to_review_step(s)
    goal_mode(s, [step("click", "모의접수"), step("fail", None, "더 할 일이 없어요.")])
    r = await s.handle_turn("남은 거 알아서 마무리해 줘")
    assert r["state"] == "WAITING_FOR_USER_CONFIRMATION"
    assert "남은 거 알아서 마무리해 줘" in r["speech"] and "김하늘" in r["speech"]
    assert "MOCK-" not in (r["observation"].get("status") or "")
    assert not [a for a in r["actions"] if (a["action"].get("target") or {}).get("name") == "모의접수" and (a.get("result") or {}).get("ok")]
    done = await s.handle_turn("눌러")
    assert done["state"] == "MOCK_SUBMITTED"
    assert "MOCK-" in done["observation"]["status"]


async def test_goal_mode_hands_off_login_before_model_can_attempt_click(new_session):
    s = await new_session()
    goal_mode(s, [step("open_url", f"{MOCK}/login.html"), step("click", "모의 로그인")])
    result = await s.handle_turn("남은 거 알아서 마무리해 줘")
    assert result["state"] == "AUTH_HANDOFF"
    assert result["authHandoff"]["kind"] == "login"
    assert not result.get("pendingConfirmation")
    assert len([call for call in s.deps.llm.calls if call["schemaName"] == "browse_step"]) == 1
    attempted = await s.handle_turn("눌러")
    assert attempted["state"] == "AUTH_HANDOFF" and not attempted["actions"]


async def test_cancelling_goal_login_handoff_leaves_the_page_alone(new_session):
    s = await new_session()
    goal_mode(s, [step("open_url", f"{MOCK}/login.html"), step("click", "모의 로그인")])
    await s.handle_turn("남은 거 알아서 마무리해 줘")
    result = await s.handle_turn("인증 취소")
    assert result["authHandoff"]["status"] == "cancelled"
    assert result["observation"]["url"].endswith("/login.html")
    assert result["actions"] == [] and s.dialogue.approval is None


# ---------------------------------------------------------------- 진행 상황("지금 어디까지 했어?")

ARTICLE_GOAL = "127.0.0.1:5174/external.html에서 장애인연금 안내 기사 내용 알려줘"
CLICKED = "127.0.0.1에서 '장애인연금 안내'를 눌렀어요."


def article_gate() -> Gate:
    """포털 열기 → 링크 누르기 뒤 세 번째 결정 앞에서 선다"""
    return Gate(
        [step("open_url", PORTAL), step("click", "장애인연금 안내"), step("answer", None, "두 번째 페이지라는 안내 기사예요.", ["두 번째 페이지입니다"])],
        at=3,
    )


async def test_progress_question_mid_goal_names_the_current_step(new_session):
    s = await new_session()
    idle = await s.handle_turn("지금 어디까지 했어?")
    assert idle["intentType"] == "PROGRESS"
    assert idle["speech"] == "지금 하고 있는 일은 없어요."
    gate = article_gate()
    s.deps.llm = gate
    goal = asyncio.create_task(s.handle_turn(ARTICLE_GOAL))
    await asyncio.wait_for(gate.reached.wait(), 30)
    # 목표 수행이 턴 대기열을 잡고 있어도 기다리지 않고 바로 답한다
    r = await asyncio.wait_for(s.handle_turn("청음아, 지금 어디까지 했어?"), 5)
    assert r["speech"] == f"지금까지 2단계 했어요. 방금 {CLICKED}"
    assert r["actions"] == []
    gate.release.set()
    assert (await goal)["speech"] == "두 번째 페이지라는 안내 기사예요."
    after = await s.handle_turn("어디까지 됐어?")
    assert after["speech"] == f"지금 하고 있는 일은 없어요. 마지막으로 {CLICKED}"


@pytest.mark.parametrize("question", ["어디까지 했어? 뒤로 가줘", "얼마나 남았어 그리고 뒤로 가줘", "어디까지 했어 뒤로 가줘"])
async def test_status_then_back_answers_and_navigates(new_session, question):
    s = await new_session()
    opened = await s.handle_turn(f"{PORTAL} 열어줘")
    first_url = opened["observation"]["url"]
    followed = await s.handle_turn("장애인연금 안내 링크 눌러줘")
    assert followed["observation"]["url"] != first_url
    reply = await s.handle_turn(question)
    assert s.web.adapter.page.url == first_url
    assert "지금 하고 있는 일은 없어요" in reply["speech"]
    assert reply["semanticAction"] == "back"
    assert reply["userUtterance"] == question


async def test_stop_still_interrupts_a_goal(new_session):
    s = await new_session()
    gate = article_gate()
    s.deps.llm = gate
    goal = asyncio.create_task(s.handle_turn(ARTICLE_GOAL))
    await asyncio.wait_for(gate.reached.wait(), 30)
    await asyncio.wait_for(s.handle_turn("지금 어디까지 했어?"), 5)
    stopped = await asyncio.wait_for(s.handle_turn("멈춰"), 5)
    assert stopped["state"] == "STOPPED"
    gate.release.set()
    assert (await goal)["state"] == "STOPPED"
    # 멈춘 뒤에도 묻는 말에는 답한다(아무것도 실행하지 않으므로)
    r = await s.handle_turn("지금 어디까지 했어?")
    assert r["state"] == "STOPPED"
    assert r["speech"] == f"지금 하고 있는 일은 없어요. 마지막으로 {CLICKED}"


async def test_no_llm_step_by_step(new_session):
    s = await new_session()
    r = await s.handle_turn("네이버에서 오늘 뉴스 알려줘")
    assert r["semanticAction"] == "goal"
    assert r["actions"] == []
