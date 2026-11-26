import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { ReadableStream } from "node:stream/web";
import { chromium, expect as screen, type Browser } from "@playwright/test";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";
import type { WelfareService } from "../../src/agents/welfare/data/index.ts";
import { NEEDS_PERSONAL_DEVICE } from "../../src/orchestrator/saved_research.ts";
import { AgentRuntime } from "../../src/server/runtime.ts";
import { SettingsInput } from "../../src/server/settings.ts";
import { VoiceEdge, type LiveSessionProvider } from "../../src/server/voice_edge.ts";
import { WorkflowStore, installationOwner } from "../../src/server/workflow_store.ts";
import type { SttProvider } from "../../src/voice/stt.ts";
import { FakeLlm, withLlm } from "../helpers.ts";
import { latch } from "./browser-cases.ts";
import { runtimeCases } from "./browser-runtime-cases.ts";
import { plannerPayloads, savedDecision } from "./saved-research-fakes.ts";
import { fakeMicrophone, startUi, textStt, textTts } from "./web-ui-fixtures.ts";

const service = runtimeCases();
let browser: Browser;
const stillOpen = new Set<() => Promise<void>>();
function closer(close: () => Promise<void>) {
  const closeOnce = async () => { if (stillOpen.delete(closeOnce)) await close(); };
  stillOpen.add(closeOnce);
  return closeOnce;
}
beforeAll(async () => { browser = await chromium.launch(); }, 90_000);
afterEach(async () => { for (const close of [...stillOpen].reverse()) await close(); });
afterAll(async () => { await browser?.close(); }, 30_000);

const parts = ["기초연금 신청 서류", "기초연금 신청 마감일"] as const;
const goal = parts.join(" 그리고 ");
const request = `${goal}을 조사해서 저장해 줘`;
const QUEUED = "조사를 맡겼어요. 결과가 나오면 알려 드릴게요.";
const ASK_TO_READ = "아까 맡긴 거 읽어줘";
const readWhichever = savedDecision("read", []).public_service_decision;
const source = {title: "복지로 공식 자료", lastCheckedAt: "2026-11-19", url: "https://www.bokjiro.go.kr/", version: "fixture"};
const card: WelfareService = {
  servId: "WLF-PENSION", servNm: "기초연금", summary: "기초연금 신청에는 신청서와 신분증이 필요합니다.", dataOrigin: "official-api",
  target: "", applyMethod: "", source, referenceDate: "2026-03-05",
};
const unused = {exclusions: [], continuation: false, question: null, choices: []};
const delegate = {kind: "delegate_research", goal, source: "welfare", subject: "기초연금", agency: "복지로", requestedFacts: ["documents"], ...unused};
const never = new Promise<never>(() => {});

function researcher() {
  return new FakeLlm(({schemaName, user}) => {
    if (schemaName === "public_service_decision") return {kind: "review_before_output", goal, source: "welfare", subject: "기초연금", agency: "복지로",
      requestedFacts: ["other"], requirements: parts, difficulty: "medium", ...unused};
    if (schemaName === "public_welfare_facts") {
      const {fields} = z.object({fields: z.object({other: z.record(z.string(), z.string())})}).parse(JSON.parse(user));
      return {claims: [{fact: "other", quote: Object.values(fields.other)[0]}]};
    }
    const input = z.object({request: z.string(), evidence: z.array(z.object({id: z.number(), text: z.string()}))}).parse(JSON.parse(user));
    const proof = input.request === parts[0] ? input.evidence.find(item => item.text.includes(card.summary)) : undefined;
    return {answer: proof?.text ?? "", nextRoute: null, checks: [
      {request: input.request, kind: "fact", citations: proof === undefined ? [] : [{id: proof.id, quote: proof.text}]},
    ]};
  });
}

async function home(deviceUse: "personal" | "shared" = "personal") {
  const {config, settings, seal, path} = await service({REQUIRE_CONSENT: "true", REQUIRE_ACTION_CONFIRMATION: "false"});
  const prefs = settings();
  prefs.save(SettingsInput.parse({deviceUse}));
  prefs.setFirstRun("done");
  const directory = dirname(path);
  const store = () => WorkflowStore.open(join(directory, "workflows.sqlite3"), installationOwner(directory));
  return {config, settings, seal, store};
}
type Home = Awaited<ReturnType<typeof home>>;
const jobsOf = async (at: Home) => (await at.store()).jobs();
async function finished(at: Home, prompt: string, text: string) {
  const store = await at.store();
  await store.enqueue(randomUUID(), prompt, "ko");
  const claimed = await store.claim();
  if (claimed === undefined) throw new Error("방금 넣은 조사를 잡지 못함");
  expect(await store.finish(claimed, "completed", {text, sources: [source]})).toBe(true);
}

interface Launch {
  decision?: object;
  research?: Promise<void>;
  stt?: SttProvider;
  voiceEdge?: VoiceEdge;
}

async function launch(at: Home, {decision = delegate, research = never, stt = textStt, voiceEdge}: Launch = {}) {
  const runtime = new AgentRuntime(at.config, stt, textTts, async () => { throw new Error("Unexpected provider call"); }, at.settings());
  runtime.sealFactory = () => at.seal;
  vi.spyOn(runtime.welfareProvider, "findService").mockResolvedValue(card);
  const planner = new FakeLlm({public_service_decision: decision});
  const working = latch();
  const create = runtime.createSession.bind(runtime);
  vi.spyOn(runtime, "createSession").mockImplementation(async options => {
    const session = await create(options);
    if (options?.background !== true) {
      session.deps.llm = planner;
      return session;
    }
    withLlm(session, researcher());
    const lookUp = session.researchPublic.bind(session);
    vi.spyOn(session, "researchPublic").mockImplementation(async (...args) => {
      working.resolve();
      await research;
      return lookUp(...args);
    });
    return session;
  });
  const ui = await startUi(false, {}, runtime, voiceEdge === undefined ? {} : {voiceEdge});
  const close = closer(ui.close);
  await ui.app.workflows.reconfigure();
  return {url: ui.url, app: ui.app, close, planner, working: working.promise};
}

const READING = /조사 결과예요/u;
const Pending = z.object({pending: z.array(z.object({id: z.string()}))});

interface Opening {
  playback?: Promise<void>;
  watcher?: Promise<void>;
  said?: string;
}

async function openWindow(url: string, {playback = Promise.resolve(), watcher = Promise.resolve(), said = ""}: Opening = {}) {
  const page = await browser.newPage({locale: "ko-KR"});
  const close = closer(() => page.close());
  const heard: string[] = [], receipts: string[] = [], offered: string[][] = [];
  await page.exposeFunction("testHeard", async (line: string) => {
    heard.push(line);
    if (READING.test(line)) await playback;
    return "played";
  });
  await page.route(route => route.pathname === "/src/speaker.ts" && !route.searchParams.has("original"), route => route.fulfill({
    contentType: "text/javascript", body: `
      export * from '/src/speaker.ts?original';
      export const serverTts = { cancel() {}, async speak(text) { return await window.testHeard(text); } };
    `}));
  await fakeMicrophone(page, said);
  await page.route(route => route.pathname.endsWith("/workspace/deliveries"), async route => {
    await watcher;
    await route.continue().catch(() => {});
  });
  page.on("request", sent => {
    const receipt = /\/workspace\/research\/([^/]+)\/delivery\/[^/]+$/u.exec(new URL(sent.url()).pathname);
    if (sent.method() === "DELETE" && receipt?.[1] !== undefined) receipts.push(receipt[1]);
  });
  let sessionId = "";
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (!response.ok() || (path !== "/api/session" && !path.endsWith("/workspace/deliveries"))) return;
    // 창을 닫는 중에 도착한 응답은 본문을 읽을 수 없다. 그때는 기록할 것도 없다.
    void response.json().then(body => {
      if (path === "/api/session") sessionId = z.object({sessionId: z.string()}).parse(body).sessionId;
      else offered.push(Pending.parse(body).pending.map(job => job.id));
    }, () => {});
  });
  await page.goto(url);
  const shown = (...ids: string[]) => page.locator(ids.map(id => `#${id}:visible`).join(", "));
  await screen(shown("recovery-no", "consent-hear", "consent-yes").first()).toBeVisible({timeout: 30_000});
  const recovery = page.locator("#recovery-no"), hear = page.locator("#consent-hear");
  if (await recovery.isVisible()) await recovery.click();
  await screen(shown("consent-hear", "consent-yes").first()).toBeVisible({timeout: 30_000});
  if (await hear.isVisible()) await hear.click();
  await page.locator("#consent-yes").click();
  await screen(page.locator("#consent-panel")).toBeHidden();
  const log = (text: string | RegExp) => page.locator("#log li").filter({hasText: text});
  async function type(text: string) {
    await screen(page.locator("#send")).toBeEnabled();
    await page.locator("#command").fill(text);
    await page.locator("#command").press("Enter");
  }
  return {page, close, session: () => sessionId, heard, receipts, offered, log, type, readings: () => heard.filter(line => READING.test(line))};
}

type Entry = (at: Home) => Promise<() => Promise<void>>;

const byKeyboard: Entry = async at => {
  const app = await launch(at);
  const {close, type, log} = await openWindow(app.url);
  await type(request);
  await screen(log(QUEUED)).toHaveCount(1, {timeout: 30_000});
  return async () => { await close(); await app.close(); };
};

const byOneShotVoice: Entry = async at => {
  const app = await launch(at);
  const {page, close, log} = await openWindow(app.url, {said: request});
  await page.locator("#conv-end").click();
  await page.locator("#mic-btn").click();
  await page.getByRole("button", {name: "말하기 끝 (보내기)"}).click();
  await screen(log(QUEUED)).toHaveCount(1, {timeout: 30_000});
  return async () => { await close(); await app.close(); };
};

function liveService() {
  let feed = (_event: object) => {};
  const events = new ReadableStream<string>({start(controller) { feed = event => controller.enqueue(JSON.stringify(event)); }});
  const provider: LiveSessionProvider = {
    offer: async () => ["live-journey", "v=0"],
    attach: async () => ({[Symbol.asyncIterator]: () => events.values(), async send() {}, async recv() { return ""; }, async close() {}}),
  };
  return {
    provider,
    say(text: string) {
      feed({type: "session.input_transcript.delta", delta: text, start_ms: 100, end_ms: 900, event_id: "heard"});
      feed({type: "session.delegation.created", offset_ms: 910, delegation: {id: "handoff", target: "client"}});
    },
    hangUp() { feed({type: "session.closed"}); },
  };
}

const byLiveSocket: Entry = async at => {
  const live = liveService();
  const app = await launch(at, {stt: {...textStt, edgeModel: "gpt-live-test"}, voiceEdge: new VoiceEdge({provider: () => live.provider})});
  const json = {"content-type": "application/json"};
  const created = await app.app.request("/api/session", {method: "POST", headers: json, body: JSON.stringify({recovery: true})});
  const {sessionId, writer} = z.object({sessionId: z.string(), writer: z.string()}).parse(await created.json());
  const agreed = await app.app.request(`/api/session/${sessionId}/consent`, {
    method: "POST", headers: {...json, "x-cheongeum-writer": writer}, body: JSON.stringify({granted: true}),
  });
  expect(agreed.status).toBe(200);
  const origin = new URL(app.url).origin;
  const socket = new WebSocket(`${origin.replace("http", "ws")}/api/session/${sessionId}/audio/conversation`, {origin});
  const hangUp = closer(async () => { live.hangUp(); socket.close(); });
  const packets: unknown[] = [];
  socket.on("message", data => { packets.push(JSON.parse(String(data))); });
  await once(socket, "open");
  socket.send(JSON.stringify({sdp: "v=0", writer}));
  await expect.poll(() => packets[0], {timeout: 15_000}).toEqual({sdp: "v=0"});
  live.say(request);
  await expect.poll(() => packets[1], {timeout: 30_000}).toMatchObject({result: {speech: QUEUED, researchDelivery: "queued", userUtterance: request}});
  return async () => { await hangUp(); await app.close(); };
};

it.each<[string, Entry]>([
  ["글로 입력해", byKeyboard], ["말하기 버튼으로 한 번 말해", byOneShotVoice], ["실시간 대화로 말해", byLiveSocket],
])("%s 조사를 맡기고 앱을 닫았다 열면 패널을 열지 않아도 주제, 출처, 자료 기준일, 확인일, 남은 항목 순서로 한 번 듣고, 그다음에 열 때는 조용하다", async (_name, entrust) => {
  const at = await home();
  const closeApp = await entrust(at);
  const [saved, ...others] = await jobsOf(at);
  expect(others).toEqual([]);
  expect(saved).toMatchObject({prompt: goal, state: "running", result: null});
  await closeApp();
  expect((await jobsOf(at))[0]).toMatchObject({id: saved?.id, state: "queued", result: null});

  const worker = latch(), playback = latch();
  const reopened = await launch(at, {research: worker.promise});
  await reopened.working;
  worker.resolve();
  const second = await openWindow(reopened.url, {playback: playback.promise});
  await expect.poll(second.readings, {timeout: 60_000}).toHaveLength(1);
  const [reading = ""] = second.readings();
  const pieces = [`‘${goal}’ 조사 결과예요.`, card.summary, "출처 복지로 공식 자료.", "자료 기준일 2026년 3월 5일.", "출처 확인일 2026년 11월 19일.", `확인이 남은 항목. ${parts[1]}.`];
  const places = pieces.map(piece => reading.indexOf(piece));
  expect(pieces.filter(piece => !reading.includes(piece)), reading).toEqual([]);
  expect(places[0], reading).toBe(0);
  expect(places, reading).toEqual([...places].sort((a, b) => a - b));
  await screen(second.log(reading)).toHaveCount(1);
  expect(second.receipts).toEqual([]);
  expect((await jobsOf(at))[0]).toMatchObject({id: saved?.id, state: "partial", deliveryToken: expect.any(String)});

  playback.resolve();
  await expect.poll(() => second.receipts, {timeout: 30_000}).toEqual([saved?.id]);
  await expect.poll(async () => (await jobsOf(at))[0]?.deliveryToken, {timeout: 30_000}).toBeUndefined();
  await screen(second.page.locator("#workflow-panel")).toHaveJSProperty("open", false);
  expect(second.readings()).toEqual([reading]);
  await second.close();
  await reopened.close();

  const later = await launch(at);
  const third = await openWindow(later.url);
  await expect.poll(() => third.offered.length, {timeout: 30_000}).toBeGreaterThan(0);
  expect(third.offered.flat()).toEqual([]);
  expect(third.readings()).toEqual([]);
  await screen(third.log(READING)).toHaveCount(0);
  expect(third.receipts).toEqual([]);
  await third.close();
  await later.close();
}, 300_000);

it("듣지 않은 끝난 조사가 둘일 때 읽어 달라고 하면 번호만 적힌 버튼 두 개가 나오고, 2번을 누르면 그 조사만 읽고 그 인수증만 보내며, 감시는 남은 조사만 전한다", async () => {
  const at = await home();
  await finished(at, "아동수당 신청 방법", "주민센터에서 신청하세요.");
  await finished(at, "기초연금 신청 서류", "신분증을 준비하세요.");
  const [first, second] = await jobsOf(at);
  if (first === undefined || second === undefined) throw new Error("조사 두 건이 저장되지 않음");
  const reading = (job: {prompt: string}) => `‘${job.prompt}’ 조사 결과예요.`;

  const app = await launch(at, {decision: readWhichever});
  const watcher = latch();
  const {page, close, type, log, readings, receipts} = await openWindow(app.url, {watcher: watcher.promise});
  await type(ASK_TO_READ);
  await screen(log(`맡긴 조사가 여러 개예요. 1번 ‘${first.prompt}’, 2번 ‘${second.prompt}’ 중 어떤 것을 읽어 드릴까요?`)).toHaveCount(1, {timeout: 30_000});
  const choices = page.getByRole("group", {name: "어느 조사인지 번호로 골라 주세요."});
  await screen(choices.getByRole("button")).toHaveText(["1번", "2번"]);
  expect(readings()).toEqual([]);

  await choices.getByRole("button", {name: "2번"}).click();
  await expect.poll(() => receipts, {timeout: 30_000}).toEqual([second.id]);
  expect(readings()).toEqual([expect.stringContaining(reading(second))]);
  await expect.poll(async () => (await jobsOf(at)).filter(job => job.deliveryToken !== undefined).map(job => job.id), {timeout: 30_000}).toEqual([first.id]);

  watcher.resolve();
  await expect.poll(() => receipts, {timeout: 30_000}).toEqual([second.id, first.id]);
  expect(readings()).toEqual([expect.stringContaining(reading(second)), expect.stringContaining(reading(first))]);
  for (const job of [first, second]) await screen(log(reading(job))).toHaveCount(1);
  await close();
  await app.close();
}, 180_000);

it("공용 기기로 설정한 PC에서는 저장소에 끝난 조사가 있어도 듣지도 보지도 못하고, 전달 목록은 거절되며, 플래너에 조사 목록이 가지 않는다", async () => {
  const at = await home("shared");
  await finished(at, "기초연금 신청 서류", "신분증을 준비하세요.");
  const app = await launch(at, {decision: readWhichever});
  const {page, close, session, type, log, heard, offered, receipts} = await openWindow(app.url);
  await type(ASK_TO_READ);
  await screen(log(NEEDS_PERSONAL_DEVICE)).toHaveCount(1, {timeout: 30_000});

  const refused = await page.evaluate(async sid => await Promise.all(["", "/deliveries"].map(async path => {
    const response = await fetch(`/api/session/${sid}/workspace${path}`);
    return [response.status, await response.json()];
  })), session());
  expect(refused).toEqual([[403, {error: "WORKSPACE_PERSONAL_REQUIRED"}], [403, {error: "WORKSPACE_PERSONAL_REQUIRED"}]]);
  expect(offered).toEqual([]);
  expect(receipts).toEqual([]);
  expect(heard.join(" ")).not.toMatch(/조사 결과예요|신분증/u);
  await screen(page.locator("#log")).not.toContainText(/조사 결과예요|신분증/u);
  await screen(page.locator("#workflow-panel")).toBeHidden();
  const [asked, ...more] = plannerPayloads(app.planner);
  expect(more).toEqual([]);
  expect(asked).toMatchObject({utterance: ASK_TO_READ});
  expect(asked).not.toHaveProperty("savedJobs");
  await close();
  await app.close();
}, 180_000);
