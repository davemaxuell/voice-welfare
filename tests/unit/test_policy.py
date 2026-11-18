import pytest

from cheongeum.safety import PolicyConfig, PolicyContext, PolicyGuard, detect_sensitive, mask_value, redact_text

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
    ],
)
def test_detect_sensitive(text, secret):
    assert detect_sensitive(text).hasSecretValue is secret


def test_redact():
    assert redact_text("비밀번호는 123456이야") == "비밀번호 [비공개]"
    assert "1234567" not in redact_text("주민번호 900101-1234567 입니다")
    assert redact_text("이름은 김하늘") == "이름은 김하늘"


def test_mask_phone():
    assert mask_value("010-1234-5678") == "010-****-5678"
