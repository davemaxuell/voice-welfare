"""간편인증 앱 화면 단서."""
from cheongeum.agents.web.auth_page import auth_page_kind, verification_app


def test_pass_app():
    view = {"title": "PASS 인증", "fields": [], "outline": {"items": []}, "mainText": ""}
    assert verification_app(view) == "PASS"
    assert auth_page_kind(view) == "verification"
    # 한글이 바로 이어져도 ASCII 단어로 본다(Python \b는 한글을 글자로 취급)
    glued = {"title": "", "fields": [], "outline": {"items": []}, "mainText": "PASS로 인증하세요"}
    assert verification_app(glued) == "PASS"
    assert verification_app({**glued, "mainText": "xPASSx"}) is None


def test_kakao_in_button():
    view = {
        "title": "본인확인",
        "fields": [],
        "outline": {"items": [{"name": "카카오톡 인증", "role": "button"}]},
        "mainText": "",
    }
    assert verification_app(view) == "카카오톡"
    assert auth_page_kind(view) == "verification"


def test_login_not_verification():
    view = {"title": "로그인", "fields": [{"visible": True, "type": "password", "fieldId": "p"}], "outline": {"items": []}}
    assert auth_page_kind(view) == "login"
