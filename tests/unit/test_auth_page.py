"""로그인·본인인증 화면 판별(auth_page_kind). '다 했어' 재관찰과 간편인증 인계가 같이 쓴다."""

import json
from pathlib import Path

import pytest

from cheongeum.agents.web.auth_page import auth_page_kind, first_fill_field, verification_app

# 공개 복지로 화면의 실제 관찰(2026-11-19). 모든 화면 머리말에 '공동인증서 내보내기' 단추가 있다.
BOKJIRO = json.loads((Path(__file__).parents[1] / "fixtures" / "bokjiro-public-pages.json").read_text(encoding="utf-8"))


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


def test_verification_clue_is_read_from_observed_main_text():
    """본문은 관찰의 outline.mainText에 있다. 제목·단추에 단서가 없어도 본문의 간편인증 안내로 알아본다."""
    view = _view(title="확인", outline={"mainText": "PASS 인증으로 본인 확인을 진행합니다.", "items": []})
    assert auth_page_kind(view) == "verification"


@pytest.mark.parametrize("page", ["detail", "home"])
def test_public_page_with_certificate_button_is_not_an_auth_screen(page):
    """기초연금 상세·복지로 첫 화면은 안내 화면이다. 머리말의 인증서 단추 이름만으로 인증 화면이 되지 않는다."""
    assert auth_page_kind(BOKJIRO[page]) == "other"


def test_real_gate_on_the_same_site_still_hands_off():
    home = BOKJIRO["home"]
    password = {"fieldId": "pw", "type": "password", "visible": True, "label": "비밀번호"}
    assert auth_page_kind({**home, "fields": [*home["fields"], password]}) == "login"
    assert auth_page_kind({**home, "title": "로그인 | 복지로"}) == "login"
    assert auth_page_kind({**home, "title": "본인인증 | 복지로"}) == "verification"
    dialog = {"title": "인증서 선택", "text": "인증서 선택 금융인증서 공동인증서 닫기", "buttons": ["금융인증서", "공동인증서", "닫기"]}
    buttons = [{"ref": f"d{i}", "role": "button", "name": name} for i, name in enumerate(dialog["buttons"])]
    opened = {**home, "dialogs": [dialog], "outline": {**home["outline"], "items": [*home["outline"]["items"], *buttons]}}
    assert auth_page_kind(opened) == "verification"
    assert verification_app(opened) == "금융인증서"


# 독립 검토(2026-11-19): 인증서·간편인증 단추만 있고 제목에 단서가 없는 로그인 화면도 인증 화면이다.
# 복지로 머리말의 '공동인증서 내보내기' 같은 인증서 도구 단추만 단서에서 뺀다.
@pytest.mark.parametrize(
    "names",
    [
        ["카카오톡 인증", "PASS 인증", "네이버 인증", "공동인증서"],
        ["공동인증서 로그인", "금융인증서 로그인", "간편인증 로그인"],
    ],
)
def test_certificate_login_buttons_without_a_telling_title_are_verification(names):
    view = _view(title="우리시청 누리집", outline={"items": [{"role": "button", "name": n} for n in names], "mainText": ""})
    assert auth_page_kind(view) == "verification"


def test_certificate_tool_buttons_alone_are_not_verification():
    names = ["공동인증서 내보내기", "인증서 가져오기", "금융인증서 발급 안내"]
    view = _view(outline={"items": [{"role": "button", "name": n} for n in names], "mainText": ""})
    assert auth_page_kind(view) == "other"


# 두 번째 독립 검토(2026-11-19): 휴대폰 인증번호 화면, '본인 확인' 제목, 간편인증 고르기 화면도 인증 화면이다.
def test_sms_code_page_is_verification():
    view = _view(
        title="휴대폰 인증 | 우리시청",
        fields=[
            {"fieldId": "name", "type": "text", "visible": True, "label": "이름"},
            {"fieldId": "code", "type": "text", "visible": True, "label": "인증번호 6자리"},
        ],
        outline={"items": [{"role": "button", "name": n} for n in ["SKT", "KT", "인증번호 받기", "확인"]], "mainText": ""},
    )
    assert auth_page_kind(view) == "verification"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"title": "휴대폰 본인 확인"},
        {"outline": {"items": [{"role": "button", "name": n} for n in ["카카오톡", "네이버", "토스"]], "mainText": "간편인증 서비스를 선택해 주세요"}},
        {"outline": {"items": [{"role": "button", "name": n} for n in ["아이디 로그인", "인증서 로그인", "간편 로그인"]], "mainText": ""}},
    ],
)
def test_other_real_verification_screens(kwargs):
    assert auth_page_kind(_view(**kwargs)) in ("verification", "login")


# 주인 결정(2026-11-19): 본문의 인증서 낱말은 '지금 인증하라'는 안내일 때만 인증 화면 단서다.
# 신청 안내 화면이 절차를 설명하는 말("…로그인이 필요합니다")은 단서가 아니다.
@pytest.mark.parametrize(
    "body",
    [
        "주민등록표 등본 발급. 공동·금융인증서 또는 간편인증으로 로그인이 필요합니다.",
        "온라인 신청은 공동인증서로 로그인한 뒤 신청하세요.",
        "PASS 앱이 있으면 더 편하게 신청할 수 있습니다.",
    ],
)
def test_guide_text_describing_certificates_is_not_a_gate(body):
    view = _view(title="주민등록표 등본(초본) 교부 | 정부24", outline={"items": [], "mainText": body})
    assert auth_page_kind(view) == "other"


@pytest.mark.parametrize(
    "body",
    ["PASS 인증으로 본인 확인을 진행합니다.", "휴대폰에서 PASS 앱으로 인증하세요.", "공동인증서를 선택해 주세요.", "PASS 앱에서 인증을 완료한 뒤 확인을 눌러 주세요."],
)
def test_body_instruction_to_verify_now_is_a_gate(body):
    assert auth_page_kind(_view(title="확인", outline={"items": [], "mainText": body})) == "verification"
