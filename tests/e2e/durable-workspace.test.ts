import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { expect as expectPage } from "@playwright/test";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { launchBrowser } from "../../src/agents/web/browser/index.ts";
import type { WelfareService } from "../../src/agents/welfare/data/index.ts";
import { EmbeddingService } from "../../src/core/model_stack.ts";
import { RESEARCH_UNDELIVERED, stateNote } from "../../src/core/research_copy.ts";
import { draft } from "../../src/core/turn.ts";
import { FIXED } from "../../src/language/i18n.ts";
import { READING_PLACEHOLDER } from "../../src/orchestrator/saved_research.ts";
import { AgentRuntime } from "../../src/server/runtime.ts";
import { SettingsInput } from "../../src/server/settings.ts";
import { DIMENSIONS, WorkflowStore, installationOwner } from "../../src/server/workflow_store.ts";
import { Workflows, type ResearchSession } from "../../src/server/workflows.ts";
import { FakeLlm, withLlm } from "../helpers.ts";
import { latch } from "./browser-cases.ts";
import { runtimeCases } from "./browser-runtime-cases.ts";
import { startUi } from "./web-ui-fixtures.ts";

const service = runtimeCases(), goal = "기초연금 신청 서류";
const checked = {title: "복지로 공식 자료", lastCheckedAt: "2026-11-19", url: "https://www.bokjiro.go.kr/", version: "fixture"};
const jobs = z.object({jobs: z.array(z.object({state: z.string(), prompt: z.string(), result: z.object({
  sources: z.array(z.object({url: z.string()})),
}).nullish()}))});

it("test_conversation_delegation_explicit_notes_and_isolated_research", async () => {
  const {app, runtime, post, session: newSession} = await service({}, {settings: true});
  const prefs = runtime.settings!; prefs.save(SettingsInput.parse({deviceUse: "personal"}));
  runtime.services.embedding = new EmbeddingService("test", "text-embedding-3-small", runtime.connections);
  const embed = vi.spyOn(runtime.services.embedding, "embed").mockResolvedValue([1, ...Array<number>(DIMENSIONS - 1).fill(0)]);
  runtime.services.moderation = undefined;
  const documents = "신청서와 신분증을 준비합니다.";
  vi.spyOn(runtime.welfareProvider, "findService").mockResolvedValue({servId: "fixture", servNm: "기초연금", summary: "검증용 제도", dataOrigin: "official-api",
    target: "", applyMethod: "", documents, source: checked});
  const create = runtime.createSession.bind(runtime), decisions: {background: boolean; savedNotes?: string[]}[] = [];
  vi.spyOn(runtime, "createSession").mockImplementation(async options => {
    const session = await create(options), background = options?.background === true;
    withLlm(session, new FakeLlm(({schemaName, system, schema, user}) => {
      if (schemaName !== "public_service_decision") return undefined;
      decisions.push({background, ...z.object({savedNotes: z.array(z.string()).optional()}).parse(JSON.parse(user))});
      if (background) {
        const data = z.object({properties: z.object({kind: z.object({enum: z.array(z.string())})})}).parse(schema);
        expect(data.properties.kind.enum).not.toContain("delegate_research"); expect(system).toContain("already confirmed");
      }
      return {kind: background ? "find_information" : "delegate_research", goal, source: "welfare", subject: "기초연금", agency: "복지로", requestedFacts: ["documents"],
        exclusions: [], continuation: false, question: null, choices: []};
    }));
    if (background) session.deps.webLlm = new FakeLlm(({schemaName, user}) => {
      expect(schemaName).toBe("public_research_coverage"); expect(JSON.parse(user)).toEqual({question: goal, evidence: documents});
      return {coverage: "all", checks: [{request: "신청 서류", quote: documents}]};
    });
    return session;
  });
  const {session, id} = await newSession(), base = "/api/session/" + id + "/workspace";
  const status = async () => jobs.parse(await (await app.request(base)).json()).jobs;
  expect((await post(base + "/notes", {text: "Prefer English"})).status).toBe(400);
  expect((await post(base + "/notes", {text: "name@example.kr", consent: true})).status).toBe(400);
  expect(embed).not.toHaveBeenCalled();
  const note = z.object({id: z.string()}).parse(await (await post(base + "/notes", {text: "안내는 쉬운 말로", consent: true})).json()).id;
  const ask = "기초연금 서류는 배경에서 조사해 줘";
  let r = await session.handleTurn(ask, {fromVoice: true});
  expect(r.pendingConfirmation?.kind).toBe("public-research"); expect(decisions.at(-1)?.savedNotes).toEqual(["안내는 쉬운 말로"]); expect(await status()).toEqual([]);
  await session.confirm(false, r.pendingConfirmation?.actionId); expect(await status()).toEqual([]);
  r = await session.handleTurn(ask); expect(r.pendingConfirmation?.kind).toBe("public-research");
  await session.confirm(true, r.pendingConfirmation?.actionId);
  await expect.poll(async () => (await status())[0]?.state, {timeout: 20_000}).toBe("completed");
  expect((await status())[0]).toMatchObject({prompt: goal, result: {sources: [{url: checked.url}]}});
  expect(decisions.at(-1)).toEqual({background: true});
  expect(await (await post(base + "/notes/search", {text: "English"})).json()).toMatchObject({notes: [{id: note}]});
  expect(await (await app.request(base + "/notes/" + note, {method: "DELETE"})).json()).toMatchObject({deleted: true});
  embed.mockClear();
  expect(await session.deps.recallNotes?.("장학금 준비 서류")).toEqual([]); expect(embed).not.toHaveBeenCalled();
  prefs.save(SettingsInput.parse({deviceUse: "shared"})); expect((await app.request(base)).status).toBe(403);
});

it("test_restart_without_foreground_session_then_cancel_running_job", async () => {
  const {settings} = await service(), storeSettings = settings(), started = latch(), canceled = latch();
  storeSettings.save(SettingsInput.parse({deviceUse: "personal"}));
  const createSession = vi.fn(async (): Promise<ResearchSession> => ({
    async researchPublic() {started.resolve(); await canceled.promise; return ["incomplete", {}];},
    cancel: canceled.resolve, async close() {},
  }));
  const host = {settings: storeSettings, config: {pilotProfile: "personal"}, createSession};
  const prior = new Workflows(host), store = await prior.store();
  const id = await store.enqueue(randomUUID(), "정부24 발급 서류", "ko");
  const restarted = new Workflows(host);
  try {
    await restarted.reconfigure(); await started.promise;
    expect(createSession).toHaveBeenCalledExactlyOnceWith({background: true});
    expect(await restarted.cancel(store, id)).toBe(true); expect((await store.jobs())[0]?.state).toBe("cancelled");
  } finally {canceled.resolve(); await restarted.close(); await prior.close();}
});

const savedDecision = (action: "read" | "answer" | "cancel", answer: string | null = null) =>
  ({kind: "saved_research", research: {action, jobs: [], answer}, requestedFacts: [], exclusions: [], continuation: false, choices: []});
const readSaved = savedDecision("read");

async function twoPartResearch(initialState: "needs_input" | "partial") {
  const {app, runtime, post, session: newSession} = await service({}, {settings: true});
  runtime.settings!.save(SettingsInput.parse({deviceUse: "personal"}));
  runtime.services.moderation = undefined;
  const parts = ["가 제도의 서류", "나 제도의 마감일"];
  const prompt = parts.join(" 그리고 ");
  const quote = "가 제도에 필요한 것은 신청서입니다.";
  const deadline = "나 제도의 서울 접수는 금요일에 마감합니다.";
  const notice = { ...checked, url: "https://www.gov.kr/notices/test", title: "마감 안내" };
  const lookedUp: string[] = [];
  const create = runtime.createSession.bind(runtime);
  vi.spyOn(runtime, "createSession").mockImplementation(async options => {
    const session = await create(options);
    if (options?.background !== true) return session;
    const execute = session.planner.execute.bind(session.planner);
    vi.spyOn(session.planner, "execute").mockImplementation(async (task, turn, mode, bounds) => {
      if (initialState === "needs_input" && task.goal.startsWith("확인할 항목: 나") && !task.goal.includes("서울")) {
        lookedUp.push(task.goal.split("\n")[0] ?? "");
        return draft("NEEDS_CLARIFICATION", "clarify", "어느 지역인가요?", { taskQuestion: "어느 지역인가요?" });
      }
      return execute(task, turn, mode, bounds);
    });
    session.deps.quietSearch = async task => {
      lookedUp.push(task.goal.split("\n")[0] ?? "");
      if (task.goal.startsWith("확인할 항목: 가")) return { speech: quote, sources: [checked], reviewQuotes: [quote] };
      return task.goal.includes("서울") ? { speech: deadline, sources: [notice], reviewQuotes: [deadline] } : {};
    };
    withLlm(session, new FakeLlm(({schemaName, user}) => {
      if (schemaName === "public_service_decision") return {kind: "review_before_output", goal: prompt,
        source: "browser", searchMode: "quiet", subject: null, agency: null, requestedFacts: ["documents", "dates"], requirements: parts,
        exclusions: [], continuation: false, question: null, choices: [], difficulty: "medium"};
      const input = z.object({request: z.string(), evidence: z.array(z.object({id: z.number(), text: z.string()}))}).parse(JSON.parse(user));
      const proof = input.evidence.find(e => e.text === quote || e.text === deadline);
      return {answer: proof?.text ?? "", nextRoute: null, checks: [
        {request: input.request, kind: "fact", citations: proof ? [{id: proof.id, quote: proof.text}] : []},
      ]};
    }));
    return session;
  });
  const {id, session} = await newSession();
  const base = "/api/session/" + id + "/workspace";
  const created = await post(base + "/research", {text: prompt, requestId: randomUUID(), consent: true});
  expect(created.status).toBe(200);
  const {id: jobId} = z.object({id: z.string()}).parse(await created.json());
  const status = async () => z.object({jobs: z.array(z.object({
    id: z.string(), state: z.string(), result: z.unknown(), questionRevision: z.number().optional(),
  }))}).parse(await (await app.request(base)).json()).jobs[0];
  await expect.poll(async () => (await status())?.state, {timeout: 12_000}).toMatch(/partial|incomplete|completed|needs_input/);
  expect(await status()).toMatchObject({ state: initialState, result: { sources: [checked], missing: [parts[1]],
    proof: [{quote, url: checked.url}] } });
  expect(await status()).toMatchObject({ result: { text: expect.stringContaining(quote) } });
  expect(lookedUp).toEqual(parts.map(part => "확인할 항목: " + part));
  const answered = {id: jobId, result: {sources: [checked, notice], text: quote + "\n\n" + deadline}};
  return {post, session, base, jobId, status, lookedUp, parts, answerPath: base + "/research/" + jobId + "/answer", answered};
}

it.each(["partial", "needs_input"] as const)("serves verified public findings as %s and preserves progress", async initialState => {
  const {post, session, jobId, status, lookedUp, parts, answerPath, answered} = await twoPartResearch(initialState);
  session.deps.llm = new FakeLlm({public_service_decision: readSaved});
  const read = await session.handleTurn("아까 맡긴 조사 읽어 줘");
  expect(read.speech).toContain(parts[1]);
  expect(read.speech.endsWith("답을 말씀해 주시면 이어서 조사할게요.")).toBe(initialState === "needs_input");
  expect(read.savedResearch).toEqual({jobId, token: expect.any(String), reading: true});
  if (initialState === "needs_input") {
    const revision = (await status())?.questionRevision;
    expect((await post(answerPath, {text: "서울", consent: true, questionRevision: 1})).status).toBe(409);
    expect((await post(answerPath, {text: "서울", questionRevision: revision})).status).toBe(400);
    expect((await post(answerPath, {text: "연락처는 010-1234-5678", consent: true, questionRevision: revision})).status).toBe(400);
    expect((await status())?.questionRevision).toBe(revision);
    expect((await post(answerPath, {text: "서울", consent: true, questionRevision: revision})).status).toBe(200);
    await expect.poll(async () => (await status())?.state, {timeout: 12_000}).toBe("completed");
    expect(await status()).toMatchObject(answered);
    expect(lookedUp).toEqual([...parts, parts[1]].map(part => "확인할 항목: " + part));
  }
});

it("맡긴 조사가 되물은 것에 말로 답하면 그 답으로 조사를 이어서 끝낸다", async () => {
  const {session, status, lookedUp, parts, answered} = await twoPartResearch("needs_input");
  const model = new FakeLlm({public_service_decision: savedDecision("answer", "서울")});
  session.deps.llm = model;
  const reply = await session.handleTurn("서울이요");
  expect(reply).toMatchObject({intentType: "SAVED_RESEARCH", speech: "답을 받았어요. 이어서 조사할게요.", researchDelivery: "queued"});
  expect(JSON.parse(model.calls[0]?.user ?? "{}")).toMatchObject({utterance: "서울이요", savedJobs: [{ref: "j1", request: parts.join(" 그리고 "), state: "asking"}]});
  await expect.poll(async () => (await status())?.state, {timeout: 12_000}).toBe("completed");
  expect(await status()).toMatchObject(answered);
  expect(lookedUp).toEqual([...parts, parts[1]].map(part => "확인할 항목: " + part));
});

it("말로 한 답을 넣기 직전에 패널에서 같은 질문에 먼저 답했으면 질문이 바뀌었다고 알리고 조사는 패널의 답으로만 이어진다", async () => {
  const {post, session, status, lookedUp, parts, answerPath, answered} = await twoPartResearch("needs_input");
  const desk = session.deps.research;
  if (desk === undefined) throw new Error("개인 기기 세션에 조사 책상이 없음");
  const byVoice = desk.answer.bind(desk);
  vi.spyOn(desk, "answer").mockImplementationOnce(async (jobId, revision, text) => {
    expect((await post(answerPath, {text: "서울", consent: true, questionRevision: revision})).status).toBe(200);
    return await byVoice(jobId, revision, text);
  });
  session.deps.llm = new FakeLlm({public_service_decision: savedDecision("answer", "부산")});
  const reply = await session.handleTurn("부산이요");
  expect(reply).toMatchObject({intentType: "SAVED_RESEARCH", speech: "그 질문은 이미 바뀌었어요."});
  expect(reply.researchDelivery).toBeUndefined();
  await expect.poll(async () => (await status())?.state, {timeout: 12_000}).toBe("completed");
  expect(await status()).toMatchObject(answered);
  expect(lookedUp).toEqual([...parts, parts[1]].map(part => "확인할 항목: " + part));
});

it("보내면 안 되는 값이 든 답은 말로 해도 넣지 않고 보내지 않았다고 알리며 조사는 묻던 그대로 남는다", async () => {
  const {session, status, lookedUp, parts} = await twoPartResearch("needs_input");
  const before = await status();
  session.deps.llm = new FakeLlm({public_service_decision: savedDecision("answer", "010-1234-5678")});
  const reply = await session.handleTurn("연락처는 010-1234-5678이에요");
  expect(reply).toMatchObject({intentType: "SAVED_RESEARCH", speech: "답에 개인정보나 비밀 값이 있는 것 같아 보내지 않았어요. 공개해도 되는 말로 다시 답해 주세요."});
  expect(reply.researchDelivery).toBeUndefined();
  expect(await status()).toEqual(before);
  expect(before?.state).toBe("needs_input");
  expect(lookedUp).toEqual(parts.map(part => "확인할 항목: " + part));
});

it("한 번에 끝나는 조사가 되물은 것에는 말로 답해도 넣지 않고 새로 맡겨 달라고 알리며, 읽어 줄 때도 같은 안내로 끝난다", async () => {
  const {app, runtime, session: newSession} = await service({}, {settings: true});
  runtime.settings!.save(SettingsInput.parse({deviceUse: "personal"}));
  const {session} = await newSession();
  const store = await app.workflows.store();
  await store.enqueue(randomUUID(), goal, "ko");
  expect(await store.finish((await store.claim())!, "needs_input", {text: "어느 지역인가요?"})).toBe(true);
  const before = await store.jobs();
  const model = new FakeLlm({public_service_decision: savedDecision("answer", "서울")});
  session.deps.llm = model;
  const reply = await session.handleTurn("서울이요");
  expect(reply).toMatchObject({intentType: "SAVED_RESEARCH", speech: "이 조사는 이어서 답을 받을 수 없어요. 새로 맡겨 주세요."});
  expect(reply.researchDelivery).toBeUndefined();
  expect(JSON.parse(model.calls[0]?.user ?? "{}")).toMatchObject({savedJobs: [{ref: "j1", state: "asking-restart"}]});
  expect(await store.jobs()).toEqual(before);
  session.deps.llm = new FakeLlm({public_service_decision: readSaved});
  expect((await session.handleTurn("그 조사 읽어 줘")).speech)
    .toBe(`‘${goal}’ 조사에서 여쭤볼 것이 있어요. 어느 지역인가요? 이 조사는 이어서 답을 받을 수 없어요. 새로 맡겨 주세요.`);
});

function holdResearch(runtime: AgentRuntime, release: Promise<void> = new Promise<never>(() => {})) {
  const started = latch(), returned = latch();
  const create = runtime.createSession.bind(runtime);
  vi.spyOn(runtime, "createSession").mockImplementation(async options => {
    const session = await create(options);
    if (options?.background === true) vi.spyOn(session, "researchPublic").mockImplementation(async () => {
      started.resolve();
      await release;
      returned.resolve();
      return ["completed", {text: "늦게 도착한 답", sources: [checked]}];
    });
    return session;
  });
  return {started: started.promise, returned: returned.promise};
}

it("조사 중인 것을 말로 취소하면 늦게 끝난 조사가 결과를 남기지 못하고, 취소했다는 말의 인수증을 받은 뒤에는 중단 소식을 전하지 않는다", async () => {
  const {app, runtime, post, session: newSession} = await service({}, {settings: true});
  runtime.settings!.save(SettingsInput.parse({deviceUse: "personal"}));
  runtime.services.moderation = undefined;
  const release = latch(), worker = holdResearch(runtime, release.promise);
  const {id, session} = await newSession();
  const base = "/api/session/" + id + "/workspace";
  const {id: jobId} = z.object({id: z.string()}).parse(await (await post(base + "/research", {text: goal, requestId: randomUUID(), consent: true})).json());
  await worker.started;
  const store = await app.workflows.store();
  const row = async () => (await store.jobs()).find(job => job.id === jobId);
  const pending = async () => deliveries.parse(await (await app.request(base + "/deliveries")).json()).pending;
  const [waiting] = await pending();
  expect(waiting).toMatchObject({id: jobId, state: "running"});

  const stopped = await session.handleTurn("취소해 줘");
  expect(stopped.state).toBe("STOPPED");
  expect((await row())?.state).toBe("running");
  expect(await session.wake(stopped.stopGeneration ?? -1)).toBe("IDLE");

  session.deps.llm = new FakeLlm({public_service_decision: savedDecision("cancel")});
  const reply = await session.handleTurn("맡긴 조사 취소해 줘");
  expect(reply).toMatchObject({intentType: "SAVED_RESEARCH", speech: `‘${goal}’ 조사를 취소했어요.`});
  expect(reply.savedResearch).toEqual({jobId, token: waiting?.token, reading: false});
  expect(await row()).toMatchObject({state: "cancelled", result: null});

  release.resolve();
  await worker.returned;
  await expect.poll(() => app.workflows.events.all().filter(event => event.turnId === jobId).map(event => event.errorCode)).toEqual(["cancelled"]);
  await new Promise(resolve => setImmediate(resolve));
  expect(await row()).toMatchObject({state: "cancelled", result: null});

  expect((await pending()).map(job => [job.id, job.state])).toEqual([[jobId, "cancelled"]]);
  expect((await app.request(`${base}/research/${jobId}/delivery/${waiting?.token}`, {method: "DELETE"})).status).toBe(200);
  expect(await pending()).toEqual([]);
  expect(await store.pendingDeliveries()).toEqual([]);

  const again = await session.handleTurn("그 조사 취소해 줘");
  expect(again.speech).toBe("이미 끝났거나 취소된 조사예요.");
  expect(again.savedResearch).toBeUndefined();
});

it("바로 맡긴 뒤에 '그거 취소해 줘'라고 하면 먼저 맡긴 조사가 있어도 방금 맡긴 조사만 그만둔다", async () => {
  const {app, runtime, session: newSession} = await service({REQUIRE_ACTION_CONFIRMATION: "false"}, {settings: true});
  runtime.settings!.save(SettingsInput.parse({deviceUse: "personal"}));
  runtime.services.moderation = undefined;
  holdResearch(runtime);
  const {session} = await newSession();
  const store = await app.workflows.store();
  const earlier = await store.enqueue(randomUUID(), "아동수당 신청 방법", "ko");
  const unused = {requestedFacts: [], exclusions: [], continuation: false, choices: []};
  const listed = z.object({utterance: z.string(), savedJobs: z.array(z.object({ref: z.string(), lastSaved: z.boolean().optional()})).optional()});
  withLlm(session, new FakeLlm(({schemaName, user}) => {
    if (schemaName !== "public_service_decision") return undefined;
    const {utterance, savedJobs = []} = listed.parse(JSON.parse(user));
    if (!utterance.includes("취소")) return {kind: "delegate_research", goal, ...unused};
    return {kind: "saved_research", research: {action: "cancel", jobs: savedJobs.filter(job => job.lastSaved === true).map(job => job.ref), answer: null}, ...unused};
  }));
  expect(await session.handleTurn("기초연금 서류는 배경에서 조사해 줘", {fromVoice: true})).toMatchObject({researchDelivery: "queued"});
  const saved = session.saved.lastSaved;
  expect((await store.jobs()).map(job => job.id)).toEqual([saved, earlier]);

  const reply = await session.handleTurn("그거 취소해 줘", {fromVoice: true});
  expect(reply).toMatchObject({intentType: "SAVED_RESEARCH", speech: `‘${goal}’ 조사를 취소했어요.`, savedResearch: {jobId: saved, reading: false}});
  const states = new Map((await store.jobs()).map(job => [job.id, job.state]));
  expect(states.get(saved ?? "")).toBe("cancelled");
  expect(["queued", "running"]).toContain(states.get(earlier));
  expect(session.saved.lastSaved).toBeUndefined();
});

it("test_workspace_panel_save_recall_and_forget_through_installed_ui", async () => {
  const {config, settings, seal} = await service(), prefs = settings();
  prefs.save(SettingsInput.parse({deviceUse: "personal", language: "en"})); prefs.setFirstRun("done");
  const runtime = new AgentRuntime(config, undefined, undefined, async () => {throw new Error("Unexpected provider call");}, prefs);
  runtime.sealFactory = () => seal;
  const ui = await startUi(false, {}, runtime);
  try {
    const browser = await launchBrowser(true);
    try {
      const page = await browser.newPage(); await page.goto(ui.url);
      await page.locator("#recovery-no").click();
      const panel = page.locator("#workflow-title"); await panel.click(); await expectPage(panel).toHaveText("Research and saved notes");
      await page.locator("#note-input").fill("Scholarship paperwork"); await page.locator("#note-consent").check(); await page.locator("#note-add").click();
      await expectPage(page.locator("#note-list")).toContainText("Scholarship paperwork");
      await page.reload(); await panel.click(); await page.locator("#note-input").fill("Scholarship"); await page.locator("#note-search").click();
      await expectPage(page.locator("#note-list")).toContainText("Scholarship paperwork");
      await page.locator("#note-list").getByRole("button", {name: "Delete"}).click(); await expectPage(page.locator("#note-list > li")).toHaveCount(0);
    } finally {await browser.close();}
  } finally {await ui.close();}
});

const dataShape = z.object({kind: z.string(), origin: z.string(), date: z.string().optional()});
const savedJobs = z.object({jobs: z.array(z.object({
  id: z.string(), state: z.string(), questionRevision: z.number().optional(),
  result: z.object({text: z.string().optional(), sources: z.array(z.object({url: z.string(), data: dataShape.optional()})), data: dataShape.optional()}).nullish(),
}))});
const official = (servId: string, summary: string, dated: {criteriaYear: string} | {referenceDate: string}): WelfareService => ({
  servId, servNm: "기초연금", summary, dataOrigin: "official-api", target: "", applyMethod: "", source: checked, ...dated,
});

it("저장한 조사의 두 항목이 같은 출처를 다른 기준일로 인용해도 점검 기록과 재시작과 답변을 거쳐 남는다", async () => {
  const {app, runtime, post, session: newSession} = await service({}, {settings: true});
  runtime.settings!.save(SettingsInput.parse({deviceUse: "personal"}));
  runtime.services.moderation = undefined;
  const parts = ["가 제도의 서류", "나 제도의 마감일"], prompt = parts.join(" 그리고 ");
  const cards = [official("WLF-A", "가 제도에 필요한 것은 신청서입니다.", {criteriaYear: "2026"}),
    official("WLF-B", "나 제도의 서울 접수는 금요일에 마감합니다.", {referenceDate: "2026-03-05"})] as const;
  let step: 0 | 1 = 0;
  vi.spyOn(runtime.welfareProvider, "findService").mockImplementation(async () => cards[step]);
  const create = runtime.createSession.bind(runtime);
  vi.spyOn(runtime, "createSession").mockImplementation(async options => {
    const session = await create(options);
    if (options?.background !== true) return session;
    const execute = session.planner.execute.bind(session.planner);
    vi.spyOn(session.planner, "execute").mockImplementation(async (task, turn, mode, bounds) => {
      step = task.goal.startsWith("확인할 항목: 가") ? 0 : 1;
      if (step === 1 && !task.goal.includes("서울")) return draft("NEEDS_CLARIFICATION", "clarify", "어느 지역인가요?", {taskQuestion: "어느 지역인가요?"});
      return execute(task, turn, mode, bounds);
    });
    withLlm(session, new FakeLlm(({schemaName, user}) => {
      if (schemaName === "public_service_decision") return {kind: "review_before_output", goal: prompt, source: "welfare",
        subject: "기초연금", agency: "복지로", requestedFacts: ["other"], requirements: parts, exclusions: [], continuation: false,
        question: null, choices: [], difficulty: "medium"};
      if (schemaName === "public_welfare_facts") {
        const {fields} = z.object({fields: z.object({other: z.record(z.string(), z.string())})}).parse(JSON.parse(user));
        return {claims: [{fact: "other", quote: Object.values(fields.other)[0]}]};
      }
      const input = z.object({request: z.string(), evidence: z.array(z.object({id: z.number(), text: z.string()}))}).parse(JSON.parse(user));
      const proof = input.evidence.find(e => cards.some(card => e.text.includes(card.summary)));
      return {answer: proof?.text ?? "", nextRoute: null, checks: [
        {request: input.request, kind: "fact", citations: proof ? [{id: proof.id, quote: proof.text}] : []},
      ]};
    }));
    return session;
  });
  const {id} = await newSession();
  const base = "/api/session/" + id + "/workspace";
  const created = await post(base + "/research", {text: prompt, requestId: randomUUID(), consent: true});
  expect(created.status).toBe(200);
  const {id: jobId} = z.object({id: z.string()}).parse(await created.json());
  const status = async () => savedJobs.parse(await (await app.request(base)).json()).jobs[0];
  const first = {url: checked.url, data: {kind: "live", origin: "official-api", date: "2026년"}};
  await expect.poll(async () => (await status())?.state, {timeout: 20_000}).toBe("needs_input");
  expect((await status())?.result?.sources).toEqual([first]);

  const store = await app.workflows.store();
  await app.workflows.close();
  const reopened = await WorkflowStore.open(store.path, store.owner);
  expect(savedJobs.parse({jobs: await reopened.jobs()}).jobs[0]?.result?.sources).toEqual([first]);

  const revision = (await status())?.questionRevision;
  expect((await post(base + "/research/" + jobId + "/answer", {text: "서울", consent: true, questionRevision: revision})).status).toBe(200);
  await expect.poll(async () => (await status())?.state, {timeout: 20_000}).toBe("completed");
  expect((await status())?.result?.sources).toEqual([first, {url: checked.url, data: {kind: "live", origin: "official-api", date: "2026-03-05"}}]);
});

const oneSolved = "신청서와 신분증을 준비합니다. 출처에서 해당 제도의 자세한 내용을 확인해 주세요.";

it("한 번에 끝나는 저장 조사도 인용마다 자료 정보를 싣는다", async () => {
  const {app, runtime, post, session: newSession} = await service({}, {settings: true});
  runtime.settings!.save(SettingsInput.parse({deviceUse: "personal"}));
  runtime.services.moderation = undefined;
  const documents = "신청서와 신분증을 준비합니다.";
  vi.spyOn(runtime.welfareProvider, "findService").mockResolvedValue({...official("WLF-1", "검증용 제도", {criteriaYear: "2026"}), documents});
  const create = runtime.createSession.bind(runtime);
  vi.spyOn(runtime, "createSession").mockImplementation(async options => {
    const session = await create(options);
    if (options?.background !== true) return session;
    withLlm(session, new FakeLlm(({schemaName}) => schemaName === "public_service_decision" ? {kind: "find_information", goal, source: "welfare",
      subject: "기초연금", agency: "복지로", requestedFacts: ["documents"], exclusions: [], continuation: false, question: null, choices: []} : undefined));
    session.deps.webLlm = new FakeLlm(() => ({coverage: "all", checks: [{request: "신청 서류", quote: documents}]}));
    return session;
  });
  const {id} = await newSession();
  const base = "/api/session/" + id + "/workspace";
  expect((await post(base + "/research", {text: goal, requestId: randomUUID(), consent: true})).status).toBe(200);
  const status = async () => savedJobs.parse(await (await app.request(base)).json()).jobs;
  await expect.poll(async () => (await status())[0]?.state, {timeout: 20_000}).toBe("completed");
  const data = {kind: "live", origin: "official-api", date: "2026년"};
  const result = (await status())[0]?.result;
  expect(result?.sources).toEqual([{url: checked.url, data}]);
  expect(result?.data).toBeUndefined();
  expect(result?.text).toBe(oneSolved);
});

it("인용마다 자료 정보를 두기 전에 저장한 기록은 조사 전체 줄 그대로 읽힌다", async () => {
  const {app, runtime, session: newSession} = await service({}, {settings: true});
  runtime.settings!.save(SettingsInput.parse({deviceUse: "personal"}));
  const {id} = await newSession();
  const store = await app.workflows.store();
  const old = {text: "신청서를 준비하세요.", sources: [{title: "복지로 공식 자료", url: checked.url, lastCheckedAt: "2026-11-19"}],
    data: {kind: "stored", origin: "fixture", date: "2026-11-18"}};
  await store.enqueue(randomUUID(), "옛 형식 조사", "ko");
  expect(await store.finish((await store.claim())!, "completed", old)).toBe(true);
  const [row] = z.object({jobs: z.array(z.object({prompt: z.string(), result: z.unknown()}))}).parse(await (await app.request("/api/session/" + id + "/workspace")).json()).jobs;
  expect(row?.result).toEqual(old);
});

const deliveries = z.object({pending: z.array(z.strictObject({id: z.string(), token: z.string(), state: z.string(), language: z.string(), speech: z.string()}))});
const workspaceRows = z.object({jobs: z.array(z.looseObject({id: z.string(), speech: z.string().optional()}))});
const reading = z.object({text: z.string(), sources: z.array(z.object({title: z.string(), url: z.string(), lastCheckedAt: z.string(), data: dataShape.optional()}))});
const answered = {title: "복지로 공식 자료", url: checked.url, lastCheckedAt: "2026-11-19", data: {kind: "live", origin: "official-api", date: "2026년"}};

it("끝난 조사는 인수증 목록에 말할 글 하나만 담아 보내고 결과 원문 칸은 두지 않으며 패널 목록도 같은 글을 쓴다", async () => {
  const {app, runtime, session: newSession} = await service({}, {settings: true});
  runtime.settings!.save(SettingsInput.parse({deviceUse: "personal"}));
  const {id, session} = await newSession();
  const store = await app.workflows.store();
  const base = "/api/session/" + id + "/workspace";
  const seed = async (prompt: string, language: string, state: string, result?: object) => {
    const jobId = await store.enqueue(randomUUID(), prompt, language);
    expect(await store.finish((await store.claim())!, state, result)).toBe(true);
    return jobId;
  };
  const text = "신청서와 신분증을 준비합니다. 가까운 주민센터에 내세요. 출처에서 해당 제도의 자세한 내용을 확인해 주세요.";
  const ids = {
    partial: await seed("기초연금 신청 서류", "ko", "partial", {text, sources: [answered], missing: ["마감일"]}),
    secret: await seed("비밀 값이 든 조사", "ko", "completed", {text: "비밀번호는 1234예요.", sources: [answered]}),
    legacy: await seed("옛 형식 조사", "ko", "completed", {text: "신청서를 준비하세요. 출처는 복지로 공식 자료이며, 공식 API 실시간 조회입니다. 자료 기준은 2026년. 확인일은 2026년 11월 19일입니다. 출처에서 확인해 주세요.",
      sources: [{title: "복지로 공식 자료", url: checked.url, lastCheckedAt: "2026-11-19"}], data: {kind: "live", origin: "official-api", date: "2026년"}}),
    english: await seed("Basic pension papers", "en", "completed", {text: "Bring the form and ID.", sources: [{...answered, data: {kind: "stored", origin: "fixture", date: "2026-03-05"}}]}),
    corrupt: await seed("깨진 출처가 섞인 조사", "ko", "completed", {text: "서류는 신청서예요.", sources: [{title: 7}, answered]}),
    cancelled: await store.enqueue(randomUUID(), "중단한 조사", "ko"),
  };
  expect(await store.cancel(ids.cancelled)).toBe(true);
  const pending = async () => new Map(deliveries.parse(await (await app.request(base + "/deliveries")).json()).pending.map(row => [row.id, row]));
  let rows = await pending();
  expect(rows.size).toBe(6);
  for (const row of rows.values()) expect(Object.keys(row).sort((a, b) => a.localeCompare(b))).toEqual(["id", "language", "speech", "state", "token"]);
  expect(rows.get(ids.partial)?.speech).toBe(
    "‘기초연금 신청 서류’ 조사 결과예요. 신청서와 신분증을 준비합니다. 가까운 주민센터에 내세요. 출처에서 해당 제도의 자세한 내용을 확인해 주세요. "
    + "출처 복지로 공식 자료. 기관 자료. 자료 기준일 2026년. 출처 확인일 2026년 11월 19일. 확인이 남은 항목. 마감일.");
  expect(rows.get(ids.secret)?.speech).toBe(RESEARCH_UNDELIVERED.ko);
  expect(rows.get(ids.legacy)?.speech).toBe("‘옛 형식 조사’ 조사 결과예요. 신청서를 준비하세요. 출처는 복지로 공식 자료이며, 공식 API 실시간 조회입니다. 자료 기준은 2026년. 확인일은 2026년 11월 19일입니다. 출처에서 확인해 주세요.");
  expect(rows.get(ids.english)).toMatchObject({language: "en", speech: "Results for “Basic pension papers”. Bring the form and ID. Source 복지로 공식 자료. Stored data. Data date 2026-03-05. Source checked 2026-11-19."});
  expect(rows.get(ids.corrupt)?.speech).toBe("‘깨진 출처가 섞인 조사’ 조사 결과예요. 서류는 신청서예요. 출처 복지로 공식 자료. 기관 자료. 자료 기준일 2026년. 출처 확인일 2026년 11월 19일.");
  expect(rows.get(ids.cancelled)?.speech).toBe(`‘중단한 조사’ 조사 소식이에요. ${stateNote("cancelled", "ko")}`);

  const shown = workspaceRows.parse(await (await app.request(base)).json()).jobs;
  for (const [name, jobId] of Object.entries(ids)) {
    expect(shown.find(job => job.id === jobId)?.speech, name).toBe(name === "cancelled" ? undefined : rows.get(jobId)?.speech);
  }

  session.personal.saveSpeech({length: "short"});
  rows = await pending();
  expect(rows.get(ids.partial)?.speech).toBe(
    "‘기초연금 신청 서류’ 조사 결과예요. 신청서와 신분증을 준비합니다. 가까운 주민센터에 내세요. "
    + "출처 복지로 공식 자료. 기관 자료. 자료 기준일 2026년. 출처 확인일 2026년 11월 19일. 확인이 남은 항목. 마감일.");
});

it("말로 요청해 읽은 저장한 조사는 '짧게'에서도 줄이지 않고, 모델에 가는 대화에는 자리 표시만 남기며, 인수증을 받은 뒤에는 다시 전달하지 않는다", async () => {
  const {app, runtime, session: newSession} = await service({}, {settings: true});
  runtime.settings!.save(SettingsInput.parse({deviceUse: "personal"}));
  const {id, session} = await newSession();
  const store = await app.workflows.store();
  const base = "/api/session/" + id + "/workspace";
  const text = "신청서와 신분증을 준비합니다. 가까운 주민센터에 내세요. 출처에서 해당 제도의 자세한 내용을 확인해 주세요.";
  const jobId = await store.enqueue(randomUUID(), "기초연금 신청 서류", "ko");
  expect(await store.finish((await store.claim())!, "partial", {text, sources: [answered], missing: ["마감일"]})).toBe(true);
  session.personal.saveSpeech({length: "short"});
  const [waiting] = deliveries.parse(await (await app.request(base + "/deliveries")).json()).pending;

  const model = new FakeLlm({public_service_decision: readSaved});
  session.deps.llm = model;
  const first = await session.handleTurn("아까 맡긴 조사 읽어 줘");
  expect(first.savedResearch).toEqual({jobId, token: waiting?.token, reading: true});
  expect(first.speech).toBe(waiting?.speech);
  expect(first.speech).toContain("출처 복지로 공식 자료");
  expect(first.speech).toContain("출처 확인일 2026년 11월 19일");
  expect(first.speech).toContain("마감일");

  const sentToModels = JSON.stringify([session.plannerTurns, session.recentVoiceDialogue(), session.recentDialogue(8)]);
  expect(sentToModels).toContain(READING_PLACEHOLDER);
  expect(sentToModels).not.toMatch(/신분증|복지로 공식 자료|마감일/u);
  expect(session.plannerTurns.at(-1)?.exchange.assistant).toBe(READING_PLACEHOLDER);
  expect(session.recentVoiceDialogue().at(-1)).toEqual({role: "assistant", text: READING_PLACEHOLDER});
  expect(session.exportHistory().at(-1)?.text).toContain("출처 복지로 공식 자료");

  const heard = await app.request(`${base}/research/${jobId}/delivery/${waiting?.token}`, {method: "DELETE"});
  expect(heard.status).toBe(200);
  expect(deliveries.parse(await (await app.request(base + "/deliveries")).json()).pending).toEqual([]);
  const second = await session.handleTurn("그 조사 다시 읽어 줘");
  expect(second.speech).toBe(first.speech);
  expect(second.savedResearch).toEqual({jobId, reading: true});
  const planned = model.calls.filter(call => call.schemaName === "public_service_decision").map(call => call.user);
  expect(planned).toHaveLength(2);
  expect(planned[1]).toContain(READING_PLACEHOLDER);
  expect(planned.join("\n")).not.toMatch(/신분증|복지로 공식 자료|마감일/u);
  session.deps.llm = undefined;
  session.personal.saveSpeech({length: "normal"});
  expect((await session.handleTurn("쉽게 말해 줘")).speech).toContain("출처 복지로 공식 자료");

  const chat = new FakeLlm({chat_route: {route: "general", reply: "1년은 보통 365일이에요.", searchQuery: null}});
  withLlm(session, chat);
  await session.handleTurn("1년은 며칠이야");
  const routed = chat.calls.filter(call => call.schemaName === "chat_route").map(call => call.user);
  expect(routed).toHaveLength(1);
  expect(routed[0]).toContain(READING_PLACEHOLDER);
  expect(routed[0]).not.toMatch(/신분증|복지로 공식 자료|마감일/u);
});

it("영어로 맡긴 한 번에 끝나는 조사는 번역한 카드의 답과 다음 할 일만 저장하고 출처와 날짜는 읽을 때 더한다", async () => {
  const {app, runtime, post, session: newSession} = await service({}, {settings: true});
  runtime.settings!.save(SettingsInput.parse({deviceUse: "personal"}));
  runtime.services.moderation = undefined;
  const documents = "신청서와 신분증을 준비합니다.";
  vi.spyOn(runtime.welfareProvider, "findService").mockResolvedValue({...official("WLF-1", "검증용 제도", {criteriaYear: "2026"}), documents});
  const create = runtime.createSession.bind(runtime);
  vi.spyOn(runtime, "createSession").mockImplementation(async options => {
    const session = await create(options);
    if (options?.background !== true) return session;
    const model = new FakeLlm(({schemaName, user}) => {
      if (schemaName === "public_service_decision") return {kind: "find_information", goal, source: "welfare", subject: "기초연금", agency: "복지로",
        requestedFacts: ["documents"], exclusions: [], continuation: false, question: null, choices: []};
      if (schemaName === "public_research_coverage") return {coverage: "all", checks: [{request: "신청 서류", quote: documents}]};
      if (schemaName !== "translate_out") return undefined;
      const {passage} = z.object({passage: z.string()}).parse(JSON.parse(user));
      return {text: passage.includes("신청서") ? "Bring the application form and ID." : "Check the source for details."};
    });
    withLlm(session, model);
    session.deps.webLlm = model;
    return session;
  });
  const {id, session} = await newSession();
  session.lang = "en";
  const base = "/api/session/" + id + "/workspace";
  expect((await post(base + "/research", {text: goal, requestId: randomUUID(), consent: true})).status).toBe(200);
  const status = async () => z.object({jobs: z.array(z.object({state: z.string(), speech: z.string().optional(), result: reading.partial().nullish()}))})
    .parse(await (await app.request(base)).json()).jobs[0];
  await expect.poll(async () => (await status())?.state, {timeout: 20_000}).toBe("completed");
  const job = await status();
  expect(job?.result?.text).toBe("Bring the application form and ID. Check the source for details.");
  expect(job?.speech).toBe("Results for “기초연금 신청 서류”. Bring the application form and ID. Check the source for details. "
    + "Source 복지로 공식 자료. Agency data. Data date 2026. Source checked 2026-11-19.");
  expect(deliveries.parse(await (await app.request(base + "/deliveries")).json()).pending[0]).toMatchObject({language: "en", speech: job?.speech});
});

it("영어로 맡긴 조사의 번역이 실패하면 저장한 글이 번역 실패 안내로 시작하고 한국어 답은 한 번만 담는다", async () => {
  const {app, runtime, post, session: newSession} = await service({}, {settings: true});
  runtime.settings!.save(SettingsInput.parse({deviceUse: "personal"}));
  runtime.services.moderation = undefined;
  const documents = "신청서와 신분증을 준비합니다.";
  vi.spyOn(runtime.welfareProvider, "findService").mockResolvedValue({...official("WLF-1", "검증용 제도", {criteriaYear: "2026"}), documents});
  const create = runtime.createSession.bind(runtime);
  vi.spyOn(runtime, "createSession").mockImplementation(async options => {
    const session = await create(options);
    if (options?.background !== true) return session;
    const model = new FakeLlm(({schemaName}) => {
      if (schemaName === "public_service_decision") return {kind: "find_information", goal, source: "welfare", subject: "기초연금", agency: "복지로",
        requestedFacts: ["documents"], exclusions: [], continuation: false, question: null, choices: []};
      if (schemaName === "public_research_coverage") return {coverage: "all", checks: [{request: "신청 서류", quote: documents}]};
      if (schemaName === "translate_out") throw new Error("translator unavailable");
      return undefined;
    });
    withLlm(session, model);
    session.deps.webLlm = model;
    return session;
  });
  const {id, session} = await newSession();
  session.lang = "en";
  const base = "/api/session/" + id + "/workspace";
  expect((await post(base + "/research", {text: goal, requestId: randomUUID(), consent: true})).status).toBe(200);
  const status = async () => z.object({jobs: z.array(z.object({state: z.string(), result: reading.partial().nullish()}))})
    .parse(await (await app.request(base)).json()).jobs[0];
  await expect.poll(async () => (await status())?.state, {timeout: 20_000}).toBe("completed");
  const text = (await status())?.result?.text ?? "";
  expect(text).toBe(`${FIXED.translateFail.en} ${oneSolved}`);
  expect(text.split("신청서와 신분증을 준비합니다.")).toHaveLength(2);
  expect(text).not.toMatch(/자료 기준|확인일|Data date/u);
});

it("패널이 보여 주는 날짜와 금액을 말로 읽는 글도 똑같이 말하고 자동 전달과 듣기 단추가 같은 글을 읽는다", async () => {
  const {config, settings, seal, path} = await service(), prefs = settings();
  prefs.save(SettingsInput.parse({deviceUse: "personal"})); prefs.setFirstRun("done");
  const directory = dirname(path), seeded = await WorkflowStore.open(join(directory, "workflows.sqlite3"), installationOwner(directory));
  await seeded.enqueue(randomUUID(), "기초연금 금액과 서류", "ko");
  expect(await seeded.finish((await seeded.claim())!, "completed", {
    text: "한 달에 최대 342,510원을 받을 수 있어요. 신분증과 신청서를 준비하세요.",
    sources: [{...answered, data: {kind: "live", origin: "official-api", date: "2026-03-05"}},
      {title: "정부24 안내", url: "https://www.gov.kr/", lastCheckedAt: "2026-11-18", data: {kind: "stored", origin: "fixture", date: "2026년"}}],
  })).toBe(true);
  const runtime = new AgentRuntime(config, undefined, undefined, async () => {throw new Error("Unexpected provider call");}, prefs);
  runtime.sealFactory = () => seal;
  const ui = await startUi(false, {}, runtime);
  try {
    const browser = await launchBrowser(true);
    try {
      const page = await browser.newPage(), spoken: string[] = [];
      await page.exposeFunction("testHeard", (line: string) => { spoken.push(line); });
      await page.route(url => url.pathname === "/src/speaker.ts" && !url.searchParams.has("original"), route =>
        route.fulfill({contentType: "text/javascript", body: `
          export * from '/src/speaker.ts?original';
          export const serverTts = { cancel() {}, async speak(text) { await window.testHeard(text); return 'played'; } };
        `}));
      await page.route("**/api/health", async route => {
        const response = await route.fetch();
        await route.fulfill({json: {...await response.json(), tts: {supported: true, provider: "test-tts"}}});
      });
      await page.goto(ui.url);
      await page.locator("#recovery-no").click();
      await expect.poll(() => spoken.length, {timeout: 20_000}).toBe(1);
      await page.locator("#workflow-title").click();
      const row = page.locator("#research-list li");
      await expectPage(row).toHaveCount(1);
      const shown = await row.innerText();
      await row.getByRole("button", {name: /^결과 듣기/}).click();
      await expect.poll(() => spoken.length, {timeout: 20_000}).toBe(2);
      const [automatic, button] = spoken;
      expect(button).toBe(automatic);
      const dates = (text: string) => [...text.matchAll(/(\d{4})-(\d{2})-(\d{2})|(\d{4})년 (\d{1,2})월 (\d{1,2})일|(\d{4})년/gu)]
        .map(m => m[1] !== undefined ? `${m[1]}-${m[2]}-${m[3]}` : m[4] !== undefined ? `${m[4]}-${(m[5] ?? "").padStart(2, "0")}-${(m[6] ?? "").padStart(2, "0")}` : (m[7] ?? ""))
        .sort((a, b) => a.localeCompare(b));
      expect(dates(shown)).toEqual(["2026", "2026-03-05", "2026-11-18", "2026-11-19"]);
      expect(dates(button ?? "")).toEqual(dates(shown));
      expect(shown.match(/\d[\d,]*원/gu)).toEqual(["342,510원"]);
      expect(button?.match(/\d[\d,]*원/gu)).toEqual(["342,510원"]);
      for (const label of ["기관 자료", "저장 자료", "복지로 공식 자료", "정부24 안내"]) {
        expect(shown, label).toContain(label);
        expect(button, label).toContain(label);
      }
    } finally {await browser.close();}
  } finally {await ui.close();}
});
