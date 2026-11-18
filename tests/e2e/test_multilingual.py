from conftest import PORTAL, FakeLlm, with_llm

from cheongeum.core.jsutil import jdumps


def with_translator(s, table: dict, out_override=None) -> FakeLlm:
    """
    가짜 통역 LLM(네트워크 없음): translate_in은 표에서 찾고, translate_out은 "[en] 원문"처럼 표시만 붙인다(숫자 보존).
    out_override로 번역 결과를 바꿔 검증 실패를 흉내 낸다.
    """

    def fn(*, system, user, schemaName, schema):
        if schemaName == "translate_in":
            return {"text": table[user]} if user in table else None
        if schemaName == "translate_out":
            return {"text": out_override(user) if out_override else f"[en] {user}"}
        return None

    llm = FakeLlm(fn=fn)
    with_llm(s, llm)
    return llm


async def test_switch_to_english_then_translate(new_session):
    s = await new_session()
    with_translator(s, {"Open the practice application form": "장애인연금 신청 도와줘"})
    sw = await s.handle_turn("영어로 말해줘")
    assert sw["intentType"] == "SET_LANGUAGE"
    assert sw["lang"] == "en"
    assert "English" in sw["speech"]

    r = await s.handle_turn("Open the practice application form")
    assert r["lang"] == "en"
    assert r["userUtterance"] == "Open the practice application form"  # 화면에는 사용자가 한 말 그대로
    assert r["observation"]["step"]["index"] == 1  # 한국어 흐름으로 모의 신청서가 열림
    assert r["speech"].startswith("[en] ")
    assert any(t.get("note") == "번역 en→ko" for t in r["trace"])
    assert any(t.get("note") == "응답 번역 ko→en" for t in r["trace"])


async def test_stop_without_translation(new_session):
    s = await new_session()
    llm = with_translator(s, {})
    await s.handle_turn("중국어로 말해줘")
    r = await s.handle_turn("停止")
    assert r["intentType"] == "STOP"
    assert r["lang"] == "zh"
    assert "已全部停止" in r["speech"]
    assert [c for c in llm.calls if c["schemaName"] == "translate_in"] == []


async def test_foreign_secret_blocked_before_translation(new_session):
    # 외국어로 말한 비밀번호는 번역(외부 LLM)에 넘기기 전에 막는다
    s = await new_session()
    llm = with_translator(s, {})
    await s.handle_turn("영어로 말해줘")
    r = await s.handle_turn("my password is 4821")
    assert r["semanticAction"] == "auth-handoff"
    assert "4821" not in jdumps(r)
    assert all("4821" not in c["user"] for c in llm.calls)
    assert [c for c in llm.calls if c["schemaName"] == "translate_in"] == []


async def test_only_rule_words_approve(new_session):
    s = await new_session()
    with_translator(s, {"Put Kim Haneul in the name field": "이름 칸에 김하늘 써줘", "Well, I guess you could do that thing": "승인"})
    await s.handle_turn(f"{PORTAL} 열어줘")
    await s.handle_turn("Speak English")
    ask = await s.handle_turn("Put Kim Haneul in the name field")
    assert ask["state"] == "WAITING_FOR_USER_CONFIRMATION"

    vague = await s.handle_turn("Well, I guess you could do that thing")
    assert "yes, approve" in vague["speech"]
    assert vague["actions"] == []
    assert vague["state"] == "WAITING_FOR_USER_CONFIRMATION"

    yes = await s.handle_turn("Yes")
    assert yes["actions"][0]["policy"]["code"] == "APPROVED"
    assert next(f for f in yes["observation"]["fields"] if f["fieldId"] == "opinionName")["value"] == "김하늘"


async def test_changed_numbers_fall_back_to_korean(new_session):
    s = await new_session()
    with_translator(s, {"Open the practice application form": "장애인연금 신청 도와줘"}, lambda ko: "There are 99 steps in total.")
    await s.handle_turn("English please")
    r = await s.handle_turn("Open the practice application form")
    assert r["lang"] == "ko"
    assert "Translation could not be verified" in r["speech"]
    assert "99" not in r["speech"]
    assert "단계" in r["speech"]


async def test_auto_switch_by_script(new_session):
    s = await new_session()
    with_translator(s, {"What can you do for me?": "뭐 할 수 있어?"})
    r = await s.handle_turn("What can you do for me?")
    assert r["lang"] == "en"
    back = await s.handle_turn("장애인연금 신청 도와줘")
    assert back["lang"] == "ko"
    assert "[en]" not in back["speech"]


async def test_no_llm_no_switch(new_session):
    s = await new_session()
    r = await s.handle_turn("일본어로 말해줘")
    assert r["lang"] == "ko"
    assert "AI 모델 설정이 필요해요" in r["speech"]
    assert s.lang == "ko"


async def test_about_unknown_site(new_session):
    s = await new_session()
    await s.handle_turn(f"{PORTAL} 열어줘")
    r = await s.handle_turn("이 사이트 뭐야?")
    assert r["intentType"] == "ABOUT_SITE"
    assert "'[테스트] 외부 포털" in r["speech"]
    assert "주요 메뉴는 뉴스, 복지, 날씨" in r["speech"]
    assert "이 사이트에서 검색" in r["speech"]


async def test_about_practice_site(new_session):
    s = await new_session()
    await s.handle_turn("장애인연금 신청 도와줘")
    r = await s.handle_turn("여기 무슨 사이트야")
    assert "연습용 모의 복지 신청 사이트" in r["speech"]
