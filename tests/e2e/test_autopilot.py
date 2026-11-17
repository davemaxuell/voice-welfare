import json

from conftest import FakeLlm

PORTAL = "http://127.0.0.1:5174/external.html"


def scripted(s, steps: list[dict]) -> list[dict]:
    """정해진 순서로 행동을 내놓는 가짜 LLM(네트워크 없음). 받은 화면 요약도 기록한다."""
    seen: list[dict] = []
    state = {"i": 0}

    def fn(*, system, user, schemaName, schema):
        if schemaName != "browse_step":
            return None
        seen.append(json.loads(user))
        out = steps[min(state["i"], len(steps) - 1)]
        state["i"] += 1
        return out

    s.deps.llm = FakeLlm(fn=fn)
    return seen


def step(action, target=None, answer=None, evidence=None) -> dict:
    return {"thought": "", "action": action, "target": target, "answer": answer, "evidence": evidence}


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


async def test_no_llm_step_by_step(new_session):
    s = await new_session()
    r = await s.handle_turn("네이버에서 오늘 뉴스 알려줘")
    assert r["semanticAction"] == "goal"
    assert r["actions"] == []
