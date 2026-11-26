import { randomUUID } from "node:crypto";
import { afterAll, afterEach, expect, it } from "vitest";
import { z } from "zod";
import { linkReference } from "../../src/agents/web/link_choices.ts";
import type { ResearchPlan } from "../../src/core/research.ts";
import type { TurnResult } from "../../src/core/turn.ts";
import type { SessionOrchestrator } from "../../src/orchestrator/session.ts";
import { SettingsInput } from "../../src/server/settings.ts";
import type { WorkflowStore } from "../../src/server/workflow_store.ts";
import { FakeLlm, PORTAL, withLlm } from "../helpers.ts";
import { runtimeCases } from "./browser-runtime-cases.ts";
import { apiFixture } from "./runtime-http-fixture.ts";
import { deskOf, plannerPayloads, savedDecision, savedJob } from "./saved-research-fakes.ts";
import { createTestRuntime } from "./session-runtime.ts";

const runtime = createTestRuntime();
const service = runtimeCases();
afterEach(runtime.closeSessions);
afterAll(runtime.close);

it("test_login_handoff_offers_done_and_cancel_and_resumes_the_form", async () => {
  const { session, page } = await runtime.createBrowserSession();
  expect((await session.handleTurn("장애인연금 신청 도와줘")).offeredChoices ?? []).toEqual([]);
  const handed = await session.handleTurn("로그인하고 싶어");
  expect(handed.state).toBe("AUTH_HANDOFF");
  expect(handed.offeredChoices).toEqual([{ key: "auth-done", label: "로그인했어요" }, { key: "auth-cancel", label: "인증 취소" }]);
  const id = handed.authHandoff?.id;
  const still = await session.choose(handed.turnId, "auth-done", id);
  expect(still).toMatchObject({ state: "AUTH_HANDOFF", userUtterance: "로그인했어요" });
  expect(still?.speech).toContain("아직");
  expect(await session.choose(handed.turnId, "auth-done", id)).toBeUndefined();
  if (still === undefined) throw new Error("Missing refreshed handoff");
  expect(await session.choose(still.turnId, "auth-done", "other-handoff")).toBeUndefined();
  await page.goto("http://localhost:5174/apply.html", { waitUntil: "domcontentloaded" });
  const done = await session.choose(still.turnId, "auth-done", id);
  expect(done).toMatchObject({ intentType: "AUTH_DONE", state: "APPLICATION_OPEN" });
  expect(session.dialogue.awaiting).toBe("applicantName");
  expect(done?.offeredChoices ?? []).toEqual([]);
});

it("test_superseded_handoff_and_cancel", async () => {
  const { session } = await runtime.createBrowserSession();
  const first = await session.handleTurn("로그인하고 싶어");
  const cancelled = await session.choose(first.turnId, "auth-cancel", first.authHandoff?.id);
  expect(cancelled?.authHandoff?.status).toBe("cancelled");
  expect(cancelled?.offeredChoices ?? []).toEqual([]);
  const second = await session.handleTurn("로그인하고 싶어");
  const third = await session.handleTurn("화면 설명해줘");
  expect(third.authHandoff?.id).toBe(second.authHandoff?.id);
  expect(await session.choose(second.turnId, "auth-done", second.authHandoff?.id)).toBeUndefined();
  expect(await session.choose(third.turnId, "auth-done", first.authHandoff?.id)).toBeUndefined();
  expect(session.dialogue.authWaiting).toBe(true);
});

it("test_read_main_offer_is_bound_to_the_page_it_was_offered_for", async () => {
  const { session, page } = await runtime.createBrowserSession();
  const open = () => session.handleTurn(PORTAL + " 열어줘");
  const first = await open();
  expect(first.offeredChoices).toEqual([{ key: "read-main", label: "본문 읽기" }]);
  expect(await session.choose(first.turnId, "read-main")).toMatchObject({ semanticAction: "read-main", userUtterance: "본문 읽어줘" });
  const second = await open();
  await page.goto("http://127.0.0.1:5174/external2.html", { waitUntil: "domcontentloaded" });
  expect(await session.choose(second.turnId, "read-main")).toBeUndefined();
});

it("test_no_offer_while_an_approval_is_pending", async () => {
  const { session } = await runtime.createBrowserSession();
  await session.handleTurn("127.0.0.1:5174/external.html 열어줘");
  const asked = await session.handleTurn("이름 칸에 김하늘 써줘");
  expect(asked.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(asked.offeredChoices ?? []).toEqual([]);
});

it("test_choice_route_validates_and_reports_expired_offers", async () => {
  const api = apiFixture();
  try {
    const { sessionId } = z.object({ sessionId: z.string() }).parse(await (await api.post("/api/session", {})).json());
    const turn = z.object({ turnId: z.string(), authHandoff: z.object({ id: z.string() }) }).parse(
      await (await api.post("/api/turn", { sessionId, text: "로그인하고 싶어", clientPlatform: "pc" })).json());
    const path = "/api/session/" + sessionId + "/choice";
    expect((await api.post(path, { turnId: turn.turnId, key: "submit" })).status).toBe(400);
    const stale = await api.post(path, { turnId: "turn-old", key: "auth-done", handoffId: turn.authHandoff.id });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "CHOICE_EXPIRED" });
    const cancel = () => api.post(path, { turnId: turn.turnId, key: "auth-cancel", handoffId: turn.authHandoff.id }, { "X-Cheongeum-Request": "1" });
    const ok = await cancel();
    expect(ok.status).toBe(200);
    const result = z.object({ turnId: z.string(), authHandoff: z.object({ status: z.literal("cancelled") }) }).parse(await ok.json());
    expect(await (await cancel()).json()).toMatchObject({ turnId: result.turnId });
  } finally { await api.close(); }
});

const ASK_TO_READ = "아까 맡긴 조사 읽어 줘";
const twoReady = () => [savedJob("job-1", "아동수당 신청 방법", {kind: "ready"}), savedJob("job-2", "기초연금 신청 서류", {kind: "ready"})];
const PendingPick = z.object({pendingPick: z.object({options: z.array(z.object({number: z.number(), ref: z.string()}))}).optional()});
function secondOptionPlanner(action: "read" | "answer" | "cancel", answer: string | null = null) {
  return new FakeLlm(request => {
    if (request.schemaName !== "public_service_decision") return undefined;
    const second = PendingPick.parse(JSON.parse(request.user)).pendingPick?.options.find(option => option.number === 2);
    return (second === undefined ? savedDecision(action, [], answer) : savedDecision(action, [second.ref])).public_service_decision;
  });
}

it("끝난 조사가 둘이면 번호를 붙여 묻고 고르는 버튼을 내며, 2번 버튼은 그 조사만 읽고 인수증을 싣는다. 다른 응답이 나간 뒤의 지난 제안은 만료다", async () => {
  const {app, runtime: server, post, session: newSession} = await service({}, {settings: true});
  server.settings!.save(SettingsInput.parse({deviceUse: "personal"}));
  const {id, session} = await newSession();
  const store = await app.workflows.store();
  const source = {title: "복지로 공식 자료", lastCheckedAt: "2026-11-19", url: "https://www.bokjiro.go.kr/", version: "fixture"};
  for (const [prompt, text] of [["기초연금 신청 서류", "신분증을 준비하세요."], ["아동수당 신청 방법", "주민센터에서 신청하세요."]] as const) {
    await store.enqueue(randomUUID(), prompt, "ko");
    expect(await store.finish((await store.claim())!, "completed", {text, sources: [source]})).toBe(true);
  }
  const [first, second] = await store.summaries(8);
  if (first === undefined || second === undefined) throw new Error("조사 두 건이 저장되지 않음");
  session.deps.llm = new FakeLlm(savedDecision("read", []));

  const asked = await session.handleTurn(ASK_TO_READ);
  expect(asked.speech).toBe(`맡긴 조사가 여러 개예요. 1번 ‘${first.prompt}’, 2번 ‘${second.prompt}’ 중 어떤 것을 읽어 드릴까요?`);
  expect(asked.offeredChoices).toEqual([{key: "job-1", label: "1번"}, {key: "job-2", label: "2번"}]);
  expect(asked.savedResearch).toBeUndefined();
  expect(session.snapshot()).toMatchObject({turnId: asked.turnId, offeredChoices: asked.offeredChoices});

  const path = `/api/session/${id}/choice`;
  const notOffered = await post(path, {turnId: asked.turnId, key: "job-3"});
  expect(notOffered.status).toBe(409);
  const chosen = await post(path, {turnId: asked.turnId, key: "job-2"});
  expect(chosen.status).toBe(200);
  const read = z.object({intentType: z.string(), userUtterance: z.string(), speech: z.string(), offeredChoices: z.array(z.unknown()).optional(),
    savedResearch: z.object({jobId: z.string(), token: z.string(), reading: z.boolean()})}).parse(await chosen.json());
  const waiting = z.object({pending: z.array(z.object({id: z.string(), token: z.string(), speech: z.string()}))})
    .parse(await (await app.request(`/api/session/${id}/workspace/deliveries`)).json()).pending.find(row => row.id === second.id);
  expect(read).toMatchObject({intentType: "SAVED_RESEARCH", userUtterance: "2번", savedResearch: {jobId: second.id, token: waiting?.token, reading: true}});
  expect(read.speech).toBe(waiting?.speech);
  expect(read.speech).not.toContain(first.prompt);
  expect(read.offeredChoices ?? []).toEqual([]);

  const again = await session.handleTurn(ASK_TO_READ);
  expect(again.offeredChoices).toEqual(asked.offeredChoices);
  const stale = await post(path, {turnId: asked.turnId, key: "job-1"});
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({error: "CHOICE_EXPIRED"});
  expect(await session.choose(again.turnId, "job-1")).toMatchObject({savedResearch: {jobId: first.id, reading: true}});
});

it("물은 뒤에 그 조사가 취소되거나 지워지면 버튼을 눌러도 읽지 않고 읽을 결과가 없다고 말한다", async () => {
  const {session} = await runtime.createBrowserSession();
  const jobs = [savedJob("job-1", "아동수당 신청 방법", {kind: "ready"}), savedJob("job-2", "기초연금 신청 서류", {kind: "asking", revision: 1})];
  const desk = deskOf(jobs);
  session.deps.research = desk;
  withLlm(session, new FakeLlm(savedDecision("read", [])));

  const asked = await session.handleTurn(ASK_TO_READ);
  jobs[1] = savedJob("job-2", "기초연금 신청 서류", {kind: "ended"});
  const cancelled = await session.choose(asked.turnId, "job-2");
  expect(cancelled).toMatchObject({intentType: "SAVED_RESEARCH", userUtterance: "2번", speech: "이미 끝났거나 취소된 조사예요."});
  expect(cancelled?.savedResearch).toBeUndefined();
  expect(cancelled?.offeredChoices ?? []).toEqual([]);
  expect(await session.choose(asked.turnId, "job-1"), "한 번 쓴 제안").toBeUndefined();

  const again = await session.handleTurn(ASK_TO_READ);
  expect(again.offeredChoices ?? [], "읽을 수 있는 조사가 하나면 묻지 않는다").toEqual([]);
  expect(desk.read.mock.calls.map(([jobId]) => jobId)).toEqual(["job-1"]);

  jobs.splice(0, 2, savedJob("job-3", "가", {kind: "ready"}), savedJob("job-4", "나", {kind: "ready"}));
  const third = await session.handleTurn(ASK_TO_READ);
  jobs.pop();
  expect((await session.choose(third.turnId, "job-2"))?.speech).toBe("이미 끝났거나 취소된 조사예요.");
  expect(desk.read.mock.calls.map(([jobId]) => jobId)).toEqual(["job-1"]);
});

it("읽을 수 있는 조사가 다섯이면 최근 세 건에만 번호와 버튼을 주고 더 있다고 알리며, '짧게'에서도 물음을 줄이지 않는다", async () => {
  const {session} = await runtime.createBrowserSession();
  const long = "기초연금을 받으려면 무엇을 준비해야 하는지 알려 줘. 마감일도 알려 줘. ".repeat(4).trim();
  const jobs = [long, "나", "다", "라", "마"].map((request, i) => savedJob(`job-${i + 1}`, request, {kind: "ready"}));
  const desk = deskOf(jobs);
  session.deps.research = desk;
  session.personal.saveSpeech({length: "short"});
  withLlm(session, new FakeLlm(savedDecision("read", [])));

  const asked = await session.handleTurn(ASK_TO_READ);
  const name = Array.from(long).slice(0, 100).join("") + "…";
  expect(Array.from(long).length).toBeGreaterThan(100);
  expect(asked.speech).toBe(`맡긴 조사가 여러 개예요. 1번 ‘${name}’, 2번 ‘나’, 3번 ‘다’ 중 어떤 것을 읽어 드릴까요? 이 밖에도 더 있어요. 다른 조사는 주제를 말씀해 주세요.`);
  expect(asked.offeredChoices).toEqual([{key: "job-1", label: "1번"}, {key: "job-2", label: "2번"}, {key: "job-3", label: "3번"}]);
  expect(await session.choose(asked.turnId, "job-3")).toMatchObject({savedResearch: {jobId: "job-3", token: "receipt-job-3", reading: true}});
  expect(desk.read.mock.calls.map(([jobId]) => jobId)).toEqual(["job-3"]);
});

it("긴 요청은 취소했다는 말에서도 백 글자까지만 부른다", async () => {
  const {session} = await runtime.createBrowserSession();
  const long = "가".repeat(150);
  session.deps.research = deskOf([savedJob("job-1", long, {kind: "working"})]);
  withLlm(session, new FakeLlm(savedDecision("cancel", ["j1"])));
  expect((await session.handleTurn("그 조사 취소해 줘")).speech).toBe(`‘${"가".repeat(100)}…’ 조사를 취소했어요.`);
});

it.each([
  ["en", "Read my saved research", "You have several saved research jobs. Which should I read: Option 1 “가”, Option 2 “나”, or Option 3 “다”? There are more. For another one, tell me what it was about.",
    ["Option 1", "Option 2", "Option 3"]],
  ["zh", "读一下我托你查的调查", "您有几项已保存的调查。第1项“가”、第2项“나”、第3项“다”，要读哪一项？此外还有其他调查。要找别的，请说出它的主题。", ["第1项", "第2项", "第3项"]],
  ["ja", "頼んだ調査を読んで", "お預かりした調査がいくつかあります。1番「가」、2番「나」、3番「다」のどれを読みましょうか。ほかにもあります。別の調査は、その内容をお話しください。", ["1番", "2番", "3番"]],
] as const)("%s로 물어도 번호 붙인 물음과 버튼 이름은 그 언어의 정해진 말이고 번호가 서로 같다", async (lang, said, speech, labels) => {
  const {session} = await runtime.createBrowserSession();
  session.deps.research = deskOf(["가", "나", "다", "라"].map((request, i) => savedJob(`job-${i + 1}`, request, {kind: "ready"})));
  session.setLanguage(lang);
  const model = new FakeLlm(savedDecision("read", []));
  withLlm(session, model);
  const asked = await session.handleTurn(said);
  expect(asked).toMatchObject({lang, speech});
  expect(asked.offeredChoices?.map(choice => choice.label)).toEqual(labels);
  for (const label of labels) expect(asked.speech).toContain(label);
  expect(model.calls.map(call => call.schemaName)).toEqual(["public_service_decision"]);
});

it("번호를 말하면 플래너가 물어 둔 선택지의 번호와 ref를 받고, 그 ref로 답한 조사만 읽는다", async () => {
  const {session} = await runtime.createBrowserSession();
  const desk = deskOf(twoReady());
  session.deps.research = desk;
  const model = secondOptionPlanner("read");
  withLlm(session, model);

  const asked = await session.handleTurn(ASK_TO_READ);
  expect(asked.offeredChoices).toHaveLength(2);
  const picked = await session.handleTurn("2번", {fromVoice: true});
  expect(picked).toMatchObject({intentType: "SAVED_RESEARCH", savedResearch: {jobId: "job-2", token: "receipt-job-2", reading: true}});
  expect(desk.read.mock.calls.map(([jobId]) => jobId)).toEqual(["job-2"]);
  expect(picked.offeredChoices ?? []).toEqual([]);
  expect(await session.choose(asked.turnId, "job-1"), "말로 고른 뒤의 지난 제안").toBeUndefined();

  await session.handleTurn("2번");
  const [first, second, third] = plannerPayloads(model);
  expect(Object.keys(first ?? {})).not.toContain("pendingPick");
  expect(second).toMatchObject({utterance: "2번", pendingPick: {action: "read", options: [{number: 1, ref: "j1"}, {number: 2, ref: "j2"}]}});
  expect(Object.keys(third ?? {}), "읽어 준 뒤에는 물어 둔 것이 없다").not.toContain("pendingPick");
});

it("답하려던 조사가 여럿이면 번호로 묻고, 번호를 말하면 받아 둔 답을 그 조사에만 넣는다", async () => {
  const {session} = await runtime.createBrowserSession();
  const desk = deskOf([savedJob("job-1", "아동수당 신청 방법", {kind: "asking", revision: 1}), savedJob("job-2", "기초연금 신청 서류", {kind: "asking", revision: 2})]);
  session.deps.research = desk;
  const model = secondOptionPlanner("answer", "서울이요");
  withLlm(session, model);

  const asked = await session.handleTurn("서울이요");
  expect(asked.speech).toBe("답을 기다리는 조사가 여러 개예요. 1번 ‘아동수당 신청 방법’, 2번 ‘기초연금 신청 서류’ 중 어느 것에 답할까요?");
  expect(asked.offeredChoices).toEqual([{key: "job-1", label: "1번"}, {key: "job-2", label: "2번"}]);
  expect(desk.answer).not.toHaveBeenCalled();

  const picked = await session.handleTurn("2번");
  expect(picked).toMatchObject({intentType: "SAVED_RESEARCH", speech: "답을 받았어요. 이어서 조사할게요.", researchDelivery: "queued"});
  expect(desk.answer.mock.calls).toEqual([["job-2", 2, "서울이요"]]);
  const pending = plannerPayloads(model)[1]?.pendingPick;
  expect(pending).toEqual({action: "answer", options: [{number: 1, ref: "j1"}, {number: 2, ref: "j2"}]});
});

const secondPicks: [string, (session: SessionOrchestrator, turnId: string) => Promise<TurnResult | undefined>][] = [
  ["번호를 말해도", session => session.handleTurn("2번")],
  ["버튼을 눌러도", (session, turnId) => session.choose(turnId, "job-2")],
];
it.each(secondPicks)("물은 뒤에 그 조사의 질문이 바뀌었으면 %s 물을 때의 질문 번호로 넣어, 답이 새 질문에 들어가지 않고 질문이 바뀌었다고 알린다", async (_name, pick) => {
  const {session} = await runtime.createBrowserSession();
  const jobs = [savedJob("job-1", "아동수당 신청 방법", {kind: "asking", revision: 1}), savedJob("job-2", "기초연금 신청 서류", {kind: "asking", revision: 2})];
  const desk = deskOf(jobs);
  desk.answer.mockImplementation(async (jobId, revision) => {
    const phase = jobs.find(job => job.id === jobId)?.phase;
    return phase?.kind === "asking" && phase.revision === revision ? "queued" : "stale";
  });
  session.deps.research = desk;
  withLlm(session, secondOptionPlanner("answer", "서울이요"));

  const asked = await session.handleTurn("서울이요");
  jobs[1] = savedJob("job-2", "기초연금 신청 서류", {kind: "asking", revision: 3});
  const picked = await pick(session, asked.turnId);
  expect(picked).toMatchObject({intentType: "SAVED_RESEARCH", speech: "그 질문은 이미 바뀌었어요."});
  expect(picked?.researchDelivery).toBeUndefined();
  expect(desk.answer.mock.calls).toEqual([["job-2", 2, "서울이요"]]);
});

async function askingJob(store: WorkflowStore, prompt: string) {
  await new Promise(resolve => setTimeout(resolve, 3));
  const id = await store.enqueue(randomUUID(), prompt, "ko");
  const job = await store.claim();
  if (job === undefined) throw new Error("조사를 집지 못함");
  const source = {title: "복지로 공식 자료", url: "https://www.bokjiro.go.kr/", lastCheckedAt: "2026-11-24"};
  const plan: ResearchPlan = {route: "quiet", goal: prompt, subject: "", exclusions: [], steps: [
    {requirement: "가 제도의 서류", attempts: 1, outcome: {status: "verified", finding: {text: "신청서를 준비하세요.", sources: [source], proof: [{quote: "신청서를 준비하세요.", url: source.url}]}}},
    {requirement: "나 제도의 마감일", attempts: 1, outcome: {status: "waiting", question: "어느 지역인가요?"}},
  ]};
  expect(await store.saveProgress(job, 0, {version: 1, plan, activeMs: 1, continuations: 0})).toBe(true);
  expect(await store.finish(job, "needs_input", {text: "어느 지역인가요?"})).toBe(true);
  return id;
}

it.each(secondPicks)("물은 뒤에 고른 조사가 패널에서 먼저 답을 받았으면 %s 말로 한 답을 넣지 않고 그 조사는 이제 답을 기다리지 않는다고 말한다", async (_name, pick) => {
  const {app, runtime: server, session: newSession} = await service({}, {settings: true});
  server.settings!.save(SettingsInput.parse({deviceUse: "personal"}));
  const {session} = await newSession();
  const store = await app.workflows.store();
  await askingJob(store, "기초연금 신청 서류");
  await askingJob(store, "아동수당 신청 방법");
  const [first, second] = await store.summaries(8);
  if (first === undefined || second === undefined) throw new Error("조사 두 건이 저장되지 않음");
  const revision = async (jobId: string) => (await store.jobs()).find(job => job.id === jobId)?.questionRevision;
  const firstRevision = await revision(first.id), secondRevision = await revision(second.id);
  expect([typeof firstRevision, typeof secondRevision]).toEqual(["number", "number"]);
  session.deps.llm = secondOptionPlanner("answer", "서울이요");

  const asked = await session.handleTurn("서울이요");
  expect(asked.speech).toBe(`답을 기다리는 조사가 여러 개예요. 1번 ‘${first.prompt}’, 2번 ‘${second.prompt}’ 중 어느 것에 답할까요?`);
  expect(await store.answer(second.id, secondRevision ?? -1, "부산")).toBe(true);

  const picked = await pick(session, asked.turnId);
  expect(picked).toMatchObject({intentType: "SAVED_RESEARCH", speech: "그 조사는 이제 답을 기다리지 않아요."});
  expect(picked?.researchDelivery).toBeUndefined();
  expect(picked?.speech, "첫 조사가 아직 기다린다는 말이 아니다").not.toContain("조사가 없어요");
  expect((await store.jobs()).find(job => job.id === first.id), "첫 조사는 묻던 그대로").toMatchObject({state: "needs_input", questionRevision: firstRevision});

  const claimed = await store.claim();
  expect(claimed?.id).toBe(second.id);
  const progress = claimed === undefined ? undefined : await store.progress(claimed);
  expect(progress?.checkpoint.plan.steps.map(step => step.clarification), "둘째 조사에는 패널의 답만").toEqual([undefined, "부산"]);
});

it("읽으려고 물은 뒤에 되묻던 조사가 패널의 답으로 다시 조사 중이면 버튼을 눌러도 읽지 않고 아직 조사하고 있다고 말한다", async () => {
  const {session} = await runtime.createBrowserSession();
  const jobs = [savedJob("job-1", "아동수당 신청 방법", {kind: "ready"}), savedJob("job-2", "기초연금 신청 서류", {kind: "asking", revision: 1})];
  const desk = deskOf(jobs);
  session.deps.research = desk;
  withLlm(session, new FakeLlm(savedDecision("read", [])));

  const asked = await session.handleTurn(ASK_TO_READ);
  expect(asked.offeredChoices).toHaveLength(2);
  jobs[1] = savedJob("job-2", "기초연금 신청 서류", {kind: "working"});
  const picked = await session.choose(asked.turnId, "job-2");
  expect(picked).toMatchObject({intentType: "SAVED_RESEARCH", speech: "아직 조사하고 있어요. 끝나면 알려 드릴게요."});
  expect(picked?.savedResearch).toBeUndefined();
  expect(desk.read).not.toHaveBeenCalled();
});

it("링크 목록을 들은 뒤라도 조사를 고르라는 물음에 답한 '2번'은 링크를 열지 않고 그 조사를 읽는다", async () => {
  const {session, page} = await runtime.createBrowserSession();
  await session.handleTurn(PORTAL + " 열어줘");
  await session.handleTurn("링크 목록 알려줘");
  expect(session.linkOfferId).not.toBe("");
  expect(linkReference("2번", session.browse.linkChoices), "링크 목록이 열려 있으면 링크 번호다").toMatchObject({action: "open"});

  const desk = deskOf(twoReady());
  session.deps.research = desk;
  withLlm(session, secondOptionPlanner("read"));
  const asked = await session.handleTurn(ASK_TO_READ);
  expect(asked.offeredChoices).toHaveLength(2);
  expect(session.linkOfferId).toBe("");
  expect(linkReference("2번", session.browse.linkChoices)).toBeUndefined();

  const url = page.url();
  const picked = await session.handleTurn("2번");
  expect(picked).toMatchObject({intentType: "SAVED_RESEARCH", savedResearch: {jobId: "job-2", reading: true}});
  expect(page.url()).toBe(url);
});

it("멈추거나 다시 연결하면 물어 둔 것이 사라져 버튼이 그 조사에 닿지 않는다", async () => {
  const {session} = await runtime.createBrowserSession();
  const desk = deskOf(twoReady());
  session.deps.research = desk;
  withLlm(session, new FakeLlm(savedDecision("read", [])));

  const reconnected = await session.handleTurn(ASK_TO_READ);
  expect(session.offeredPick).toMatchObject({action: "read", options: [{jobId: "job-1"}, {jobId: "job-2"}]});
  expect(await session.resumeForRecovery({})).not.toHaveProperty("offeredChoices");
  expect(session.offeredPick).toBeUndefined();
  expect(await session.choose(reconnected.turnId, "job-1")).toBeUndefined();

  const stopped = await session.handleTurn(ASK_TO_READ);
  expect((await session.handleTurn("멈춰")).state).toBe("STOPPED");
  expect(session.offeredPick).toBeUndefined();
  expect(await session.choose(stopped.turnId, "job-1")).toBeUndefined();
  expect(desk.read).not.toHaveBeenCalled();
});
