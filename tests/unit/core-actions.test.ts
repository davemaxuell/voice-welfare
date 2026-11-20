import { expect, it } from "vitest";
import {
  ACTION_TYPES, EXECUTION_ERROR_CODES, ActionResultSchema, parseAction, parseObservation,
} from "../../src/core/actions.ts";

// 기대값은 pyref(77aad3e)의 cheongeum.core.actions.parse_observation 출력이다.
const base = { platform: "pc", url: "https://a.example/", title: "t", fields: [], errors: [], dialogs: [], capturedAt: "2026-11-20T00:00:00.000Z" };
const emptyOutline = { headings: [], notices: [], steps: [], buttons: [], links: [] };
const withOutline = (extra: Record<string, unknown>) => ({ ...base, outline: { ...emptyOutline, ...extra } });
const item = { ref: "r1", role: "button", name: "닫기", region: "main", disabled: false };

type Outcome = { ok: Record<string, unknown> } | "error";
const cases: [name: string, raw: Record<string, unknown>, expected: Outcome][] = [
  ["loading true", { ...base, loading: true }, { ok: { loading: true } }],
  ["loading false", { ...base, loading: false }, { ok: { loading: false } }],
  ["loading null", { ...base, loading: null }, { ok: {} }],
  ["loading string", { ...base, loading: "yes" }, "error"],
  ["loading int", { ...base, loading: 1 }, "error"],
  ["target selection", withOutline({ screenTarget: { kind: "selection", role: "textbox", label: "이름", text: "김하늘" } }),
    { ok: { outline: { ...emptyOutline, screenTarget: { kind: "selection", role: "textbox", label: "이름", text: "김하늘" } } } }],
  ["target hover with position", withOutline({ screenTarget: { kind: "hover", role: "link", label: "복지로", text: "복지로", position: "왼쪽 위" } }),
    { ok: { outline: { ...emptyOutline, screenTarget: { kind: "hover", role: "link", label: "복지로", text: "복지로", position: "왼쪽 위" } } } }],
  ["target position null", withOutline({ screenTarget: { kind: "focus", role: "button", label: "확인", text: "", position: null } }),
    { ok: { outline: { ...emptyOutline, screenTarget: { kind: "focus", role: "button", label: "확인", text: "" } } } }],
  ["target bad kind", withOutline({ screenTarget: { kind: "click", role: "button", label: "확인", text: "" } }), "error"],
  ["target missing label", withOutline({ screenTarget: { kind: "focus", role: "button", text: "" } }), "error"],
  ["target extra key dropped", withOutline({ screenTarget: { kind: "focus", role: "button", label: "a", text: "b", other: 1 } }),
    { ok: { outline: { ...emptyOutline, screenTarget: { kind: "focus", role: "button", label: "a", text: "b" } } } }],
  ["visual content", withOutline({ hasVisualContent: true, visualLabels: ["차트", "사진"] }),
    { ok: { outline: { ...emptyOutline, hasVisualContent: true, visualLabels: ["차트", "사진"] } } }],
  ["visual labels not list", withOutline({ visualLabels: "차트" }), "error"],
  ["visual labels mixed", withOutline({ visualLabels: ["차트", 1] }), "error"],
  ["visual null", withOutline({ hasVisualContent: null, visualLabels: null }), { ok: { outline: emptyOutline } }],
  ["item searchResult", withOutline({ items: [{ ...item, searchResult: true, pictureMasked: true }] }),
    { ok: { outline: { ...emptyOutline, items: [{ ...item, searchResult: true, pictureMasked: true }] } } }],
  ["item flags false", withOutline({ items: [{ ...item, searchResult: false, pictureMasked: false, selected: false, expanded: true }] }),
    { ok: { outline: { ...emptyOutline, items: [{ ...item, searchResult: false, selected: false, expanded: true, pictureMasked: false }] } } }],
  ["item flags null", withOutline({ items: [{ ...item, searchResult: null, pictureMasked: null }] }),
    { ok: { outline: { ...emptyOutline, items: [item] } } }],
  ["item searchResult int", withOutline({ items: [{ ...item, searchResult: 1 }] }), "error"],
];

it.each(cases)("관찰 계약 %s", (_name, raw, expected) => {
  if (expected === "error") {
    expect(() => parseObservation(raw)).toThrow();
    return;
  }
  const parsed = parseObservation(raw);
  expect(Object.fromEntries(Object.entries(parsed).filter(([key]) => key === "outline" || key === "loading")))
    .toStrictEqual(expected.ok);
});

it("사진 찍기 동작과 기록 실패 코드를 받는다", () => {
  expect(ACTION_TYPES).toEqual(["navigate", "back", "click", "fill", "press", "select", "check", "scroll", "read", "focus", "capture"]);
  expect(EXECUTION_ERROR_CODES).toEqual([
    "TARGET_NOT_FOUND", "AMBIGUOUS_TARGET", "VERIFY_FAILED", "TIMEOUT", "ABORTED",
    "NAVIGATION_FAILED", "RESUBMIT_BLOCKED", "LOG_FAILED", "NOT_SUPPORTED", "UNKNOWN",
  ]);
  const capture = { id: "a", type: "capture", reason: "사진", risk: "low", requiresConfirmation: false };
  expect(parseAction(capture)).toEqual(capture);
  const result = { actionId: "a", ok: false, verified: false, errorCode: "LOG_FAILED", latencyMs: 0 };
  expect(ActionResultSchema.parse(result)).toEqual(result);
  expect(ActionResultSchema.safeParse({ ...result, errorCode: "OTHER" }).success).toBe(false);
});
