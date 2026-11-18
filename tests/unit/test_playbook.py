"""막다른 길(차단·정책 거부·사람 도움)은 공식 번호와 다음 단계를 말한다. 자동화 금지 안내는 세션당 한 번."""
from cheongeum.agents.web import playbook
from cheongeum.agents.web.agent import WebOutcome
from cheongeum.agents.web.playbook import blocked_speech, help_human_speech
from cheongeum.agents.web.skills.common import outcome_failure


def test_help_human_says_cant_speaks_129_then_alternatives():
    said = help_human_speech()
    assert "전화" in said or "연결" in said
    assert "못" in said or "않" in said
    assert said.index("129") < said.index("대신") or said.index("129") < said.index("도와드릴")
    assert "129" in said
    # 2~3가지 대안
    assert sum(1 for tip in ("찾아", "읽", "신청", "열어", "검색") if tip in said) >= 2
    assert "다시 들려" in said or "다시 말씀" in said


def test_help_human_prefers_service_contact_over_129():
    said = help_human_speech(contact_name="국민연금공단", contact_number="1355", service_name="기초연금")
    assert "1355" in said
    assert "129" not in said.split("1355")[0]  # 번호는 1355가 먼저
    assert "기초연금" in said


def test_help_human_uses_gov24_playbook_number():
    said = help_human_speech(url="https://www.gov.kr/mw/AA020InfoServiceList.do")
    assert "1588-2188" in said


def test_blocked_bokjiro_ends_with_next_step_and_notice_once():
    given: set[str] = set()

    def once(key: str, text: str, short: str = "") -> str:
        if key in given:
            return short
        given.add(key)
        return text

    first = blocked_speech("https://www.bokjiro.go.kr/", once)
    second = blocked_speech("https://www.bokjiro.go.kr/", once)
    assert "막을" in first or "자동" in first
    assert "브라우저" in first and ("직접" in first or "찾아" in first)
    assert playbook.for_url("https://www.bokjiro.go.kr/").automation_notice in first
    assert playbook.for_url("https://www.bokjiro.go.kr/").automation_notice not in second
    assert "직접" in second or "찾아" in second


def test_policy_denied_ends_with_one_next_step():
    out = WebOutcome(
        status="policy-denied",
        actions=[],
        message="지원하지 않는 사이트라 읽기 전용입니다. 클릭할 수 없습니다.",
        view={"url": "https://www.gov.kr/", "pageId": "external", "title": "정부24"},
    )
    draft = outcome_failure(out, "BROWSING")
    speech = draft["speech"]
    assert "안전 규칙" in speech or "실행하지 않" in speech
    assert "본문 읽어줘" in speech or "검색" in speech or "이동" in speech
