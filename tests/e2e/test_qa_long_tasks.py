"""2026-11-19 07:00 QA 보고서의 긴 목표 실패: 질문 나누기가 사이트를 잃음(L1.1·L2.1·L6.2), 본문 끝까지 못 읽음(S1.3)."""
import json

from conftest import flat, FakeLlm, step, with_llm

PORTAL2 = "127.0.0.1:5174/portal2.html"


def goal_llm(steps: list[dict]):
    """사이트의 여러 질문은 조건을 유지한 목표 하나로 계획한다."""
    seen: list[dict] = []
    state = {"i": 0}

    def fn(*, system, user, schemaName, schema):
        if schemaName == "intent_plan":
            text = json.loads(user)["utterance"]
            if PORTAL2 in text or "external.html" in text:
                return {"steps": [flat("GOAL", topic=text)]}
            return None
        if schemaName == "browse_step":
            seen.append(json.loads(user))
            out = steps[min(state["i"], len(steps) - 1)]
            state["i"] += 1
            return out
        return None

    return FakeLlm(fn=fn), seen


async def test_site_goal_with_several_questions_stays_one_goal(new_session):
    s = await new_session()
    llm, seen = goal_llm(
        [
            step("open_url", PORTAL2),
            step("answer", None, "주소지 행정복지센터 3층 복지과 창구를 방문하면 돼요.", ["신청 방법은 주소지 행정복지센터 3층 복지과 창구를 방문하는 것입니다."]),
        ],
    )
    with_llm(s, llm)
    text = f"{PORTAL2}에서 보조기기 지원 신청 방법 찾아줘. 인터넷이 어려우니 어디로 직접 가면 되는지, 언제 신청할 수 있는지 알려줘."
    r = await s.handle_turn(text)
    assert r["intentType"] == "GOAL"
    assert "언제 신청할 수 있는지" in seen[0]["goal"]
    assert [json.loads(c["user"])["utterance"] for c in llm.calls if c["schemaName"] == "intent_plan"] == [text]


async def test_reads_to_the_end_of_a_long_page(new_session):
    s = await new_session()
    final = "이의 신청은 결정 통지를 받은 날부터 90일 안에 할 수 있습니다."
    llm, seen = goal_llm(
        [
            step("open_url", PORTAL2),
            step("read_more"),
            step("read_more"),
            step("read_more"),
            step("answer", None, "결정 통지를 받은 날부터 90일 안에 이의 신청을 할 수 있어요.", [final]),
        ],
    )
    with_llm(s, llm)
    r = await s.handle_turn(f"{PORTAL2}에서 긴 안내문 끝에 있는 이의 신청 기한 알려줘.")
    assert "맴돌고" not in r["speech"]
    assert "90일" in r["speech"]


async def test_read_more_past_the_end_is_a_failed_step(new_session):
    s = await new_session()
    llm, seen = goal_llm([step("open_url", PORTAL2), *[step("read_more")] * 9])
    with_llm(s, llm)
    r = await s.handle_turn(f"{PORTAL2}에서 긴 안내문 끝에 있는 이의 신청 기한 알려줘.")
    notes = [t.get("note") or "" for t in r["trace"]]
    assert any("본문 끝" in n for n in notes)
    # 끝에서는 위치가 그대로라 같은 행동의 반복으로 멈춘다(헛돌지 않는다)
    assert "맴돌고" in r["speech"]


async def test_slow_repeat_spells_the_number_and_keeps_settings(new_session):
    s = await new_session()
    llm, _seen = goal_llm([step("open_url", "127.0.0.1:5174/external.html"), step("answer", None, "대표번호는 국번없이 1234예요.", ["대표번호 국번없이 1234"])])
    rewrites: list[str] = []
    inner = llm.fn

    def fn(*, system, user, schemaName, schema):
        if schemaName == "simple":
            rewrites.append(user)
            return {"text": "쉽게 바꾼 말이에요."}
        return inner(system=system, user=user, schemaName=schemaName, schema=schema)

    llm.fn = fn
    with_llm(s, llm)
    await s.handle_turn("127.0.0.1:5174/external.html에서 고객센터 전화번호 찾아줘")
    before = s.snapshot().get("speechPrefs")
    r = await s.handle_turn("그 번호를 다시 천천히 말해줘")
    assert r["intentType"] == "REPHRASE"
    assert "1 2 3 4" in r["speech"]
    assert not rewrites
    assert s.snapshot().get("speechPrefs") == before


async def test_open_official_opens_the_selected_service_page(new_session, monkeypatch):
    s = await new_session()
    welfare = type(s.deps.welfare)
    monkeypatch.setattr(welfare, "current_service_name", property(lambda self: "보조기기 지원"))
    monkeypatch.setattr(welfare, "current_service_url", property(lambda self: "http://127.0.0.1:5174/portal2.html"))
    r = await s.handle_turn("공식 안내 열어줘")
    assert r["intentType"] == "OPEN_OFFICIAL"
    assert r["observation"]["url"].endswith("/portal2.html")
    assert r["speech"].startswith("보조기기 지원 공식 안내를 열었어요.")
    assert all(a["policy"]["code"] == "ALLOWED_READ_ONLY" for a in r["actions"])


async def test_open_official_without_a_service_asks(new_session):
    s = await new_session()
    r = await s.handle_turn("공식 안내 열어줘")
    assert r["state"] == "NEEDS_CLARIFICATION" or "어떤 제도" in r["speech"]
    assert not r["actions"]


async def test_real_site_login_without_a_site_asks_instead_of_practice_login(new_session, monkeypatch):
    s = await new_session()
    monkeypatch.setattr(s.deps, "practice_mode", False)
    r = await s.handle_turn("로그인해줘")
    assert r["state"] != "AUTH_HANDOFF"
    assert not any((a.get("action") or {}).get("type") == "navigate" for a in r["actions"])
    assert "어느 사이트" in r["speech"]
    r = await s.handle_turn("모의 로그인 연습할래")
    assert r["state"] == "AUTH_HANDOFF"


async def test_verified_web_answer_carries_its_page_as_source(new_session):
    s = await new_session()
    llm, _seen = goal_llm([step("open_url", "127.0.0.1:5174/external.html"), step("answer", None, "대표번호는 국번없이 1234예요.", ["대표번호 국번없이 1234"])])
    with_llm(s, llm)
    r = await s.handle_turn("127.0.0.1:5174/external.html에서 고객센터 전화번호 찾아줘")
    assert r["sources"] and r["sources"][0]["url"].startswith("http://127.0.0.1:5174/external.html")
    # 이름 없는 주소(IP)는 읽지 않는다: 출처는 화면 카드와 '어디서 확인했어?'에 남는다
    assert r["speech"] == "대표번호는 국번없이 1234예요."


async def test_open_official_for_another_named_service_does_not_open_the_current_one(new_session, monkeypatch):
    s = await new_session()
    welfare = type(s.deps.welfare)
    monkeypatch.setattr(welfare, "current_service_name", property(lambda self: "기초연금"))
    monkeypatch.setattr(welfare, "current_service_url", property(lambda self: "http://127.0.0.1:5174/portal2.html"))

    async def not_found(self, text):
        return None

    monkeypatch.setattr(welfare, "select_service", not_found)
    r = await s.handle_turn("장애인연금 공식 안내 열어줘")
    assert r["intentType"] == "OPEN_OFFICIAL"
    assert not r["actions"]
    assert "기초연금" not in r["speech"] and "장애인연금" in r["speech"]


async def test_name_question_on_a_page_without_a_form_is_answered_not_refused(new_session):
    s = await new_session()
    llm, _seen = goal_llm([step("open_url", "127.0.0.1:5174/external.html"), step("answer", None, "상담은 보건복지상담센터에서 받을 수 있어요.", ["상담은 보건복지상담센터에서 받을 수 있습니다"])])
    inner = llm.fn

    def fn(*, system, user, schemaName, schema):
        if schemaName == "chat_route":
            return {"route": "general", "reply": "행정복지센터라고 하시면 돼요.", "searchQuery": None, "language": None}
        return inner(system=system, user=user, schemaName=schemaName, schema=schema)

    llm.fn = fn
    with_llm(s, llm)
    await s.handle_turn("127.0.0.1:5174/external.html에서 상담 어디서 받는지 알려줘")
    r = await s.handle_turn("문의해야 할 기관 이름이 뭐야?")
    assert "입력을 대신하지 않아요" not in r["speech"]


async def test_typed_verification_code_never_reaches_the_screen_summary(new_session):
    s = await new_session()
    view = {
        "pageId": "external",
        "url": "https://example.org/verify?x=1",
        "title": "회원 정보",
        "fields": [
            {"fieldId": "code", "type": "text", "visible": True, "label": "주민등록번호 뒷자리", "value": "1234567"},
            {"fieldId": "name", "type": "text", "visible": True, "label": "이름", "value": "김하늘"},
        ],
        "errors": [],
        "outline": {"items": [], "mainText": ""},
    }
    fields = {f["fieldId"]: f["value"] for f in s._summarize(view)["fields"]}
    assert fields["code"] == ""


# ================================================================ 주인 결정(2026-11-19 오전): 인증 대기 중 외국어 사용자


async def test_language_switch_and_fixed_lines_during_a_login_handoff(new_session):
    from cheongeum.language.i18n import FIXED

    s = await new_session()
    with_llm(s, FakeLlm({}))
    r = await s.handle_turn("모의 로그인 연습할래")
    assert r["state"] == "AUTH_HANDOFF"
    r = await s.handle_turn("영어로 말해줘")
    assert r["intentType"] == "SET_LANGUAGE" and r["lang"] == "en"
    assert s.dialogue.auth_waiting
    r = await s.handle_turn("hmm what now")
    assert r["speech"] == FIXED["possibleSecretAuth"]["en"]
    r = await s.handle_turn("I'm done")
    assert r["intentType"] == "AUTH_DONE"


async def test_named_source_is_spoken_once_per_site(new_session):
    s = await new_session()
    catalog = await s.deps.welfare.provider.catalog()
    url = next(row["detailUrl"] for row in catalog if row["servNm"] == "기초연금")
    quote = "가까운 읍면동 주민센터에 방문하여 신청합니다."
    await s.web.adapter.page.route(url, lambda route: route.fulfill(
        content_type="text/html; charset=utf-8", body=f"<title>기초연금 상세</title><main>{quote}</main>"
    ))
    llm, _seen = goal_llm([step("answer", None, quote, [quote])])
    with_llm(s, llm)
    first = await s.handle_turn("복지로에서 기초연금 신청 방법 찾아줘")
    again = await s.handle_turn("복지로에서 기초연금 신청 방법 찾아줘")
    assert first["speech"].endswith("복지로 화면에서 확인했어요.")
    assert again["speech"] == quote
    assert again["sources"][0]["url"] == url


# ================================================================ 주인 결정(2026-11-19 오전): 한 글자 다른 사이트 이름은 소리로 확인


async def test_near_miss_site_name_is_confirmed_before_going(new_session):
    s = await new_session()
    r = await s.handle_turn("복지관에서 하는 프로그램 알려줘")
    assert "'복지로' 말씀이세요?" in r["speech"]
    assert not r["actions"]
    r = await s.handle_turn("아니")
    assert not r["actions"]
    assert r["intentType"] != "GOAL"


async def test_near_miss_site_name_goes_after_yes(new_session):
    s = await new_session()
    await s.web.adapter.page.route("https://www.naver.com/**", lambda route: route.fulfill(
        content_type="text/html; charset=utf-8", body="<title>NAVER</title><main>네이버 첫 화면</main>"
    ))
    r = await s.handle_turn("네이보 열어줘")
    assert "'네이버' 말씀이세요?" in r["speech"] and not r["actions"]
    r = await s.handle_turn("응")
    assert r["intentType"] == "OPEN_SITE"
    assert r["observation"]["url"].startswith("https://www.naver.com")


async def test_exact_site_name_is_not_confirmed(new_session):
    s = await new_session()
    await s.web.adapter.page.route("https://www.naver.com/**", lambda route: route.fulfill(
        content_type="text/html; charset=utf-8", body="<title>NAVER</title><main>네이버 첫 화면</main>"
    ))
    r = await s.handle_turn("네이버 열어줘")
    assert r["intentType"] == "OPEN_SITE" and "말씀이세요" not in r["speech"]
