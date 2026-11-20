
async def test_period_uses_application_fields_and_preserves_date_provenance():
    s = _svc(applyMethod="신청 기간: 2026년 9월 1일 ~ 2026년 11월 30일",
             benefit="지원금 지급 기한은 2027년 1월 1일까지", dataOrigin="fixture", criteriaYear="2026")
    agent = WelfareInformationAgent(FakeProvider(find=lambda n: s))
    answer = await agent.answer_question("시험지원금 신청 기한은 2027년 1월 1일이야?", today="2026-11-18")
    card = answer.card
    assert card["grounded"] and card["fields"] == ["applyMethod"] and card["dataKind"] == "stored"
    assert card["dataDate"] == "2026년" and card["source"]["lastCheckedAt"] == "2026-11-18"
    assert "2026년 11월 30일" in card["answer"] and "2027년" not in card["answer"]
    assert card["nextAction"]

    s["applyMethod"] = "방문 신청"
    unknown = await agent.answer_question("시험지원금 신청 기한 알려줘", today="2026-11-18")
    assert not unknown.card["grounded"] and unknown.card["fields"] == []
    assert "051-111-2222" in unknown.card["nextAction"]
import json

import httpx
import pytest
from conftest import FIXTURES, FakeLlm

from cheongeum.agents.web import INCOME_OPTIONS, create_mock_welfare_profile, match_option, validate_address, validate_name
from cheongeum.agents.welfare import WelfareInformationAgent, chunk_service
from cheongeum.agents.welfare.data import FixtureWelfareDataProvider, OfficialCentralWelfareApiProvider, clean_api_text, parse_welfare_detail, parse_welfare_list
from cheongeum.core.actions import parse_action
from cheongeum.core.turn import AGENT_IDS, AgentHandoff, parse_intent
from cheongeum.evaluation import DEMO_SCENARIO_PATH, ScenarioStep, check_expectations, evaluate_retrieval, is_active_pc, load_rag_qa, load_scenario_file

LIST = (FIXTURES / "welfare-list-disability-pension.xml").read_text(encoding="utf-8")
DETAIL = (FIXTURES / "welfare-detail-WLF00003249.xml").read_text(encoding="utf-8")
BOKJIRO = "https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=WLF00003249&wlfareInfoReldBztpCd=01"
API_ERROR = '<?xml version="1.0" encoding="UTF-8"?><OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</errMsg><returnAuthMsg>등록되지 않은 서비스키</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>'


def official() -> OfficialCentralWelfareApiProvider:
    return OfficialCentralWelfareApiProvider(
        api_key="test-key", base_url="https://apis.data.go.kr/B554287/NationalWelfareInformationsV001", fallback=FixtureWelfareDataProvider.from_file()
    )


def list_or_detail(req: httpx.Request) -> httpx.Response:
    return httpx.Response(200, text=LIST if req.url.path.endswith("NationalWelfarelistV001") else DETAIL)


# ---------------------------------------------------------------- 공식 API 매핑(welfare-api)


def test_list_mapping():
    s = parse_welfare_list(LIST, "2026-11-16")[0]
    assert (s["servId"], s["servNm"], s["onlineApply"], s["dataOrigin"]) == ("WLF00003249", "장애인연금", True, "official-api")
    assert "중증장애인" in s["summary"]
    assert s["source"]["url"] == BOKJIRO


def test_detail_mapping():
    s = parse_welfare_detail(DETAIL, BOKJIRO, "2026-11-16")
    assert s["target"].startswith("18세 이상의 등록한 중중장애인")
    assert "2026년 선정기준액은 단독가구 140만원, 부부가구 224만원" in s["criteria"]
    assert "349,700원" in s["benefit"]
    assert "×" in s["benefit"]  # 이중 인코딩된 &amp;times; 복원
    assert s["applySteps"][0] == {"step": "신청기관", "detail": "거주지 읍/면/동 주민센터, 읍면동 또는 복지로 웹사이트(PC/모바일앱)에서 ‘서비스 신청’"}
    assert {"name": "보건복지상담센터", "value": "129"} in s["contacts"]
    assert "★2026년 장애인연금 사업안내(최종).pdf" in [f["name"] for f in s["forms"]]
    assert s["laws"] == ["장애인연금법"]
    assert s["criteriaYear"] == "2026"
    assert (s["source"]["url"], s["source"]["version"], s["source"]["lastCheckedAt"]) == (BOKJIRO, "2026년 기준", "2026-11-16")


def test_entity_cleanup():
    assert clean_api_text("a&#13;b &times; c &#9312;") == "a\nb × c ①"


async def test_official_paths_params_and_cache(http_mock):
    calls = http_mock(list_or_detail)
    p = official()
    s = await p.find_service("장애인연금")
    assert "선정기준액" in s["criteria"]
    assert s["source"]["url"] == BOKJIRO
    assert [c.url.path.split("/")[-1] for c in calls] == ["NationalWelfarelistV001", "NationalWelfaredetailedV001"]
    q0 = dict(calls[0].url.params)
    assert {k: q0[k] for k in ("callTp", "pageNo", "numOfRows", "srchKeyCode", "searchWrd")} == {
        "callTp": "L",
        "pageNo": "1",
        "numOfRows": "10",
        "srchKeyCode": "001",
        "searchWrd": "장애인연금",
    }
    q1 = dict(calls[1].url.params)
    assert (q1["callTp"], q1["servId"]) == ("D", "WLF00003249")
    await p.find_service("장애인연금")
    assert len(calls) == 2  # 캐시


async def test_official_error_falls_back(http_mock):
    http_mock(lambda req: httpx.Response(401, text=API_ERROR))
    p = official()
    s = await p.find_service("장애인연금")
    assert s["dataOrigin"] == "fixture"
    assert "SERVICE_KEY_IS_NOT_REGISTERED_ERROR" in p.last_error


@pytest.mark.parametrize("rows, expected", [
    ([BOKJIRO], BOKJIRO),
    ([BOKJIRO, BOKJIRO], None),
    ([BOKJIRO.replace("WLF00003249", "WLF00001164")], None),
    ([BOKJIRO.replace("www.bokjiro.go.kr", "example.org")], None),
    ([], None),
])
async def test_application_guide_requires_an_unambiguous_official_catalog_entry(rows, expected):
    class Provider:
        async def catalog(self):
            return [{"servNm": "장애인연금", "servId": "WLF00003249", "detailUrl": url} for url in rows]

    assert await WelfareInformationAgent(Provider()).application_guide_url("장애인 연금") == expected


@pytest.mark.parametrize(
    "q,expected",
    [
        ("장애인연금 지원대상이 누구야?", ["18세 이상의 등록한 중중장애인", "단독가구 140만원"]),
        ("장애인연금 얼마 받아?", ["349,700원"]),
        ("장애인연금 신청 절차 알려줘", ["신청기관은 거주지 읍/면/동 주민센터", "결정기관은"]),
        ("장애인연금 필요한 서류 알려줘", ["금융정보 등(금융ㆍ신용ㆍ보험정보) 제공 동의서"]),
        ("장애인연금 어디에 문의해?", ["보건복지상담센터 129"]),
    ],
)
async def test_topic_answers_from_official_data(http_mock, q, expected):
    http_mock(list_or_detail)
    a = await WelfareInformationAgent(official()).answer_policy_question(q)
    for e in expected:
        assert e in a.speech
    # 자격 안내는 대상·자격을 물었을 때만(매번 붙이면 장황함)
    assert ("최종 판단" in a.speech) == ("대상" in q)
    assert "2026년 기준" in a.speech
    assert a.sources[0]["url"] == BOKJIRO
    assert a.service["dataOrigin"] == "official-api"


# ---------------------------------------------------------------- RAG


SERVICE = parse_welfare_detail(DETAIL, "https://www.bokjiro.go.kr/x", "2026-11-16")


class FakeProvider:
    mode = "official-api"

    def __init__(self, find=None):
        self._find = find or (lambda n: SERVICE if n == "장애인연금" else None)

    async def list_services(self, q=""):
        return [SERVICE]

    async def get_service(self, sid):
        return SERVICE

    async def find_service(self, name):
        return self._find(name)

    async def get_field_glossary(self, fid):
        return await FixtureWelfareDataProvider.from_file().get_field_glossary(fid)

    async def catalog(self, ctpv=None):
        return []


def rag_llm(reply):
    def fn(*, system, user, schemaName, schema):
        return reply(json.loads(user))

    return FakeLlm(fn=fn)


def test_chunk_sections():
    sections = list(dict.fromkeys(c["section"] for c in chunk_service(SERVICE)))
    assert sections == ["개요", "지원대상", "선정기준", "지원내용", "신청절차", "서식", "문의처", "근거법령"]


def test_retrieval_quality():
    r = evaluate_retrieval(SERVICE, load_rag_qa(), 3)
    assert r["recallAtK"] >= 0.9, r["misses"]
    assert r["mrr"] >= 0.8


async def test_amount_uses_cited_benefit_field_and_preserves_conditions():
    def never_called(_):
        raise AssertionError("금액 질문은 근거 필드로 답한다")

    a = await WelfareInformationAgent(FakeProvider(), rag_llm(never_called)).answer_question("장애인연금 한 달에 50만 원 받아?")
    assert a.method == "topic-rule"
    assert a.grounded and a.card["fields"] == ["benefit"]
    assert a.card["serviceId"] == SERVICE["servId"] and a.card["dataKind"] == "live"
    assert "349,700원" in a.card["answer"] and "50만" not in a.card["answer"]
    assert "2026" in a.card["dataDate"]
    assert "최종 판단" not in a.speech


async def test_rag_rejects_amount_from_an_uncited_field_or_question():
    def invented(u):
        wrong = next(chunk for chunk in u["근거"] if chunk["항목"] != "지원내용")
        return {"answerable": True, "answer": "1년에 349,700원을 받아요.", "usedChunkIds": [wrong["id"]]}

    a = await WelfareInformationAgent(FakeProvider(), rag_llm(invented)).answer_question("장애인연금 신청 절차 설명해줘")
    assert a.method == "topic-rule"
    assert a.verification and not a.verification["ok"]
    assert "1년에 349,700원" not in a.speech


async def test_rag_not_answerable():
    llm = rag_llm(lambda u: {"answerable": False, "answer": "", "usedChunkIds": []})
    a = await WelfareInformationAgent(FakeProvider(), llm).answer_question("장애인연금 받으면 교통비도 할인돼?")
    assert not a.grounded
    assert "찾지 못했습니다" in a.speech
    assert "129" in a.speech


def general_llm(answer):
    """공식 자료에 답이 없다고 한 뒤, '일반적으로 알려진' 답을 내는 가짜 LLM"""

    def fn(*, system, user, schemaName, schema):
        if schemaName == "general_answer":
            return {"known": True, "answer": answer}
        return {"answerable": False, "answer": "", "usedChunkIds": []}

    return FakeLlm(fn=fn)


async def test_general_answer_without_number_is_spoken():
    llm = general_llm("보통 매달 정해진 날에 계좌로 들어와요.")
    a = await WelfareInformationAgent(FakeProvider(), llm).answer_question("장애인연금 받으면 언제 돈이 들어와?")
    assert a.method == "general-llm"
    assert not a.grounded
    assert "공식 자료에는 그 내용이 없어요" in a.speech
    assert "보통 매달 정해진 날에 계좌로 들어와요." in a.speech


@pytest.mark.parametrize("answer", ["보통 매달 20일에 계좌로 들어와요.", "교통비는 한 달에 5만 원까지 할인돼요.", "신청하고 3개월쯤 걸려요."])
async def test_general_answer_with_number_is_not_spoken(answer):
    a = await WelfareInformationAgent(FakeProvider(), general_llm(answer)).answer_question("장애인연금 받으면 언제 돈이 들어와?")
    assert a.method == "rag-llm"
    assert not a.grounded
    assert "찾지 못했습니다" in a.speech
    assert "일반적으로 알려진 바로는" not in a.speech
    assert answer not in a.speech
    assert a.verification["ok"] is False


async def test_rag_unknown_chunk_ids_replaced():
    llm = rag_llm(lambda u: {"answerable": True, "answer": "아마 30만원쯤일 거예요.", "usedChunkIds": ["made-up#9"]})
    a = await WelfareInformationAgent(FakeProvider(), llm).answer_question("장애인연금 얼마 받아?")
    assert a.method == "topic-rule"
    assert "30만원쯤" not in a.speech


async def test_rag_follow_up_remembers_service():
    llm = rag_llm(lambda u: {"answerable": True, "answer": "거주지 읍면동 주민센터나 복지로에서 신청합니다.", "usedChunkIds": [u["근거"][0]["id"]]})
    agent = WelfareInformationAgent(FakeProvider(), llm)
    await agent.answer_question("장애인연금 대상이 누구야?")
    a = await agent.answer_question("그럼 어디서 신청해?")
    assert a.service["servNm"] == "장애인연금"
    assert a.retrieval["sections"][0] == "신청절차"


async def test_application_context_switches_service():
    other = {**SERVICE, "servId": "WLF-BASIC", "servNm": "기초연금"}
    p2 = FakeProvider(find=lambda n: other if n == "기초연금" else SERVICE if n == "장애인연금" else None)
    llm = rag_llm(lambda u: {"answerable": True, "answer": "답", "usedChunkIds": [u["근거"][0]["id"]]})
    agent = WelfareInformationAgent(p2, llm)
    await agent.answer_question("기초연금은 몇 살부터 받아?")
    await agent.application_context()
    assert (await agent.answer_question("소득이 조금 있어도 받을 수 있어?")).service["servNm"] == "장애인연금"


async def test_rule_answer_without_llm():
    a = await WelfareInformationAgent(FakeProvider()).answer_question("장애인연금 얼마 받아?")
    assert a.method == "topic-rule"
    assert "349,700원" in a.speech


# ---------------------------------------------------------------- fixture 근거·계약(welfare-and-contracts)

fixture_agent = WelfareInformationAgent(FixtureWelfareDataProvider.from_file())


async def test_explain_field_has_source():
    a = await fixture_agent.explain_field("incomeStatus", "소득·재산 신고")
    assert a.grounded
    assert a.sources[0]["url"].startswith("https://")
    assert a.sources[0]["lastCheckedAt"] == "2026-11-15"
    assert "출처" in a.speech


async def test_explain_unknown_field_no_guess():
    a = await fixture_agent.explain_field("unknownField", "알 수 없음")
    assert not a.grounded
    assert a.sources == []


async def test_policy_question_has_disclaimer():
    a = await fixture_agent.answer_policy_question("장애인연금 지원대상과 신청 절차 알려줘")
    assert "지원 대상" in a.speech
    assert "신청 방법" in a.speech
    assert "최종 판단" in a.speech


def test_profile_validators():
    assert not validate_address("부산").ok
    assert not validate_address("부산광역시 예시구").ok
    assert validate_address("부산광역시 예시구 예시로 10").ok
    m = match_option("없음", INCOME_OPTIONS)
    assert (m.ok, m.value) == (True, "신고할 소득·재산 없음")
    m = match_option("잘 모르겠어", INCOME_OPTIONS)
    assert (m.ok, m.value) == (True, "잘 모르겠음 (상담 필요)")
    assert not match_option("글쎄", INCOME_OPTIONS).ok
    p = create_mock_welfare_profile("http://localhost:5174")
    assert p.classify("http://localhost:5174/apply.html") == "mock-welfare"
    assert p.classify("https://www.bokjiro.go.kr/") == "external"


def test_contracts():
    assert parse_action({"id": "1", "type": "click", "reason": "x", "risk": "low", "requiresConfirmation": False, "x": 1}) is None
    AgentHandoff.model_validate(
        {
            "from": AGENT_IDS.welfare,
            "to": AGENT_IDS.web,
            "taskId": "t",
            "goal": "신청 페이지 열기",
            "targetUrl": "http://localhost:5174/apply.html",
            "sources": [],
            "requiresApprovedDomain": True,
            "domainApproved": True,
        }
    )
    assert parse_intent({"type": "FILL", "fills": []}) is None


def test_scenario_file_and_evaluator():
    f = load_scenario_file(DEMO_SCENARIO_PATH)
    assert [s.id for s in f.scenarios if is_active_pc(s)] == ["S1-normal-flow", "S2-field-validation", "S3-sensitive-auth-handoff", "S4-stop-cancel"]
    fake = {"state": "IDLE", "actions": [], "sources": [], "missingFields": [], "speech": "", "flags": {"masked": False, "secretDetected": False}}
    assert len(check_expectations(ScenarioStep(utterance="x", expect={"somethingNew": True}), fake, "[]")) == 1


@pytest.mark.parametrize("v,ok", [("김하늘", True), ("남궁민수", True), ("John Smith", True), ("음 그냥 좀 도와줄래", False), ("근데 이 신청하면", False), ("네", False), ("1234", False)])
def test_validate_name(v, ok):
    assert validate_name(v).ok is ok


# ---------------------------------------------------------------- 신청 기간("지금 신청할 수 있어?")


def _svc(**extra):
    return {
        "servId": "T1",
        "servNm": "시험지원금",
        "summary": "요약",
        "target": "대상",
        "applyMethod": "방문 신청",
        "source": {"title": "출처", "url": "https://example.com/x", "lastCheckedAt": "2026-11-18", "version": "API 실시간"},
        "dataOrigin": "official-api",
        "contacts": [{"name": "담당과", "value": "051-111-2222"}],
        **extra,
    }


async def test_deadline_open_from_enforcement_dates():
    s = _svc(enfcBgngYmd="20240101", enfcEndYmd="99991231")
    a = await WelfareInformationAgent(FakeProvider(find=lambda n: s)).answer_question("시험지원금 지금 신청할 수 있어?", today="2026-11-18")
    assert a.method == "topic-rule"
    assert a.grounded
    assert "신청할 수 있어요" in a.speech
    assert "신청할 수 없어요" not in a.speech


async def test_deadline_closed_from_enforcement_dates():
    s = _svc(enfcBgngYmd="20240101", enfcEndYmd="20241231")
    a = await WelfareInformationAgent(FakeProvider(find=lambda n: s)).answer_question("시험지원금 지금 신청할 수 있어?", today="2026-11-18")
    assert a.grounded
    assert "신청할 수 없어요" in a.speech


async def test_deadline_open_from_year_round_text():
    s = _svc(applyMethod="신청기간 : 연중 신청. 방문 또는 인터넷.")
    a = await WelfareInformationAgent(FakeProvider(find=lambda n: s)).answer_question("시험지원금 지금 신청할 수 있어?", today="2026-06-01")
    assert a.grounded
    assert "신청할 수 있어요" in a.speech


async def test_deadline_unknown_without_period_gives_contact():
    """중앙 상세처럼 기간 필드·문구가 없으면 예/아니오를 단정하지 않고 문의처만 안내."""
    a = await WelfareInformationAgent(FakeProvider()).answer_question("장애인연금 지금 신청할 수 있어?", today="2026-11-18")
    assert "확인하지 못" in a.speech
    assert "신청할 수 있어요" not in a.speech
    assert "신청할 수 없어요" not in a.speech
    assert "129" in a.speech


async def test_deadline_question_bypasses_llm():
    """기간 답은 LLM이 지어내지 못하게 규칙만 쓴다."""
    s = _svc(enfcBgngYmd="20200101", enfcEndYmd="20201231")
    llm = rag_llm(lambda u: {"answerable": True, "answer": "네, 지금 바로 신청할 수 있어요.", "usedChunkIds": [u["근거"][0]["id"]]})
    a = await WelfareInformationAgent(FakeProvider(find=lambda n: s), llm).answer_question("시험지원금 지금 신청할 수 있어?", today="2026-11-18")
    assert a.method == "topic-rule"
    assert "신청할 수 없어요" in a.speech
    assert "바로 신청할 수 있어요" not in a.speech


# ---------------------------------------------------------------- 직접 링크 확대(15090532 · 15108347 · 15083323)


def test_detail_mapping_extracts_related_sites_and_forms_for_central_and_local():
    central = parse_welfare_detail(DETAIL, BOKJIRO, "2026-11-16")
    assert central["relatedSites"] == [{"name": "보건복지상담센터", "url": "http://www.129.go.kr"}]
    assert len(central["forms"]) == 4
    assert all(f["url"].startswith("https://bokjiro.go.kr/") for f in central["forms"])

    local_xml = """<?xml version="1.0" encoding="UTF-8"?>
    <wantedDtl>
      <servId>WLF00006793</servId><servNm>첫째아 출산지원금</servNm><ctpvNm>부산광역시</ctpvNm>
      <bizChrDeptNm>해운대구 가족복지과</bizChrDeptNm><servDgst>출산지원금 지원</servDgst>
      <sprtTrgtCn>해운대구 거주 출산 가정</sprtTrgtCn><aplyMtdCn>행정복지센터 방문</aplyMtdCn>
      <inqplHmpgReldList><wlfareInfoReldNm>해운대구청</wlfareInfoReldNm><wlfareInfoReldCn>www.haeundae.go.kr</wlfareInfoReldCn></inqplHmpgReldList>
      <basfrmList><wlfareInfoReldNm>출산지원금 신청서.hwpx</wlfareInfoReldNm><wlfareInfoReldCn>https://www.bokjiro.go.kr/ssis-tbu/CmmFileUtil/getDownload.do?atcflId=LOCAL1&amp;atcflSn=1</wlfareInfoReldCn></basfrmList>
      <resultCode>0</resultCode><resultMessage>SUCCESS</resultMessage>
    </wantedDtl>"""
    local_detail = "https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=WLF00006793&wlfareInfoReldBztpCd=02"
    local = parse_welfare_detail(local_xml, local_detail, "2026-11-16")
    assert local["relatedSites"] == [{"name": "해운대구청", "url": "https://www.haeundae.go.kr"}]
    assert local["forms"] == [{"name": "출산지원금 신청서.hwpx", "url": "https://www.bokjiro.go.kr/ssis-tbu/CmmFileUtil/getDownload.do?atcflId=LOCAL1&atcflSn=1"}]


async def test_catalog_paginates_local_and_central_lists_when_total_count_exceeds_page(http_mock):
    def xml_page(total, rows, *, local=False):
        tag = "<ctpvNm>경기도</ctpvNm>" if local else ""
        items = "".join(
            f"<servList><servId>{sid}</servId><servNm>{name}</servNm>{tag}"
            f"<servDtlLink>https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId={sid}&amp;wlfareInfoReldBztpCd={'02' if local else '01'}</servDtlLink></servList>"
            for sid, name in rows
        )
        return f'<?xml version="1.0" encoding="UTF-8"?><wantedList><totalCount>{total}</totalCount><resultCode>0</resultCode>{items}</wantedList>'

    def handler(req: httpx.Request) -> httpx.Response:
        page = req.url.params.get("pageNo", "1")
        if req.url.path.endswith("LcgvWelfarelist"):
            rows = [("WLF00009001", "경기사업1")] if page == "1" else [("WLF00009002", "경기사업2")]
            return httpx.Response(200, text=xml_page(2, rows, local=True))
        return httpx.Response(200, text=xml_page(1, [("WLF00003249", "장애인연금")], local=False))

    calls = http_mock(handler)
    rows = await official().catalog("경기도")
    assert {r["servId"] for r in rows} == {"WLF00003249", "WLF00009001", "WLF00009002"}
    local_pages = [c.url.params["pageNo"] for c in calls if c.url.path.endswith("LcgvWelfarelist")]
    assert local_pages == ["1", "2"]


async def test_direct_links_combines_central_api_local_api_and_csv(http_mock):
    from cheongeum.agents.welfare.open_data import OpenData

    http_mock(list_or_detail)
    links = OpenData.load().links

    # 15090532 중앙 API: 복지로 상세 + 관련 사이트 + 다운로드 서식
    central_agent = WelfareInformationAgent(official(), links=links)
    bundle = await central_agent.direct_links("장애인연금", include_detail=True)
    assert bundle and bundle["detailUrl"] == BOKJIRO
    assert any(s["url"] == "http://www.129.go.kr" for s in bundle["relatedSites"])
    assert len(bundle["forms"]) == 4
    prep = await central_agent.prepare("장애인연금")
    assert prep.sources[0]["url"] == BOKJIRO
    assert any(s.get("note") == "관련 사이트" and s["url"] == "http://www.129.go.kr" for s in prep.sources)
    assert any(s.get("note") == "공식 서식 다운로드" and "getDownload.do" in s["url"] for s in prep.sources)

    # 15108347 지자체 API: 시·도·구 단서로 동명 지역 사업 구분, 다른 구·중복 사업은 추측하지 않음
    local_agent = WelfareInformationAgent(FixtureWelfareDataProvider.from_file(), links=links)
    busan_url = await local_agent.application_guide_url("부산 해운대구 첫째아 출산지원금")
    assert busan_url and "wlfareInfoId=WLF00006793" in busan_url
    inferred_url = await local_agent.application_guide_url("해운대구 첫째아 출산지원금")
    assert inferred_url == busan_url
    assert await local_agent.application_guide_url("부산 사상구 첫째아 출산지원금") is None
    assert await local_agent.application_guide_url("출산축하금", ctpv="부산광역시") is None
    assert "wlfareInfoId=WLF00006547" in (await local_agent.application_guide_url("부산진구 출산축하금") or "")

    # 15083323 중앙 CSV: API 목록이 비어도 복지로 상세와 관련 사이트를 직접 찾는다
    class EmptyProvider(FixtureWelfareDataProvider):
        async def catalog(self, ctpv=None):
            return []

    csv_agent = WelfareInformationAgent(EmptyProvider(FixtureWelfareDataProvider.from_file().data), links=links)
    childcare = await csv_agent.direct_links("아이돌봄서비스")
    assert childcare and "wlfareInfoId=WLF00000024" in childcare["detailUrl"]
    assert childcare["relatedSites"][0]["url"] == "https://idolbom.go.kr/"
    assert (await csv_agent.resolve_site_link("문화누리카드 열어줘"))["url"] == "https://www.mnuri.kr"
    assert (await csv_agent.resolve_site_link("아이돌봄서비스 관련 사이트 열어줘"))["url"] == "https://idolbom.go.kr/"
    assert (await csv_agent.resolve_guide_target("아이돌봄서비스 관련 사이트 찾아줘"))["url"] == "https://idolbom.go.kr/"
