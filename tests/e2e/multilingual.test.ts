import { afterAll, afterEach, expect, it } from "vitest";
import type { SessionOrchestrator } from "../../src/orchestrator/session.ts";
import { FakeLlm, fieldValue, PORTAL, withLlm } from "../helpers.ts";
import { createTestRuntime } from "./session-runtime.ts";

const runtime = createTestRuntime();
afterEach(runtime.closeSessions);
afterAll(runtime.close);
async function newSession() { return (await runtime.createBrowserSession()).session; }
function withTranslator(session: SessionOrchestrator, table: Record<string, string>, output = (ko: string) => "[en] " + ko) {
  const model = new FakeLlm(({ schemaName, user }) => {
    if (schemaName === "translate_in" && Object.hasOwn(table, user)) return { text: table[user] };
    if (schemaName === "translate_out") return { text: output(user) };
    return undefined;
  });
  withLlm(session, model);
  return model;
}

it("test_switch_to_english_then_translate", async () => {
  const session = await newSession();
  const utterance = "Open the practice application form";
  withTranslator(session, { [utterance]: "장애인연금 신청 도와줘" });
  const switched = await session.handleTurn("영어로 말해줘");
  expect(switched.intentType).toBe("SET_LANGUAGE");
  expect(switched.lang).toBe("en");
  expect(switched.speech).toContain("English");
  const result = await session.handleTurn(utterance);
  expect(result.lang).toBe("en");
  expect(result.userUtterance).toBe(utterance);
  expect(result.observation?.step?.index).toBe(1);
  expect(result.speech.startsWith("[en] ")).toBe(true);
  expect(result.trace.map(t => t.note)).toEqual(expect.arrayContaining(["번역 en→ko", "응답 번역 ko→en"]));
});

it("test_stop_without_translation", async () => {
  const session = await newSession(), model = withTranslator(session, {});
  await session.handleTurn("중국어로 말해줘");
  const result = await session.handleTurn("停止");
  expect(result.intentType).toBe("STOP");
  expect(result.lang).toBe("zh");
  expect(result.speech).toContain("已全部停止");
  expect(model.calls.filter(c => c.schemaName === "translate_in")).toEqual([]);
});

it("test_foreign_secret_blocked_before_translation", async () => {
  const session = await newSession(), model = withTranslator(session, {});
  await session.handleTurn("영어로 말해줘");
  const result = await session.handleTurn("my password is 4821");
  expect(result.semanticAction).toBe("auth-handoff");
  expect(JSON.stringify(result)).not.toContain("4821");
  for (const call of model.calls) expect(call.user).not.toContain("4821");
  expect(model.calls.filter(c => c.schemaName === "translate_in")).toEqual([]);
});

it("test_only_rule_words_approve", async () => {
  const session = await newSession();
  withTranslator(session, { "Put Kim Haneul in the name field": "이름 칸에 김하늘 써줘", "Well, I guess you could do that thing": "승인" });
  await session.handleTurn(PORTAL + " 열어줘");
  await session.handleTurn("Speak English");
  const ask = await session.handleTurn("Put Kim Haneul in the name field");
  expect(ask.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  const vague = await session.handleTurn("Well, I guess you could do that thing");
  expect(vague.speech).toContain("yes, approve");
  expect(vague.actions).toEqual([]);
  expect(vague.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  const yes = await session.handleTurn("Yes");
  expect(yes.actions[0]?.policy.code).toBe("APPROVED");
  expect(fieldValue(yes, "opinionName")).toBe("김하늘");
});

it("입력 승인 대기 중 언어를 바꿔도 같은 승인을 한 번만 실행한다", async () => {
  const { session, page } = await runtime.createBrowserSession();
  withTranslator(session, {});
  await session.handleTurn(PORTAL + " 열어줘");
  const asked = await session.handleTurn("이름 칸에 김하늘 써줘");
  const approval = asked.pendingConfirmation;
  if (approval === undefined) throw new Error("입력 승인을 요청하지 않았습니다.");
  await page.locator("#opinionName").evaluate(field => {
    field.addEventListener("input", () => { field.dataset.inputs = String(Number(field.dataset.inputs ?? 0) + 1); });
  });
  const switched = await session.setLanguage("en");
  expect(switched.lang).toBe("en");
  expect(switched.pendingConfirmation?.actionId).toBe(approval.actionId);
  expect(switched.pendingConfirmation?.purpose).toBe("Fill in fields without submitting");
  expect(switched.pendingConfirmation?.values).toContainEqual({ label: "Name", value: "김하늘" });
  expect(switched.localSpeechOnly).toBe(true);
  expect(switched.speech).toContain("김하늘");
  expect(session.snapshot().pendingConfirmation).toEqual(switched.pendingConfirmation);
  await session.confirm(true, approval.actionId);
  expect(await page.locator("#opinionName").inputValue()).toBe("김하늘");
  expect(await page.locator("#opinionName").getAttribute("data-inputs")).toBe("1");
});

it("test_changed_numbers_fall_back_to_korean", async () => {
  const session = await newSession();
  const utterance = "Open the practice application form";
  withTranslator(session, { [utterance]: "장애인연금 신청 도와줘" }, () => "There are 99 steps in total.");
  await session.handleTurn("English please");
  const result = await session.handleTurn(utterance);
  expect(result.lang).toBe("ko");
  expect(result.speech).toContain("Translation could not be verified");
  expect(result.speech).not.toContain("99");
  expect(result.speech).toContain("단계");
});

it("test_auto_switch_by_script", async () => {
  const session = await newSession();
  withTranslator(session, { "What can you do for me?": "뭐 할 수 있어?" });
  expect((await session.handleTurn("What can you do for me?")).lang).toBe("en");
  const back = await session.handleTurn("장애인연금 신청 도와줘");
  expect(back.lang).toBe("ko");
  expect(back.speech).not.toContain("[en]");
});

it("test_no_llm_no_switch", async () => {
  const session = await newSession();
  const result = await session.handleTurn("일본어로 말해줘");
  expect(result.lang).toBe("ko");
  expect(result.speech).toContain("AI 모델 설정이 필요해요");
  expect(session.lang).toBe("ko");
});

it("test_about_unknown_site", async () => {
  const session = await newSession();
  await session.handleTurn(PORTAL + " 열어줘");
  const result = await session.handleTurn("이 사이트 뭐야?");
  expect(result.intentType).toBe("ABOUT_SITE");
  expect(result.speech).toContain("'[테스트] 외부 포털");
  expect(result.speech).toContain("주요 메뉴는 뉴스, 복지, 날씨");
  expect(result.speech).toContain("이 사이트에서 검색");
});

it("test_about_practice_site", async () => {
  const session = await newSession();
  await session.handleTurn("장애인연금 신청 도와줘");
  expect((await session.handleTurn("여기 무슨 사이트야")).speech).toContain("연습용 모의 복지 신청 사이트");
});

it.each([
  ["en", "Where do I enter my password?", "BlueMeadow"],
  ["ja", "パスワードはどこに入力しますか", "青いしずく"],
  ["zh", "在哪里输入密码？", "蓝色草地"],
  ["ko", "비밀번호를 어디에 입력하죠?", "푸른언덕"],
] as const)("test_only_the_first_bare_reply_to_a_password_mention_is_screened_locally", async (lang, mention, value) => {
  const session = await newSession(), model = withTranslator(session, {});
  await session.setLanguage(lang);
  await session.handleTurn(mention);
  model.calls.length = 0;
  const blocked = await session.handleTurn(value);
  expect(model.calls.every(call => !call.user.includes(value))).toBe(true);
  expect(blocked).toMatchObject({ lang, intentType: "SECRET_DISCLOSURE" });
  expect(JSON.stringify([blocked, session.exportHistory()])).not.toContain(value);
  if (lang === "en") {
    await session.handleTurn("Read the page");
    expect(model.calls.some(call => call.user.includes("Read the page"))).toBe(true);
  }
});

it.each([
  ["en", "Please remember my name as Melody Finch", {"name": "Melody Finch"}],
  ["en", "Save my address as 27 Maple Lane", {"address": "27 Maple Lane"}],
  ["ja", "私の名前は星空です。覚えてください", {"name": "星空"}],
  ["ja", "私の住所は月見町七番地です。保存してください", {"address": "月見町七番地"}],
  ["zh", "请记住我的名字是云舟", {"name": "云舟"}],
  ["zh", "请保存我的地址：月光路七号", {"address": "月光路七号"}],
  ["en", "Remember my name is Cloud Finch and my address is 가상특별시 달빛나루구 새봄마을 은빛길", {"name": "Cloud Finch", "address": "가상특별시 달빛나루구 새봄마을 은빛길"}],
  ["ja", "私の名前は星空、住所は月見町七番地です。保存してください", {"name": "星空", "address": "月見町七番地"}],
  ["zh", "请保存我的姓名是云舟，地址是月光路七号", {"name": "云舟", "address": "月光路七号"}],
] as const)("test_explicit_vault_save_never_sends_the_supplied_value_to_a_model", async (lang, request, fields) => {
  const session = await newSession(), model = withTranslator(session, {});
  session.deps.publicPlanning = true;
  const prompt = await session.handleTurn(request);
  const values = Object.values(fields);
  const sentPrivate = () => model.calls.some(call => values.some(value => call.user.includes(value)));
  expect(sentPrivate()).toBe(false);
  expect(prompt).toMatchObject({ lang, localSpeechOnly: true, pendingConfirmation: { kind: "vault-save" } });
  for (const value of values) expect(prompt.speech).toContain(value);
  const [decline, approve] = { en: ["no", "yes"], ja: ["いいえ", "はい"], zh: ["不用", "是的"] }[lang] as [string, string];
  expect((await session.handleTurn(decline)).pendingConfirmation).toBeUndefined();
  expect(session.personal.vault()).toEqual({});
  for (const value of values) expect(JSON.stringify(session.recentVoiceDialogue())).not.toContain(value);
  await session.handleTurn(request);
  await session.handleTurn(approve);
  expect(session.personal.vault()).toEqual(fields);
  expect(sentPrivate()).toBe(false);
});

it.each([
  ["Save the address 77 Pineview Orchard on this computer", "77 Pineview Orchard"],
  ["Keep Aurelia Rowan as the name I use for applications", "Aurelia Rowan"],
  ["把云舟作为我的名字保存下来", "云舟"],
  ["星空を私の名前として覚えてください", "星空"],
] as const)("test_recognizable_personal_saves_can_clarify_locally", async (request, privateValue) => {
  const session = await newSession(), model = withTranslator(session, {});
  session.deps.publicPlanning = true;
  expect((await session.handleTurn(request)).intentType).toBe("PERSONAL_VAULT_SAVE");
  expect(model.calls.every(call => !call.user.includes(privateValue))).toBe(true);
  expect(JSON.stringify(session.recentVoiceDialogue())).not.toContain(privateValue);
  expect(session.personal.vault()).toEqual({});
});

it("test_private_readback_is_localized_without_sending_profile_to_the_translator", async () => {
  const s = await newSession();
  await s.handleTurn("내 이름은 별구름이라고 저장해줘");
  await s.handleTurn("응");
  const model = withTranslator(s, { "Read my saved information": "내 정보 알려줘" });
  await s.setLanguage("en");
  const read = await s.handleTurn("Read my saved information");
  expect(model.calls.every(call => !call.user.includes("별구름"))).toBe(true);
  expect(read).toMatchObject({ lang: "en", localSpeechOnly: true });
  expect(read.speech).toContain("별구름");
});

it("test_question_about_saving_an_address_still_reaches_general_language_routing", async () => {
  const s = await newSession(), model = withTranslator(s, {});
  const text = "How do I save my address on a public form?";
  expect((await s.handleTurn(text)).pendingConfirmation).toBeUndefined();
  expect(model.calls.some(call => call.user.includes(text))).toBe(true);
});
