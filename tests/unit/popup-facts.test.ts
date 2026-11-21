import { expect, it } from "vitest";
import { parseObservation } from "../../src/core/actions.ts";
import { authPageKind } from "../../src/agents/web/auth_page.ts";
import { digestPage } from "../../src/agents/web/digest.ts";
import { diffViews } from "../../src/agents/web/effect.ts";
import { WebObservationSchema, type WebObservation } from "../../src/agents/web/view.ts";
import { Narrator } from "../../src/speech/screen.ts";

// 팝업 사실(dialog.kind·hasInputs, item.dialog)은 선택 항목이다. 새 필드가 없던 관찰과 값이 그대로여야 한다.
const base = { platform: "pc", url: "https://a.example/", title: "t", fields: [], errors: [], capturedAt: "2026-11-22T00:00:00.000Z" };
const emptyOutline = { headings: [], notices: [], steps: [], buttons: [], links: [] };
const dialog = { title: "공지", text: "점검 안내입니다.", buttons: ["닫기"] };
const item = { ref: "r1", role: "button", name: "닫기", region: "other", disabled: false } as const;

it("팝업 사실은 값이 있을 때만 남기고 false와 생략을 구분한다", () => {
  const parsed = parseObservation({
    ...base,
    dialogs: [
      { ...dialog, hasInputs: false, kind: "layer" },
      { ...dialog, hasInputs: true, kind: "dialog" },
      dialog,
      { ...dialog, hasInputs: null, kind: null },
    ],
  });
  expect(parsed.dialogs).toStrictEqual([
    { ...dialog, hasInputs: false, kind: "layer" },
    { ...dialog, hasInputs: true, kind: "dialog" },
    dialog,
    dialog,
  ]);
});

it("알 수 없는 팝업 종류와 불리언이 아닌 입력 표시는 받지 않는다", () => {
  for (const bad of [{ kind: "popup" }, { kind: 1 }, { hasInputs: "yes" }, { hasInputs: 0 }]) {
    expect(() => parseObservation({ ...base, dialogs: [{ ...dialog, ...bad }] }), JSON.stringify(bad)).toThrow();
  }
});

it("팝업 단추의 빈 이름과 같은 이름은 지우지 않고 개수 그대로 둔다", () => {
  const buttons = ["닫기", "", "닫기", ""];
  expect(parseObservation({ ...base, dialogs: [{ ...dialog, buttons }] }).dialogs[0]?.buttons).toStrictEqual(buttons);
});

it("이름 없는 팝업 단추는 관찰에 남아도 화면 설명에서는 지금처럼 읽지 않는다", () => {
  const view: WebObservation = {
    url: "https://a.example/", title: "복지 안내", fields: [], errors: [],
    dialogs: [{ title: "안내", text: "내용입니다.", buttons: ["닫기", ""], hasInputs: true, kind: "dialog" }],
    outline: { mainText: "복지 안내 본문입니다." },
  };
  const spoken = new Narrator({ web: { field: () => undefined } }).describeScreen(view);
  expect(spoken).toContain("버튼: 닫기.");
  expect(spoken).not.toContain("닫기, .");
});

it("항목의 dialog 번호는 0부터 시작하는 정수일 때만 받는다", () => {
  const withItem = (extra: Record<string, unknown>) =>
    ({ ...base, dialogs: [dialog], outline: { ...emptyOutline, items: [{ ...item, ...extra }] } });
  expect(parseObservation(withItem({ dialog: 0 })).outline?.items).toStrictEqual([{ ...item, dialog: 0 }]);
  expect(parseObservation(withItem({ dialog: 2 })).outline?.items).toStrictEqual([{ ...item, dialog: 2 }]);
  expect(parseObservation(withItem({ dialog: null })).outline?.items).toStrictEqual([item]);
  expect(parseObservation(withItem({})).outline?.items).toStrictEqual([item]);
  for (const bad of [-1, 1.5, "0", true]) {
    expect(() => parseObservation(withItem({ dialog: bad })), String(bad)).toThrow();
  }
});

it("화면 비교용 느슨한 스키마도 팝업 사실을 그대로 둔다", () => {
  const raw = {
    dialogs: [{ title: "공지", kind: "layer", hasInputs: false }, { title: "확인" }],
    outline: { items: [{ ref: "r1", dialog: 0 }] },
  };
  expect(WebObservationSchema.parse(raw)).toEqual(raw);
});

it("팝업 사실이 있어도 화면 요약과 변화 판정은 달라지지 않는다", () => {
  const plain: WebObservation = {
    url: "https://a.example/", title: "복지 안내", fields: [], errors: [],
    dialogs: [dialog], outline: { mainText: "복지 안내 본문입니다.", items: [item] },
  };
  const withFacts: WebObservation = {
    ...plain, dialogs: [{ ...dialog, hasInputs: false, kind: "layer" }],
    outline: { mainText: "복지 안내 본문입니다.", items: [{ ...item, dialog: 0 }] },
  };
  expect(digestPage(withFacts)).toEqual(digestPage(plain));
  const closed: WebObservation = { ...plain, dialogs: [] };
  expect(diffViews(closed, withFacts, "r1")).toEqual(diffViews(closed, plain, "r1"));
});

it("레이어 팝업의 홍보 문구는 인증 화면으로 읽지 않고 대화상자는 지금처럼 읽는다", () => {
  const promo = { title: "안내", text: "카카오톡 인증으로 로그인하세요.", buttons: ["닫기"] };
  const view = (dialogs: WebObservation["dialogs"]): WebObservation => ({
    url: "https://a.example/", title: "복지 안내", fields: [], errors: [], dialogs,
    outline: { mainText: "복지 안내 본문입니다.", items: [] },
  });
  expect(authPageKind(view([]))).toBe("other");
  expect(authPageKind(view([{ ...promo, kind: "layer", hasInputs: false }]))).toBe("other");
  expect(authPageKind(view([{ ...promo, kind: "dialog", hasInputs: false }]))).toBe("verification");
  expect(authPageKind(view([promo]))).toBe("verification");
});
