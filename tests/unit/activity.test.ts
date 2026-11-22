import { expect, it } from "vitest";
import type { StructuredLlm } from "../../src/core/llm.ts";
import { describeActivity, fixedActivity, settleActivity, type ActivityFact } from "../../src/speech/activity.ts";

const lines: Array<[ActivityFact, string]> = [
  [{ phase: "thinking" }, "생각하는 중이에요."],
  [{ phase: "pulling" }, "내용을 가져오는 중이에요."],
  [{ phase: "pulling", source: "복지로" }, "복지로에서 내용을 가져오는 중이에요."],
  [{ phase: "tool" }, "요청한 일을 실행하는 중이에요."],
  [{ phase: "checking" }, "답을 찾았어요. 화면과 맞는지 확인할게요."],
  [{ phase: "step", action: "click", target: "신청", ok: false }, "요청한 결과를 확인하지 못했어요."],
  [{ phase: "step", action: "click", target: "신청", ok: true, outcome: "moved" }, "새 페이지가 열렸어요."],
];

it("고정 문장은 단계마다 정해진 한 문장이다", () => {
  for (const [fact, line] of lines) expect(fixedActivity(fact), fact.phase).toBe(line);
});

it("실패한 단계를 열렸다고 하면 고정 문장을 쓴다", async () => {
  const secret = "비밀번호는 556677";
  const fact: ActivityFact = {
    phase: "tool", action: "search", target: "신청", ok: false,
    source: "비".repeat(40) + secret,
  };
  let user = "";
  const llm: StructuredLlm = {
    name: "fake",
    async generate(request) {
      user = String(request.user);
      expect(request.schemaName).toBe("activity_line");
      return { line: "복지로를 열었어요." };
    },
  };
  expect(await describeActivity(llm, fact)).toBe(fixedActivity(fact));
  expect(user).not.toContain(secret);
  expect(JSON.parse(user)).toMatchObject({ source: "비".repeat(40), target: "신청", ok: false });
});

it("실패인데 열렸다고 하면 고정 문장을 쓴다", async () => {
  const llm: StructuredLlm = { name: "fake", async generate() { return { line: "페이지가 열렸습니다." }; } };
  expect(await describeActivity(llm, { phase: "step", action: "click", target: "신청", ok: false })).toBe("요청한 결과를 확인하지 못했어요.");
});

it("늦은 다시 쓰기는 이미 지난 단계의 문장을 덮지 않는다", () => {
  expect(settleActivity(2, 1, "늦은 문장", "생각하는 중이에요.")).toBe("생각하는 중이에요.");
});
