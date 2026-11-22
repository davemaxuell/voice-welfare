import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { DialogueState } from "../../src/core/dialogue.ts";
import { LANGS, LangSchema, SessionStateSchema } from "../../src/core/turn.ts";
import { ActionLog } from "../../src/personal/action_log.ts";
import { dueReminder, parseDate, parsePersonalCommand, parseVaultValues, vaultKeyForLabel } from "../../src/personal/commands.ts";
import { PersonalDialogue, vaultReply } from "../../src/personal/dialogue.ts";
import { PersonalStore } from "../../src/personal/store.ts";

const today = "2026-11-16";
it("예전 음성 이름을 요청해도 실제 청음 목소리와 조절 가능한 빠르기를 안내한다", () => {
  const store = new PersonalStore(), dialogue = new PersonalDialogue(store, new DialogueState("IDLE"));
  const result = dialogue.run({ kind: "speech-set", values: { voice: "이전 기기 음성", rate: 0.9 } });
  expect(result?.speech).toContain("coral");
  expect(result?.speech).not.toContain("이전 기기 음성");
  expect(store.speech().rate).toBe(0.9);
  expect(store.speech().voice).toBeUndefined();
});
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
  expect(d.run({ kind: "speech-read" })?.speech).toContain("진행 상황은 대화 화면에 표시");
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
  expect(vaultReply("다른 질문", "vault-save", "ko")).toBeUndefined();
  expect(d.confirm(false).speech).toBe("알겠어요. 그대로 둘게요.");
  expect(state.vaultConfirm).toBeUndefined();
  expect(store.vault()).toEqual({});
  expect(() => d.confirm(true)).toThrow();
  d.run(save);
  expect(vaultReply("네", "vault-save", "ko")).toBe(true);
  expect(d.confirm(true).state).toBe("IDLE");
  expect(d.savedFor("신청인 성명")).toBe("김하늘");
  expect(d.savedFor("비밀번호")).toBeUndefined();
  expect(d.run({ kind: "vault-read" })?.speech).toBe("저장된 정보는 연락처 010-0000-0000, 이름 김하늘이에요.");
  expect(d.run({ kind: "vault-clear" })?.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(vaultReply("하지 마", "vault-clear", "ko")).toBe(false);
  expect(d.confirm(false).speech).toBe("알겠어요. 그대로 둘게요.");
  expect(d.savedFor("이름")).toBe("김하늘");
  d.run({ kind: "vault-clear" });
  expect(vaultReply("지워", "vault-clear", "ko")).toBe(true);
  expect(d.confirm(true).speech).toBe("저장된 내 정보를 모두 지웠어요.");
  expect(store.vault()).toEqual({});
});

it("부르는 이름과 보호자만 남아 있어도 내 정보 지우기를 묻고 함께 지운다", () => {
  const store = new PersonalStore(), d = new PersonalDialogue(store, new DialogueState("IDLE"));
  store.setGuardian({ name: "홍길동", phone: "01011223344" });
  expect(d.run({ kind: "vault-clear" })?.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  d.confirm(true);
  expect(store.guardian()).toBeUndefined();
  expect(d.run({ kind: "vault-clear" })?.speech).toBe("저장된 정보가 없어요.");
  store.setCallName("홍길동");
  expect(d.run({ kind: "vault-read" })?.speech).toBe("저장된 정보는 부르는 이름 홍길동님이에요.");
  expect(d.run({ kind: "vault-clear" })?.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  d.confirm(true);
  expect(store.callName()).toBeUndefined();
});

it("읽어 줄 값에 있는 중괄호와 달러 기호는 그대로 읽는다", () => {
  const store = new PersonalStore(), d = new PersonalDialogue(store, new DialogueState("IDLE"));
  store.saveVault({ name: "{entries}", address: "$& $1 {0}" });
  expect(d.run({ kind: "vault-read" })?.speech).toBe("저장된 정보는 이름 {entries}, 주소 $& $1 {0}이에요.");
});

// 기대값은 pyref(77aad3e)의 cheongeum.personal.dialogue를 같은 말과 같은 순서로 돌린 결과다. 만드는 법은 tests/fixtures/personal/generate.py.
const vaultValues = z.partialRecord(z.enum(["name", "address", "phone", "email", "birth"]), z.string());
const contact = z.object({ name: z.string(), phone: z.string() });
const runCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("vault-save"), values: vaultValues }), z.object({ kind: z.literal("vault-read") }), z.object({ kind: z.literal("vault-clear") }),
]);
const guardianQuestion = z.object({ kind: z.literal("guardian-clear"), contact, at: z.number(), resume: SessionStateSchema });
const snapshot = z.object({ vault: vaultValues, guardian: contact.nullable(), callName: z.string().nullable() });
const fixture = z.object({
  vaultReply: z.array(z.tuple([z.string(), z.record(z.string(), z.boolean())])),
  scenarios: z.array(z.object({
    name: z.string(), persistent: z.boolean(), lang: LangSchema,
    setup: z.object({ vault: vaultValues.optional(), callName: z.string().optional(), guardian: contact.optional() }),
    steps: z.array(z.object({
      run: runCommand.optional(), confirm: z.boolean().optional(), ask: guardianQuestion.optional(),
      draft: z.json().optional(), error: z.literal(true).optional(), state: z.string(), pending: z.json(), store: snapshot, reloaded: snapshot.optional(),
    })),
  })),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/personal/dialogue.json", import.meta.url), "utf8")));

it("금고 확인 대답이 기록한 Python 판정과 같다", () => {
  expect(fixture.vaultReply.length).toBeGreaterThan(1000);
  const different = fixture.vaultReply.flatMap(([text, expected]) => {
    const actual: Record<string, boolean> = {};
    for (const kind of ["vault-save", "vault-clear"] as const) {
      for (const lang of LANGS) {
        const answer = vaultReply(text, kind, lang);
        if (answer !== undefined) actual[`${kind.slice("vault-".length)}.${lang}`] = answer;
      }
    }
    return isDeepStrictEqual(actual, expected) ? [] : [{ text, expected, actual }];
  });
  expect(different.slice(0, 10)).toEqual([]);
});

function describePending(pending: DialogueState["vaultConfirm"]) {
  if (pending === undefined) return null;
  const { confirmation, ...rest } = pending;
  if (confirmation === undefined) return { ...rest, confirmation: null };
  const { actionId: _id, ...fixed } = confirmation;
  return { ...rest, confirmation: fixed };
}
function storeSnapshot(store: PersonalStore) {
  return { vault: store.vault(), guardian: store.guardian() ?? null, callName: store.callName() ?? null };
}

it.each(fixture.scenarios.map(scenario => [`${scenario.name} (${scenario.lang}, ${scenario.persistent ? "파일" : "메모리"})`, scenario] as const))(
  "금고 대화 시나리오: %s", (_name, scenario) => {
    const directory = mkdtempSync(join(tmpdir(), "cheongeum-dialogue-"));
    try {
      const path = scenario.persistent ? join(directory, "personal.json") : undefined;
      const store = new PersonalStore(path);
      if (scenario.setup.vault !== undefined) store.saveVault(scenario.setup.vault);
      if (scenario.setup.callName !== undefined) store.setCallName(scenario.setup.callName);
      if (scenario.setup.guardian !== undefined) store.setGuardian(scenario.setup.guardian);
      const state = new DialogueState("IDLE");
      const talk = new PersonalDialogue(store, state);
      for (const [index, step] of scenario.steps.entries()) {
        const actual: Record<string, unknown> = {};
        try {
          if (step.run !== undefined) actual.draft = talk.run(step.run, { lang: scenario.lang });
          else if (step.confirm !== undefined) actual.draft = talk.confirm(step.confirm);
          else if (step.ask !== undefined) state.askVaultConfirm(step.ask);
        } catch { actual.error = true; }
        actual.state = state.state;
        actual.pending = describePending(state.vaultConfirm);
        actual.store = storeSnapshot(store);
        if (path !== undefined) actual.reloaded = storeSnapshot(new PersonalStore(path));
        const { run: _run, confirm: _confirm, ask: _ask, ...expected } = step;
        expect(actual, `${scenario.name} step ${index + 1}`).toEqual(expected);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  },
);

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
