import { expect, it } from "vitest";
import { Churn, diffViews, itemChanged, looksLoading, openedDialog } from "../../src/agents/web/effect.ts";
import type { WebItem, WebObservation } from "../../src/agents/web/view.ts";

function view(main: string, items: WebItem[] = []): WebObservation {
  return { url: "https://example.kr/a", title: "가", outline: { mainText: main, items } };
}
function link(name: string, selected?: boolean): WebItem { return { ref: name, role: "link", name, selected }; }
const page = (banner: string) => "보조기기 지원\n" + banner + "\n지원 대상은 등록 장애인입니다.";
function learned(...mains: string[]) {
  const churn = new Churn();
  let prev: WebObservation | undefined;
  for (const main of mains) {
    const next = view(main);
    churn.observe(next, prev);
    prev = next;
  }
  return churn;
}

it("test_moved_when_address_or_title_changes", () => {
  const v = view("본문");
  expect(diffViews(v, { ...v, url: "https://example.kr/b" })).toEqual(["moved", ""]);
  expect(diffViews(v, { ...v, title: "나" })).toEqual(["moved", ""]);
});
it("test_changed_reports_only_new_lines", () => {
  expect(diffViews(view("지원 대상은 등록 장애인입니다.\n자주 묻는 질문"), view("신청 방법은 창구 방문입니다.\n자주 묻는 질문")))
    .toEqual(["changed", "신청 방법은 창구 방문입니다."]);
  expect(diffViews(view("기존"), view("😀".repeat(601)))).toEqual(["changed", "😀".repeat(600)]);
});
it("test_state_change_alone_counts", () => {
  const tab: WebItem = { ref: "r1", role: "tab", name: "신청방법", selected: false };
  expect(diffViews(view("같은 본문", [tab]), view("같은 본문", [{ ...tab, selected: true }]), "r1")).toEqual(["changed", ""]);
});
it("test_clicked_link_becoming_selected_is_its_own_change", () => {
  const before = view("본문", [link("지원대상", true), link("신청방법")]);
  const after = view("본문", [link("지원대상"), link("신청방법", true)]);
  expect(itemChanged(before, after, "신청방법")).toBe(true);
  expect(itemChanged(before, before, "신청방법")).toBe(false);
});
it("test_selection_elsewhere_is_not_the_clicks_effect", () => {
  const before = view("배너 하나", [link("배너 1", true), link("배너 2"), link("공지")]);
  const after = view("배너 둘", [link("배너 1"), link("배너 2", true), link("공지")]);
  expect(itemChanged(before, after, "공지")).toBe(false);
});
it("test_new_dialog_text_is_revealed", () => {
  const before = view("본문");
  const after = { ...before, dialogs: [{ title: "안내", text: "접수가 마감되었습니다.", buttons: ["닫기"] }] };
  expect(openedDialog(before, after)).toBe(true);
  expect(diffViews(before, after)).toEqual(["changed", "접수가 마감되었습니다."]);
});
it("test_a_spot_that_changed_in_two_pauses_is_ignored_for_any_text", () => {
  const churn = learned(page("알림 1호"), page("알림 2호"), page("알림 3호"));
  expect(churn.volatile()).toEqual({ "보조기기 지원": 1 });
  expect(diffViews(view(page("알림 3호")), view(page("알림 9호")), undefined, churn.volatile())).toEqual(["none", ""]);
});
it("test_content_that_arrived_once_is_not_ignored", () => {
  const churn = learned("검색 결과", "검색 결과\n1쪽 첫 항목");
  expect(churn.volatile()).toEqual({});
  expect(diffViews(view("검색 결과\n1쪽 첫 항목"), view("검색 결과\n2쪽 첫 항목"), undefined, churn.volatile())).toEqual(["changed", "2쪽 첫 항목"]);
});
it("test_only_the_lines_that_used_to_change_are_ignored", () => {
  const before = view("보조기기 지원\n알림 1호\n지원 대상"), after = view("보조기기 지원\n알림 2호\n신청 방법은 창구 방문입니다.");
  expect(diffViews(before, after, undefined, { "보조기기 지원": 1 })).toEqual(["changed", "신청 방법은 창구 방문입니다."]);
});
it("test_ticker_at_the_top_does_not_hide_a_whole_page_swap", () => {
  expect(diffViews(view("알림 1호\n가 화면 내용"), view("알림 2호\n나 화면 내용"), undefined, { "": 1 })).toEqual(["changed", "나 화면 내용"]);
});
it("test_churn_forgets_when_the_page_changes", () => {
  const churn = learned(page("알림 1호"), page("알림 2호"), page("알림 3호"));
  churn.observe({ ...view("다른 화면"), title: "나" });
  expect(churn.volatile()).toEqual({});
});
it("test_loading_placeholders_are_not_content", () => {
  expect(looksLoading("불러오는 중…")).toBe(true);
  expect(looksLoading("Loading...")).toBe(true);
  expect(looksLoading("부산 창구는 시청 2층 민원실입니다.")).toBe(false);
  expect(looksLoading("자료를 불러오는 중에 오류가 나면 고객센터로 문의하세요. ".repeat(3))).toBe(false);
});
it("test_none_when_nothing_changes", () => {
  expect(diffViews(view("본문", [link("r1", true)]), view("본문", [link("r1", true)]), "r1")).toEqual(["none", ""]);
});
