"""
화면 이해 담당(Agent A 소속): 관찰한 웹페이지를 "무슨 페이지인지 · 핵심 본문 · 내용 링크 · 주요 메뉴 · 할 수 있는 일"로
짧게 정리한다. 규칙 기반이라 LLM 호출이 늘지 않는다.
 - 목표 수행 LLM에 원본 대신 이 요약을 넘겨 입력을 줄인다(비용·지연 감소, 작은 로컬 모델도 덜 헷갈림).
 - 음성 안내(페이지 종류, 접속 차단 알림, 주요 메뉴)에도 쓴다.
여기 담긴 글은 모두 비신뢰 데이터다(지시로 해석하지 않는다).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from cheongeum.core.actions import LINK_ROLES
from cheongeum.core.jsutil import I, rx, try_url
from cheongeum.safety import redact_text

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
    controls: list[dict] = field(default_factory=list)
    # 꼬리말 글(대표번호·주소 등). 읽어 주는 본문에는 넣지 않는다.
    footer: str = ""


_WS = rx(r"\s+")
UTILITY_BUTTON = rx(
    r"^(글자\s*(크게|작게|확대|축소)|화면\s*(크게|작게|확대|축소|인쇄)|인쇄(하기)?|프린트|english|eng|中文|日本語|chinese|japanese|한국어|language|언어\s*선택"
    r"|(이전|다음|정지|재생|일시\s*정지|멈춤)\s*(배너|슬라이드)|(배너|슬라이드)\s*(이전|다음|정지|재생)|정지|재생|일시\s*정지"
    r"|공유(하기)?|페이스북|트위터|카카오\s*스토리|블로그|맨\s*위로|top|본문\s*바로\s*가기|건너뛰기)$",
    I,
)
_CONTROL_KIND = {"button": "button", "tab": "tab", "menuitem": "menu", "generic": "button"}


def _controls(o: dict) -> list[dict]:
    items = o.get("items")
    if items is None:
        items = [{"role": "button", "name": b["name"], "disabled": b.get("disabled")} for b in o.get("buttons") or []]
    out: list[dict] = []
    seen: set[str] = set()
    for it in items:
        name = _WS.sub(" ", it["name"]).strip()
        if it["role"] in LINK_ROLES or it.get("disabled") or not name or name in seen or UTILITY_BUTTON.search(name):
            continue
        seen.add(name)
        c = {"kind": _CONTROL_KIND[it["role"]], "name": name}
        for key in ("selected", "expanded"):
            if it.get(key) is not None:
                c[key] = it[key]
        out.append(c)
    return sorted(out, key=lambda c: 0 if c["kind"] == "tab" else 1 if "expanded" in c else 2)


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
        controls=_controls(o),
        footer=o.get("footerText") or "",
    )


def flat_main(d: PageDigest) -> str:
    return rx(r"\n+").sub(" / ", d.main)


def text_offset(d: PageDigest, needle: str) -> int | None:
    """본문에서 needle(띄어쓰기 무시)이 있는 줄의 시작 위치. 없으면 None."""
    letters = [re.escape(ch) for ch in rx(r"\s+").sub("", needle)]
    if not letters:
        return None
    flat = flat_main(d)
    m = rx(r"\s*".join(letters)).search(flat)
    if not m:
        return None
    start = flat.rfind(" / ", 0, m.start())
    return start + 3 if start >= 0 else 0


def page_text_for_llm(d: PageDigest, limit: int = 3000) -> tuple[str, str]:
    """
    요약·답에 쓸 본문(제목글 + 정리한 본문): (원문, LLM에 줄 비식별화본). 원문은 검증에만 쓴다.
    가린 뒤에 자른다. 자른 뒤에 가리면 경계에 걸린 번호 조각('900101-1')이 그대로 나간다.
    """
    raw = "\n".join([*d.headings[:6], d.main])
    return raw[:limit], redact_text(raw)[:limit]


def digest_for_llm(d: PageDigest, offset: int = 0, main_chars: int = 1500, max_links: int = 30) -> dict:
    """목표 수행 LLM에 넘길 짧은 화면 요약. items 이름은 그대로 눌러야 하므로 바꾸지 않는다. 제목·제목글·대화창·본문은 비식별화한다."""
    content = d.contentLinks[:max_links]
    menu_all = [m for m in d.menu if m not in content]
    controls_all = [c for c in d.controls if c["name"] not in content and c["name"] not in menu_all]
    spare = max(0, max_links - len(content)) + max(0, 12 - len(menu_all))
    n_controls = min(len(controls_all), 12 + spare)
    spare -= max(0, n_controls - 12)
    menu = menu_all[: 12 + max(0, spare)]
    flat = flat_main(d)
    return {
        "url": d.url,
        "title": redact_text(d.title),
        "kind": PAGE_KIND_LABEL[d.kind],
        "headings": [redact_text(h) for h in d.headings[:8]],
        "items": [
            *({"kind": "link", "name": name} for name in content),
            *({"kind": "menu", "name": name} for name in menu),
            *controls_all[:n_controls],
        ],
        "hasSearchBox": d.hasSearchBox,
        "dialogs": [redact_text(x) for x in d.dialogs],
        "mainText": redact_text(flat[offset : offset + main_chars]),
        "moreText": len(flat) > offset + main_chars,
        "footer": redact_text(d.footer)[:400],
    }
