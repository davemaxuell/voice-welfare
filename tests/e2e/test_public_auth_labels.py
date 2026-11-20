"""공개 안내 화면에 인증서 단추가 있어도 본인인증 인계로 대화를 막지 않는다(2026-11-19 복지로 QA)."""
from conftest import FakeLlm, with_llm

# 복지로처럼 머리말에 '공동인증서 내보내기'·'로그인' 단추가 있는 공개 안내 화면
URL = "http://127.0.0.1:5174/pilot-public-guide.html"
TITLE = "복지서비스 상세 | 복지로"
PAGE = (
    f"<title>{TITLE}</title>"
    '<div class="util"><button type="button">공동인증서 내보내기</button><button type="button">로그인</button></div>'
    "<h1>기초연금</h1><p>기초연금은 가까운 동 주민센터나 국민연금공단 지사에서 신청할 수 있어요.</p>"
)
ASK_ENGLISH = "Please read the page to me"


async def open_public_guide(s) -> dict:
    await s.web.adapter.page.route(URL, lambda route: route.fulfill(content_type="text/html; charset=utf-8", body=PAGE))
    return await s.handle_turn(f"{URL} 열어줘")


async def test_public_guide_with_certificate_button_keeps_guidance(new_session):
    s = await new_session()
    opened = await open_public_guide(s)
    assert opened["state"] != "AUTH_HANDOFF" and not opened.get("authHandoff")
    assert opened["observation"]["title"] == TITLE
    read = await s.handle_turn("본문 읽어줘")
    assert read["state"] != "AUTH_HANDOFF"
    assert "주민센터" in read["speech"]


async def test_english_follow_up_on_public_guide_is_answered_in_english(new_session):
    s = await new_session()

    def fn(*, system, user, schemaName, schema):
        if schemaName == "translate_in":
            return {"text": "본문 읽어줘"} if user == ASK_ENGLISH else None
        if schemaName == "translate_out":
            return {"text": f"[en] {user}"}
        return None

    llm = FakeLlm(fn=fn)
    with_llm(s, llm)
    await open_public_guide(s)
    await s.handle_turn("영어로 말해줘")
    r = await s.handle_turn(ASK_ENGLISH)
    assert r["intentType"] != "SECRET_DISCLOSURE" and r["state"] != "AUTH_HANDOFF"
    assert r["lang"] == "en" and r["speech"].startswith("[en] ")
    assert "주민센터" in r["speech"]
