import pytest

from ieum.agents.web import create_mock_welfare_profile, field_vocabulary
from ieum.safety import PolicyConfig, PolicyContext, PolicyGuard
from ieum.understanding import IntentContext, RuleBasedIntentProvider, clean_value, is_stop_utterance, resolve_site

parser = RuleBasedIntentProvider(field_vocabulary(create_mock_welfare_profile("http://localhost:5174")))


def parse(t: str, state: str = "APPLICATION_OPEN", awaiting: str | None = None) -> dict:
    return parser.parse_sync(t, IntentContext(state=state, awaitingFieldId=awaiting))


@pytest.mark.parametrize(
    "text,type_",
    [
        ("장애인연금 신청 도와줘", "START_APPLICATION"),
        ("신청 페이지를 열어줘", "START_APPLICATION"),
        ("주소 다시 읽어줘", "READ_FIELD"),
        ("다음으로", "NEXT"),
        ("이전으로", "PREV"),
        ("이 항목은 무슨 뜻이야?", "EXPLAIN"),
        ("지금까지 쓴 내용 읽어줘", "REVIEW"),
        ("모의 접수 내용을 확인했어", "PREPARE_SUBMIT"),
        ("최종 확인할게", "PREPARE_SUBMIT"),
        ("제출해", "PREPARE_SUBMIT"),
        ("모의접수 승인", "APPROVE"),
        ("승인 안 해", "REJECT"),
        ("멈춰", "STOP"),
        ("다시 시작", "RESUME"),
        ("로그인하고 싶어", "LOGIN"),
        ("주소 수정할게", "EDIT_FIELD"),
        ("현재 단계 알려줘", "CURRENT_STEP"),
        ("화면 설명해줘", "DESCRIBE_SCREEN"),
        ("지금 화면에 뭐가 있어?", "DESCRIBE_SCREEN"),
        ("장애인연금 신청 화면 설명해줘", "DESCRIBE_SCREEN"),
        ("장애인연금 지원대상과 신청 절차 알려줘", "POLICY_QUESTION"),
        ("상담원 연결해줘", "HELP_HUMAN"),
        ("오늘 날씨 어때", "UNKNOWN"),
    ],
)
def test_intents(text, type_):
    assert parse(text)["type"] == type_


def test_field_and_value_split():
    assert parse("이름은 김하늘") == {"type": "FILL", "fills": [{"fieldMention": "이름", "value": "김하늘"}]}
    assert parse("주소는 부산광역시 예시구 예시로 10") == {
        "type": "FILL",
        "fills": [{"fieldMention": "주소", "value": "부산광역시 예시구 예시로 10"}],
    }
    assert parse("이름은 김하늘이야")["fills"][0]["value"] == "김하늘"


def test_multiple_fields_in_one_sentence():
    r = parse("이름은 김하늘, 주소는 부산광역시 예시구 예시로 10")
    assert r["type"] == "FILL"
    assert [f["fieldMention"] for f in r["fills"]] == ["이름", "주소"]


def test_specific_alias_beats_generic():
    assert parse("실거주지 주소는 서울특별시 예시구 예시로 5")["fills"] == [
        {"fieldMention": "실거주지 주소", "value": "서울특별시 예시구 예시로 5"}
    ]


def test_edit_with_value_is_fill():
    r = parse("주소 수정해 부산광역시 예시구 예시로 20")
    assert r == {"type": "FILL", "fills": [{"fieldMention": "주소", "value": "부산광역시 예시구 예시로 20"}]}


def test_awaiting_value_long_address_not_navigation():
    assert parse("서울특별시 이전구 다음로 3", "AWAITING_FIELD_VALUE", "address")["type"] == "UNKNOWN"


def test_stop_is_rule_based():
    assert is_stop_utterance("잠깐 멈춰")
    assert is_stop_utterance("취소")
    assert not is_stop_utterance("멈추지 마")


def test_clean_value():
    assert clean_value('"김하늘"이라고 써줘') == "김하늘"
    assert clean_value("3명으로 해줘") == "3명"


@pytest.mark.parametrize(
    "text,n",
    [
        ("이름은 김하늘이고 주소는 부산광역시 예시구 예시로 10, 다음으로 넘어가줘", 3),
        ("복지로 열어줘 그리고 기초연금 검색해줘", 2),
        ("이름은 김하늘", 1),
    ],
)
def test_split_commands(text, n):
    assert len(parser.split_commands(text)) == n


def test_rephrase():
    assert parse("무슨 말이야?")["type"] == "REPHRASE"
    assert parse("다시 말해줘")["type"] == "REPHRASE"
    assert parse("주소 다시 말해줘")["type"] == "READ_FIELD"


# ---------------------------------------------------------------- 웹 읽기 명령(browsing-rules)


def bparse(t: str) -> dict:
    return parser.parse_sync(t, IntentContext(state="BROWSING"))


@pytest.mark.parametrize(
    "text,expected",
    [
        ("복지로 열어줘", {"type": "OPEN_SITE"}),
        ("정부24 들어가줘", {"type": "OPEN_SITE"}),
        ("gov.kr 열어줘", {"type": "OPEN_SITE"}),
        ("모의 사이트 열어줘", {"type": "OPEN_SITE"}),
        ("본문 읽어줘", {"type": "READ_MAIN", "more": False}),
        ("계속 읽어줘", {"type": "READ_MAIN", "more": True}),
        ("링크 목록 알려줘", {"type": "LIST_LINKS", "more": False}),
        ("링크 더 알려줘", {"type": "LIST_LINKS", "more": True}),
        ("장애인연금 안내 링크 눌러줘", {"type": "FOLLOW_LINK", "name": "장애인연금 안내"}),
        ("'자세히 보기' 눌러줘", {"type": "FOLLOW_LINK", "name": "자세히 보기"}),
        ("뒤로 가줘", {"type": "PREV"}),
        ("장애인연금 검색해줘", {"type": "SEARCH", "query": "장애인연금"}),
        ("복지로에서 기초연금 검색해줘", {"type": "SEARCH", "query": "기초연금", "site": "복지로"}),
    ],
)
def test_browsing_commands(text, expected):
    r = bparse(text)
    assert {k: r.get(k) for k in expected} == expected


def test_browsing_does_not_clash():
    assert bparse("지금까지 쓴 내용 읽어줘")["type"] == "REVIEW"
    assert bparse("장애인연금 신청 도와줘")["type"] == "START_APPLICATION"
    assert bparse("신청 페이지를 열어줘")["type"] == "START_APPLICATION"
    assert bparse("로그인 페이지 열어줘")["type"] == "LOGIN"


def test_resolve_site():
    assert resolve_site("복지로 열어줘")["url"] == "https://www.bokjiro.go.kr"
    assert resolve_site("국민연금공단 사이트")["url"] == "https://www.nps.or.kr"
    assert resolve_site("gov.kr 열어줘")["url"] == "https://gov.kr"
    assert resolve_site("127.0.0.1:5174/external.html 열어줘")["url"] == "http://127.0.0.1:5174/external.html"
    assert resolve_site("우리동네복지관 열어줘") is None


def test_resolve_site_stt_variants():
    assert resolve_site("Naver 열어줘")["url"] == "https://www.naver.com"
    assert resolve_site("네이보 열어줘")["url"] == "https://www.naver.com"
    assert resolve_site("복지루 들어가줘")["url"] == "https://www.bokjiro.go.kr"
    assert resolve_site("naver news 열어줘")["url"] == "https://news.naver.com"
    assert resolve_site("우리동네복지관 열어줘") is None


# ---------------------------------------------------------------- PolicyGuard 읽기 전용 등급

ALL_TYPES = ["navigate", "back", "click", "fill", "press", "select", "check", "scroll", "read", "focus"]
ro_guard = PolicyGuard(
    PolicyConfig(
        allowedOrigins=["http://localhost:5174"],
        allowedActionTypes=ALL_TYPES,
        allowedFieldIds=["applicantName"],
        secretFieldIds=["loginPassword"],
        maxActionsPerTurn=10,
        readOnlyWeb=True,
    )
)
RO_CTX = PolicyContext(currentUrl="https://example.org/", stopped=False, approvals=set(), actionsThisTurn=0)


def a(**p) -> dict:
    return {"id": "x", "type": "click", "reason": "t", "risk": "low", "requiresConfirmation": False, **p}


def test_tiers():
    assert ro_guard.tier_of("http://localhost:5174/apply.html") == "full"
    assert ro_guard.tier_of("https://www.bokjiro.go.kr/") == "read-only"
    assert ro_guard.tier_of("file:///etc/passwd") == "none"
    assert ro_guard.tier_of("javascript:alert(1)") == "none"


@pytest.mark.parametrize(
    "name,action,code",
    [
        ("다른 사이트로 이동", a(type="navigate", url="https://www.gov.kr/"), "ALLOWED_READ_ONLY"),
        ("링크 클릭", a(target={"role": "link", "name": "복지서비스"}), "ALLOWED_READ_ONLY"),
        ("뒤로", a(type="back"), "ALLOWED_READ_ONLY"),
        ("검색창 입력", a(type="fill", target={"role": "searchbox", "fieldId": "q"}, value="장애인연금"), "ALLOWED_READ_ONLY"),
        ("검색 실행", a(type="press", target={"role": "searchbox", "fieldId": "q"}, value="Enter"), "ALLOWED_READ_ONLY"),
        ("버튼 클릭", a(target={"role": "button", "name": "보내기"}), "DENIED_READ_ONLY"),
        ("일반 입력란", a(type="fill", target={"label": "이름", "fieldId": "n"}, value="김하늘"), "DENIED_READ_ONLY"),
        ("선택", a(type="select", target={"fieldId": "s"}, value="1"), "DENIED_READ_ONLY"),
        ("Enter 외 키", a(type="press", target={"role": "searchbox", "fieldId": "q"}, value="Tab"), "DENIED_READ_ONLY"),
        ("검색어에 주민번호", a(type="fill", target={"role": "searchbox", "fieldId": "q"}, value="900101-1234567"), "DENIED_SECRET"),
        ("중요 동작", a(target={"role": "link", "name": "x"}, risk="consequential", requiresConfirmation=True), "DENIED_READ_ONLY"),
        ("파일 주소 이동", a(type="navigate", url="file:///etc/hosts"), "DENIED_ORIGIN"),
    ],
)
def test_read_only_policy(name, action, code):
    assert ro_guard.check(action, RO_CTX)["code"] == code


def test_read_only_off_means_supported_sites_only():
    strict = PolicyGuard(PolicyConfig(**{**ro_guard.config.__dict__, "readOnlyWeb": False}))
    assert strict.tier_of("https://www.gov.kr/") == "none"


assist_guard = PolicyGuard(
    PolicyConfig(
        allowedOrigins=["http://localhost:5174"],
        allowedActionTypes=ALL_TYPES,
        allowedFieldIds=[],
        secretFieldIds=[],
        maxActionsPerTurn=10,
        readOnlyWeb=True,
    )
)
BASE = {
    "id": "f1",
    "type": "fill",
    "target": {"fieldId": "x", "name": "이름"},
    "value": "김하늘",
    "reason": "t",
    "risk": "sensitive",
    "requiresConfirmation": True,
}


def actx(approved: bool) -> PolicyContext:
    return PolicyContext(currentUrl="https://example.org/", approvals={"f1"} if approved else set())


def test_assist_needs_approval():
    assert assist_guard.check(BASE, actx(False))["code"] == "NEEDS_CONFIRMATION"
    assert assist_guard.check(BASE, actx(True))["code"] == "APPROVED"


def test_assist_secret_always_denied():
    assert assist_guard.check({**BASE, "target": {"fieldId": "p", "name": "비밀번호"}}, actx(True))["code"] == "DENIED_SECRET"
    assert assist_guard.check({**BASE, "value": "900101-1234567"}, actx(True))["code"] == "DENIED_SECRET"


def test_assist_low_risk_input_denied():
    assert assist_guard.check({**BASE, "risk": "low", "requiresConfirmation": False}, actx(True))["code"] == "DENIED_READ_ONLY"
