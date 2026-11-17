"""
사이트별 어댑터 프로필(FR-11). 에이전트 코드는 특정 사이트 DOM을 하드코딩하지 않고
이 프로필의 접근성 이름(label/role+name)으로만 대상을 찾는다.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Literal

import regex

from ieum.core.jsutil import parse_url, rx, try_url

PageId = Literal["mock-home", "mock-welfare", "mock-login", "external", "blank"]


@dataclass
class Validation:
    ok: bool
    value: str = ""
    message: str = ""


def ok(value: str) -> Validation:
    return Validation(ok=True, value=value)


def fail(message: str) -> Validation:
    return Validation(ok=False, message=message)


@dataclass
class FieldProfile:
    field_id: str
    # 화면의 접근성 이름(label). get_by_label(exact)로 찾는다.
    label: str
    step: int
    kind: Literal["text", "tel", "number", "select", "checkbox"]
    sensitivity: Literal["normal", "personal", "secret"]
    # 이 필드만 가리키는 말
    aliases: list[str]
    # 여러 필드를 가리킬 수 있는 말(예: "주소"). 화면에 둘 이상 보이면 되묻는다.
    generic_aliases: list[str] = field(default_factory=list)
    mask_on_readback: bool = False
    options: list[str] | None = None
    validate: Callable[[str], Validation] | None = None


@dataclass
class SiteUrls:
    home: str
    apply: str
    login: str


@dataclass
class SiteLinks:
    application: str
    login: str


@dataclass
class SiteButtons:
    next: str
    prev: str
    submit: str
    dismiss_dialog: tuple[str, ...]


@dataclass
class SiteProfile:
    id: str
    name: str
    origin: str
    urls: SiteUrls
    links: SiteLinks
    buttons: SiteButtons
    receipt_pattern: regex.Pattern
    fields: list[FieldProfile]

    def classify(self, url: str) -> PageId:
        if not url or url == "about:blank":
            return "blank"
        u = try_url(url)
        if u is None:
            return "external"
        if u.origin != self.origin:
            return "external"
        if u.pathname.startswith("/apply"):
            return "mock-welfare"
        if u.pathname.startswith("/login"):
            return "mock-login"
        return "mock-home"


_TERM = rx(r"[\s·.,]")


def normalize_term(s: str) -> str:
    return _TERM.sub("", s).lower()


# 이름이 아닌 군말·대화 표현(이름으로 넣지 않는다)
NOT_A_NAME = rx(r"(^|\s)(음+|어+|아+|그냥|좀|도와|해줘|뭐|네|응|아니|잠깐|근데|그러니까|저기|이거|그거)(\s|$)|[?？]")


def _squash(raw: str) -> str:
    return rx(r"\s+").sub(" ", raw.strip())


def validate_name(raw: str) -> Validation:
    v = _squash(raw)
    # 한글 이름 2~5자(띄어쓰기 없이) 또는 영문 이름(최대 4단어)만 받는다. 문장처럼 들리면 되묻는다.
    korean = bool(rx(r"^[가-힣]{2,5}$").search(v))
    english = bool(rx(r"^[A-Za-z]+( [A-Za-z]+){0,3}$").search(v)) and len(v) <= 30
    if (korean or english) and not NOT_A_NAME.search(v):
        return ok(v)
    return fail("이름만 또박또박 말씀해 주세요. 예: 김하늘.")


def validate_address(raw: str) -> Validation:
    """불완전한 주소는 추측해서 채우지 않는다(FR-06)."""
    v = _squash(raw)
    tokens = v.split(" ")
    has_road = bool(rx(r"(로|길|동|리|가)(\s|\d|$)").search(v))
    if len(tokens) >= 3 and rx(r"\d").search(v) and has_road and len(v) <= 100:
        return ok(v)
    return fail("주소가 불완전합니다. 시·도, 시·군·구, 도로명과 건물번호까지 말씀해 주세요. 추측해서 입력하지 않았습니다.")


def validate_phone(raw: str) -> Validation:
    d = rx(r"\D").sub("", raw)
    if rx(r"^01[016789]\d{7,8}$").search(d):
        return ok(f"{d[:3]}-{d[3:7]}-{d[7:]}" if len(d) == 11 else f"{d[:3]}-{d[3:6]}-{d[6:]}")
    return fail("연락처는 010으로 시작하는 휴대전화 번호 10~11자리로 말씀해 주세요.")


def validate_household_size(raw: str) -> Validation:
    m = rx(r"\d+").search(raw)
    if m:
        n = int(m.group(0))
        if 1 <= n <= 20:
            return ok(str(n))
    return fail("가구원 수는 1에서 20 사이의 숫자로 말씀해 주세요.")


def validate_yes_no(raw: str) -> Validation:
    if rx(r"(아니|안 ?달라|같아|해제)").search(raw):
        return ok("아니오")
    if rx(r"(예|네|응|달라|다름|다릅니다|맞아|체크)").search(raw):
        return ok("예")
    return fail('"예" 또는 "아니오"로 말씀해 주세요.')


def match_option(raw: str, options: list[str]) -> Validation:
    """선택지 매칭: 정확히 하나로 좁혀질 때만 선택. 아니면 되묻는다."""
    v = normalize_term(raw)
    exact = [o for o in options if normalize_term(o) == v]
    if len(exact) == 1:
        return ok(exact[0])
    contains = [o for o in options if v in normalize_term(o) or normalize_term(o) in v]
    if len(contains) == 1:
        return ok(contains[0])

    def keyword(pattern: str) -> list[str]:
        return [o for o in options if rx(pattern).search(o)]

    if rx(r"모르").search(raw):
        hits = keyword(r"모르")
    elif rx(r"없").search(raw):
        hits = keyword(r"없음")
    elif rx(r"있").search(raw):
        hits = keyword(r"있음")
    else:
        hits = []
    if len(hits) == 1:
        return ok(hits[0])
    return fail(f"선택지 중 하나로 말씀해 주세요: {', '.join(options)}.")


INCOME_OPTIONS = ["신고할 소득·재산 있음", "신고할 소득·재산 없음", "잘 모르겠음 (상담 필요)"]


def create_mock_welfare_profile(base_url: str) -> SiteProfile:
    origin = parse_url(base_url).origin
    return SiteProfile(
        id="mock-welfare",
        name="모의 복지 신청 사이트",
        origin=origin,
        urls=SiteUrls(home=f"{origin}/", apply=f"{origin}/apply.html", login=f"{origin}/login.html"),
        links=SiteLinks(application="장애인연금 모의 신청하기", login="모의 본인인증"),
        buttons=SiteButtons(next="다음", prev="이전", submit="모의접수", dismiss_dialog=("닫기", "확인")),
        receipt_pattern=rx(r"모의 접수번호:\s*(MOCK-[0-9]{8}-[0-9]{4})"),
        fields=[
            FieldProfile(
                field_id="applicantName",
                label="성명",
                step=1,
                kind="text",
                sensitivity="personal",
                aliases=["이름", "성명", "신청인 이름", "신청자 이름", "신청인 성명"],
                validate=validate_name,
            ),
            FieldProfile(
                field_id="address",
                label="주민등록 주소",
                step=1,
                kind="text",
                sensitivity="personal",
                aliases=["주민등록 주소", "주민등록상 주소", "등록 주소", "주민등록"],
                generic_aliases=["주소"],
                validate=validate_address,
            ),
            FieldProfile(
                field_id="residenceDiffers",
                label="실거주지가 주민등록 주소와 다릅니다",
                step=1,
                kind="checkbox",
                sensitivity="normal",
                aliases=["실거주지가 주민등록 주소와 다릅니다", "실거주지 다름"],
                validate=validate_yes_no,
            ),
            FieldProfile(
                field_id="residenceAddress",
                label="실거주지 주소",
                step=1,
                kind="text",
                sensitivity="personal",
                aliases=["실거주지 주소", "거주지 주소", "실거주지", "사는 곳 주소"],
                generic_aliases=["주소"],
                validate=validate_address,
            ),
            FieldProfile(
                field_id="phone",
                label="연락처 (선택)",
                step=1,
                kind="tel",
                sensitivity="personal",
                aliases=["연락처", "전화번호", "휴대폰 번호", "휴대폰", "핸드폰 번호", "핸드폰", "휴대전화"],
                mask_on_readback=True,
                validate=validate_phone,
            ),
            FieldProfile(
                field_id="incomeStatus",
                label="소득·재산 신고 (선택)",
                step=2,
                kind="select",
                sensitivity="normal",
                aliases=["소득·재산 신고", "소득 재산 신고", "소득·재산", "소득 재산", "소득 신고", "소득", "재산"],
                options=INCOME_OPTIONS,
                validate=lambda raw: match_option(raw, INCOME_OPTIONS),
            ),
            FieldProfile(
                field_id="householdSize",
                label="가구원 수 (선택)",
                step=2,
                kind="number",
                sensitivity="normal",
                aliases=["가구원 수", "가구원", "가족 수"],
                validate=validate_household_size,
            ),
            FieldProfile(
                field_id="loginPassword",
                label="비밀번호",
                step=0,
                kind="text",
                sensitivity="secret",
                aliases=[],
            ),
        ],
    )


def field_vocabulary(profile: SiteProfile) -> list[str]:
    """사용자의 말이 가리키는 필드 후보. 생성기·되묻기에 쓰는 어휘 목록"""
    words: dict[str, None] = {}
    for f in profile.fields:
        if f.sensitivity == "secret":
            continue
        for a in [*f.aliases, *f.generic_aliases]:
            words[a] = None
    return sorted(words, key=lambda w: -len(normalize_term(w)))
