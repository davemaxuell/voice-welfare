import { expect, it } from "vitest";
import { fingerprint, recheck, type ApprovalAction } from "../../src/agents/web/approval.ts";
import type { WebItem, WebObservation } from "../../src/agents/web/view.ts";

const login = { ref: "r7-ab", role: "button", name: "로그인", region: "menu", disabled: false } satisfies WebItem;
const click = { type: "click", target: { ref: "r7-ab", role: "button", name: "로그인" } } satisfies ApprovalAction;
const fill = { type: "fill", target: { fieldId: "address", name: "주민등록 주소" }, value: "부산광역시 예시구 예시로 10" } satisfies ApprovalAction;

function view({ main = "본문", url = "https://example.kr/a?x=1", items = [login], address = "" }:
  { main?: string; url?: string; items?: WebItem[]; address?: string } = {}): WebObservation {
  return { url, title: "가", fields: [{ fieldId: "address", label: "주민등록 주소", value: address }], outline: { mainText: main, items } };
}

function change(before: WebObservation, after: WebObservation, action: ApprovalAction = click) {
  return recheck(fingerprint(before, [action], "누를까요?"), after, [action])[1];
}

it("test_body_text_and_title_changes_do_not_count", () => {
  expect(change(view({ main: "알림: 점검 1호" }), { ...view({ main: "알림: 점검 2호" }), title: "나" })).toBeUndefined();
});

it("test_page_change_is_named", () => {
  expect(change(view(), view({ url: "https://example.kr/b" }))).toBe("여쭤본 뒤에 화면이 바뀌었어요.");
});

it("test_target_gone_or_replaced_is_named", () => {
  expect(change(view(), view({ items: [] }))).toBe("누르려던 '로그인' 버튼이 화면에서 없어졌어요.");
  expect(change(view(), view({ items: [{ ...login, name: "회원 탈퇴" }] }))).toBe("누르려던 '로그인' 버튼이 다른 것으로 바뀌었어요.");
});

it("test_value_change_in_a_read_back_field_is_named", () => {
  expect(change(view(), view({ address: "다른 주소" }), fill)).toBe("주민등록 주소 칸 값이 바뀌었어요.");
  expect(change(view(), view(), fill)).toBeUndefined();
});

it("test_recheck_returns_a_fresh_fingerprint_with_the_same_sentence", () => {
  const asked = fingerprint(view(), [click], "누를까요?");
  expect(recheck(asked, view({ main: "다른 본문" }), [click])).toEqual([asked, undefined]);
});

it("test_proposed_fill_value_is_bound_in_the_fingerprint", () => {
  const asked = fingerprint(view(), [fill], "넣을까요?");
  expect(asked.actions[0]?.valueHash).toHaveLength(16);
  expect(JSON.stringify(asked)).not.toContain(fill.value);
  const mutated = { ...fill, value: "서울시 다른구 다른로 1" };
  expect(recheck(asked, view(), [mutated])[1]).toBe("여쭤본 뒤에 넣을 값이 바뀌었어요.");
  expect(recheck(asked, view(), [fill])[1]).toBeUndefined();
});

it("같은 칸이라도 이름이 바뀌면 바뀐 칸으로 말한다", () => {
  const relabelled = view();
  const fields = [{ fieldId: "address", label: "실거주 주소", value: "" }];
  const asked = fingerprint(view(), [click], "누를까요?", ["address"]);
  expect(recheck(asked, { ...relabelled, fields }, [click])[1]).toBe("주민등록 주소 칸 값이 바뀌었어요.");
});
