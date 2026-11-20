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


def test_footer_is_redacted_before_it_is_cut():
    # 400자에서 자르기 전에 가린다. 자른 뒤에 가리면 경계에 걸린 번호 조각('900101-1')이 그대로 나간다.
    page = digest_for_llm(digest_page(view(outline={**OUTLINE, "mainText": "본문", "footerText": "가" * 392 + RRN})))
    assert "900101" not in page["footer"]


async def test_page_summary_sends_the_llm_redacted_text():
    from cheongeum.speech.screen import Narrator

    sent: dict = {}

    class Llm:
        async def generate(self, **kw):
            sent.update(kw)
            return {"text": "기초연금 안내 페이지예요."}

    class Deps:
        llm = Llm()
        web = None

    class Ctx:
        signal = None

        def trace(self, *a) -> None:
            pass

    v = view(title=f"안내 {RRN}", outline={**OUTLINE, "mainText": f"본인 확인 주민등록번호 {RRN} 입니다. 기초연금은 주민센터에서 신청합니다."})
    await Narrator(Deps()).summarize_body(v, Ctx())
    assert RRN not in sent["user"]
    assert "900101" not in sent["user"]
    assert "기초연금은 주민센터에서 신청합니다" in sent["user"]


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


def test_goal_history_lines_hide_personal_data():
    # 단계 기록의 메모에는 화면 제목·드러난 글이 들어간다(예: "'홍길동님 … 마이페이지' 열림"). 다음 단계 LLM에 그대로 간다.
    from cheongeum.agents.web.autopilot import _history_line

    line = _history_line({"n": 1, "action": "open_url", "ok": True, "note": f"'홍길동님 {RRN} 마이페이지' 열림"})
    assert RRN not in line
    assert "900101" not in line
    assert "마이페이지" in line


def test_page_text_for_llm_hides_personal_data_before_cutting():
    from cheongeum.agents.web.digest import page_text_for_llm

    d = digest_page(view(outline={**OUTLINE, "mainText": "가" * 2992 + " " + RRN + " 끝"}))
    raw, safe = page_text_for_llm(d)
    assert "900101" not in safe
    assert len(safe) <= 3000 and len(raw) <= 3000
