import { expect, it } from "vitest";
import { clickNote, pressResult, unconfirmedMessage } from "../../src/agents/web/effect.ts";
import { josa } from "../../src/speech/phrasing.ts";

it("test_press_result_confirmed_moved", () => {
  const moved = "'안내' 링크를 열었습니다. 제목입니다.";
  expect(pressResult("'안내'를", "moved", { moved })).toBe(moved);
});
it("test_press_result_confirmed_changed_with_and_without_reveal", () => {
  expect(pressResult("'신청방법'을", "changed", { revealed: "창구 방문" })).toBe("새로 보이는 내용입니다. 창구 방문");
  expect(pressResult("'탭'을", "changed")).toBe("같은 화면에서 내용이 바뀌었어요.");
  expect(pressResult("'저장'을", "changed", { approved: true, revealed: "저장 완료" })).toBe("'저장'을 눌렀어요. 새로 보이는 내용입니다. 저장 완료");
});
it("test_press_result_nothing_changed", () => {
  expect(pressResult("'글자 크게'를", "none")).toBe("'글자 크게'를 눌렀지만 화면이 바뀌지 않았어요.");
});
it("test_unconfirmed_message_is_third_form", () => {
  expect(unconfirmedMessage("눌렸는지")).toBe("눌렸는지 확인하지 못했어요.");
  expect(unconfirmedMessage("접수됐는지")).toBe("접수됐는지 확인하지 못했어요.");
});
it("test_click_note_uses_three_way_forms_for_autopilot", () => {
  expect(clickNote("글자 크게", { status: "ok", effect: "none" })).toBe(pressResult(josa("'글자 크게'", "을", "를"), "none"));
  expect(clickNote("신청방법", { status: "ok", effect: "changed", revealed: "창구 방문" })).toBe(pressResult(josa("'신청방법'", "을", "를"), "changed", { revealed: "창구 방문" }));
  expect(clickNote("안내", { status: "ok", effect: "moved", title: "공지" })).toBe(pressResult(josa("'안내'", "을", "를"), "moved", { moved: "'공지' 열림" }));
  expect(clickNote("보내기", { status: "unconfirmed", message: unconfirmedMessage("눌렸는지") })).toBe(unconfirmedMessage("눌렸는지"));
});
