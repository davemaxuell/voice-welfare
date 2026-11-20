"""다국어 의도 결정부터 실제 브라우저 재관찰, 근거 검증, 다음 발화까지."""
import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from conftest import FakeLlm, create_test_runtime, with_llm
from cheongeum.language.i18n import detect_script_lang
from cheongeum.orchestrator.public_task import PublicTask, parse_decision, review_completion
from cheongeum.core.jsutil import AbortSignal
from cheongeum.safety.guard import PolicyContext
from cheongeum.safety.verify import PublicEvidence
from cheongeum.server.app import create_app
from cheongeum.server.runtime import DEFAULT_PUBLIC_MODEL, load_config
from cheongeum.understanding import IntentContext, RuleBasedIntentProvider


def decision(kind="find_information", *, agency="정부24", goal="주민등록등본 발급 서류", subject="주민등록등본",
             facts=("documents",), exclusions=(), continuing=False, question=None, choices=(), source="browser"):
    return {"kind": kind, "source": source, "agency": agency, "subject": subject, "goal": goal,
            "requestedFacts": list(facts), "exclusions": list(exclusions), "continuation": continuing,
            "question": question, "choices": list(choices)}


def test_decision_schema_scopes_memory_and_keeps_explicit_model_overrides():
    config = load_config({"OPENAI_API_KEY": "test"})
    assert config.llmUnderstand.model == config.llmGoal.model == DEFAULT_PUBLIC_MODEL
    custom = load_config({"OPENAI_API_KEY": "test", "LLM_MODEL": "configured", "LLM_GOAL_MODEL": "another"})
    assert custom.llmUnderstand.model == "configured" and custom.llmGoal.model == "another"
    for unsafe in ({"kind": "approve"}, {"agency": "https://external.invalid"}, {"tool": "submit"}, {"goal": "https://external.invalid"}):
        assert parse_decision({**decision(), **unsafe}) is None
    task = PublicTask(agency="정부24", exclusions=("login",))
    assert task.advance(parse_decision(decision(continuing=True))).exclusions == ("login",)
    assert task.advance(parse_decision(decision(agency="한국장학재단", continuing=True))).exclusions == ()
    assert detect_script_lang("Can you find 국가장학금 documents?") == "en"
    parser = RuleBasedIntentProvider([])
    for phrase in ("정부24에서 로그인은 건너뛰고 주민등록등본 발급 서류만 알려줘", "로그인은 됐고 국가장학금 서류만 알려줘"):
        assert parser.parse_sync(phrase, IntentContext(state="IDLE"))["type"] == "GOAL"
    assert parser.parse_sync("승인하면 어떻게 되나요?", IntentContext(state="WAITING_FOR_USER_CONFIRMATION"))["type"] != "APPROVE"


def test_claims_preserve_source_conditions_and_missing_facts():
    e = PublicEvidence(("amount", "dates"))
    e.collect([{"fact": "amount", "quote": "월 13만 원을 받습니다."}, {"fact": "dates", "quote": "매년 8월 31일까지"}],
              {"notice": "해당 가구에 한해 월 13만 원을 받습니다."})
    speech, sources = e.result({"notice": "공식 공고"})
    assert "해당 가구에 한해 월 13만 원" in speech and "기간 항목은 아직" in speech
    assert e.missing == ["dates"] and sources == [{"url": "notice", "title": "공식 공고"}]
    e.collect([{"fact": "dates", "quote": "2026년 11월입니다. 신입생에 한해"}],
              {"notice": "신청 기간은 2026년 11월입니다.\n신입생에 한해 12월에도 받습니다."})
    assert not e.missing and "신입생에 한해 12월에도 받습니다." in e.result({"notice": "공고"})[0]


@pytest.mark.parametrize(("locale", "utterance"), [
    ("ko", "정부24에서 로그인은 건너뛰고 주민등록등본 발급 서류만 알려줘"),
    ("en", "On Gov24 please find the paperwork, without logging in."),
    ("zh", "请在政府24查一下办理住民登记所需材料，不要登录。"),
    ("ja", "政府24で住民登録謄本の書類を調べてください。ログインは不要です。"),
])
async def test_normal_turn_uses_native_intake_and_verified_page(locale, utterance):
    rt = create_test_runtime({"PRACTICE_MODE": "false"})
    app, sessions = create_app(rt)
    source = "방문 신청자는 신분증과 신청서를 지참합니다."
    calls = []
    def model(**args):
        name, payload = args["schemaName"], args["user"]
        calls.append(name)
        if name == "public_service_decision":
            data = json.loads(payload)
            assert data["utterance"] == utterance and data["replyLanguage"] == locale
            return decision(exclusions=("login",))
        if name == "public_browse_step":
            data = json.loads(payload)
            assert data["conversation"]["exclusions"] == ["login"]
            row = next(row for row in data["page"]["passages"] if row["text"] == source)
            return {"action": "answer", "target": None, "answer": "수수료는 72만원이에요.",
                    "claims": [{"fact": "documents", "passageId": row["id"], "quote": None}]}
        if name == "translate_out":
            return {"text": {"en": "In-person applicants must bring ID and the form, according to Gov24.",
                             "zh": "政府24资料显示，现场申请需携带身份证和申请表。",
                             "ja": "政府24によると、窓口では身分証と申請書を持参します。"}[locale]}
        raise AssertionError(name)

    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
            sid = (await client.post("/api/session")).json()["sessionId"]
            s = sessions.get(sid)
            with_llm(s, FakeLlm(fn=model))
            await s.web.adapter.page.route("https://www.gov.kr/**", lambda route: route.fulfill(
                content_type="text/html; charset=utf-8", body=f"<title>정부24</title><main><p>{source}</p></main>"))
            r = (await client.post("/api/turn", json={"sessionId": sid, "text": utterance})).json()
            assert r["intentType"] == "GOAL" and r["lang"] == locale and r["sources"][0]["url"].startswith("https://www.gov.kr/")
            assert not r.get("pendingConfirmation")
            assert "72" not in r["speech"] and all(a["action"]["type"] != "click" for a in r["actions"])
            assert calls.count("public_service_decision") == 1 and "translate_in" not in calls and "intent_plan" not in calls
    finally:
        for s in sessions.values():
            await s.close()
        sessions.clear()
        await rt.close()


async def test_clarification_choice_rejection_and_agency_switch(new_session):
    s = await new_session()
    s._lang = "en"
    seen = []
    def model(**args):
        if args["schemaName"] == "translate_out":
            return {"text": "I opened the requested page."}
        if args["schemaName"] != "public_service_decision":
            return None
        data = json.loads(args["user"])
        seen.append(data)
        if data["selectedChoice"]:
            return decision("open_agency", agency="한국장학재단", subject="국가장학금", goal=None, facts=(), continuing=True)
        return decision("clarify", agency=None, subject=None, goal="공공서비스 기관 찾기", facts=(),
                        question="Do you mean Gov24 or the scholarship foundation?", choices=("Gov24", "Scholarship foundation"))
    with_llm(s, FakeLlm(fn=model))
    await s.web.adapter.page.route("https://www.kosaf.go.kr/**", lambda r: r.fulfill(content_type="text/html", body="<main>KOSAF</main>"))
    ask = await s.handle_turn("I couldn't catch the agency name.", from_voice=True)
    assert ask["semanticAction"] == "clarify" and not ask["actions"]
    assert not (await s.handle_turn("yes"))["actions"] and len(seen) == 1
    assert not (await s.handle_turn("no"))["actions"] and not s._public_task.question
    await s.handle_turn("Which place was that again?", from_voice=True)
    opened = await s.handle_turn("2", from_voice=True)
    assert seen[-1]["selectedChoice"] == "Scholarship foundation" and opened["intentType"] == "OPEN_SITE"
    assert s._public_task.agency == "한국장학재단"
    s.cancel()
    assert not s._public_task.question


async def test_stop_during_intake_discards_late_decision(new_session):
    s = await new_session()
    started, release = asyncio.Event(), asyncio.Event()
    class Slow:
        name = "slow"
        async def generate(self, **kwargs):
            started.set()
            await release.wait()
            return decision("open_agency", goal=None, facts=())
    s.deps.llm = Slow()
    work = asyncio.create_task(s.handle_turn("Could you find the relevant public service?"))
    await asyncio.wait_for(started.wait(), 3)
    assert (await s.handle_turn("stop"))["state"] == "STOPPED"
    release.set()
    late = await work
    assert late["state"] == "STOPPED" and not late["actions"] and not s._public_task.goal


async def test_read_scope_even_on_a_supported_form(new_session):
    s = await new_session()
    guard = s.web.guard
    ctx = PolicyContext(currentUrl=s.web.profile.origin, approvals={"x"}, public_lookup=True)
    for name in ("로그인", "신청하기", "제출"):
        action = {"id": "x", "type": "click", "target": {"role": "link", "name": name},
                  "reason": "test", "requiresConfirmation": False, "risk": "low"}
        assert guard.check(action, ctx)["code"] == "DENIED_TASK_SCOPE"


async def test_partial_lookup_keeps_earlier_proof_and_names_the_missing_fact(new_session):
    session = await new_session()
    source = "방문 신청자는 신분증과 신청서를 지참합니다."
    observed = []

    def model(**call):
        if call["schemaName"] == "public_service_decision":
            return decision(facts=("documents", "amount"), goal="주민등록등본 방문 발급 서류와 수수료 확인")
        if call["schemaName"] == "public_browse_step":
            missing = json.loads(call["user"])["missingFacts"]
            observed.append(missing)
            if "documents" in missing:
                return {"action": "find", "target": "수수료", "answer": None,
                        "claims": [{"fact": "documents", "quote": source}]}
            return {"action": "fail", "target": None, "answer": "무료라고 생각합니다.",
                    "claims": [{"fact": "amount", "passageId": 999, "quote": "무료입니다."}]}
        return None

    with_llm(session, FakeLlm(fn=model))
    await session.web.adapter.page.route("https://www.gov.kr/**", lambda route: route.fulfill(
        content_type="text/html; charset=utf-8", body=f"<title>정부24</title><main><p>{source}</p></main>"))
    answer = await session.handle_turn("정부24에서 등본 방문 발급 서류와 수수료를 확인해줘")
    assert observed == [["documents", "amount"], ["amount"]]
    assert source in answer["speech"] and "금액 항목은 아직" in answer["speech"] and "무료" not in answer["speech"]
    assert len(answer["sources"]) == 1


async def test_catalog_answers_compound_public_lookup_without_a_browser_or_another_model(new_session, monkeypatch):
    s = await new_session()
    source = {"title": "공공서비스 자료", "lastCheckedAt": "2026-11-19", "url": "https://www.bokjiro.go.kr/"}
    service = {"servId": "sample", "servNm": "기초연금", "summary": "검증용 제도", "dataOrigin": "official-api",
               "documents": "신청서와 신분증을 준비합니다.", "benefit": "예시 대상에게 월 13만 원을 지급합니다.", "source": source}
    monkeypatch.setattr(s.deps.welfare.provider, "find_service", AsyncMock(return_value=service))
    llm = FakeLlm({"public_service_decision": decision(source="welfare", agency="복지로", subject="기초연금",
                   goal="기초연금 서류와 금액", facts=("documents", "amount"))})
    with_llm(s, llm)
    reply = await s.handle_turn("기초연금을 신청하려면 서류가 뭐고 얼마를 받나요?")
    assert reply["intentType"] == "POLICY_QUESTION" and not reply["actions"]
    assert reply["answerCard"]["answer"] == service["documents"] + " " + service["benefit"]
    assert reply["sources"][0]["url"] == source["url"] and [call["schemaName"] for call in llm.calls] == ["public_service_decision"]


@pytest.mark.parametrize("research, available", [(False, True), (True, True), (True, False)])
async def test_fixture_reference_requires_observed_official_evidence(new_session, research, available):
    s = await new_session()
    source = "공식 안내에 따르면 신청자는 주소지 주민센터에 방문해 신청합니다."
    query = "복지로에서 장애인연금 신청 방법을 알려줘"
    service = await s.deps.welfare.provider.find_service("장애인연금")
    assert service["dataOrigin"] == "fixture" and service["source"]["url"].startswith("https://")
    step = {"action": "answer" if available else "fail", "answer": None, "target": None,
            "claims": [{"fact": "procedure", "quote": source}] if available else []}
    model = FakeLlm({"public_service_decision": decision(agency="복지로", subject="장애인연금", goal=query,
                     facts=("procedure",), source="welfare"), "public_browse_step": step})
    with_llm(s, model)
    s.deps.web_llm = FakeLlm({"public_research_coverage": {"coverage": "all", "checks": [
        {"request": "장애인연금 신청 방법", "quote": source}]}})
    await s.web.adapter.page.route("https://www.bokjiro.go.kr/**", lambda route: route.fulfill(
        content_type="text/html; charset=utf-8", body=f"<title>복지로</title><main>{source if available else '검색 결과 없음'}</main>"))
    if research:
        state, r = await s.research_public(query, "ko")
        assert state == ("completed" if available else "incomplete")
    else:
        r = await s.handle_turn(query)
        assert r["actions"][0]["action"]["type"] == "navigate"
    assert bool(r["sources"]) == available
    assert all(x["url"].startswith("https://www.bokjiro.go.kr/") for x in r["sources"])
    assert any(call["schemaName"] == "public_browse_step" for call in model.calls)


@pytest.mark.parametrize("case, expected", [
    ("different-action", "partial"), ("unsupported-quote", "partial"), ("timeout-response", "partial"),
    ("irrelevant", "incomplete"), ("fully-supported", "completed"),
])
async def test_durable_completion_checks_original_request_and_verbatim_support(case, expected):
    request = "How do I check whether documents are needed, and how do I submit the documents?"
    status = "장학금 신청현황에서 서류제출 대상 여부를 확인합니다."
    upload = "대상자는 서류제출현황에서 증빙 파일을 업로드합니다."
    evidence = status if case != "fully-supported" else status + " " + upload
    review = {"coverage": {"different-action": "some", "irrelevant": "unrelated"}.get(case, "all"),
              "checks": [{"request": "check whether documents are needed", "quote": status},
                         {"request": "submit the documents", "quote": None if case == "different-action" else upload}]}
    model = FakeLlm({"public_research_coverage": None if case == "timeout-response" else review})
    assert await review_completion(model, request, evidence, AbortSignal()) == expected
    assert len(model.calls) == 1
    assert json.loads(model.calls[0]["user"]) == {"question": request, "evidence": evidence}


async def test_browser_launch_recovers_on_retry_and_after_disconnect(monkeypatch):
    rt = create_test_runtime()
    launched = []

    class Browser:
        def on(self, event, callback):
            assert event == "disconnected"
            self.disconnect = callback

        def is_connected(self):
            return True

        async def close(self):
            self.disconnect(self)

    async def launch(*_):
        browser = Browser()
        launched.append(browser)
        if len(launched) == 1:
            raise RuntimeError("launch failure")
        return browser

    monkeypatch.setattr("cheongeum.server.runtime.launch_browser", launch)
    try:
        with pytest.raises(RuntimeError, match="launch failure"):
            await rt._get_browser()
        a, b = await asyncio.gather(rt._get_browser(), rt._get_browser())
        assert a is b
        await a.close()
        assert await rt._get_browser() is not a and len(launched) == 3
    finally:
        await rt.close()
