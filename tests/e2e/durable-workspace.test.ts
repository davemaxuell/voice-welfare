import { randomUUID } from "node:crypto";
import { expect as expectPage } from "@playwright/test";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { launchBrowser } from "../../src/agents/web/browser/index.ts";
import { EmbeddingService } from "../../src/core/model_stack.ts";
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
      const panel = page.locator("#workflow-title"); await panel.click(); await expectPage(panel).toHaveText("Research and saved notes");
      await page.locator("#note-input").fill("Scholarship paperwork"); await page.locator("#note-consent").check(); await page.locator("#note-add").click();
      await expectPage(page.locator("#note-list")).toContainText("Scholarship paperwork");
      await page.reload(); await panel.click(); await page.locator("#note-input").fill("Scholarship"); await page.locator("#note-search").click();
      await expectPage(page.locator("#note-list")).toContainText("Scholarship paperwork");
      await page.locator("#note-list").getByRole("button", {name: "Delete"}).click(); await expectPage(page.locator("#note-list > li")).toHaveCount(0);
    } finally {await browser.close();}
  } finally {await ui.close();}
});
