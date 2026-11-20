"""화면 사진을 찍어도 되는가, 무엇을 가리는가(순수 함수 표)."""
from typing import get_args

import pytest

from cheongeum.agents.web.shot import REFUSAL_SPEECH, ShotPlan, ShotRefusal, ShotRefusalReason, judge_blocks, judge_marks, plan_shot

RRN = "900101-1234567"


def view(**over) -> dict:
    base = {
        "url": "https://example.kr/notice",
        "title": "기초연금 안내",
        "fields": [],
        "errors": [],
        "dialogs": [],
        "outline": {"mainText": "기초연금은 만 65세 이상 어르신께 드립니다.", "items": []},
    }
    return {**base, **over}


def main(text: str) -> dict:
    return {"mainText": text, "items": []}


def field(type_: str, *, visible: bool = True, label: str = "칸") -> dict:
    return {"fieldId": f"f-{type_}", "type": type_, "visible": visible, "label": label}


@pytest.mark.parametrize(
    "screen, reason",
    [
        (view(title="접속이 차단되었습니다"), "blocked"),
        (view(outline=main("비정상적인 접근이 감지되었습니다. 잠시 후 다시 시도하세요.")), "blocked"),
        (view(title="reCAPTCHA 확인"), "captcha"),
        (view(outline=main("회원가입\n아래 보안문자를 입력해 주세요.")), "captcha"),
        (view(fields=[field("text", label="자동입력 방지 문자")]), "captcha"),
        (view(title="회원 로그인"), "login"),
        (view(fields=[field("text", label="아이디"), field("password", label="비밀번호")]), "login"),
        (view(pageId="mock-login", title="[모의] 본인인증 (가상 화면)"), "login"),
        (view(title="본인인증"), "verification"),
        (view(title="확인", outline=main("PASS 인증으로 본인 확인을 진행합니다.")), "verification"),
        (view(fields=[field("password", visible=False)]), "password"),
    ],
)
def test_screens_that_are_never_photographed(screen, reason):
    refusal = plan_shot(screen)
    assert isinstance(refusal, ShotRefusal)
    assert refusal.reason == reason
    assert refusal.speech


def test_every_refusal_has_its_own_sentence():
    assert set(REFUSAL_SPEECH) == set(get_args(ShotRefusalReason))
    assert len(set(REFUSAL_SPEECH.values())) == len(REFUSAL_SPEECH)


def test_normal_page_masks_every_input_and_frame_and_hides_the_cursor():
    plan = plan_shot(view(fields=[field("text", label="검색어")]))
    assert isinstance(plan, ShotPlan)
    assert {"input", "textarea", "select", "[contenteditable]", "iframe"} <= set(plan.mask)
    assert '[id^="__cheongeum"]' in plan.hide


def block(i: int, text: str) -> dict:
    return {"id": f"b{i}", "text": text}


def blocks(*texts: str) -> list[dict]:
    return [block(i, text) for i, text in enumerate(texts)]


@pytest.mark.parametrize(
    "page, main_text, expected",
    [
        (blocks("기초연금 안내", f"주민등록번호 {RRN}"), f"기초연금 안내\n주민등록번호 {RRN}", (["b1"], True)),
        (blocks("기초연금 안내", "만 65세 이상이면 신청할 수 있습니다."), "기초연금 안내\n만 65세 이상이면 신청할 수 있습니다.", ([], True)),
        # 표: 이름과 값이 다른 칸에 있다
        (
            blocks("계좌번호", "110-123-456789", "담당 부서", "복지정책과"),
            "계좌번호 110-123-456789\n담당 부서 복지정책과",
            (["b1"], True),
        ),
        (blocks("주민등록번호", RRN), f"주민등록번호\n{RRN}", (["b1"], True)),
        # 본문에는 있는데 그것을 담은 조각이 없다(그림 속 글이 아니라 관찰과 화면이 어긋난 경우 등)
        (blocks("기초연금 안내"), f"기초연금 안내\n주민등록번호 {RRN}", ([], False)),
        (blocks("기초연금 안내", f"주민등록번호 {RRN}"), f"주민등록번호 {RRN}\n카드번호 1234-5678-9012-3456", (["b1"], False)),
        (blocks("계좌번호"), "계좌번호\n110-123-456789", ([], False)),
        # 띄어쓰기·줄바꿈이 달라도 같은 글이다
        (blocks(f"주민등록번호 {RRN}"), f"주민등록번호\n  {RRN}", (["b0"], True)),
        # 관찰한 본문은 조각과 그 안쪽 요소의 글을 붙여 쓰기도 한다
        (blocks(f"주민등록번호 {RRN}", "안쪽 문단입니다."), f"주민등록번호 {RRN}안쪽 문단입니다.", (["b0"], True)),
        (blocks("앞 문단입니다", f"주민등록번호 {RRN}"), f"앞 문단입니다주민등록번호 {RRN}", (["b1"], True)),
        # 짧은 조각('3')이 다른 번호의 일부를 지워 그 번호를 못 알아보게 하면 안 된다
        (blocks("계좌번호", "3"), f"계좌번호 3\n{RRN}", (["b1"], False)),
        # 한 요소의 글이 둘로 나뉘어 와도 id는 한 번
        ([block(0, f"주민등록번호 {RRN}"), block(1, "안내"), block(0, "카드번호 1234-5678-9012-3456")], "", (["b0"], True)),
    ],
)
def test_judge_blocks(page, main_text, expected):
    assert judge_blocks(page, main_text) == expected


def marks(**over) -> dict:
    return {"blocks": blocks("기초연금 안내"), "frames": [], "inputs": 0, "passwords": 0, "overlays": 0, **over}


def frame(src: str) -> dict:
    return {"src": src, "shown": True}


@pytest.mark.parametrize(
    "src",
    [
        "https://www.google.com/recaptcha/api2/anchor?k=site",
        "https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html",
        "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/x/",
    ],
)
def test_captcha_frame_is_refused(src):
    refusal = judge_marks(marks(frames=[frame("https://www.youtube.com/embed/abc"), frame(src)]), "기초연금 안내")
    assert isinstance(refusal, ShotRefusal)
    assert refusal.reason == "captcha"


def test_ordinary_frame_and_text_pass_with_the_blocks_to_mask():
    page = marks(blocks=blocks("기초연금 안내", f"주민등록번호 {RRN}"), frames=[frame("https://www.youtube.com/embed/abc")])
    assert judge_marks(page, f"기초연금 안내\n주민등록번호 {RRN}") == ["b1"]


def test_password_field_seen_at_capture_time_is_refused():
    refusal = judge_marks(marks(passwords=1), "기초연금 안내")
    assert isinstance(refusal, ShotRefusal)
    assert refusal.reason == "password"


def test_uncovered_secret_is_refused_as_unmaskable():
    refusal = judge_marks(marks(), f"주민등록번호 {RRN}")
    assert isinstance(refusal, ShotRefusal)
    assert refusal.reason == "unmaskable"
