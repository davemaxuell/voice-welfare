
from cheongeum.agents.web import digest_for_llm, digest_page
from cheongeum.core.jsutil import jdumps, now_iso
from cheongeum.safety import check_grounding, extract_numbers, quote_in_source, unsupported_numbers


def test_quote_tolerates_spacing_punctuation_endings():
    src = "신청은 주소지 행정복지센터나 온라인으로 할 수 있습니다. 필요한 서류는 기관마다 다릅니다."
    assert quote_in_source("신청은 주소지 행정복지센터나 온라인으로 할 수 있습니다", src)
    assert quote_in_source('"신청은 주소지  행정복지센터나 온라인으로 할 수 있어요."', src)


def test_quote_not_in_source_or_too_short():
    src = "신청은 주소지 행정복지센터나 온라인으로 할 수 있습니다."
    assert not quote_in_source("신청은 우체국에서만 받습니다", src)
    assert not quote_in_source("신청", src)


def test_units_converted():
    assert unsupported_numbers("매월 30만 원을 받아요.", ["기준액 300,000원"]) == []
    assert unsupported_numbers("기준액은 300,000원이에요.", ["기준액 30만원"]) == []
    assert unsupported_numbers("1억 2천만 원 이하", ["재산 120,000,000원 이하"]) == []


def test_unsupported_amounts_and_phones():
    assert unsupported_numbers("매월 40만 원이에요.", ["기준액 300,000원"]) == ["40만"]
    assert unsupported_numbers("1588-1234로 전화하세요.", ["문의 1588-0000"]) == ["15881234"]


def test_small_numbers_ignored():
    assert unsupported_numbers("두 가지 중 1번이 맞아요.", ["아무 숫자 없음"]) == []


def test_dates():
    assert 2026 in extract_numbers("2026.1.1").values
    assert unsupported_numbers("2026년 1월부터예요.", ["시행일 2026.1.1"]) == []


def test_check_grounding():
    ok = check_grounding(answer="만 65세 이상이면 대상이에요.", quotes=["만 65세 이상"], sources=["대상: 만 65세 이상 어르신"])
    assert ok.ok
    no_quote = check_grounding(answer="대상이에요.", quotes=[], sources=["대상: 만 65세 이상"])
    assert "근거 문장이 없음" in no_quote.reasons
    from_question = check_grounding(answer="70세면 해당돼요.", sources=["만 65세 이상"], allowed=["70세인데 받을 수 있어?"], min_quotes=0)
    assert from_question.ok


OUTLINE = {"headings": [], "notices": [], "steps": [], "buttons": [], "links": []}


def view(**p) -> dict:
    return {
        "platform": "pc",
        "pageId": "external",
        "url": "https://example.kr/",
        "title": "예시",
        "fields": [],
        "errors": [],
        "dialogs": [],
        "capturedAt": now_iso(),
        **p,
    }


def test_digest_menu_and_content():
    d = digest_page(
        view(
            outline={
                **OUTLINE,
                "headings": [{"level": 1, "text": "공지사항"}],
                "links": ["본문 바로가기", "홈", "공지", "2026년 접수 안내", "2026년 접수 안내", "서식 자료실"],
                "menuLinks": ["홈", "공지"],
                "mainLinks": ["2026년 접수 안내", "2026년 접수 안내", "서식 자료실"],
                "mainText": "홈\n공지\n공지사항\n2026년 접수 안내\n2026년 접수 안내\n가\n접수는 3월까지입니다.",
            }
        )
    )
    assert d.menu == ["홈", "공지"]
    assert d.contentLinks == ["2026년 접수 안내", "서식 자료실"]
    assert d.main == "공지사항\n2026년 접수 안내\n접수는 3월까지입니다."
    assert "메뉴 이동" in d.canDo


def test_digest_kinds():
    assert digest_page(view(url="https://search.example.kr/?query=날씨", outline=OUTLINE)).kind == "search-results"
    assert digest_page(view(title="Access Denied", outline=OUTLINE)).kind == "blocked"
    field = {"fieldId": "a", "label": "이름", "type": "text", "visible": True, "required": False, "filled": False}
    assert digest_page(view(fields=[field, {**field, "fieldId": "b", "label": "주소"}], outline=OUTLINE)).kind == "form"


def test_digest_for_llm_is_smaller():
    links = [f"기사 제목 {i}번 — 아주 긴 제목이 이어집니다" for i in range(200)]
    main_text = "\n".join(f"{i}번째 문단입니다. 같은 이야기가 계속됩니다." for i in range(200))
    v = view(outline={**OUTLINE, "links": links, "mainLinks": links, "mainText": main_text})
    small = digest_for_llm(digest_page(v))
    assert len(small["items"]) <= 30 + 12 + 12
    assert len(small["mainText"]) <= 1500
    assert small["moreText"] is True
    assert len(jdumps(small)) < len(jdumps(v["outline"])) / 3


def test_digest_ranks_menu_buttons_over_screen_tools():
    tools = ["글자 작게", "글자 크게", "화면 인쇄", "English", "中文", "日本語", "이전 배너", "다음 배너", "공유하기", "맨 위로", "본문 바로가기"]
    menu = ["복지서비스", "서비스 찾기", "복지지도"]
    buttons = [{"name": n, "disabled": False} for n in [*tools, *menu]]
    shown = [x["name"] for x in digest_for_llm(digest_page(view(outline={**OUTLINE, "buttons": buttons})))["items"]]
    assert set(menu) <= set(shown)
    assert not set(tools) & set(shown)


def test_digest_gives_spare_room_to_buttons():
    buttons = [{"name": f"메뉴 {i}", "disabled": False} for i in range(40)]
    page = digest_for_llm(digest_page(view(outline={**OUTLINE, "links": ["가나", "다라"], "mainLinks": ["가나", "다라"], "buttons": buttons})))
    assert len([x for x in page["items"] if x["kind"] == "button"]) == 40
    assert len(page["items"]) <= 30 + 12 + 12


def test_digest_lists_tabs_and_expanders_first_with_state():
    def item(role, name, **state):
        return {"ref": name, "role": role, "name": name, "region": "main", "disabled": False, **state}

    items = [item("button", "더 보기"), item("button", "서류 안내", expanded=False), item("tab", "지원대상", selected=True), item("tab", "신청방법", selected=False)]
    page = digest_for_llm(digest_page(view(outline={**OUTLINE, "items": items})))
    assert page["items"] == [
        {"kind": "tab", "name": "지원대상", "selected": True},
        {"kind": "tab", "name": "신청방법", "selected": False},
        {"kind": "button", "name": "서류 안내", "expanded": False},
        {"kind": "button", "name": "더 보기"},
    ]


def test_readable_body():
    lines = [
        "로그아웃", "복지소식", "복지로 소개", "고객센터", "사이트맵", "복지서비스 상세(중앙)", "즐겨찾기", "찜하기",
        "기초연금", "노인에게 기초연금을 지급하여 안정적인 소득기반을 제공함으로써 노인의 생활안정을 지원합니다.",
        "신청하기", "지원대상 선택됨", "만 65세 이상인 어르신으로서 소득인정액이 기준 이하인 사람에게 지원합니다.",
        "만족도 평가", "이 페이지에서 제공하는 정보에 얼마나 만족하십니까 ?", "매우 만족",
    ]  # fmt: skip
    d = digest_page(view(outline={**OUTLINE, "mainText": "\n".join(lines)}))
    assert d.body.split("\n")[0] == "기초연금"
    assert "로그아웃" not in d.body
    assert "신청하기" not in d.body
    assert "지원대상\n만 65세" in d.body
    assert "만족도" not in d.body
