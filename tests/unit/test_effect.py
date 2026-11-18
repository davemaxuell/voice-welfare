from unittest.mock import AsyncMock, Mock

from cheongeum.agents.web.agent import WebExecutionAgent
from cheongeum.agents.web.effect import Churn, diff_views, item_changed, looks_loading


def view(main: str, url="https://example.kr/a", title="가", items=None, dialogs=None) -> dict:
    return {"url": url, "title": title, "dialogs": dialogs or [], "outline": {"mainText": main, "items": items or []}}


def tab(selected: bool) -> dict:
    return {"ref": "r1", "role": "tab", "name": "신청방법", "region": "main", "disabled": False, "selected": selected}


def test_moved_when_address_or_title_changes():
    assert diff_views(view("본문"), view("본문", url="https://example.kr/b")) == ("moved", "")
    assert diff_views(view("본문"), view("본문", title="나")) == ("moved", "")


def test_changed_reports_only_new_lines():
    before = view("지원 대상은 등록 장애인입니다.\n자주 묻는 질문")
    after = view("신청 방법은 창구 방문입니다.\n자주 묻는 질문")
    assert diff_views(before, after) == ("changed", "신청 방법은 창구 방문입니다.")


def test_state_change_alone_counts():
    before = view("같은 본문", items=[tab(False)])
    after = view("같은 본문", items=[tab(True)])
    assert diff_views(before, after, "r1") == ("changed", "")


def link(name, **state):
    return {"ref": name, "role": "link", "name": name, "region": "main", "disabled": False, **state}


def test_clicked_link_becoming_selected_is_its_own_change():
    before = view("본문", items=[link("지원대상", selected=True), link("신청방법")])
    after = view("본문", items=[link("지원대상"), link("신청방법", selected=True)])
    assert item_changed(before, after, "신청방법")
    assert not item_changed(before, before, "신청방법")


def test_selection_elsewhere_is_not_the_clicks_effect():
    # 돌아가는 배너의 점(aria-selected)이 바뀌어도 누른 요소의 변화가 아니다
    before = view("배너 하나", items=[link("배너 1", selected=True), link("배너 2"), link("공지")])
    after = view("배너 둘", items=[link("배너 1"), link("배너 2", selected=True), link("공지")])
    assert not item_changed(before, after, "공지")


def test_new_dialog_text_is_revealed():
    d = {"title": "안내", "text": "접수가 마감되었습니다.", "buttons": ["닫기"]}
    assert diff_views(view("본문"), view("본문", dialogs=[d])) == ("changed", "접수가 마감되었습니다.")


PAGE = "보조기기 지원\n{}\n지원 대상은 등록 장애인입니다."


def learned(*mains: str) -> Churn:
    churn = Churn()
    prev = None
    for main in mains:
        cur = view(main)
        churn.observe(cur, prev)
        prev = cur
    return churn


def test_a_spot_that_changed_in_two_pauses_is_ignored_for_any_text():
    churn = learned(PAGE.format("알림 1호"), PAGE.format("알림 2호"), PAGE.format("알림 3호"))
    assert churn.volatile() == {"보조기기 지원": 1}
    assert diff_views(view(PAGE.format("알림 3호")), view(PAGE.format("알림 9호")), volatile=churn.volatile()) == ("none", "")


async def test_observe_learns_churn_only_after_idle_gaps():
    adapter = AsyncMock()
    adapter.observe.side_effect = [view(PAGE.format(f"알림 {i}호")) for i in range(4)]
    agent = WebExecutionAgent(adapter, Mock(), Mock())
    agent.clock = iter([0, 0.5, 1.5, 2.5]).__next__
    for _ in range(3):
        await agent.observe()
    assert agent._churn.volatile() == {}
    await agent.observe()
    assert agent._churn.volatile() == {"보조기기 지원": 1}


def test_content_that_arrived_once_is_not_ignored():
    # 늦게 도착한 목록(한 번 바뀜) 자리에서 나중에 누른 결과가 나와도 숨기지 않는다
    churn = learned("검색 결과", "검색 결과\n1쪽 첫 항목")
    assert churn.volatile() == {}
    assert diff_views(view("검색 결과\n1쪽 첫 항목"), view("검색 결과\n2쪽 첫 항목"), volatile=churn.volatile()) == ("changed", "2쪽 첫 항목")


def test_only_the_lines_that_used_to_change_are_ignored():
    # 배너 바로 아래 패널이 함께 바뀌어도 배너 한 줄만 빼고 나머지는 누른 효과다
    volatile = {"보조기기 지원": 1}
    before = view("보조기기 지원\n알림 1호\n지원 대상")
    after = view("보조기기 지원\n알림 2호\n신청 방법은 창구 방문입니다.")
    assert diff_views(before, after, volatile=volatile) == ("changed", "신청 방법은 창구 방문입니다.")


def test_ticker_at_the_top_does_not_hide_a_whole_page_swap():
    volatile = {"": 1}
    assert diff_views(view("알림 1호\n가 화면 내용"), view("알림 2호\n나 화면 내용"), volatile=volatile) == ("changed", "나 화면 내용")


def test_churn_forgets_when_the_page_changes():
    churn = learned(PAGE.format("알림 1호"), PAGE.format("알림 2호"), PAGE.format("알림 3호"))
    churn.observe({**view("다른 화면"), "title": "나"}, None)
    assert churn.volatile() == {}


def test_loading_placeholders_are_not_content():
    assert looks_loading("불러오는 중…")
    assert looks_loading("Loading...")
    assert not looks_loading("부산 창구는 시청 2층 민원실입니다.")
    assert not looks_loading("자료를 불러오는 중에 오류가 나면 고객센터로 문의하세요. " * 3)


def test_none_when_nothing_changes():
    assert diff_views(view("본문", items=[tab(True)]), view("본문", items=[tab(True)]), "r1") == ("none", "")
