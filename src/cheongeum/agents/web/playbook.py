"""
사이트별 막다른 길 안내: 장애물 → 다른 길 한 문장, 자동화 금지 한 번 알림, 사람 도움 시 공식 번호.
청음은 전화를 걸지 않는다. 번호와 짧은 말 스크립트만 읽어 준다.
(agents/web에 둔 이유: speech.screen이 skills를 가져올 수 없고, Narrator.once로 한 번 안내해야 함.)
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from cheongeum.core.jsutil import rx, try_url

OnceFn = Callable[..., str]

# 제도·사이트 문의처가 없을 때
DEFAULT_CONTACT_NAME = "보건복지상담센터"
DEFAULT_CONTACT_NUMBER = "129"

DEFAULT_CAN_DO = (
    "복지 제도 찾아 드리기",
    "웹 페이지 읽어 드리기",
    "연습 신청서 작성 돕기",
)

DEFAULT_ROUTES = {
    "blocked": "평소 쓰시는 브라우저로 직접 여시거나, 비슷한 정보를 다른 사이트에서 찾아 드릴까요?",
    "policy-denied": "읽기·이동·검색은 도와드릴 수 있어요. 예: '본문 읽어줘', '뒤로 가줘'.",
}


@dataclass(frozen=True)
class SitePlaybook:
    host: str
    label: str
    contact_name: str
    contact_number: str
    automation_notice: str
    routes: dict[str, str] = field(default_factory=dict)
    can_do: tuple[str, ...] = DEFAULT_CAN_DO

    def next_step(self, obstacle: str) -> str:
        return self.routes.get(obstacle) or DEFAULT_ROUTES.get(obstacle) or DEFAULT_ROUTES["blocked"]


PLAYBOOKS: dict[str, SitePlaybook] = {
    "bokjiro.go.kr": SitePlaybook(
        host="bokjiro.go.kr",
        label="복지로",
        contact_name=DEFAULT_CONTACT_NAME,
        contact_number=DEFAULT_CONTACT_NUMBER,
        automation_notice=(
            "복지로는 자동으로 여는 브라우저의 접속을 막을 수 있어요. "
            "막혀도 우회하지 않고, 직접 여시는 방법이나 다른 도움을 말씀드릴게요."
        ),
        routes={
            "blocked": "평소 쓰시는 브라우저로 복지로를 직접 여시거나, '복지 제도 찾아줘'라고 말씀해 주세요.",
            "policy-denied": "읽기·검색·메뉴 이동은 도와드릴 수 있어요. 예: '본문 읽어줘', '서비스 찾기 눌러줘'.",
        },
        can_do=("복지 제도 찾아 드리기", "공식 안내 읽어 드리기", "연습 신청서 작성 돕기"),
    ),
    "gov.kr": SitePlaybook(
        host="gov.kr",
        label="정부24",
        contact_name="정부민원안내콜센터",
        contact_number="1588-2188",
        automation_notice=(
            "정부24는 자동 프로그램을 쓰면 이용이 제한될 수 있어요. "
            "청음은 막히면 우회하지 않고, 직접 여시는 방법이나 다른 도움을 말씀드릴게요."
        ),
        routes={
            "blocked": "평소 쓰시는 브라우저로 정부24를 직접 여시거나, 발급 절차를 물어 주세요. 예: '주민등록등본 발급 방법 알려줘'.",
            "policy-denied": "읽기·검색·링크 이동은 도와드릴 수 있어요. 예: '본문 읽어줘', '신청 방법 찾아줘'.",
        },
        can_do=("민원 절차 안내 읽어 드리기", "페이지 읽고 찾아 드리기", "다른 공식 사이트 열어 드리기"),
    ),
}


def loads_bokjiro_search_results(url: str) -> bool:
    """통합검색은 헤더 응답 뒤에 결과 목록을 받는다. 두 요청은 오래 걸려도 롱 폴링이 아니다."""
    request = try_url(url)
    return bool(request and request.hostname in ("www.bokjiro.go.kr", "bokjiro.go.kr") and request.pathname in (
        "/ssis-tbu/TWZZ01000M/getHeaderInf.do",
        "/ssis-tbu/TWZZ01000M/twatzzza/intgSearch/selectTwzzIntgSearchList.do",
    ))


def public_guide_url(site_url: str | None, question: str) -> str | None:
    """기관이 공개한 업무별 안내 페이지. 사용자가 지정한 상세 주소는 그대로 둔다."""
    site = try_url(site_url or "")
    if not site or site.pathname != "/" or site.search:
        return None
    words = rx(r"\s").sub("", question)
    if site.hostname == "www.gov.kr" and rx(r"주민등록(?:표)?(?:등본|초본)|등본발급").search(words):
        return "https://www.gov.kr/mw/AA020InfoCappView.do?CappBizCD=13100000015"
    if site.hostname == "www.kosaf.go.kr" and "국가장학금" in words:
        page = "scholarship05_12_01_01"
        if "다자녀" in words:
            page = "scholarship05_12_10"
        elif rx(r"(?:2|Ⅱ|ⅱ|II|ii)유형").search(words):
            page = "scholarship05_12_01_02"
        if "서류" in words:
            return f"https://www.kosaf.go.kr/ko/scholar.do?pg={page}&ttab1=3"
        if rx(r"신청방법|신청절차|어떻게신청|신청하는법").search(words):
            return f"https://www.kosaf.go.kr/ko/scholar.do?pg={page}&ttab1=2"
        return "https://www.kosaf.go.kr/ko/scholar.do?pg=scholarship_submain01&naviParam=JH,02,00,00"
    return None


def guide_section(view: dict, question: str) -> dict:
    """장학재단의 업무별 탭은 공통 일정 배너 뒤에 있다. 절차 질문의 근거는 현재 탭의 본문이다."""
    page = try_url(view.get("url") or "")
    if not page or page.hostname != "www.kosaf.go.kr" or page.pathname != "/ko/scholar.do":
        return view
    if "ttab1=2" not in page.search or rx(r"언제|기간|기한|일정|마감|날짜").search(question):
        return view
    outline = view.get("outline") or {}
    main = outline.get("mainText") or ""
    heading = rx(r"(?:^|\n)[ \t]*[^\n]{0,75}국가장학금[^\n]{0,75}지원절차[ \t]*\n").search(main)
    if not heading:
        return view
    return {**view, "outline": {**outline, "mainText": main[heading.start():].strip()}}


def _bare_host(url: str | None) -> str:
    u = try_url(url or "")
    return rx(r"^www\.").sub("", u.hostname) if u and u.hostname else ""


def for_url(url: str | None) -> SitePlaybook | None:
    """주소에 맞는 플레이북(하위 도메인 포함). 없으면 None."""
    here = _bare_host(url)
    if not here:
        return None
    for host, pb in PLAYBOOKS.items():
        if here == host or here.endswith(f".{host}"):
            return pb
    return None


def next_step(obstacle: str, url: str | None = None) -> str:
    pb = for_url(url)
    return pb.next_step(obstacle) if pb else DEFAULT_ROUTES.get(obstacle) or DEFAULT_ROUTES["blocked"]


def resolve_contact(
    *,
    contact_name: str | None = None,
    contact_number: str | None = None,
    url: str | None = None,
) -> tuple[str, str]:
    """제도 문의처 → 사이트 플레이북 → 129."""
    if contact_number and rx(r"\d").search(contact_number):
        return (contact_name or "담당 기관", contact_number)
    pb = for_url(url)
    if pb:
        return pb.contact_name, pb.contact_number
    return DEFAULT_CONTACT_NAME, DEFAULT_CONTACT_NUMBER


def can_do_list(url: str | None = None) -> tuple[str, ...]:
    pb = for_url(url)
    return pb.can_do if pb else DEFAULT_CAN_DO


def blocked_speech(url: str | None, once: OnceFn | None = None) -> str:
    """접속 차단: 못 함 + (사이트면) 자동화 안내 한 번 + 다음 단계 하나."""
    pb = for_url(url)
    parts = [
        "이 사이트는 자동으로 여는 브라우저의 접속을 막고 있어서 내용을 읽을 수 없어요. 보안 장치를 우회하지는 않아요.",
    ]
    if pb and pb.automation_notice and once:
        notice = once(f"automation:{pb.host}", pb.automation_notice)
        if notice:
            parts.append(notice)
    parts.append(next_step("blocked", url))
    return " ".join(parts)


def help_human_speech(
    *,
    contact_name: str | None = None,
    contact_number: str | None = None,
    url: str | None = None,
    service_name: str | None = None,
    step_hint: str | None = None,
) -> str:
    """사람 도움: 전화·연결 불가 → 공식 번호 먼저 → 짧은 말 스크립트 → 대신 할 수 있는 일 2~3가지."""
    name, number = resolve_contact(contact_name=contact_name, contact_number=contact_number, url=url)
    pb = for_url(url)
    topic = service_name or (pb.label if pb else None) or "복지·민원"
    where = step_hint or "도움이 필요한 단계"
    script = f"'{topic} 문의인데요, {where}에서 도움이 필요해요.'"
    alts = ", ".join(can_do_list(url)[:3])
    return (
        f"제가 상담원에게 전화하거나 연결해 드리지는 못해요. "
        f"문의는 {name} {number}입니다. "
        f"직접 거실 때 이렇게 말씀하시면 좋아요: {script} "
        f"대신 제가 도와드릴 수 있는 일은 {alts}이에요. "
        f"번호를 다시 들려 드릴까요?"
    )
