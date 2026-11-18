import { expect, it, vi } from "vitest";
import { DialogueState } from "../../src/core/dialogue.ts";
import { ActionLog } from "../../src/personal/action_log.ts";
import { dueReminder, parseDate, parsePersonalCommand, parseVaultValues, vaultKeyForLabel } from "../../src/personal/commands.ts";
import { PersonalDialogue } from "../../src/personal/dialogue.ts";
import { PersonalStore } from "../../src/personal/store.ts";

const today = "2026-11-16";
it("test_vault_values", () => {
  expect(parseVaultValues("내 이름은 김하늘이고 주소는 부산광역시 예시구 예시로 10이고 연락처는 010-1234-5678이라고 저장해줘")).toEqual({
    name: "김하늘", address: "부산광역시 예시구 예시로 10", phone: "010-1234-5678",
  });
  expect(parseVaultValues("주소는 [비공개]라고 저장해줘")).toEqual({});
});
it("test_vault_key_for_label", () => {
  expect(vaultKeyForLabel("신청인 성명")).toBe("name");
  expect(vaultKeyForLabel("휴대전화 번호")).toBe("phone");
  expect(vaultKeyForLabel("비밀번호")).toBeUndefined();
});
it("test_personal_commands", () => {
  expect(parsePersonalCommand("기초연금 신청했어, 접수번호는 A12345678")).toEqual({ kind: "app-record", service: "기초연금", receiptNo: "A12345678" });
  expect(parsePersonalCommand("기초연금 신청했어?")).toBeUndefined();
  expect(parsePersonalCommand("보완 서류는 12월 3일까지래", today)).toMatchObject({ kind: "app-due", note: "보완 서류 제출" });
  expect(parsePersonalCommand("기초연금 12월 25일까지 신청해야 해?")).toBeUndefined();
  expect(parsePersonalCommand("신청한 거 어떻게 됐어?")).toEqual({ kind: "app-status" });
  expect(parsePersonalCommand("내 정보 지워줘")).toEqual({ kind: "vault-clear" });
});
it("test_speech_pref_commands", () => {
  const pairs = [
    ["천천히 말해줘", { rate: 0.9 }], ["빨리 말해줘", { rate: 1.5 }], ["짧게 말해줘", { length: "short" }],
    ["자세히 말해줘", { length: "detailed" }], ["진행 상황 말해줘", { progressSpoken: true }],
    ["조용히 해", { progressSpoken: false }], ["목소리는 기본으로 해줘", { voice: null }],
  ] as const;
  for (const [text, values] of pairs) expect(parsePersonalCommand(text)).toEqual({ kind: "speech-set", values });
  expect(parsePersonalCommand("말하기 설정 알려줘")).toEqual({ kind: "speech-read" });
  expect(parsePersonalCommand("말하기 설정 초기화")).toEqual({ kind: "speech-clear" });
});
it("test_speech_dialogue_applies", () => {
  const onSpeech = vi.fn(), store = new PersonalStore(), d = new PersonalDialogue(store, new DialogueState("IDLE"), onSpeech);
  const out = d.run({ kind: "speech-set", values: { rate: 0.9, progressSpoken: false } });
  expect(out?.semanticAction).toBe("none");
  expect(out?.speech).toContain("천천히");
  expect(onSpeech).toHaveBeenLastCalledWith(expect.objectContaining({ rate: 0.9, progressSpoken: false }));
  expect(d.run({ kind: "speech-read" })?.speech).toContain("진행 상황 알림은 끕니다");
  d.run({ kind: "speech-clear" });
  expect(onSpeech).toHaveBeenLastCalledWith(expect.objectContaining({ rate: 1.25, progressSpoken: true }));
});
it("test_parse_date", () => {
  expect(parseDate("12월 3일까지", today)).toBe("2026-12-03");
  expect(parseDate("1월 5일", today)).toBe("2027-01-05");
  expect(parseDate("3일 뒤", today)).toBe("2026-11-19");
});
it("test_due_reminder", () => {
  const first = { id: "1", service: "기초연금", appliedAt: "2026-11-01", dueDate: "2026-11-18", dueNote: "보완 서류 제출" };
  const second = { id: "2", service: "장애수당", appliedAt: "2026-11-01", dueDate: "2026-12-30" };
  expect(dueReminder([first, second], today)).toBe("기초연금 보완 서류 제출이 11월 18일까지, 2일 남았어요.");
  expect(dueReminder([second], today)).toBeUndefined();
});
it("test_parse_action_log_read", () => {
  for (const text of ["오늘 한 일 들려줘", "오늘 뭐 했어"]) expect(parsePersonalCommand(text)).toEqual({ kind: "action-log-read" });
});

it("금고 확인은 대기를 한 번만 소비한다", () => {
  const store = new PersonalStore(), state = new DialogueState("BROWSING"), d = new PersonalDialogue(store, state);
  const save = { kind: "vault-save", values: { phone: "010-0000-0000", name: "김하늘" } } as const;
  expect(d.run({ kind: "vault-save", values: {} })?.semanticAction).toBe("clarify");
  expect(d.run(save)?.speech).toMatch(/^연락처 010-0000-0000, 이름 김하늘/u);
  expect(store.vault()).toEqual({});
  expect(d.confirm("다른 질문")).toBeUndefined();
  expect(state.vaultConfirm).toBeUndefined();
  expect(d.confirm("네")).toBeUndefined();
  d.run(save);
  expect(d.confirm("네")?.state).toBe("IDLE");
  expect(d.savedFor("신청인 성명")).toBe("김하늘");
  expect(d.savedFor("비밀번호")).toBeUndefined();
  expect(d.run({ kind: "vault-read" })?.speech).toBe("저장된 정보는 연락처 010-0000-0000, 이름 김하늘이에요.");
  expect(d.run({ kind: "vault-clear" })?.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(d.confirm("하지\u00a0마")?.speech).toBe("알겠어요. 그대로 둘게요.");
  expect(d.savedFor("이름")).toBe("김하늘");
  d.run({ kind: "vault-clear" });
  expect(d.confirm("지워")?.speech).toBe("저장된 내 정보를 모두 지웠어요.");
  expect(store.vault()).toEqual({});
});
it("신청 기록·마감일·완료는 진행 중인 신청과 서비스 이름을 기준으로 한다", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 16, 12));
  try {
    const store = new PersonalStore(), d = new PersonalDialogue(store, new DialogueState("IDLE"));
    const due = { kind: "app-due", note: "보완 서류 제출", dueDate: "2026-11-18" } as const;
    expect(d.run(due)?.semanticAction).toBe("clarify");
    expect(d.run({ kind: "app-record", service: "기초연금", receiptNo: "A1" })?.speech).toContain("접수번호 A1");
    d.run({ kind: "app-record", service: "장애수당" });
    expect(store.applications().map(a => a.appliedAt)).toEqual([today, today]);
    expect(d.run({ ...due, service: "기초연금 신청" })?.speech).toBe("기초연금 보완 서류 제출 기한을 11월 18일로 적었어요. 2일 남았어요. 기한까지 매일 알려 드릴게요.");
    expect(d.run({ ...due, service: "다른 제도", dueDate: "2026-11-10" })?.speech).toContain("장애수당");
    expect(d.run({ kind: "app-status" })?.speech).toBe("기록된 신청은 2건이에요. 1. 기초연금, 11월 16일 신청, 보완 서류 제출 11월 18일까지(2일 남음). 2. 장애수당, 11월 16일 신청, 보완 서류 제출 11월 10일까지(기한 지남). 실제 처리 상태는 복지로에 로그인해서 신청 현황에서 볼 수 있어요. 로그인은 직접 하셔야 해요.");
    expect(d.run({ kind: "app-done" })?.semanticAction).toBe("clarify");
    expect(d.run({ kind: "app-done", service: "장애" })?.speech).toContain("장애수당 신청을 끝난");
    expect(d.run({ kind: "app-done" })?.speech).toContain("기초연금 신청을 끝난");
    expect(d.run({ kind: "app-status" })?.speech).toMatch(/^기록된 신청이 없어요/u);
  } finally { vi.useRealTimers(); }
});
it("사이트 허용 목록과 오늘의 조작 기록을 읽어 준다", () => {
  const store = new PersonalStore(), state = new DialogueState("IDLE"), log = new ActionLog();
  expect(new PersonalDialogue(store, state).run({ kind: "action-log-read" })?.speech).toContain("이 세션에서는 쓰지 않아요");
  const d = new PersonalDialogue(store, state, undefined, log);
  expect(d.run({ kind: "action-log-read" })?.speech).toBe("오늘 기록된 조작이 없어요.");
  store.allowSite("https://example.kr");
  expect(d.run({ kind: "site-allow-read" })?.speech).toBe("허용한 사이트는 https://example.kr이에요.");
  expect(d.run({ kind: "site-allow-clear" })?.speech).toBe("사이트별 정보 공유 허용을 모두 지웠어요.");
  expect(store.allowedSites()).toEqual([]);
});
