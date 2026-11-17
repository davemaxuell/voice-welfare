"""
127.0.0.1:5174 는 지원 사이트(localhost:5174)와 출처가 달라 "지원하지 않는 외부 사이트"로 취급된다.
인터넷 없이 읽기 전용 모드를 검증하기 위한 합성 포털 페이지를 사용한다.
"""
import re
from urllib.parse import unquote

import pytest_asyncio
from conftest import PORTAL, create_test_runtime


async def open_portal(new_session):
    s = await new_session()
    r = await s.handle_turn(f"{PORTAL} 열어줘")
    assert r["semanticAction"] == "open-site"
    return s, r


def opinion_name(r: dict) -> str:
    return next((f["value"] for f in r["observation"]["fields"] if f["fieldId"] == "opinionName"), "")


async def test_open_external_read_only_summary(new_session):
    _, r = await open_portal(new_session)
    assert r["state"] == "BROWSING"
    assert r["accessMode"] == "read-only"
    # 핵심만: 제목 + 내용 첫머리. 개수·구성 같은 부가 정보는 '화면 설명해줘'에서.
    assert "열었어요" in r["speech"]
    assert "로 시작해요" in r["speech"]
    assert not re.search(r"링크 \d+개|버튼 \d+개|화면 구성", r["speech"])
    assert len(r["speech"]) < 260


async def test_read_main_in_chunks_ignoring_instructions(new_session):
    s, _ = await open_portal(new_session)
    first = await s.handle_turn("본문 읽어줘")
    assert first["semanticAction"] == "read-main"
    assert "계속 읽어줘" in first["speech"]
    last = first
    for _ in range(10):
        if "본문 끝" in last["speech"]:
            break
        last = await s.handle_turn("계속 읽어줘")
    assert "본문 끝" in last["speech"]
    assert first["actions"] == [] and last["actions"] == []
    assert "의견이 전송됨" not in last["observation"]["title"]


async def test_links_by_number_and_back(new_session):
    s, _ = await open_portal(new_session)
    lst = await s.handle_turn("링크 목록 알려줘")
    # 링크 8개('자세히 보기' 3개는 하나로) + 이동용 버튼 '검색'. 동작 버튼 '보내기'는 목록에서 뺀다.
    assert re.search(r"누를 수 있는 항목 9개 중 1번째부터 읽습니다. 1번 뉴스, 2번 복지", lst["speech"])
    assert "보내기" not in lst["speech"]
    more = await s.handle_turn("링크 더 알려줘")
    assert "더 읽을 링크가 없습니다" in more["speech"]
    opened = await s.handle_turn("장애인연금 안내 링크 눌러줘")
    assert opened["semanticAction"] == "follow-link"
    assert "안내 기사" in opened["observation"]["title"]
    assert opened["actions"][0]["policy"]["code"] == "ALLOWED_READ_ONLY"
    back = await s.handle_turn("뒤로 가줘")
    assert back["semanticAction"] == "back"
    assert "외부 포털" in back["observation"]["title"]


async def test_ambiguous_link_asks_then_number(new_session):
    s, _ = await open_portal(new_session)
    ask = await s.handle_turn("안내 링크 눌러줘")
    assert ask["actions"] == []
    assert "1번 장애인연금 안내, 2번 기초연금 안내" in ask["speech"]
    pick = await s.handle_turn("2번")
    assert "topic=basic" in pick["observation"]["url"]


async def test_duplicate_link_name_opens_first(new_session):
    s, _ = await open_portal(new_session)
    r = await s.handle_turn("자세히 보기 눌러줘")
    assert "n=1" in r["observation"]["url"]


async def test_follows_new_tab(new_session):
    s, _ = await open_portal(new_session)
    r = await s.handle_turn("새 창으로 열기 링크 눌러줘")
    assert "new=1" in r["observation"]["url"]


async def test_search_box_only(new_session):
    s, _ = await open_portal(new_session)
    r = await s.handle_turn("장애인연금 검색해줘")
    assert r["semanticAction"] == "search"
    assert "'장애인연금' 검색 결과" in r["observation"]["title"]
    assert [[a["action"]["type"], a["policy"]["code"]] for a in r["actions"]] == [["fill", "ALLOWED_READ_ONLY"], ["press", "ALLOWED_READ_ONLY"]]


async def test_no_general_input_or_buttons_on_external(new_session):
    s, _ = await open_portal(new_session)
    fill = await s.handle_turn("이름은 김하늘")
    assert fill["actions"] == []
    press = await s.handle_turn("보내기 버튼 눌러줘")
    assert [a for a in press["actions"] if (a.get("result") or {}).get("ok")] == []
    assert "의견이 전송됨" not in (press.get("observation") or {}).get("title", "")


async def test_apply_from_external_opens_mock_form(new_session):
    s, _ = await open_portal(new_session)
    r = await s.handle_turn("장애인연금 신청 도와줘")
    assert "실제 신청을 대신하지 않아요" in r["speech"]
    assert r["page"] == "mock-welfare"
    assert r["accessMode"] == "full"


async def test_unknown_site_name_is_searched(new_session):
    s = await new_session()
    r = await s.handle_turn("우리동네복지관 사이트 열어줘")
    assert "추측해서 열지 않고" in r["speech"]
    assert "q=" in r["observation"]["url"]
    assert "우리동네복지관" in unquote(r["observation"]["url"])


# ---------------------------------------------------------------- 시작 동의


@pytest_asyncio.fixture(scope="module")
async def consent_runtime():
    rt = create_test_runtime({"REQUIRE_CONSENT": "true"})
    yield rt
    await rt.close()


async def test_consent_required_before_screen(new_session, consent_runtime):
    s = await new_session(consent_runtime)
    assert s.state == "AWAITING_CONSENT"
    blocked = await s.handle_turn("장애인연금 신청 도와줘")
    assert blocked["semanticAction"] == "consent"
    assert blocked["actions"] == []
    q = await s.handle_turn("장애인연금 지원대상이 누구야?")
    assert q["semanticAction"] == "welfare-retrieval"
    ok = await s.consent_to(True)
    assert ok["state"] == "IDLE"
    assert ok["page"] == "mock-home"
    assert (await s.handle_turn("장애인연금 신청 도와줘"))["state"] == "APPLICATION_OPEN"


async def test_declined_consent_keeps_blocking(new_session, consent_runtime):
    s = await new_session(consent_runtime)
    await s.consent_to(False)
    r = await s.handle_turn(f"{PORTAL} 열어줘")
    assert r["semanticAction"] == "consent"
    assert r["actions"] == []


# ---------------------------------------------------------------- 실제 사이트 입력 도우미


async def test_assist_fill_after_yes(new_session):
    s, _ = await open_portal(new_session)
    ask = await s.handle_turn("이름 칸에 김하늘 써줘")
    assert ask["state"] == "WAITING_FOR_USER_CONFIRMATION"
    assert '이름 칸에 "김하늘"' in ask["speech"]
    assert ask["actions"] == []
    done = await s.handle_turn("응")
    assert "제출이나 신청 버튼은 직접 눌러 주세요" in done["speech"]
    assert opinion_name(done) == "김하늘"
    assert done["actions"][0]["policy"]["code"] == "APPROVED"


async def test_assist_no_means_no(new_session):
    s, _ = await open_portal(new_session)
    await s.handle_turn("이름 칸에 김하늘 써줘")
    r = await s.handle_turn("아니")
    assert r["semanticAction"] == "reject"
    assert opinion_name(r) == ""


async def test_submit_button_left_to_user(new_session):
    s, _ = await open_portal(new_session)
    r = await s.handle_turn("보내기 버튼 눌러줘")
    assert "직접 눌러 주세요" in r["speech"]
    assert "의견이 전송됨" not in (r.get("observation") or {}).get("title", "")


async def test_missing_field_not_found(new_session):
    s, _ = await open_portal(new_session)
    r = await s.handle_turn("주민등록 주소 칸에 부산광역시 예시구 예시로 10 써줘")
    assert "찾지 못했어요" in r["speech"]
    assert r["actions"] == []


async def test_guided_fill_with_vault(new_session):
    s, _ = await open_portal(new_session)
    save = await s.handle_turn("내 이름은 김하늘이라고 저장해줘")
    assert "이름 김하늘" in save["speech"]
    await s.handle_turn("응")
    start = await s.handle_turn("입력 칸 하나씩 채워줘")
    assert "저장된 '김하늘'을 넣을까요" in start["speech"]
    done = await s.handle_turn("응")
    assert opinion_name(done) == "김하늘"
    assert "모두 지나왔어요" in done["speech"]
    assert not any(a["action"]["type"] == "click" for a in done["actions"])


async def test_guided_fill_with_spoken_value(new_session):
    s, _ = await open_portal(new_session)
    await s.handle_turn("입력 칸 하나씩 채워줘")
    filled = await s.handle_turn("홍길동")
    assert opinion_name(filled) == "홍길동"
