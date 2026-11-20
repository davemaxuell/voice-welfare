import { afterAll, afterEach, expect, it } from "vitest";
import { FakeLlm } from "../helpers.ts";
import { createTestRuntime } from "./session-runtime.ts";

const runtime = createTestRuntime();
const save = "내 이름은 박하늘이라고 저장해줘";
afterEach(runtime.closeSessions);
afterAll(runtime.close);

it.each(["네, 지우지 마세요", "네이버 열어줘", "저장해"])("test_delete_needs_assent_to_this_operation", async reply => {
  const { session, page } = await runtime.createBrowserSession();
  await page.route("https://**/*", route => route.fulfill({ contentType: "text/html", body: "<title>Test</title><main>Test</main>" }));
  await session.handleTurn(save);
  await session.handleTurn("응");
  await session.handleTurn("내 정보 지워줘");
  const result = await session.handleTurn(reply);
  expect(session.personal.vault()).toEqual({ name: "박하늘" });
  if (reply === "네이버 열어줘") expect(result.semanticAction).toBe("open-site");
});

it("test_queued_yes_cannot_answer_a_vault_question_created_while_waiting", async () => {
  const { session } = await runtime.createBrowserSession();
  const question = session.handleTurn(save);
  const early = session.handleTurn("응");
  await Promise.all([question, early]);
  expect(session.personal.vault()).toEqual({});
  await session.handleTurn("응");
  expect(session.personal.vault()).toEqual({ name: "박하늘" });
});

it("test_original_language_controls_vault_consent", async () => {
  const { session } = await runtime.createBrowserSession();
  session.deps.llm = new FakeLlm({ translate_in: { text: "좋아" } });
  await session.handleTurn(save);
  await session.setLanguage("en");
  await session.handleTurn("I have another question");
  expect(session.personal.vault()).toEqual({});
  await session.handleTurn(save);
  await session.setLanguage("en");
  await session.handleTurn("yes");
  expect(session.personal.vault()).toEqual({ name: "박하늘" });
});

it("test_foreign_correction_can_change_tasks_during_vault_confirmation", async () => {
  const { session, page } = await runtime.createBrowserSession();
  await page.route("https://**/*", route => route.fulfill({ contentType: "text/html", body: "<title>Gov24</title><main>Gov24</main>" }));
  session.deps.llm = new FakeLlm({ translate_in: { text: "정부24 열어줘" } });
  await session.handleTurn(save);
  await session.setLanguage("en");
  expect((await session.handleTurn("No, open Gov24 instead")).semanticAction).toBe("open-site");
  expect(session.personal.vault()).toEqual({});
});
