"""화면·대화 글이 LLM·기록에 들어가기 전에 개인정보가 가려지는지."""

from cheongeum.agents.web import digest_for_llm, digest_page, page_for_llm
from cheongeum.core.jsutil import now_iso
from cheongeum.safety import REDACTED, check_grounding, redact_text

OUTLINE = {"headings": [], "notices": [], "steps": [], "buttons": [], "links": []}
RRN = "900101-1234567"


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


def test_digest_for_llm_redacts_resident_number_in_main_text():
    # 본문에 주민번호 패턴만 있어도 가리고, 앞뒤 안내용은 남긴다(키워드 뒤 통째 가림과 별개).
    main = f"기초연금 안내입니다. 번호 {RRN} 는 보여 주면 안 됩니다. 대상은 만 65세 이상입니다."
    page = digest_for_llm(digest_page(view(outline={**OUTLINE, "mainText": main})))
    assert RRN not in page["mainText"]
    assert "900101" not in page["mainText"]
    assert REDACTED in page["mainText"]
    assert "만 65세 이상" in page["mainText"]


def test_digest_for_llm_gives_the_footer_with_personal_data_hidden():
    # 대표번호·주소 같은 연락처는 꼬리말에 있다. 본문 읽기에서는 빼도 목표 수행 모델은 봐야 한다.
    footer = f"대표번호 국번없이 1355(평일 09시~18시) 담당 {RRN}"
    page = digest_for_llm(digest_page(view(outline={**OUTLINE, "mainText": "본문만", "footerText": footer})))
    assert "대표번호 국번없이 1355" in page["footer"]
    assert RRN not in page["footer"]
    assert "1355" not in page["mainText"]


def test_digest_for_llm_redacts_title_heading_and_dialog():
    page = digest_for_llm(
        digest_page(
            view(
                title=f"주민 {RRN}",
                dialogs=[{"title": f"확인 {RRN}", "text": ""}],
                outline={**OUTLINE, "headings": [{"level": 1, "text": f"제목 {RRN}"}], "mainText": "본문만"},
            )
        )
    )
    assert RRN not in page["title"]
    assert RRN not in "".join(page["headings"])
    assert RRN not in "".join(page["dialogs"])
    assert REDACTED in page["title"]


def test_page_for_llm_redacts_resident_number():
    main = f"신청 안내. 주민번호 {RRN}. 문의는 129입니다."
    page = page_for_llm(view(outline={**OUTLINE, "mainText": main}))
    assert RRN not in page["mainText"]
    assert REDACTED in page["mainText"]


def test_grounding_still_passes_on_unredacted_page_copy():
    """LLM에는 가린 본문을 주고, 검증만 원문으로 한다(web_answer·autopilot 계약)."""
    raw = f"대상은 만 65세 이상입니다. 주민번호 {RRN}."
    llm_page = redact_text(raw)
    assert RRN not in llm_page
    answer = "대상은 만 65세 이상입니다."
    check = check_grounding(answer=answer, quotes=[answer], sources=[raw], allowed=["나이 조건이 뭐야?"])
    assert check.ok
