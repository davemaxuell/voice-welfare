import { randomUUID } from "node:crypto";
import { expect as expectPage } from "@playwright/test";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { launchBrowser } from "../../src/agents/web/browser/index.ts";
import { EmbeddingService } from "../../src/core/model_stack.ts";
import { draft } from "../../src/core/turn.ts";
import { AgentRuntime } from "../../src/server/runtime.ts";
import { SettingsInput } from "../../src/server/settings.ts";
import { DIMENSIONS } from "../../src/server/workflow_store.ts";
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

it.each(["partial", "needs_input"])("serves verified public findings as %s and preserves progress", async initialState => {
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
  expect((await session.handleTurn("맡긴 조사 결과 읽어줘")).speech).toContain(parts[1]);
  if (initialState === "needs_input") {
    const revision = (await status())?.questionRevision;
    const path = base + "/research/" + jobId + "/answer";
    expect((await post(path, {text: "서울", consent: true, questionRevision: 1})).status).toBe(409);
    expect((await post(path, {text: "서울", consent: true, questionRevision: revision})).status).toBe(200);
    await expect.poll(async () => (await status())?.state, {timeout: 12_000}).toBe("completed");
    expect(await status()).toMatchObject({ id: jobId, result: { sources: [checked, notice], text: quote + "\n\n" + deadline } });
    expect(lookedUp).toEqual([...parts, parts[1]].map(part => "확인할 항목: " + part));
  }
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
