import re

import pytest
from conftest import PORTAL, FakeLlm, field_value, with_llm

# ---------------------------------------------------------------- 여러 명령 한 번에


async def test_open_fill_next_in_one_sentence(new_session):
    s = await new_session()
    r = await s.handle_turn("장애인연금 신청 도와줘 그리고 이름은 김하늘이고 주소는 부산광역시 예시구 예시로 10, 다음으로 넘어가줘")
    assert re.match(r"^PLAN\(START_APPLICATION>FILL>NEXT\)$", r["intentType"])
    assert field_value(r, "applicantName") == "김하늘"
    assert field_value(r, "address") == "부산광역시 예시구 예시로 10"
    assert r["observation"]["step"]["index"] == 2
    assert re.match(r'^모의 신청서를 열었어요\. 성명에 "김하늘" 넣었어요\.', r["speech"])


async def test_plan_stops_on_clarification(new_session):
    s = await new_session()
    await s.handle_turn("장애인연금 신청 도와줘")
    r = await s.handle_turn("주소는 부산, 다음으로 넘어가줘")
    assert r["state"] == "NEEDS_CLARIFICATION"
    assert "나머지 1가지 요청은" in r["speech"]
    assert r["observation"]["step"]["index"] == 1


async def test_llm_plan_when_rules_cannot_split(new_session):
    s = await new_session()
    with_llm(
        s,
        FakeLlm(
            {
                "intent_plan": {
                    "steps": [
                        {"type": "FILL", "fills": [{"fieldMention": "이름", "value": "김하늘"}], "fieldMention": None, "topic": None, "text": None},
                        {"type": "FILL", "fills": [{"fieldMention": "주소", "value": "부산광역시 예시구 예시로 10"}], "fieldMention": None, "topic": None, "text": None},
                    ]
                }
            }
        ),
    )
    await s.handle_turn("장애인연금 신청 도와줘")
    r = await s.handle_turn("부산광역시 예시구 예시로 10에 사는 김하늘이에요")
    assert field_value(r, "applicantName") == "김하늘"
    assert field_value(r, "address") == "부산광역시 예시구 예시로 10"


# ---------------------------------------------------------------- 융통성 있는 대화


async def test_rephrase_without_llm(new_session):
    s = await new_session()
    first = await s.handle_turn("장애인연금 신청 도와줘")
    r = await s.handle_turn("무슨 말이야? 쉽게 말해줘")
    assert r["semanticAction"] == "rephrase"
    assert first["speech"][:20] in r["speech"]


async def test_rephrase_with_llm(new_session):
    s = await new_session()
    with_llm(s, FakeLlm({"simple": {"text": "연습용 신청서를 열었어요. 이름부터 말해 주세요."}}))
    await s.handle_turn("장애인연금 신청 도와줘")
    r = await s.handle_turn("이해가 안 돼")
    assert "연습용 신청서를 열었어요. 이름부터 말해 주세요." in r["speech"]


async def test_general_question_then_resume(new_session):
    s = await new_session()
    with_llm(s, FakeLlm({"chat_route": {"route": "general", "reply": "1년은 보통 365일이에요.", "searchQuery": None}}))
    await s.handle_turn("장애인연금 신청 도와줘")
    r = await s.handle_turn("1년은 며칠이야")
    assert r["semanticAction"] == "chat"
    assert "1년은 보통 365일이에요. 이어서 성명을 말씀해 주세요" in r["speech"]
    assert r["actions"] == []


async def test_realtime_question_searches_and_grounds(new_session):
    s = await new_session()
    with_llm(
        s,
        FakeLlm(
            {
                "chat_route": {"route": "web_search", "reply": "", "searchQuery": "오늘 날씨"},
                "web_answer": {"found": True, "answer": "첫 검색 결과는 오늘 날씨 신청 방법이에요.", "evidence": ["오늘 날씨 신청 방법"]},
            }
        ),
    )
    r = await s.handle_turn("오늘 날씨 어때")
    assert r["semanticAction"] == "web-answer"
    assert "'오늘 날씨'를 검색해 봤어요. 첫 검색 결과는 오늘 날씨 신청 방법이에요." in r["speech"]
    assert r["accessMode"] == "read-only"
    assert r["actions"][0]["policy"]["code"] == "ALLOWED_READ_ONLY"


async def test_verifier_blocks_ungrounded_search_answer(new_session):
    s = await new_session()
    with_llm(
        s,
        FakeLlm(
            {
                "chat_route": {"route": "web_search", "reply": "", "searchQuery": "오늘 날씨"},
                "web_answer": {"found": True, "answer": "오늘은 맑고 기온은 23도예요.", "evidence": ["맑음 23도"]},
            }
        ),
    )
    r = await s.handle_turn("오늘 날씨 어때")
    assert "확실한 답을 확인하지 못했어요" in r["speech"]
    assert "23도" not in r["speech"]
    assert any(t["agent"] == "answer-verifier" and "근거 부족" in (t.get("note") or "") for t in r["trace"])


async def test_welfare_question_not_in_official_data(new_session):
    s = await new_session()
    with_llm(
        s,
        FakeLlm(
            {
                "chat_route": {"route": "welfare", "reply": "", "searchQuery": None},
                "grounded_answer": {"answerable": False, "answer": "", "usedChunkIds": []},
                "general_answer": {"known": True, "answer": "보통 매달 정해진 날에 계좌로 들어와요."},
            }
        ),
    )
    await s.handle_turn("장애인연금 신청 도와줘")  # 맥락: 장애인연금
    r = await s.handle_turn("근데 이 신청하면 언제 돈이 지급돼?")
    assert "공식 자료에는 그 내용이 없어요" in r["speech"]
    assert "보통 매달 정해진 날에 계좌로 들어와요" in r["speech"]
    assert "129" in r["speech"]


# ---------------------------------------------------------------- 되묻기


@pytest.mark.parametrize(
    "text,ask",
    [("열어줘", "어느 사이트를 열까요"), ("검색해줘", "무엇을 검색할까요"), ("그거 해줘", "무엇을 할까요"), ("알려줘", "무엇을 알려드릴까요")],
)
async def test_vague_requests_ask_back(new_session, text, ask):
    s = await new_session()
    r = await s.handle_turn(text)
    assert r["semanticAction"] == "clarify"
    assert ask in r["speech"]
    assert r["actions"] == []


async def test_apply_without_service_name_asks(new_session):
    s = await new_session()
    r = await s.handle_turn("신청 도와줘")
    assert r["semanticAction"] == "clarify"
    assert r.get("page") != "mock-welfare"


async def test_welfare_question_without_context_asks_service(new_session):
    s = await new_session()
    r = await s.handle_turn("얼마 받을 수 있어?")
    assert "어떤 제도에 대해 궁금하신가요" in r["speech"]
    assert "장애인연금" not in r["speech"]


# ---------------------------------------------------------------- 회귀 방지


async def test_fillers_not_entered_as_name(new_session):
    s = await new_session()
    await s.handle_turn("장애인연금 신청 도와줘")
    for t in ["음 그냥 좀 도와줄래", "근데 이 신청하면 언제 돈이 지급돼"]:
        r = await s.handle_turn(t)
        assert [a for a in r["actions"] if a["action"]["type"] == "fill" and (a.get("result") or {}).get("ok")] == []
    assert (await s.handle_turn("김하늘"))["field"] == "applicantName"


async def test_other_service_context_does_not_open_disability_form(new_session):
    s = await new_session()
    await s.handle_turn("장애인연금 지원대상 알려줘")
    s._grounded = {"servNm": "기초연금", "sources": []}
    r = await s.handle_turn("신청 도와줘")
    assert r["semanticAction"] == "clarify"
    assert "기초연금 연습 신청서는 아직 없어요" in r["speech"]
    assert r.get("page") != "mock-welfare"


# ---------------------------------------------------------------- 맞춤 복지 찾기


async def test_discover_flow(new_session):
    s = await new_session()
    r1 = await s.handle_turn("나한테 맞는 복지 찾아줘")
    assert "나이" in r1["speech"]
    assert "저장하지 않아요" in r1["speech"]
    await s.handle_turn("일흔 살이에요")
    await s.handle_turn("아니요")
    await s.handle_turn("잘 모르겠어요")
    r5 = await s.handle_turn("건너뛸게요")
    assert r5["semanticAction"] == "discover"
    assert re.search(r"1번 .+2번 .+3번", r5["speech"])
    assert "기관이 판단" in r5["speech"]
    pc = await s.handle_turn("1번 자격 확인해줘")
    assert pc["semanticAction"] == "precheck"
    assert re.search(r"최종 자격은 기관이 판단|선정기준을 공식 자료에서 가져오지 못했", pc["speech"])
    more = await s.handle_turn("더 알려줘")
    assert "4번" in more["speech"]


async def test_discover_interrupted_by_other_command(new_session):
    s = await new_session()
    await s.handle_turn("받을 수 있는 복지 찾아줘")
    r = await s.handle_turn("도움말")
    assert r["semanticAction"] != "discover"


# ---------------------------------------------------------------- 사용자 테스트에서 나온 문제


async def test_no_consecutive_clarify(new_session):
    s = await new_session()
    enums: list[list[str]] = []

    def fn(*, system, user, schemaName, schema):
        if schemaName != "chat_route":
            return None
        enums.append(schema["properties"]["route"]["enum"])
        if len(enums) == 1:
            return {"route": "clarify", "reply": "(1) 이것 (2) 저것 중 무엇인가요?", "searchQuery": None, "language": None}
        return {"route": "general", "reply": "1번으로 할게요.", "searchQuery": None, "language": None}

    s.deps.llm = FakeLlm(fn=fn)
    first = await s.handle_turn("사과 하나 줄래요")
    assert first["semanticAction"] == "clarify"
    r = await s.handle_turn("1번.")
    assert "clarify" in enums[0]
    assert "clarify" not in enums[-1]
    assert r["speech"] == "1번으로 할게요."


async def test_llm_language_route(new_session):
    s = await new_session()
    with_llm(s, FakeLlm({"chat_route": {"route": "language", "reply": "", "searchQuery": None, "language": "en"}}))
    r = await s.handle_turn("잉글리쉬로 좀 부탁해요")
    assert r["lang"] == "en"
    assert r["semanticAction"] == "set-language"


async def test_brief_screen_vs_detailed(new_session):
    s = await new_session()
    with_llm(s, FakeLlm({"page_summary": {"text": "복지 소식을 전하는 시험용 포털이에요. 장애인연금 기준액 조정과 신청 방법을 안내해요."}}))
    await s.handle_turn(f"{PORTAL} 열어줘")
    r = await s.handle_turn("화면 설명해줘")
    assert "'[테스트] 외부 포털" in r["speech"]
    assert "장애인연금 기준액 조정과 신청 방법을 안내해요" in r["speech"]
    assert "누를 수 있는 버튼" not in r["speech"]
    assert "링크:" not in r["speech"]
    full = await s.handle_turn("화면 자세히 설명해줘")
    assert "화면 전체를 위에서부터 설명합니다" in full["speech"]


async def test_summary_with_unknown_number_dropped(new_session):
    s = await new_session()
    with_llm(s, FakeLlm({"page_summary": {"text": "기준액이 50만 원으로 올랐어요."}}))
    await s.handle_turn(f"{PORTAL} 열어줘")
    r = await s.handle_turn("화면 설명해줘")
    assert "50만" not in r["speech"]
    assert '내용은 "' in r["speech"]


async def test_login_link_only_then_handoff(new_session):
    s = await new_session()
    await s.handle_turn(f"{PORTAL} 열어줘")
    ask = await s.handle_turn("로그인하고 싶어")
    assert ask["actions"] == []
    r = await s.handle_turn("로그인 눌러줘. 그 뒤로는 내가 할게")
    assert r["state"] == "AUTH_HANDOFF"
    assert "/login.html" in r["observation"]["url"]
    assert "직접 해 주세요" in r["speech"]


async def test_main_screen_opens_site_home(new_session):
    s = await new_session()
    await s.handle_turn("127.0.0.1:5174/external2.html 열어줘")
    r = await s.handle_turn("메인 화면 눌러줘")
    assert r["observation"]["url"] == "http://127.0.0.1:5174/"


async def test_custom_named_link_is_follow_link(new_session):
    s = await new_session()
    await s.handle_turn(f"{PORTAL} 열어줘")
    r = await s.handle_turn("맞춤형 급여 안내 눌러줘")
    assert r["intentType"] == "FOLLOW_LINK"


# ---------------------------------------------------------------- 짧은 대답·여러 질문


async def test_short_replies_not_values(new_session):
    s = await new_session()
    opened = await s.handle_turn("장애인연금 신청 도와줘")
    assert "성명을 말씀해 주세요" in opened["speech"]
    ok = await s.handle_turn("알았어")
    assert "성명을 말씀해 주세요" in ok["speech"]
    assert field_value(ok, "applicantName") == ""
    no = await s.handle_turn("아니")
    assert "비워 둘게요" in no["speech"]
    assert field_value(no, "applicantName") == ""
    name = await s.handle_turn("알았고 이름은 김하늘")
    assert field_value(name, "applicantName") == "김하늘"


async def test_multiple_questions(new_session):
    s = await new_session()
    with_llm(
        s,
        FakeLlm(
            {
                "split_questions": {"questions": ["1년은 며칠이야?", "하루는 몇 시간이야?"]},
                "chat_route": {"route": "general", "reply": "답이에요.", "searchQuery": None, "language": None},
            }
        ),
    )
    r = await s.handle_turn("1년은 며칠이고 하루는 몇 시간이야?")
    assert r["intentType"] == "MULTI_QUESTION"
    assert r["speech"] == "1. 답이에요. 2. 답이에요."


async def test_real_site_mode(new_session):
    s = await new_session()
    s.deps.practice_mode = False
    real = await s.handle_turn("장애인연금 신청 도와줘")
    assert "step" not in (real.get("observation") or {})
    assert real["semanticAction"] == "agent-handoff"
    practice = await s.handle_turn("장애인연금 연습 신청 도와줘")
    assert practice["observation"]["step"]["index"] == 1
