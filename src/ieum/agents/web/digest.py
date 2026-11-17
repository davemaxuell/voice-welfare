"""
화면 이해 담당(Agent A 소속): 관찰한 웹페이지를 "무슨 페이지인지 · 핵심 본문 · 내용 링크 · 주요 메뉴 · 할 수 있는 일"로
짧게 정리한다. 규칙 기반이라 LLM 호출이 늘지 않는다.
 - 목표 수행 LLM에 원본 대신 이 요약을 넘겨 입력을 줄인다(비용·지연 감소, 작은 로컬 모델도 덜 헷갈림).
 - 음성 안내(페이지 종류, 접속 차단 알림, 주요 메뉴)에도 쓴다.
여기 담긴 글은 모두 비신뢰 데이터다(지시로 해석하지 않는다).
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ieum.core.jsutil import I, rx, try_url

BLOCKED = rx(r"(접속이\s*차단|접근이\s*차단|비정상적인\s*접근|자동\s*입력\s*방지|unusual traffic|are you a robot|captcha|access denied)", I)
# 어디에나 있는 도구 링크(내용이 아님). 더보기·다음 쪽 같은 목록 이동은 남긴다.
UTILITY = rx(r"^(본문\s*바로\s*가기|(주|메인)\s*메뉴\s*바로\s*가기|건너뛰기|맨\s*위로|top|skip to (main )?content)$", I)

PAGE_KIND_LABEL: dict[str, str] = {
    "blank": "빈 화면",
    "blocked": "접속 차단 안내",
    "form": "입력 양식",
    "search-results": "검색 결과",
    "article": "글 본문",
    "list": "목록",
    "page": "일반 페이지",
}


@dataclass
class PageDigest:
    kind: str
    url: str
    title: str
    # 큰 제목·소제목(제목과 같은 것 제외)
    headings: list[str]
    # 정리한 본문(중복 줄·메뉴 글자·한두 글자 조각 제거)
    main: str
    # 읽어 줄 본문: 위쪽 메뉴·버튼 글자를 건너뛰고 첫 문장(과 그 바로 앞 제목)부터, 만족도 조사 같은 꼬리말 전까지
    body: str
    # 본문 안 링크(기사·검색 결과 등) — 앞쪽이 중요
    contentLinks: list[str]
    # 머리말·탐색 메뉴 링크
    menu: list[str]
    # 누를 수 있는 버튼
    buttons: list[str]
    hasSearchBox: bool
    # 검색창이 아닌 입력 칸 수
    inputCount: int
    dialogs: list[str]
    # 할 수 있는 일(쉬운 말)
    canDo: list[str] = field(default_factory=list)


_WS = rx(r"\s+")


def _uniq(arr) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in arr:
        v = _WS.sub(" ", raw).strip()
        if not v or v in seen:
            continue
        seen.add(v)
        out.append(v)
    return out


def _clean_main(main_text: str, menu: set[str]) -> str:
    """본문 정리: 같은 줄 반복, 메뉴 이름만 있는 줄, 한두 글자 조각을 뺀다."""
    lines = [_WS.sub(" ", line).strip() for line in rx(r"\n+").split(main_text)]
    seen: set[str] = set()
    kept: list[str] = []
    for line in lines:
        if not line:
            continue
        if len(line) <= 2 and not rx(r"\d").search(line):
            continue
        if line in menu or UTILITY.search(line):
            continue
        if line in seen:
            continue
        seen.add(line)
        kept.append(line)
    return "\n".join(kept)


# 메뉴·버튼처럼 보이는 한 줄(본문이 아님)
UI_LINE = rx(
    r"^(찜하기|신청하기|모의계산|목록|즐겨찾기|공유하기|공유|인쇄|프린트|더\s*보기|닫기|열기|top|맨\s*위로|로그인|로그아웃|회원가입|사이트맵|고객센터|검색|전체메뉴|메뉴|홈|home|이전|다음|확인|취소)$",
    I,
)
# 여기부터는 본문이 아닌 꼬리말
TRAILER = rx(r"^(만족도\s*평가|이\s*페이지(에서|의)\s*(제공하는\s*)?정보에|페이지\s*만족도|저작권|copyright|개인정보\s*처리\s*방침|이용\s*약관|관련\s*사이트)", I)
_SENTENCE_END = rx(r"([다요죠]|니다|세요)[.!?]?$|[.!?]$")


def _sentence(line: str) -> bool:
    return len(line) >= 40 or (len(line) >= 20 and bool(_SENTENCE_END.search(line)))


def _readable_body(main: str) -> str:
    """읽어 줄 본문 고르기(규칙): 메뉴 줄을 건너뛰고 첫 문장부터, 꼬리말 앞까지. 문장이 없으면 정리한 본문 그대로."""
    lines = [rx(r"\s*선택됨$").sub("", line).strip() for line in main.split("\n")]
    lines = [line for line in lines if line and not UI_LINE.search(line)]
    first = next((i for i, line in enumerate(lines) if _sentence(line)), -1)
    if first < 0:
        return "\n".join(lines)
    # 첫 문장 바로 앞의 짧은 줄은 제목인 경우가 많다(예: "기초연금" → "노인에게 기초연금을 지급하여…")
    start = first - 1 if first > 0 and len(lines[first - 1]) <= 30 else first
    end = next((i for i, line in enumerate(lines) if i > start and TRAILER.search(line)), -1)
    return "\n".join(lines[start:] if end < 0 else lines[start:end])


_SEARCH_KEYS = ("query", "q", "keyword", "search", "searchWrd", "kwd")


def _classify(view: dict, main: str, content_links: list[str], input_count: int) -> str:
    url = view.get("url") or ""
    if view.get("pageId") == "blank" or not url or url == "about:blank":
        return "blank"
    if BLOCKED.search(f"{view.get('title', '')} {main[:600]}"):
        return "blocked"
    if view.get("pageId") == "mock-welfare" or input_count >= 2:
        return "form"
    u = try_url(url)
    searchy = bool(u) and any(u.param(k) for k in _SEARCH_KEYS)
    if searchy or rx(r"검색\s*결과|search results", I).search(view.get("title", "")):
        return "search-results"
    if len(main) > 600 and len(content_links) < 15:
        return "article"
    if len(content_links) >= 15:
        return "list"
    return "page"


def digest_page(view: dict) -> PageDigest:
    o = view.get("outline") or {}
    menu = [m for m in _uniq(o.get("menuLinks") or []) if not UTILITY.search(m)]
    menu_set = set(menu)
    all_links = _uniq(o.get("links") or [])
    # 본문 링크를 알면 그것을, 모르면(이전 관찰 형식) 메뉴가 아닌 링크를 내용 링크로 본다.
    main_links = o.get("mainLinks")
    content_links = [
        link for link in _uniq(main_links if main_links is not None else [x for x in all_links if x not in menu_set]) if not UTILITY.search(link)
    ]
    buttons = _uniq([b["name"] for b in (o.get("buttons") or []) if not b.get("disabled")])
    fields = [f for f in view.get("fields", []) if f.get("visible")]
    has_search_box = any(f.get("searchable") for f in fields)
    input_count = len([f for f in fields if not f.get("searchable")])
    main = _clean_main(o.get("mainText") or "", menu_set)
    title = (view.get("title") or "").strip()
    headings = [h for h in _uniq([h["text"] for h in (o.get("headings") or [])]) if h != title]
    kind = _classify(view, main, content_links, input_count)
    can_do: list[str] = []
    if main:
        can_do.append("본문 읽기")
    if content_links:
        can_do.append("검색 결과 열기" if kind == "search-results" else "내용 링크 열기")
    if has_search_box:
        can_do.append("이 사이트에서 검색")
    if menu:
        can_do.append("메뉴 이동")
    if input_count:
        can_do.append(f"입력 칸 {input_count}개 채우기")
    return PageDigest(
        kind=kind,
        url=view.get("url") or "",
        title=view.get("title") or "",
        headings=headings,
        main=main,
        body=_readable_body(main),
        contentLinks=content_links,
        menu=menu,
        buttons=buttons,
        hasSearchBox=has_search_box,
        inputCount=input_count,
        dialogs=[d["title"] for d in view.get("dialogs", [])],
        canDo=can_do,
    )


def digest_for_llm(d: PageDigest, offset: int = 0, main_chars: int = 1500, max_links: int = 30) -> dict:
    """
    목표 수행 LLM에 넘길 짧은 화면 요약. items 이름은 그대로 눌러야 하므로 바꾸지 않는다.
    원본(링크 60·버튼 25·본문 2,500자)보다 작게: 내용 링크 위주 + 메뉴 일부 + 정리한 본문.
    """
    content = d.contentLinks[:max_links]
    menu = [m for m in d.menu if m not in content][:12]
    flat = rx(r"\n+").sub(" / ", d.main)
    return {
        "url": d.url,
        "title": d.title,
        "kind": PAGE_KIND_LABEL[d.kind],
        "headings": d.headings[:8],
        "items": [
            *({"kind": "link", "name": name} for name in content),
            *({"kind": "menu", "name": name} for name in menu),
            *({"kind": "button", "name": name} for name in d.buttons[:12]),
        ],
        "hasSearchBox": d.hasSearchBox,
        "dialogs": d.dialogs,
        "mainText": flat[offset : offset + main_chars],
        "moreText": len(flat) > offset + main_chars,
    }
