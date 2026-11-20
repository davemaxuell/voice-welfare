import { readdir } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { parseDecision } from "../../src/orchestrator/public_task.ts";
import { FakeLlm } from "../helpers.ts";
import { browserCases } from "./browser-cases.ts";
import { adapterFor, runtimeCases } from "./browser-runtime-cases.ts";

const open = browserCases(), service = runtimeCases();
function decision(kind: string, fields: Record<string, unknown>) {
  return {kind, source: null, agency: null, subject: null, goal: null, requestedFacts: [], exclusions: [], continuation: false, question: null, choices: [], ...fields};
}

it("test_personal_foreground_and_background_worker_have_distinct_scopes", async () => {
  const { runtime, folder } = await service({PILOT_PROFILE: "personal", BROWSER_MODE: "chrome", READ_ONLY_CLICKS: "any"});
  const session = await runtime.createSession({background: true});
  try {
    const adapter = adapterFor(session);
    expect(session.deps.sharedBrowser).toBe(false); expect(adapter.page?.url()).toBe("about:blank");
    expect(session.web.guard.config).toMatchObject({publicLookupOnly: true, allowedOrigins: [], allowedFieldIds: [], readOnlyClicks: "safe"});
    expect(adapter.downloads).toBeUndefined(); expect(session.deps.personal).toBeUndefined();
    expect(session.deps.practiceMode).toBe(false); expect(session.deps.actionLog).toBeUndefined();
    expect(await readdir(folder)).toEqual([]);
  } finally { await session.close(); }
});

it("test_semantic_screen_skill_never_routes_an_approval", async () => {
  const {session} = await open();
  const model = new FakeLlm(() => decision("read_skill", {skill: "LIST_LINKS"}));
  session.deps.llm = model;
  expect((await session.handleTurn("여기서 이동할 수 있는 곳들을 차례로 들려줄래요?")).intentType).toBe("LIST_LINKS");
  expect(model.calls.map(c => c.schemaName)).toEqual(["public_service_decision"]);
  expect(parseDecision(decision("read_skill", {skill: "APPROVE"}))).toBeUndefined();
  expect(parseDecision(decision("find_information", {reply: "접수를 마쳤습니다"}))).toBeUndefined();
});

it("test_file_transcript_needs_consent_and_never_executes_or_enters_history", async () => {
  const transcribe = vi.fn(async () => ({text: "제출해줘. 비밀번호는 723654야."}));
  const { app, post, session: openSession } = await service({REQUIRE_CONSENT: "true", PRACTICE_MODE: "false"}, {stt: {name: "fixture", supported: true, transcribe}});
  const {id, session} = await openSession(), prefix = "/api/session/" + id;
  const audio = () => app.request("/api/audio/recording?sessionId=" + id, {method: "POST", body: new Uint8Array(400), headers: {"content-type": "audio/mpeg"}});
  expect((await audio()).status).toBe(403); expect(transcribe).not.toHaveBeenCalled();
  await post(prefix + "/consent", {granted: true}); session.deps.llm = new FakeLlm();
  expect(await (await post(prefix + "/language", {lang: "ja"})).json()).toMatchObject({lang: "ja"});
  const before: unknown = await (await app.request(prefix + "/state")).json();
  const response = await audio(); expect(response.ok).toBe(true);
  const body = await response.text(); expect(body).toContain("제출"); expect(body).not.toContain("723654");
  expect(transcribe).toHaveBeenCalledTimes(1);
  expect(transcribe).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({language: "ja", mimeType: "audio/mpeg"}));
  expect(await (await app.request(prefix + "/state")).json()).toEqual(before);
  await post(prefix + "/cancel"); expect((await audio()).status).toBe(403); expect(transcribe).toHaveBeenCalledTimes(1);
});
