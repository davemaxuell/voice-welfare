"""맞춤 찾기의 사는 시·군·구: 다른 구·군 사업을 권하지 않고, 자격 미리 점검에서 거주 조건을 빠뜨리지 않는다."""
import pytest
from conftest import FakeLlm

from cheongeum.agents.welfare import (
    WelfareInformationAgent,
    match_services,
    next_profile_slot,
    parse_profile_answer,
    profile_question,
)
from cheongeum.agents.welfare.agent import speak_answer_card
from cheongeum.agents.welfare.discovery import residence_status
from cheongeum.agents.welfare.data import FixtureWelfareDataProvider, fixture_catalog

GIJANG_TRANSPORT = "WLF00005911"
SAID = "68세, 심한 장애, 차상위, 부산 사상구에 사는데 이동이 힘든데 받을 수 있는 복지 찾아줘"
BUSAN_ONLY = {"age": 68, "disability": "severe", "income": "near-poor", "ctpv": "부산광역시"}
LEFT_OUT = "다른 시·군·구 사업은 뺐어요"


class LocalDetailProvider(FixtureWelfareDataProvider):
    """지자체 상세를 돌려주는 가짜 공식 API(복지로 WLF00005911을 본뜬 합성 자료)."""

    mode = "official-api"

    async def get_local_service(self, serv_id, detail_url=""):
        return {
            "servId": serv_id,
            "servNm": "부산광역시 기장군 저소득 중증장애인 교통비 지원",
            "summary": "저소득 중증장애인의 이동을 돕는 교통비 지원",
            "target": "신청일 현재 기장군에 주민등록을 둔 차상위 이하 저소득 장애 정도가 심한 장애인(시설 입소자 제외)",
            "criteria": "",
            "applyMethod": "주소지 읍·면 행정복지센터 방문 신청",
            "applySteps": [],
            "contacts": [{"name": "노인장애인복지과", "value": "051-000-0000"}],
            "forms": [{"name": "기장군 저소득 중증장애인 교통비 지원 조례.hwp", "url": "https://example.invalid/f"}],
            "source": {"title": "복지로 '기장군 교통비'", "url": detail_url or "https://example.invalid/d",
                       "lastCheckedAt": "2026-11-19", "version": "API 실시간"},
            "dataOrigin": "official-api",
        }


def heard(answer) -> str:
    """오케스트레이터는 카드가 있으면 카드를 읽는다(_welfare_draft)."""
    return speak_answer_card(answer.card) if answer.card else answer.speech


def _precheck_llm() -> FakeLlm:
    # L3.3에서 본 답: 차상위·심한 장애만 비교하고 거주 조건은 빠뜨림
    return FakeLlm({"precheck": {"checks": [
        {"condition": "차상위", "status": "met", "note": ""},
        {"condition": "장애 정도가 심한 장애인", "status": "met", "note": ""},
    ]}})


def test_profile_keeps_district_said_after_province():
    p = parse_profile_answer(SAID)
    assert (p["ctpv"], p.get("sgg")) == ("부산광역시", "사상구")
    # 시·도 뒤에 붙지 않은 '가구'는 사는 곳이 아니다
    assert parse_profile_answer("부산 살고 1인 가구예요").get("sgg") is None


def test_other_district_program_is_never_recommended():
    catalog = fixture_catalog("부산광역시")
    sasang = match_services(catalog, parse_profile_answer(SAID))
    assert GIJANG_TRANSPORT not in [m.service["servId"] for m in sasang]
    assert all((m.service.get("region") or {}).get("sgg") in (None, "사상구", "부산광역시교육청") for m in sasang)

    gijang = match_services(catalog, {**BUSAN_ONLY, "sgg": "기장군"})
    assert gijang[0].service["servId"] == GIJANG_TRANSPORT
    assert "기장군 지역" in gijang[0].reasons


async def test_list_says_once_that_other_district_programs_were_left_out():
    agent = WelfareInformationAgent(FixtureWelfareDataProvider.from_file())
    sasang = {**BUSAN_ONLY, "sgg": "사상구"}
    first = (await agent.discover(sasang)).speech
    assert first.count(LEFT_OUT) == 1
    pages = [agent.more_matches().speech]
    while not pages[-1].startswith("찾은 제도를 모두"):
        pages.append(agent.more_matches().speech)
    assert not any(LEFT_OUT in page for page in pages)
    # 같은 대화에서 다시 찾아도 다시 말하지 않는다
    assert LEFT_OUT not in (await agent.discover(sasang)).speech


@pytest.mark.parametrize("profile", [
    BUSAN_ONLY,  # 사는 구를 모르면 다른 구 사업을 빼지 않는다
    {**BUSAN_ONLY, "ctpv": "서울특별시", "sgg": "중구"},  # 저장 자료에 서울 구 사업이 없어 뺀 것이 없다
])
async def test_list_does_not_mention_left_out_programs_when_none_were(profile):
    agent = WelfareInformationAgent(FixtureWelfareDataProvider.from_file())
    assert LEFT_OUT not in (await agent.discover(profile)).speech


@pytest.mark.parametrize("said, ctpv, area", [
    ("사상구에 살아요", "부산광역시", "사상구"),
    ("기장군이요", "부산광역시", "기장군"),
    ("부산에 살고 중구예요", "부산광역시", "중구"),  # 말한 시·도 안의 구
    ("분당구 살아요", "경기도", "성남시"),  # 일반구는 복지 사업을 하는 시의 주민이다
])
def test_bare_official_district_name_is_where_the_user_lives(said, ctpv, area):
    p = parse_profile_answer(said)
    assert p["ctpv"] == ctpv
    # 그 시·군·구 사업은 사는 곳 사업으로, 이웃 구 사업은 다른 곳 사업으로 본다
    assert residence_status({"provider": "local", "region": {"ctpv": ctpv, "sgg": area}}, p) == "met"
    assert residence_status({"provider": "local", "region": {"ctpv": ctpv, "sgg": "영도구"}}, p) == "unmet"


@pytest.mark.parametrize("said", ["1인 가구예요", "혼자 사는 1인 가구고 도시에 살아요", "부산 살고 분당구예요", "광주시에 살아요"])
def test_word_that_is_not_an_official_district_of_the_province_is_not_a_district(said):
    # '가구'·'도시'는 공식 시·군·구 이름이 아니고, 분당구는 부산에 없다(말한 시·도를 따른다).
    # '광주시'는 경기도 광주시인지 광주광역시인지 모른다.
    p = parse_profile_answer(said)
    assert p.get("sgg") is None
    assert p.get("ctpv") in (None, "부산광역시")


@pytest.mark.parametrize("name, asked", [("중구", "어느 시의 중구인가요?"), ("고성군", "어느 도의 고성군인가요?")])
def test_shared_district_name_asks_which_province_once_it_is_time(name, asked):
    so_far = {"age": 70, "disability": "no", "income": "near-poor", **parse_profile_answer(f"{name} 살아요")}
    assert profile_question(next_profile_slot(so_far), so_far) == asked


def test_answer_to_which_city_keeps_the_district_only_if_that_city_has_it():
    so_far = {"age": 70, "disability": "no", "income": "near-poor", **parse_profile_answer("중구 살아요")}
    busan = {**so_far, **parse_profile_answer("부산이요", "ctpv", so_far)}
    assert residence_status({"provider": "local", "region": {"ctpv": "부산광역시", "sgg": "중구"}}, busan) == "met"
    assert residence_status({"provider": "local", "region": {"ctpv": "부산광역시", "sgg": "영도구"}}, busan) == "unmet"
    # 경기도에는 중구가 없다: 구를 버려 경기도의 시·군 사업을 모두 빼지 않는다
    gyeonggi = {**so_far, **parse_profile_answer("경기도요", "ctpv", so_far)}
    assert residence_status({"provider": "local", "region": {"ctpv": "경기도", "sgg": "성남시"}}, gyeonggi) == "unknown"


def test_known_province_settles_a_shared_district_name():
    p = parse_profile_answer("중구 살아요", "age", {"ctpv": "부산광역시"})
    assert residence_status({"provider": "local", "region": {"ctpv": "부산광역시", "sgg": "중구"}}, {"ctpv": "부산광역시", **p}) == "met"


async def test_unknown_district_ranks_district_programs_lower_and_names_their_district():
    agent = WelfareInformationAgent(FixtureWelfareDataProvider.from_file())
    heard_list = [(await agent.discover(BUSAN_ONLY)).speech]
    while not heard_list[-1].startswith("찾은 제도를 모두"):
        heard_list.append(agent.more_matches().speech)
    # 사는 구·군을 모르면 기장군 사업이 지역 점수로 장애인연금을 앞지르지 않는다
    assert "1번 장애인연금" in heard_list[0]
    # 부산진구 사업 '저소득노인 건강보험료 지원'은 이름에 구가 없어 목록에서 구를 붙여 말한다
    assert "부산진구 저소득노인 건강보험료 지원" in " ".join(heard_list)


@pytest.mark.parametrize("home, word", [
    ("사상구", "기장군 거주: 맞지 않을 수 있어요"),
    ("기장군", "기장군 거주: 말씀하신 대로면 맞아요"),
    (None, "기장군 거주: 확인이 필요해요"),
])
async def test_precheck_surfaces_the_residence_gate(home, word):
    agent = WelfareInformationAgent(LocalDetailProvider.from_file(), llm=_precheck_llm())
    await agent.discover(BUSAN_ONLY)
    profile = {**BUSAN_ONLY, **({"sgg": home} if home else {})}
    said = heard(await agent.precheck("기장군 저소득 중증장애인 교통비", profile))
    assert word in said
    # 사용자가 말한 장애 정도는 공식 판정이 아니다
    assert "장애 정도가 심한 장애인: 맞아요" not in said
    assert "장애 정도가 심한 장애인: 말씀하신 대로면 맞아요" in said
    assert "공식 판정" in said


class DurationDetailProvider(LocalDetailProvider):
    """거주 기간 조건이 있는 지자체 사업(합성)."""

    async def get_local_service(self, serv_id, detail_url=""):
        detail = await super().get_local_service(serv_id, detail_url)
        return {**detail, "target": "신청일 현재 기장군에 주민등록을 두고 기장군에 1년 이상 거주했거나 전입 후 6개월이 지난 차상위 이하 저소득 장애 정도가 심한 장애인"}


@pytest.mark.parametrize("duration", ["기장군에 1년 이상 거주", "전입 후 6개월"])
async def test_precheck_keeps_length_of_residence_from_the_model(duration):
    llm = FakeLlm({"precheck": {"checks": [
        {"condition": "기장군에 주민등록", "status": "met", "note": ""},
        {"condition": duration, "status": "met", "note": ""},
        {"condition": "차상위", "status": "met", "note": ""},
    ]}})
    agent = WelfareInformationAgent(DurationDetailProvider.from_file(), llm=llm)
    await agent.discover(BUSAN_ONLY)
    said = heard(await agent.precheck("기장군 저소득 중증장애인 교통비", {**BUSAN_ONLY, "sgg": "기장군"}))
    # 규칙의 거주 확인이 먼저, 같은 말을 되풀이한 주민등록 조건은 빼고, 사용자가 말한 적 없는 거주 기간은 확인이 필요하다
    assert f"기장군 거주: 말씀하신 대로면 맞아요. {duration}: 확인이 필요해요. 차상위: 말씀하신 대로면 맞아요" in said
    assert "주민등록" not in said


async def test_precheck_without_official_criteria_still_names_residence():
    agent = WelfareInformationAgent(FixtureWelfareDataProvider.from_file())
    await agent.discover(BUSAN_ONLY)
    answer = await agent.precheck("기장군 저소득 중증장애인 교통비", {**BUSAN_ONLY, "sgg": "사상구"})
    assert "기장군 거주: 맞지 않을 수 있어요" in heard(answer)


async def test_prepare_does_not_call_attachments_required_forms():
    agent = WelfareInformationAgent(LocalDetailProvider.from_file())
    await agent.discover(BUSAN_ONLY)
    said = heard(await agent.prepare("기장군 저소득 중증장애인 교통비"))
    assert "필요한 서식" not in said
    assert "서식·자료" in said
