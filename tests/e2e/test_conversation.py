import json
import re

import pytest
from conftest import PORTAL, FakeLlm, create_test_runtime, field_value, with_llm

from cheongeum.agents.web import create_mock_welfare_profile, field_vocabulary
from cheongeum.core.intents import INTENTS
from cheongeum.orchestrator.session import HELP_POINTER
from cheongeum.safety.gates import ALLOWED_WITHOUT_CONSENT
from cheongeum.understanding import INTENT_JSON_SCHEMA, IntentContext, RuleBasedIntentProvider

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


async def test_rephrase_that_changes_a_number_repeats_the_original(new_session):
    s = await new_session()
    with_llm(
        s,
        FakeLlm(
            {
                "chat_route": {"route": "general", "reply": "1년은 보통 365일이에요.", "searchQuery": None},
                "simple": {"text": "1년은 366일이에요."},
            }
        ),
    )
    await s.handle_turn("1년은 며칠이야")
    r = await s.handle_turn("쉽게 말해줘")
    assert r["semanticAction"] == "rephrase"
    assert "366" not in r["speech"]
    assert "천천히 다시 말씀드릴게요. 1년은 보통 365일이에요." in r["speech"]
    assert any(t["agent"] == "answer-verifier" and "366" in (t.get("note") or "") for t in r["trace"])


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


async def test_real_site_login_moves_explains_asks_then_clicks(new_session):
    """주인 결정(2026-11-18): 실제 사이트 로그인도 버튼으로 옮겨 가서 무엇을 왜 하는지 말하고, '눌러'를 들은 뒤 누른다."""
    s = await new_session()
    await s.handle_turn(f"{PORTAL} 열어줘")
    ask = await s.handle_turn("로그인하고 싶어")
    assert ask["state"] == "WAITING_FOR_USER_CONFIRMATION"
    assert "'로그인하고 싶어'라고 하셔서" in ask["speech"] and "이동했어요" in ask["speech"] and "'눌러'" in ask["speech"]
    assert [a["action"]["type"] for a in ask["actions"]] == ["focus"]
    assert "/login.html" not in ask["observation"]["url"]

    opened = await s.handle_turn("눌러")
    assert opened["state"] == "AUTH_HANDOFF"
    assert "/login.html" in opened["observation"]["url"]
    assert "비밀번호" in opened["speech"] and "직접" in opened["speech"] and "다 입력했어" in opened["speech"]
    # 인계 직후 사용자가 채울 첫 칸(아이디)에 초점을 옮긴다
    assert any(
        a["action"]["type"] == "focus" and (a["action"].get("target") or {}).get("fieldId") == "loginId" and (a.get("result") or {}).get("ok")
        for a in opened["actions"]
    )

    submit = await s.handle_turn("다 입력했어")
    assert submit["state"] == "WAITING_FOR_USER_CONFIRMATION"
    assert "'모의 로그인'" in submit["speech"]
    done = await s.handle_turn("눌러")
    clicks = [a for a in done["actions"] if a["action"]["type"] == "click"]
    assert clicks and clicks[-1]["policy"]["code"] == "APPROVED" and clicks[-1]["result"]["ok"]
    every = [a for r in (ask, opened, submit, done) for a in r["actions"]]
    assert not [a for a in every if a["action"]["type"] in ("fill", "select", "check")]


async def test_real_site_login_rejected_clicks_nothing(new_session):
    s = await new_session()
    await s.handle_turn(f"{PORTAL} 열어줘")
    await s.handle_turn("로그인 화면 열어줘")
    r = await s.handle_turn("거절")
    assert "누르지 않았어요" in r["speech"]
    assert "/login.html" not in r["observation"]["url"]


async def test_auth_done_stays_while_login_page_unchanged(new_session):
    """'다 했어'여도 아직 로그인·인증 화면이면 인계를 유지하고 다시 기다린다."""
    s = await new_session()
    handed = await s.handle_turn("로그인하고 싶어")
    assert handed["state"] == "AUTH_HANDOFF"
    assert "/login.html" in handed["observation"]["url"]
    assert any(
        a["action"]["type"] == "focus" and (a["action"].get("target") or {}).get("fieldId") == "loginId" and (a.get("result") or {}).get("ok")
        for a in handed["actions"]
    )
    still = await s.handle_turn("다 했어")
    assert still["intentType"] == "AUTH_DONE"
    assert still["state"] == "AUTH_HANDOFF"
    assert "/login.html" in still["observation"]["url"]
    assert "아직" in still["speech"] and ("로그인" in still["speech"] or "인증" in still["speech"])


async def test_auth_done_speaks_title_and_resumes_pending_form(new_session):
    """연습 로그인 인계 뒤, 화면이 바뀐 다음에만 '인증 끝났어'로 제목을 말하고 신청서 작업을 이어 간다."""
    s = await new_session()
    opened = await s.handle_turn("장애인연금 신청 도와줘")
    assert opened["state"] == "APPLICATION_OPEN"
    handed = await s.handle_turn("로그인하고 싶어")
    assert handed["state"] == "AUTH_HANDOFF"
    assert "/login.html" in handed["observation"]["url"]
    assert s.dialogue.auth_resume == {"kind": "form"}
    # 화면이 그대로면 이어가지 않는다
    still = await s.handle_turn("다 했어")
    assert still["state"] == "AUTH_HANDOFF"
    assert s.dialogue.auth_resume == {"kind": "form"}
    assert "아직" in still["speech"]
    # 연습 사이트는 제출해도 주소가 안 바뀌므로, 관찰 가능한 이동(신청서)으로 바뀐 뒤 재개한다
    await s.web.adapter.page.goto("http://localhost:5174/apply.html", wait_until="domcontentloaded")
    done = await s.handle_turn("인증 끝났어")
    assert done["intentType"] == "AUTH_DONE"
    assert done["state"] == "APPLICATION_OPEN"
    assert "화면으로 바뀌었어요" in done["speech"]
    assert "모의" in done["speech"] or "신청" in done["speech"]
    assert s.dialogue.auth_resume is None
    assert s.dialogue.awaiting == "applicantName"


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


async def test_called_by_name(new_session):
    s = await new_session()
    opened = await s.handle_turn("청음아, 장애인연금 신청 도와줘")
    assert "성명을 말씀해 주세요" in opened["speech"]
    called = await s.handle_turn("청음아")
    assert called["speech"] == "네, 말씀하세요."
    assert field_value(called, "applicantName") == ""
    name = await s.handle_turn("청음아 이름은 김하늘")
    assert field_value(name, "applicantName") == "김하늘"
    stopped = await s.handle_turn("청음아 멈춰")
    assert stopped["state"] == "STOPPED"


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


# ---------------------------------------------------------------- LLM 계획이 받는 말(규칙이 놓친 일상 표현)

# drafts/research results/probes/phrasings.py의 19개. 규칙이 놓치면 LLM 계획이 이 평탄화 답을 낸다.
PLANNED = {
    "READ_MAIN": [
        ("이 페이지 내용 좀 들려줄래", {"more": False}),
        ("기사 마저 읽어", {"more": True}),
        ("본문 읽어줘", {"more": False}),
        ("그 다음 내용은?", {"more": True}),
    ],
    "LIST_LINKS": [
        ("여기 누를 수 있는 거 뭐 있어", {"more": False}),
        ("어떤 메뉴가 있어", {"more": False}),
        ("링크 목록 알려줘", {"more": False}),
    ],
    "SEARCH": [
        ("기초연금으로 검색해 볼래", {"topic": "기초연금"}),
        ("검색창에 기초연금 쳐줘", {"topic": "기초연금"}),
        ("기초연금 검색해줘", {"topic": "기초연금"}),
    ],
    "FOLLOW_LINK": [
        ("공지사항으로 가자", {"topic": "공지사항"}),
        ("공지사항 들어가 볼래", {"topic": "공지사항"}),
        ("공지사항 눌러줘", {"topic": "공지사항"}),
    ],
    "REPHRASE": [("무슨 소리야", {}), ("좀 더 쉽게", {}), ("쉽게 말해줘", {})],
    "SERVICE_DETAIL": [
        ("첫 번째 거 자세히 알려줘", {"topic": "1번"}),
        ("두 번째 제도 설명해줘", {"topic": "2번"}),
        ("2번 자세히 알려줘", {"topic": "2번"}),
    ],
}


@pytest.mark.parametrize("want", list(PLANNED))
async def test_planner_understands_what_rules_miss(new_session, want):
    steps = {said: {**dict.fromkeys(INTENT_JSON_SCHEMA["schema"]["required"]), "type": want, **slots} for said, slots in PLANNED[want]}

    def fn(*, system, user, schemaName, schema):
        return {"steps": [steps[json.loads(user)["utterance"]]]} if schemaName == "intent_plan" else None

    s = await new_session()
    await s.handle_turn(f"{PORTAL} 열어줘")
    with_llm(s, FakeLlm(fn=fn))
    for said in steps:
        r = await s.handle_turn(said)
        assert r["intentType"] == want, said


# ---------------------------------------------------------------- 도움말("뭐라고 말하면 돼?")

rules = RuleBasedIntentProvider(field_vocabulary(create_mock_welfare_profile("http://localhost:5174")))
EXAMPLE_TYPE = {e.text: i.type for i in INTENTS for e in i.examples}


def spoken(r: dict) -> list[str]:
    """도움말이 따옴표로 읽어 준 말(맨 끝의 '다른 말도 알려줘'·'도움말' 안내 제외)"""
    return re.findall(r"'([^']+)'", r["speech"])[:-1]


def assert_each_understood(r: dict) -> None:
    said = spoken(r)
    assert said
    for text in said:
        assert rules.parse_sync(text, IntentContext(state=r["state"]))["type"] == EXAMPLE_TYPE[text], text
    tail = re.findall(r"'([^']+)'", r["speech"])[-1]
    assert rules.parse_sync(tail, IntentContext(state=r["state"]))["type"] == "WHAT_CAN_I_SAY"


async def test_help_on_form_starts_with_form_examples(new_session):
    s = await new_session()
    await s.handle_turn("장애인연금 신청 도와줘")
    first = await s.handle_turn("뭐라고 말하면 돼?")
    assert first["intentType"] == "WHAT_CAN_I_SAY"
    assert first["semanticAction"] == "help-list"
    assert first["state"] == "APPLICATION_OPEN"
    assert first["speech"].startswith("이렇게 말해 보세요. 신청서: ")
    assert first["actions"] == []
    assert_each_understood(first)
    more = await s.handle_turn("다른 말도 알려줘")
    assert more["speech"].startswith("이어서 알려 드릴게요. 신청서: ")
    assert_each_understood(more)
    assert not set(spoken(first)) & set(spoken(more))
    again = await s.handle_turn("도움말")
    assert spoken(again) == spoken(first)


async def test_help_on_web_page_starts_with_web_reading(new_session):
    s = await new_session()
    await s.handle_turn(f"{PORTAL} 열어줘")
    r = await s.handle_turn("뭘 할 수 있어?")
    assert r["speech"].startswith("이렇게 말해 보세요. 웹 읽기: ")
    assert_each_understood(r)


async def test_help_until_nothing_left(new_session):
    s = await new_session()
    r = await s.handle_turn("도움말")
    heard = set(spoken(r))
    while "다른 말도 알려줘" in r["speech"]:
        r = await s.handle_turn("다른 말도 알려줘")
        assert not heard & set(spoken(r))
        heard |= set(spoken(r))
    assert heard == {i.examples[0].text for i in INTENTS if i.help}
    done = await s.handle_turn("다른 말도 알려줘")
    assert "더 알려 드릴 말은 없어요" in done["speech"]


async def test_help_before_consent():
    rt = create_test_runtime({"REQUIRE_CONSENT": "true"})
    s = await rt.create_session()
    try:
        r = await s.handle_turn("뭐라고 말하면 돼?")
        assert r["semanticAction"] == "help-list"
        assert "동의하시면" in r["speech"]
        assert_each_understood(r)
        assert {EXAMPLE_TYPE[t] for t in spoken(r)} <= ALLOWED_WITHOUT_CONSENT
    finally:
        await s.close()
        await rt.close()


async def test_help_while_stopped_gets_stop_reply(new_session):
    s = await new_session()
    await s.handle_turn("멈춰")
    r = await s.handle_turn("뭐라고 말하면 돼?")
    assert r["state"] == "STOPPED"
    assert "중단 상태" in r["speech"]
    assert r["semanticAction"] != "help-list"


async def test_not_understood_points_to_help(new_session):
    s = await new_session()
    r = await s.handle_turn("블라블라")
    assert r["speech"].endswith(HELP_POINTER)
