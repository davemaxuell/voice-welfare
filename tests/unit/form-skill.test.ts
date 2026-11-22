import { expect, it, vi } from "vitest";
import { ACTION_TYPES, type Action, type Observation, type ObservedField } from "../../src/core/actions.ts";
import { DialogueState } from "../../src/core/dialogue.ts";
import { draft } from "../../src/core/turn.ts";
import { ExecContext, WebExecutionAgent, type PageView } from "../../src/agents/web/agent.ts";
import { recheck } from "../../src/agents/web/approval.ts";
import { createMockWelfareProfile, fieldVocabulary, type FieldProfile } from "../../src/agents/web/profile.ts";
import { FormSkill } from "../../src/agents/web/skills/form.ts";
import { GuidedFill } from "../../src/agents/web/skills/guided.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";
import { Narrator } from "../../src/speech/screen.ts";
import { RuleBasedIntentProvider } from "../../src/understanding/rules.ts";

const profile = createMockWelfareProfile("http://localhost:5174");
function field(fieldId: string, label: string, extra: Partial<ObservedField> = {}): ObservedField {
  return {fieldId, label, type: "text", value: "", visible: true, filled: false, required: false, invalid: false, sensitive: false, ...extra};
}
function page(fields: ObservedField[], url = profile.urls.apply): PageView {
  return {url, fields, platform: "pc", title: "서류 작성", capturedAt: "", step: {index: 1, total: 3, name: "1단계: 기본 정보"},
    errors: [], dialogs: [], pageId: profile.classify(url)};
}
const ctx = new ExecContext({signal: new AbortController().signal, trace() {}, isStopped: () => false});
function setup(initial: PageView) {
  let current = initial;
  const execute = vi.fn(async (_action: Action): Promise<never> => { throw new Error("unexpected browser action"); });
  const web = new WebExecutionAgent({async observe(): Promise<Observation> {return current;}, execute, async close() {}},
    new PolicyGuard({allowedOrigins: [profile.origin], allowedActionTypes: ACTION_TYPES, allowedFieldIds: profile.fields.map(f => f.fieldId),
      secretFieldIds: [], maxActionsPerTurn: 12, readOnlyWeb: true}), profile);
  const dialogue = new DialogueState<FieldProfile>("BROWSING");
  const narrator = new Narrator({web});
  const form = new FormSkill(web, dialogue, narrator);
  const grants = new Set<string>();
  const guided = new GuidedFill(web, dialogue, narrator, new RuleBasedIntentProvider(fieldVocabulary(profile)), {
    siteAllowed: origin => grants.has(origin), allowSite: origin => { grants.add(origin); },
    savedValue: label => label === "이름" ? "김하늘" : undefined,
  });
  return {web, execute, dialogue, form, guided, grants, setView(view: PageView) {current = view;}};
}

it("asks the first visible required field before offering optional fields", () => {
  const name = field("applicantName", "성명", {required: true});
  const phone = field("phone", "연락처 (선택)");
  const view = page([field("hidden", "숨은 값", {required: true, visible: false}), field("agree", "동의", {type: "checkbox", required: true}), name, phone]);
  const {form, dialogue} = setup(view);
  expect(form.askNext(view)).toBe("성명을 말씀해 주세요.");
  expect(dialogue.awaiting).toBe("applicantName");
  name.filled = true;
  dialogue.valueFilled(name.fieldId);
  expect(form.askNext(view)).toContain("연락처는 선택이에요.");
  expect(dialogue.awaiting).toBeUndefined();
  phone.filled = true;
  expect(form.askNext(view)).toBe("다음 단계로 가려면 '다음으로'라고 해 주세요.");
});

it("mock submission fingerprints empty fields and masks telephone numbers in the review", async () => {
  const name = field("applicantName", "성명", {value: "김하늘", filled: true});
  const phone = field("phone", "연락처", {value: "010-2345-6789", filled: true});
  const optional = field("incomeStatus", "소득·재산 신고");
  const view = page([name, phone, optional]);
  const {form, dialogue, web, execute} = setup(view);
  await web.observe(ctx);
  vi.spyOn(web, "goToFinalStep").mockResolvedValue({status: "ok", actions: [], view});
  const result = await form.prepareSubmit(ctx);
  expect(result.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(result.speech).toContain("김하늘");
  expect(result.speech).not.toContain(phone.value);
  const approval = dialogue.approval!;
  if (!("action" in approval)) throw new Error("모의접수 승인에는 행동이 있어야 합니다.");
  expect(approval).toMatchObject({kind: "submit", url: view.url, confirmation: {kind: "practice-submission", description: result.speech, realSubmission: false}});
  const changed = {...view, fields: [name, phone, {...optional, value: "소득 있음", filled: true}]};
  expect(recheck(approval.fingerprint, changed, [approval.action])[1]).toBeTruthy();
  expect(execute).not.toHaveBeenCalled();
});

it("an unconfirmed assisted fill keeps the exact approval available for the next turn", async () => {
  const view = page([field("custom-name", "이름")], "https://example.org/form");
  const {form, dialogue, web, execute} = setup(view);
  await web.observe(ctx);
  const asked = await form.fill([{fieldMention: "이름", value: "김하늘"}], ctx);
  expect(asked.speech).toContain('example.org의 이름 칸에 "김하늘"');
  const pending = dialogue.approval!;
  expect(pending).toMatchObject({url: view.url, confirmation: {kind: "field-entry", description: asked.speech}});
  if (pending.kind !== "assist") throw new Error("expected assisted fill approval");
  vi.spyOn(web, "assistFill").mockResolvedValue({status: "unconfirmed", message: "화면의 값을 확인하지 못했습니다.", view, actions: []});
  const reply = await form.assistApproved(pending.actions, ctx);
  expect(reply.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(reply.speech).toContain("다시 할까요?");
  expect(dialogue.approval).toBe(pending);
  expect(form.reject().speech).toBe("넣지 않았어요. 다시 말씀해 주세요.");
  expect(dialogue.approval).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
});

it("guided auth redirects ask the new site for vault permission", async () => {
  const field1 = field("name", "이름");
  const before = page([field1, field("contact", "연락처")], "https://example.org/form");
  const {guided, dialogue, web, grants, setView, execute} = setup(before);
  grants.add("https://example.org");
  expect((await guided.start(ctx)).speech).toContain("저장된 '김하늘'");
  const after = page([field1, field("contact", "인증번호", {type: "password"})], "https://other.example.org/form");
  setView(after);
  await web.observe(ctx);
  const question = await guided.resumeAfterAuth(after, ctx);
  expect(question).toContain("other.example.org에 저장된 내 정보를 쓸까요");
  expect(question).not.toContain("김하늘");
  expect(dialogue.guided?.fieldIds).toEqual(["name"]);
  expect((await guided.answer("응", ctx))?.speech).toContain("저장된 '김하늘'");
  expect(grants.has("https://other.example.org")).toBe(true);
  expect((await guided.answer("응", ctx))?.semanticAction).toBe("prepare-submit");
  expect(dialogue.confirmation?.site).toBe("other.example.org");
  expect(execute).not.toHaveBeenCalled();
});

it("guided answers advance only after a value is approved or a field is skipped", async () => {
  const view = page([field("name", "이름"), field("email", "이메일"), field("agree", "동의"),
    field("pwd", "비밀번호"), field("find", "검색", {searchable: true})], "https://example.org/form");
  const {guided, dialogue, execute} = setup(view);
  const start = await guided.start(ctx);
  expect(start.speech).toContain("입력 칸이 2개");
  expect((await guided.answer("아니", ctx))?.speech).toContain("이 사이트에는 저장된 값을 쓰지 않을게요.");
  expect((await guided.answer("홍길동", ctx))?.speech).toContain("이름 칸에 '홍길동' 넣을까요?");
  expect(dialogue.guided?.index).toBe(0);
  expect(execute).not.toHaveBeenCalled();
  dialogue.clearApproval();
  expect((await guided.afterAssist(draft("BROWSING", "fill", "넣고 확인했어요."), ctx)).speech).toContain("2번째, 이메일.");
  expect((await guided.answer("건너뛰기", ctx))?.speech).toContain("입력 칸을 모두 지나왔어요.");
  expect(guided.active()).toBe(false);
});
