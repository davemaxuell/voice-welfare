import asyncio
import time

import pytest
import pytest_asyncio

from conftest import create_test_runtime, scripted, step

SITE = "127.0.0.1:5174/portal2.html"
PORTAL2 = f"http://{SITE}"


@pytest_asyncio.fixture(scope="module")
async def runtime():
    rt = create_test_runtime({"READ_ONLY_CLICKS": "any"})
    yield rt
    await rt.close()


def names(page: dict) -> list[str]:
    return [x["name"] for x in page["items"]]


def notes(r: dict) -> list[str]:
    return [t.get("note") or "" for t in r["trace"]]


async def test_menu_buttons_reach_the_model(new_session):
    s = await new_session()
    seen = scripted(s, [step("open_url", PORTAL2), step("answer", None, "복지서비스 메뉴가 있어요.", ["복지서비스"])])
    await s.handle_turn(f"{SITE}에서 메뉴 뭐 있는지 알려줘")
    shown = names(seen[1]["page"])
    assert {"복지서비스", "서비스 찾기", "복지지도"} <= set(shown)
    assert "글자 크게" not in shown


@pytest.mark.parametrize(
    "target,title",
    [
        pytest.param("복지 상담 센터", "복지 상담 센터", id="image-link-alt"),
        pytest.param("이용 안내서", "이용 안내서", id="image-link-alt-over-title"),
        pytest.param("관련 법령 보기", "관련 법령", id="role-link-without-href"),
        pytest.param("보조기기 체험관 둘러보기", "보조기기 체험관", id="roleless-clickable"),
    ],
)
async def test_clicks_elements_missed_before(new_session, target, title):
    s = await new_session()
    seen = scripted(s, [step("open_url", PORTAL2), step("click", target), step("answer", None, "열었어요.", [title])])
    r = await s.handle_turn(f"{SITE}에서 {target} 찾아줘")
    assert target in names(seen[1]["page"])
    assert r["observation"]["title"] == f"[테스트] 복지 포털 2 - {title}"


@pytest.mark.parametrize(
    "tab,quote",
    [
        pytest.param("신청방법", "신청 방법은 주소지 행정복지센터 3층 복지과 창구를 방문하는 것입니다", id="li-role-tab"),
        pytest.param("서비스 내용", "서비스 내용은 보조기기 대여료를 한 달에 최대 3만 원까지 지원하는 것입니다", id="button-role-tab"),
    ],
)
async def test_tab_reveals_its_panel(new_session, tab, quote):
    s = await new_session()
    seen = scripted(s, [step("open_url", PORTAL2), step("click", tab), step("answer", None, f"{quote[:30]}예요.", [quote])])
    r = await s.handle_turn(f"{SITE}에서 {tab} 알려줘")
    assert r["speech"] == f"{quote[:30]}예요."
    item = next(x for x in seen[1]["page"]["items"] if x["name"] == tab)
    assert item["kind"] == "tab"
    assert seen[2]["page"]["mainText"].startswith(quote[:20])
    assert any("새로 보이는 내용입니다" in n or "같은 화면에서 내용이 바뀌었어요" in n for n in notes(r))


async def test_expander_opens_in_place(new_session):
    s = await new_session()
    quote = "필요한 서류는 신분증 사본과 진단서 두 가지입니다"
    seen = scripted(s, [step("open_url", PORTAL2), step("click", "서류는 몇 장인가요?"), step("answer", None, "신분증 사본과 진단서, 두 가지예요.", [quote])])
    r = await s.handle_turn(f"{SITE}에서 서류 몇 장인지 알려줘")
    assert r["speech"] == "신분증 사본과 진단서, 두 가지예요."
    before = next(x for x in seen[1]["page"]["items"] if x["name"] == "서류는 몇 장인가요?")
    after = next(x for x in seen[2]["page"]["items"] if x["name"] == "서류는 몇 장인가요?")
    assert (before.get("expanded"), after.get("expanded")) == (False, True)


async def test_find_moves_the_text_window(new_session):
    s = await new_session()
    quote = "이의 신청은 결정 통지를 받은 날부터 90일 안에 할 수 있습니다"
    seen = scripted(s, [step("open_url", PORTAL2), step("find", "이의 신청"), step("answer", None, "결정 통지를 받고 90일 안에 이의 신청할 수 있어요.", [quote])])
    r = await s.handle_turn(f"{SITE}에서 이의 신청 기한 알려줘")
    assert quote not in seen[1]["page"]["mainText"]
    assert quote in seen[2]["page"]["mainText"]
    assert r["speech"] == "결정 통지를 받고 90일 안에 이의 신청할 수 있어요."


async def test_nothing_changed_is_reported(new_session):
    s = await new_session()
    scripted(s, [step("open_url", PORTAL2), step("click", "글자 크게"), step("fail", None, "못 찾았어요.")])
    r = await s.handle_turn(f"{SITE}에서 글자 크게 버튼 찾아줘")
    assert r["semanticAction"] == "goal"
    assert any("바뀌지 않았" in n for n in notes(r))


async def test_voice_tab_click_reads_revealed_text_quickly(new_session):
    s = await new_session()
    await s.handle_turn(f"{SITE} 열어줘")
    t0 = time.monotonic()
    r = await s.handle_turn("신청방법 탭 눌러줘")
    elapsed = time.monotonic() - t0
    assert "행정복지센터 3층 복지과" in r["speech"]
    assert "링크를 열었습니다" not in r["speech"]
    assert elapsed < 4.0


async def test_slow_tab_panel_is_read_after_it_loads(new_session):
    s = await new_session()
    await s.handle_turn(f"{SITE} 열어줘")
    r = await s.handle_turn("부산 창구 탭 눌러줘")
    assert "시청 2층 민원실" in r["speech"]
    assert "불러오는 중" not in r["speech"]


async def test_rotating_notice_is_not_read_as_the_click_effect(new_session):
    s = await new_session()
    await s.handle_turn(f"{SITE}?rotate=1 열어줘")
    # 저절로 바뀌는 자리로 믿으려면 사용자를 기다린 두 번의 틈에서 바뀌어야 한다
    await asyncio.sleep(1.5)
    await s.handle_turn("본문 읽어줘")
    await asyncio.sleep(1.5)
    nothing = await s.handle_turn("글자 크게 버튼 눌러줘")
    assert "바뀌지 않았" in nothing["speech"]
    await asyncio.sleep(1.0)
    tab = await s.handle_turn("신청방법 탭 눌러줘")
    assert "행정복지센터 3층 복지과" in tab["speech"]
    assert "점검" not in tab["speech"]


async def test_content_that_arrived_late_does_not_hide_the_next_click(new_session):
    s = await new_session()
    await s.handle_turn(f"{SITE}?lazy=1 열어줘")
    await asyncio.sleep(3.0)  # 목록은 연 뒤 2.5초에 도착한다(이미 기다림이 끝난 뒤)
    await s.handle_turn("본문 읽어줘")
    r = await s.handle_turn("다음 쪽 버튼 눌러줘")
    assert "2쪽 첫 항목" in r["speech"]


async def test_link_acting_as_tab_finishes_quickly(new_session):
    s = await new_session()
    await s.handle_turn(f"{SITE} 열어줘")
    t0 = time.monotonic()
    r = await s.handle_turn("문의처 안내 링크 눌러줘")
    elapsed = time.monotonic() - t0
    assert "내선 204번" in r["speech"]
    assert elapsed < 4.0


async def test_voice_click_without_effect_says_so(new_session):
    s = await new_session()
    await s.handle_turn(f"{SITE} 열어줘")
    r = await s.handle_turn("글자 크게 버튼 눌러줘")
    assert "바뀌지 않았" in r["speech"]


async def test_link_inside_popup_can_be_pressed(new_session):
    s = await new_session()
    await s.handle_turn(f"{SITE} 열어줘")
    t0 = time.monotonic()
    opened = await s.handle_turn("공지 팝업 열기 버튼 눌러줘")
    assert "대여 품목이 늘어납니다" in opened["speech"]
    assert time.monotonic() - t0 < 4.0
    r = await s.handle_turn("공지 자세히 보기 링크 눌러줘")
    assert r["observation"]["title"] == "[테스트] 복지 포털 2 - 공지"


async def test_login_button_waits_for_the_go_word(new_session):
    s = await new_session()
    await s.handle_turn(f"{SITE} 열어줘")
    r = await s.handle_turn("로그인 눌러줘")
    assert "누를까요?" in r["speech"]
    assert [a for a in r["actions"] if a["action"]["type"] == "click"] == []


async def test_login_click_is_dropped_when_the_button_changed(new_session):
    s = await new_session()
    await s.handle_turn(f"{SITE} 열어줘")
    await s.handle_turn("로그인 눌러줘")
    ref = s.dialogue.approval["action"]["target"]["ref"]
    await s.web.adapter.page.evaluate("(ref) => { document.querySelector(`[data-cheongeum-ref=\"${ref}\"]`).textContent = '회원 탈퇴'; }", ref)
    r = await s.handle_turn("눌러")
    assert r["speech"].startswith("누르려던 '로그인' 버튼이 다른 것으로 바뀌었어요. 그래서 누르지 않았어요.")
    assert [a for a in r["actions"] if a["action"]["type"] == "click"] == []
    assert s.dialogue.approval is None


async def test_rotating_notice_does_not_cancel_an_approval(new_session):
    s = await new_session()
    await s.handle_turn(f"{SITE}?rotate=1 열어줘")
    await s.handle_turn("로그인 눌러줘")
    await asyncio.sleep(1.5)  # 알림 글이 두 번 바뀐다
    r = await s.handle_turn("눌러")
    clicks = [a for a in r["actions"] if a["action"]["type"] == "click"]
    assert clicks and clicks[-1]["policy"]["code"] == "APPROVED" and clicks[-1]["result"]["ok"]


async def test_cloned_elements_get_their_own_ref(new_session):
    s = await new_session()
    await s.handle_turn(f"{SITE} 열어줘")
    await s.web.observe()
    await s.web.adapter.page.evaluate(
        "() => { const a = [...document.querySelectorAll('[role=link]')].find((e) => e.textContent === '담당 기관 안내');"
        " const c = a.cloneNode(true); c.textContent = '담당 기관 안내 2'; a.parentElement.append(c);"
        " c.addEventListener('click', () => { location.href = '/portal2.html?section=agency'; }); }"
    )
    items = (await s.web.observe())["outline"]["items"]
    refs = [x["ref"] for x in items]
    assert len(refs) == len(set(refs))
    r = await s.handle_turn("담당 기관 안내 2 링크 눌러줘")
    assert r["observation"]["title"] == "[테스트] 복지 포털 2 - 담당 기관"


async def test_changed_element_is_not_clicked(new_session):
    s = await new_session()
    await s.handle_turn(f"{SITE} 열어줘")
    view = await s.web.observe()
    item = next(x for x in view["outline"]["items"] if x["name"] == "관련 법령 보기")
    page = s.web.adapter.page
    await page.evaluate("(ref) => { document.querySelector(`[data-cheongeum-ref=\"${ref}\"]`).textContent = '회원 탈퇴'; }", item["ref"])
    action = {
        "id": "stale",
        "type": "click",
        "target": {"ref": item["ref"], "role": item["role"], "name": item["name"]},
        "reason": "t",
        "risk": "low",
        "requiresConfirmation": False,
    }
    result = await s.web.adapter.execute(action)
    assert result["errorCode"] == "VERIFY_FAILED"
    assert await page.title() == "[테스트] 복지 포털 2 - 보조기기 지원 상세"


async def test_elements_are_classified_for_the_guard(new_session):
    s = await new_session()
    await s.handle_turn(f"{SITE} 열어줘")
    roles = {x["name"]: x["role"] for x in (await s.web.observe())["outline"]["items"]}
    assert roles["맞춤 서비스"] == "link"
    assert roles["관련 법령 보기"] == "scriptlink"
    assert roles["복지서비스"] == "button"
    assert roles["신청방법"] == "tab"
    assert roles["보조기기 체험관 둘러보기"] == "generic"


async def test_safe_mode_allows_information_tabs_only():
    rt = create_test_runtime({"READ_ONLY_CLICKS": "safe"})
    s = await rt.create_session()
    try:
        scripted(
            s,
            [
                step("open_url", PORTAL2),
                step("click", "온라인 신청하기"),
                step("click", "신청방법"),
                step("answer", None, "행정복지센터 3층 복지과 창구에서 신청해요.", ["신청 방법은 주소지 행정복지센터 3층 복지과 창구를 방문하는 것입니다"]),
            ],
        )
        r = await s.handle_turn(f"{SITE}에서 신청 방법 알려줘")
        assert len([n for n in notes(r) if "안전 규칙으로 막힘" in n]) == 1
        assert r["speech"] == "행정복지센터 3층 복지과 창구에서 신청해요."
        assert r["observation"]["title"] == "[테스트] 복지 포털 2 - 보조기기 지원 상세"
    finally:
        await s.close()
        await rt.close()
