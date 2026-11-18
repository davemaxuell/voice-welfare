import pytest

from cheongeum.safety import (
    PolicyConfig,
    PolicyContext,
    PolicyGuard,
    detect_sensitive,
    mask_value,
    redact_text,
    set_pii_model,
    spoken_digit_spans,
)
from cheongeum.safety.pii_model import merge_bio

ORIGIN = "http://localhost:5174"
guard = PolicyGuard(
    PolicyConfig(
        allowedOrigins=[ORIGIN],
        allowedActionTypes=["navigate", "click", "fill", "select", "check", "read"],
        allowedFieldIds=["applicantName", "address"],
        secretFieldIds=["loginPassword"],
        maxActionsPerTurn=3,
    )
)


def ctx(**p) -> PolicyContext:
    return PolicyContext(**{"currentUrl": f"{ORIGIN}/apply.html", "stopped": False, "approvals": set(), "actionsThisTurn": 0, **p})


def action(**p) -> dict:
    out = {
        "id": "a1",
        "type": "fill",
        "target": {"label": "성명", "fieldId": "applicantName"},
        "value": "김하늘",
        "reason": "test",
        "risk": "low",
        "requiresConfirmation": False,
        **p,
    }
    return {k: v for k, v in out.items() if v is not None}


def test_allowed_low_risk_fill():
    assert guard.check(action(), ctx())["code"] == "ALLOWED"


def test_schema_mismatch_denied():
    assert guard.check({"type": "fill", "coords": [10, 20]}, ctx())["code"] == "DENIED_SCHEMA"
    assert guard.check({**action(), "type": "eval"}, ctx())["code"] == "DENIED_SCHEMA"


def test_origin_outside_allowlist_denied():
    assert guard.check(action(type="navigate", url="https://www.bokjiro.go.kr/", target=None, value=None), ctx())["code"] == "DENIED_ORIGIN"
    assert guard.check(action(), ctx(currentUrl="https://evil.example/"))["code"] == "DENIED_ORIGIN"


def test_secret_field_and_values_always_denied():
    assert guard.check(action(target={"label": "비밀번호", "fieldId": "loginPassword"}), ctx())["code"] == "DENIED_SECRET"
    assert guard.check(action(target={"label": "비밀번호", "fieldId": "applicantName"}), ctx())["code"] == "DENIED_SECRET"
    assert guard.check(action(value="900101-1234567"), ctx())["code"] == "DENIED_SECRET"


def test_unknown_field_denied():
    assert guard.check(action(target={"label": "기타", "fieldId": "other"}), ctx())["code"] == "DENIED_FIELD"


def test_consequential_needs_prior_approval():
    submit = action(id="s1", type="click", target={"role": "button", "name": "모의접수"}, value=None, risk="consequential", requiresConfirmation=True)
    assert guard.check(submit, ctx())["code"] == "NEEDS_CONFIRMATION"
    assert guard.check(submit, ctx(approvals={"other"}))["code"] == "NEEDS_CONFIRMATION"
    assert guard.check(submit, ctx(approvals={"s1"}))["code"] == "APPROVED"


def test_risky_button_on_supported_site_needs_approval_whatever_the_declared_risk():
    g = PolicyGuard(
        PolicyConfig(
            allowedOrigins=[ORIGIN],
            allowedActionTypes=["click"],
            allowedFieldIds=[],
            secretFieldIds=[],
            maxActionsPerTurn=3,
            safeButtons=["다음", "이전", "닫기", "확인"],
        )
    )

    def click(role: str, name: str) -> dict:
        return action(id="c1", type="click", target={"role": role, "name": name}, value=None)

    assert g.check(click("button", "모의접수"), ctx())["code"] == "NEEDS_CONFIRMATION"
    assert g.check(click("button", "모의 로그인"), ctx())["code"] == "NEEDS_CONFIRMATION"
    assert g.check(click("button", "모의접수"), ctx(approvals={"c1"}))["code"] == "APPROVED"
    assert g.check(click("button", "다음"), ctx())["code"] == "ALLOWED"
    assert g.check(click("button", "확인"), ctx())["code"] == "ALLOWED"
    assert g.check(click("link", "장애인연금 모의 신청하기"), ctx())["code"] == "ALLOWED"


def test_stopped_and_rate_limit():
    assert guard.check(action(), ctx(stopped=True))["code"] == "DENIED_STOPPED"
    assert guard.check(action(), ctx(actionsThisTurn=3))["code"] == "DENIED_RATE_LIMIT"


@pytest.mark.parametrize(
    "text,secret",
    [
        ("비밀번호는 123456이야", True),
        ("비밀번호는 직접 입력할게", False),
        ("주민번호 900101-1234567", True),
        ("9001011234567", True),
        ("OTP 482913", True),
        ("계좌번호는 110-123-456789", True),
        ("로그인하고 싶어", False),
        ("주소는 부산광역시 예시구 예시로 10", False),
        ("연락처는 010-1234-5678", False),
        # 한글로 읽은 숫자, 키워드 뒤의 낱말 비밀번호, 외국어 키워드
        ("비밀번호는 일이삼사", True),
        ("비밀번호는 사과나무야", True),
        ("비밀번호는 사과나무로 할게", True),
        ("비밀번호 알려줄게 사과나무", True),
        ("인증번호는 칠칠칠팔팔팔", True),
        ("주민번호 구공공일공일 일이삼사오육칠", True),
        ("구공공일공일 일이삼사오육칠", True),
        ("구공공일공일 일이삼사오육칠 이에요", True),
        ("my password is 1234", True),
        ("密码是1234", True),
        ("パスワードは1234です", True),
        # 비밀번호에 "대해" 하는 말, 비슷한 낱말, 한글로 읽은 전화번호
        ("비밀번호 칸이 어디야", False),
        ("비밀번호를 잊어버렸어", False),
        ("비밀번호 재설정 페이지 열어줘", False),
        ("비밀번호 입력해줘", False),
        ("비밀번호가 뭐야", False),
        ("비밀번호 이거 뭐야", False),
        ("비밀번호 알려줄게", False),
        ("비밀번호요?", False),
        ("인증번호 어디서 받아", False),
        ("오늘 비번이야", False),
        ("암호화폐 지원금 알려줘", False),
        ("이사 가고 싶어", False),
        ("사이사이에 넣어줘", False),
        ("연락처는 공일공 일이삼사 오육칠팔", False),
    ],
)
def test_detect_sensitive(text, secret):
    assert detect_sensitive(text).hasSecretValue is secret


def test_redact():
    assert redact_text("비밀번호는 123456이야") == "비밀번호 [비공개]"
    assert "1234567" not in redact_text("주민번호 900101-1234567 입니다")
    assert redact_text("이름은 김하늘") == "이름은 김하늘"
    assert redact_text("비밀번호는 사과나무야") == "비밀번호 [비공개]"
    # 한글로 읽은 주민번호는 원래 낱말을 가린다. 전화번호는 그대로(입력에 쓰임)
    assert redact_text("구공공일공일 일이삼사오육칠 입니다") == "[비공개] 입니다"
    assert "일이삼사오육칠" not in redact_text("구공공일공일 일이삼사오육칠 이에요")
    assert redact_text("연락처는 공일공 일이삼사 오육칠팔") == "연락처는 공일공 일이삼사 오육칠팔"


def test_spoken_digit_spans():
    assert [d for _s, _e, d in spoken_digit_spans("공일공 일이삼사, 이사 가요")] == ["0101234"]


class FakeFinder:
    """개인정보 인식 모델 대신: '사과나무'를 비밀번호로 본다."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def secret_spans(self, text: str):
        self.calls.append(text)
        i = text.find("사과나무")
        return [("password", i, i + 4)] if i >= 0 else []


@pytest.fixture
def finder():
    f = FakeFinder()
    set_pii_model(f)
    yield f
    set_pii_model(None)


def test_model_union_with_rules(finder):
    # 키워드 없이 말한 값도 모델이 잡는다(규칙 ∪ 모델)
    d = detect_sensitive("오늘은 사과나무 라고 해")
    assert d.hasSecretValue is True and d.kinds == ["password"]
    assert redact_text("오늘은 사과나무 라고 해") == "오늘은 [비공개] 라고 해"
    # 규칙만 요청하면 모델을 부르지 않는다(PolicyGuard)
    finder.calls.clear()
    assert detect_sensitive("오늘은 사과나무 라고 해", model=False).hasSecretValue is False
    assert finder.calls == []
    # 한국어 모델이라 한글 없는 글은 보내지 않는다
    detect_sensitive("hello world")
    assert finder.calls == []


def test_guard_uses_rules_only(finder):
    finder.calls.clear()
    assert guard.check(action(value="사과나무"), ctx())["code"] == "ALLOWED"
    assert finder.calls == []


def test_model_error_falls_back_to_rules():
    class Broken:
        def secret_spans(self, text):
            raise RuntimeError("boom")

    set_pii_model(Broken())
    try:
        assert detect_sensitive("비밀번호는 1234").hasSecretValue is True
        assert detect_sensitive("이름은 김하늘").hasSecretValue is False
    finally:
        set_pii_model(None)


def test_merge_bio():
    tags = [
        ("B-NAME", 0.9, 0, 2),
        ("I-NAME", 0.7, 2, 3),
        ("O", 0.99, 4, 6),
        ("I-PHONE", 0.8, 7, 10),
        ("I-PHONE", 0.6, 11, 15),
        ("B-SECRET", 0.5, 16, 20),
        ("B-SECRET", 0.9, 21, 25),
    ]
    spans = merge_bio(tags)
    assert [(s.label, s.start, s.end) for s in spans] == [("NAME", 0, 3), ("PHONE", 7, 15), ("SECRET", 16, 20), ("SECRET", 21, 25)]
    assert spans[0].score == pytest.approx(0.8)


def test_mask_phone():
    assert mask_value("010-1234-5678") == "010-****-5678"
