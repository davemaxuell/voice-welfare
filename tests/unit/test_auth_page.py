"""로그인·본인인증 화면 판별(auth_page_kind). '다 했어' 재관찰과 간편인증 인계가 같이 쓴다."""

from cheongeum.agents.web.auth_page import auth_page_kind, first_fill_field


def _view(**kwargs) -> dict:
    base = {"pageId": "external", "title": "일반 페이지", "fields": [], "url": "https://example.org/"}
    base.update(kwargs)
    return base


def test_auth_page_kind_login_by_page_id_and_password():
    assert auth_page_kind(_view(pageId="mock-login", title="아무 제목")) == "login"
    assert (
        auth_page_kind(
            _view(
                fields=[
                    {"fieldId": "id", "type": "text", "visible": True, "label": "아이디"},
                    {"fieldId": "pw", "type": "password", "visible": True, "label": "비밀번호"},
                ]
            )
        )
        == "login"
    )


def test_auth_page_kind_login_by_title():
    assert auth_page_kind(_view(title="회원 로그인")) == "login"
    assert auth_page_kind(_view(title="Sign in to continue")) == "login"


def test_auth_page_kind_verification_by_title_without_password():
    """간편인증·본인인증 제목만 있고 비밀번호 칸이 없으면 verification(item 24가 앱 단서를 더한다)."""
    assert auth_page_kind(_view(title="본인인증")) == "verification"
    assert auth_page_kind(_view(title="간편 인증 화면")) == "verification"


def test_auth_page_kind_other_when_not_auth():
    assert auth_page_kind(_view(title="장애인연금 모의 신청", pageId="mock-welfare")) == "other"
    assert auth_page_kind(_view(title="검색 결과")) == "other"


def test_first_fill_field_prefers_non_password():
    view = _view(
        fields=[
            {"fieldId": "pw", "type": "password", "visible": True, "label": "비밀번호"},
            {"fieldId": "loginId", "type": "text", "visible": True, "label": "아이디"},
        ]
    )
    assert first_fill_field(view)["fieldId"] == "loginId"
