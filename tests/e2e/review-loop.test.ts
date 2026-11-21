import { afterAll, afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StructuredLlm } from "../../src/core/llm.ts";
import { draft, type SourceCitation } from "../../src/core/turn.ts";
import { parseDecision, PublicTask } from "../../src/orchestrator/public_task.ts";
import { ReviewedTask } from "../../src/orchestrator/review_loop.ts";
import { redactText } from "../../src/safety/privacy.ts";
import { FakeLlm, type LlmRequest } from "../helpers.ts";
import { createTestRuntime } from "./session-runtime.ts";

const runtime = createTestRuntime();
afterEach(runtime.closeSessions);
afterAll(runtime.close);
async function newSession() { return (await runtime.createBrowserSession()).session; }

const PARTS = ["행사 기간", "접수 장소"];
const REQUEST = PARTS.join(" 그리고 ");
const QUOTES = ["행사는 가을에 열립니다.", "접수 장소는 중앙 도서관입니다."];
const LIMITS = [["easy", 2], ["medium", 3], ["hard", 5]] as const;

function decision() {
  return {
    kind: "review_before_output", source: "browser", searchMode: "quiet", agency: null,
    subject: "행사", goal: "행사 기간과 접수 장소 확인", requestedFacts: ["dates", "location"],
    exclusions: ["login"], continuation: false, question: null, choices: [], reply: null,
    skill: null, difficulty: "medium", requirements: PARTS,
  };
}

const Payload = z.object({ evidence: z.array(z.object({ id: z.number(), text: z.string() })) });
function verdict(user: string) {
  const { evidence } = Payload.parse(JSON.parse(user));
  const checks = PARTS.map((part, i) => {
    const quote = QUOTES[i] ?? "";
    return { request: part, kind: "fact", citations: evidence.filter(e => e.text.includes(quote)).slice(0, 1).map(e => ({ id: e.id, quote })) };
  });
  const complete = checks.every(row => row.citations.length > 0);
  return { checks, answer: complete ? QUOTES.join(" ") : "", nextRoute: complete ? null : "quiet" };
}

function reviewing(onReview: () => void = () => {}) {
  return new FakeLlm(({ schemaName, user }: LlmRequest) => {
    if (schemaName === "public_service_decision") return decision();
    if (schemaName !== "review_before_output") return undefined;
    onReview();
    return verdict(user);
  });
}

function source(url: string, title: string): SourceCitation {
  return { url, title, lastCheckedAt: "2026-11-20" };
}

it("test_intake_accepts_all_requested_steps_within_the_hard_budget", () => {
  const requirements = Array.from({ length: 32 }, (_, n) => `Visit the service record labeled ${n}`);
  expect(parseDecision({ ...decision(), difficulty: "hard", requirements })?.requirements).toEqual(requirements);
});

it("retains a dependent action and continues an independent read after a failed browser step", async () => {
  const session = await newSession();
  const text = redactText("본문을 읽고 다음 페이지에서 본문을 읽고 별도 제도를 확인해 줘");
  const route = vi.spyOn(session, "route").mockImplementation(async intent =>
    draft("BROWSING", intent.type === "NEXT" ? "none" : "web-answer", "안내"));
  const task = new ReviewedTask({ request: text, task: new PublicTask(), requirements: [text], route: "existing", difficulty: "medium",
    remaining: [[{ type: "READ_MAIN", more: false }, text], [{ type: "NEXT" }, text],
      [{ type: "READ_MAIN", more: false }, text], [{ type: "POLICY_QUESTION", topic: "별도 제도의 서류" }, text]] });
  for await (const _ of session.review.actions(task, session.beginTurn(text), "", {resuming: false})) { /* 결과는 경로 기록에서 확인한다. */ }
  expect(route.mock.calls.map(([intent]) => intent.type)).toEqual(["READ_MAIN", "NEXT", "POLICY_QUESTION"]);
  expect(task.plan.map(step => step.status)).toEqual(["observed", "unresolved", "ready", "observed"]);
});

it("test_public_retry_keeps_form_values_out_of_the_search", async () => {
  const session = await newSession();
  const alias = "GardenAster";
  const question = redactText(`Enter the alias ${alias} and find visiting hours`);
  const turn = session.beginTurn(question);
  const run = new ReviewedTask({
    request: question, task: new PublicTask({ goal: question }), requirements: ["find visiting hours"], route: "quiet", difficulty: "medium",
    counter: turn.ctx.counter, rounds: 1, privateValues: [alias],
  });
  const queries: string[] = [];
  session.deps.quietSearch = async task => {
    queries.push(task.goal);
    return {};
  };
  await session.review.lookup(run, turn, run.requirements);
  expect(queries).toHaveLength(1);
  expect(queries[0]).not.toContain(alias);
  expect(queries[0]).toContain("find visiting hours");
});

it.each([...LIMITS, [undefined, 3] as const])("test_missing_fact_retries_in_same_turn_and_keeps_first_quote", async (difficulty, limit) => {
  const session = await newSession();
  const searches: PublicTask[] = [];
  session.deps.quietSearch = async task => {
    searches.push(task);
    const index = searches.length - 1;
    return { speech: "검토 전 초안", reviewQuotes: [QUOTES[index] ?? ""], sources: [source(`https://www.gov.kr/event/${index}`, "행사 자료")] };
  };
  session.deps.llm = reviewing(() => { expect(session.progress.snapshot().spoken).toBe(false); });
  const result = await session.handleTurn(REQUEST, { fromVoice: difficulty !== undefined, difficulty });
  expect(result.review).toEqual({ status: "completed", difficulty: difficulty ?? "medium", rounds: 2, maxRounds: limit, browserIterations: 0 });
  expect(result.semanticAction).toBe("review-before-output");
  expect(result.speech).toBe(QUOTES.join(" "));
  expect(searches).toHaveLength(2);
  expect(searches.at(-1)?.goal).toContain(PARTS[1]);
  expect(searches.at(-1)?.exclusions).toEqual(["login"]);
  expect(result.sources).toHaveLength(2);
  expect(result.actions).toEqual([]);
  for (const entry of session.exportHistory()) expect(entry.text).not.toContain("검토 전 초안");
});

it("test_no_progress_or_missing_reviewer_never_announces_success", async () => {
  const session = await newSession();
  session.deps.llm = reviewing();
  session.deps.quietSearch = async () => ({ speech: "완료했다고 주장하는 초안", sources: [source("https://www.gov.kr/", "포털")] });
  const result = await session.handleTurn(REQUEST, { fromVoice: true, difficulty: "hard" });
  expect(result.review?.status).toBe("incomplete");
  expect(result.review?.rounds).toBe(2);
  expect(result.speech).toContain("접수 장소");
  expect(result.speech).not.toContain("주장하는 초안");
});

it("test_stop_cancels_outstanding_review_without_another_lookup", async () => {
  const session = await newSession();
  let reached = () => {};
  const reviewStarted = new Promise<void>(resolve => { reached = resolve; });
  const held: StructuredLlm = {
    name: "held",
    generate: async ({ schemaName }) => {
      if (schemaName === "public_service_decision") return decision();
      reached();
      return new Promise(() => {});
    },
  };
  let lookups = 0;
  session.deps.llm = held;
  session.deps.quietSearch = async () => {
    lookups += 1;
    return {};
  };
  const pending = session.handleTurn(REQUEST);
  await reviewStarted;
  const stopped = await session.handleTurn("멈춰");
  const result = await pending;
  expect(stopped.state).toBe("STOPPED");
  expect(result.state).toBe("STOPPED");
  expect(lookups).toBe(1);
  expect(result.review).toBeUndefined();
});

it.each(LIMITS)("test_new_evidence_cannot_extend_the_selected_iteration_limit", async (difficulty, limit) => {
  const session = await newSession();
  let searches = 0;
  session.deps.llm = reviewing();
  session.deps.quietSearch = async () => {
    searches += 1;
    return { speech: "장소를 찾는 중이에요.", sources: [source("https://www.gov.kr/event", "공고")], reviewQuotes: [QUOTES[0] ?? "", `공고 개정 이력 ${searches}`] };
  };
  const final = await session.handleTurn(REQUEST, { fromVoice: true, difficulty });
  expect(searches).toBe(limit);
  expect(final.review?.rounds).toBe(limit);
  expect(final.review?.maxRounds).toBe(limit);
  expect(final.review?.status).toBe("incomplete");
  expect(final.speech).toContain(PARTS[1]);
  expect(final.speech).not.toContain("장소를 찾는 중");
});
