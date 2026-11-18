"""조작 결과 말 세 갈래(확인됨 / 변화 없음 / 확인 못 함)와 fixture 출처 표기."""
from cheongeum.agents.web.effect import click_note, press_result, unconfirmed_message
from cheongeum.agents.web.skills.common import press_result as common_press_result
from cheongeum.agents.welfare.agent import WelfareInformationAgent, cite, source_sentence
from cheongeum.agents.welfare.data import FixtureWelfareDataProvider
from cheongeum.speech.phrasing import josa

fixture_agent = WelfareInformationAgent(FixtureWelfareDataProvider.from_file())


def test_press_result_confirmed_moved():
    assert press_result("'안내'를", "moved", moved="'안내' 링크를 열었습니다. 제목입니다.") == "'안내' 링크를 열었습니다. 제목입니다."
    assert common_press_result("'안내'를", "moved", moved="'안내' 링크를 열었습니다. 제목입니다.") == press_result(
        "'안내'를", "moved", moved="'안내' 링크를 열었습니다. 제목입니다."
    )


def test_press_result_confirmed_changed_with_and_without_reveal():
    assert press_result("'신청방법'을", "changed", revealed="창구 방문") == "'신청방법'을 눌렀어요. 새로 보이는 내용입니다. 창구 방문"
    assert press_result("'탭'을", "changed") == "'탭'을 눌렀어요. 같은 화면에서 내용이 바뀌었어요."


def test_press_result_nothing_changed():
    assert press_result("'글자 크게'를", "none") == "'글자 크게'를 눌렀지만 화면이 바뀌지 않았어요."


def test_unconfirmed_message_is_third_form():
    assert unconfirmed_message("눌렸는지") == "눌렸는지 확인하지 못했어요."
    assert unconfirmed_message("접수됐는지") == "접수됐는지 확인하지 못했어요."


def test_click_note_uses_three_way_forms_for_autopilot():
    """목표 수행(autopilot) 클릭 기록도 press_result 세 갈래를 쓴다(템플릿을 흩뿌리지 않음)."""
    pressed = josa("'글자 크게'", "을", "를")
    assert click_note("글자 크게", status="ok", effect="none") == press_result(pressed, "none")
    assert click_note("신청방법", status="ok", effect="changed", revealed="창구 방문") == press_result(
        josa("'신청방법'", "을", "를"), "changed", revealed="창구 방문"
    )
    assert click_note("안내", status="ok", effect="moved", title="공지") == press_result(
        josa("'안내'", "을", "를"), "moved", moved="'공지' 열림"
    )
    assert click_note("보내기", status="unconfirmed", message=unconfirmed_message("눌렸는지")) == unconfirmed_message("눌렸는지")


async def test_fixture_field_speech_says_saved_not_live_api():
    a = await fixture_agent.explain_field("incomeStatus", "소득·재산 신고")
    assert a.grounded
    assert "저장된 자료 기준" in a.speech
    assert "API 실시간" not in a.speech
    assert a.sources[0]["version"] == "저장된 자료 기준"


async def test_fixture_policy_speech_says_saved_not_live_api():
    a = await fixture_agent.answer_policy_question("장애인연금 지원대상과 신청 절차 알려줘")
    assert "저장된 자료 기준" in a.speech
    assert "API 실시간" not in a.speech
    assert all(s["version"] == "저장된 자료 기준" for s in a.sources)


async def test_fixture_catalog_source_not_labelled_live_api():
    a = await fixture_agent.discover({"age": 40, "disability": "severe", "income": "basic", "ctpv": None})
    assert a.sources
    assert a.sources[0]["version"] == "저장된 자료 기준"
    assert "API 실시간" not in a.sources[0]["version"]


async def test_api_fallback_catalog_source_not_labelled_live_api():
    """공식 API가 실패해 fixture로 대체된 뒤에도 목록 출처는 실시간처럼 말하지 않는다(C13)."""

    class FallbackProvider:
        mode = "official-api"
        last_error = "timeout"

        async def catalog(self, ctpv=None):
            return await FixtureWelfareDataProvider.from_file().catalog(ctpv)

    a = await WelfareInformationAgent(FallbackProvider()).discover(
        {"age": 40, "disability": "severe", "income": "basic", "ctpv": None}
    )
    assert a.sources[0]["version"] == "저장된 자료 기준"
    assert "API 실시간" not in a.sources[0]["version"]


def test_cite_rewrites_fixture_version_label():
    s = cite(
        {
            "title": "보건복지부 안내",
            "url": "https://example.com",
            "lastCheckedAt": "2026-11-15",
            "version": "fixture-v1",
            "note": "fixture 작성일 기준",
        }
    )
    assert s["version"] == "저장된 자료 기준"
    assert "저장된 자료 기준" in source_sentence(s)
    assert "fixture-v1" not in source_sentence(s)
