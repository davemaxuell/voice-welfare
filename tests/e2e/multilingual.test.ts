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
