import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { z } from "zod";
import { guideSection } from "../../src/agents/web/playbook.ts";
import { AgentRuntime } from "../../src/server/runtime.ts";
import { SettingsInput } from "../../src/server/settings.ts";
import { fakeFetch, FakeLlm, step, withLlm } from "../helpers.ts";
import { browserCases } from "./browser-cases.ts";
import { pageFor, runtimeCases } from "./browser-runtime-cases.ts";

const open = browserCases(), service = runtimeCases();
it("test_scholarship_procedure_uses_selected_tab_for_evidence", () => {
  const view = {url: "https://www.kosaf.go.kr/ko/scholar.do?pg=scholarship05_12_01_01&ttab1=2",
    outline: {mainText: "지난 학기 신청일정 8월 12일~9월 9일\n국가장학금Ⅰ유형(학생직접지원형) 지원절차\n온라인 신청\n가구원동의"}};
  const text = guideSection(view, "국가장학금 신청 방법 알려줘").outline.mainText;
  expect(text).toContain("온라인 신청"); expect(text).not.toContain("지난 학기");
  expect(guideSection(view, "신청 일정도 알려줘")).toEqual(view);
});
it("test_settings_enable_audio_planning_and_survive_restart", async () => {
  const key = "sk-test-onboarding";
  const fetcher = fakeFetch(async req => {
    const url = new URL(req.url);
    expect(url.hostname).toBe("api.openai.com"); expect(req.headers.get("Authorization")).toBe("Bearer " + key);
    if (url.pathname.endsWith("/transcriptions")) return Response.json({text: "정부24 열어줘"});
    expect(await req.json()).toMatchObject({speed: 1.6}); return new Response("audio");
  });
  const {app, post, session, config, runtime, path, settings, seal} = await service(
    {VOICE_BASE_URL: "https://old.example/v1", LLM_BASE_URL: "https://old.example/v1", PRACTICE_MODE: "false"}, {settings: true, fetch: fetcher});
  const prefs = {region: "부산", language: "en", speed: 1.6, deviceUse: "personal", rememberService: true};
  expect(await (await app.request("/api/health")).json()).toMatchObject({setupRequired: true}); expect((await post("/api/session")).status).toBe(409);
  const invalid = await post("/api/settings", {apiKey: key, speed: 10}); expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain(key);
  expect(existsSync(path)).toBe(false); expect((await post("/api/settings", {...prefs, apiKey: key})).ok).toBe(true);
  expect((await readFile(path)).includes(key)).toBe(false);
  const visible = await app.request("/api/settings"), health = await app.request("/api/health");
  expect(await visible.clone().text() + await health.clone().text()).not.toContain(key);
  expect(await visible.json()).toMatchObject({hasKey: true, region: "부산광역시"});
  expect(await health.json()).toMatchObject({setupRequired: false, llmRoles: {understand: expect.stringContaining("openai"), goal: expect.stringContaining("openai"), web: expect.stringContaining("openai")}});
  const {id} = await session(); await post("/api/session/" + id + "/consent", {granted: true});
  const transcript = await app.request("/api/audio/transcribe?sessionId=" + id, {method: "POST", body: new Uint8Array(250), headers: {"content-type": "audio/wav"}});
  expect(await transcript.json()).toMatchObject({text: "정부24 열어줘"});
  expect(await (await post("/api/audio/speak", {text: "청음입니다.", rate: 1.25})).text()).toBe("audio");
  expect(fetcher.calls).toHaveLength(2);
  expect((await post("/api/settings", {...prefs, apiKey: "", speed: 0.85})).ok).toBe(true);
  expect(await (await app.request("/api/settings")).json()).toMatchObject({hasKey: true});
  expect(runtime.settings?.claimStartupGuide()).toBe(true); runtime.settings?.rememberService("한국장학재단", "국가장학금");
  await app.sessions.close(); await runtime.close();
  const next = new AgentRuntime(config, undefined, undefined, fetcher, settings()); next.sealFactory = () => seal;
  try {
    expect(next.settings?.claimStartupGuide()).toBe(false);
    const resident = await next.createSession();
    try {
      expect(resident.lang).toBe("en"); expect(resident.profile.ctpv).toBe("부산광역시");
      expect(resident.planner.followup("그럼 서류는?")).toBe("한국장학재단에서 국가장학금 그럼 서류는?");
      expect(next.tts.speed).toBe(0.85); expect(next.stt.apiKey).toBe(key);
      next.settings?.save(SettingsInput.parse({rememberService: false})); expect(settings().lastService).toBeUndefined();
    } finally { await resident.close(); }
  } finally { await next.close(); }
});

it("test_switches_official_sites_and_keeps_followup_on_scholarships", async () => {
  const {session, page} = await open(), quote = "국가장학금 신청 안내와 제출 서류를 확인하세요.";
  for (const host of ["www.bokjiro.go.kr", "www.gov.kr", "www.kosaf.go.kr", "portal.kosaf.go.kr", "www.epeople.go.kr", "www.work24.go.kr"]) {
    await page.route("https://" + host + "/**", r => r.fulfill({contentType: "text/html; charset=utf-8", body: "<title>공공서비스 안내</title><main>" + quote + "</main>"}));
  }
  expect((await session.handleTurn("복지로 열어줘")).observation?.url).toMatch(/^https:\/\/www\.bokjiro\.go\.kr\//u);
  const gov = await session.handleTurn("주민등록등본 발급 방법 알려줘");
  expect(gov.intentType).toBe("GOAL"); expect(gov.observation?.url).toContain("CappBizCD=13100000015");
  const model = new FakeLlm({browse_step: step("answer", null, quote, [quote])}); withLlm(session, model);
  let last = "";
  for (const query of ["장학재단에서 국가장학금 신청 기간 찾아줘", "그럼 신청 서류는 뭐가 필요해?"]) {
    const result = await session.handleTurn(query); expect(result.intentType).toBe("GOAL"); expect(result.state).toBe("BROWSING");
    last = result.sources[0]?.url ?? ""; expect(last.startsWith("https://www.kosaf.go.kr/")).toBe(true);
  }
  const call = model.calls.filter(c => c.schemaName === "browse_step").at(-1)!;
  const data = z.object({conversation: z.looseObject({service: z.string(), recentTurns: z.array(z.object({request: z.string()}))})}).parse(JSON.parse(call.user));
  expect(data.conversation.service).toBe("국가장학금");
  expect(data.conversation.recentTurns.some(x => x.request.includes("신청 기간"))).toBe(true);
  expect(JSON.stringify(data.conversation)).not.toContain("주민등록등본"); expect(last).toContain("ttab1=3");
  for (const [query, domain] of [["민원24 열어줘", "www.gov.kr"], ["국민신문고로 가줘", "www.epeople.go.kr"], ["고용 이십사 열어줘", "www.work24.go.kr"]] as const) {
    expect((await session.handleTurn(query)).observation?.url).toBe("https://" + domain + "/");
  }
});

it("test_editing_settings_keeps_the_current_task_and_forgets_shared_device_topic", async () => {
  const {post, session: create, runtime, settings} = await service({PRACTICE_MODE: "false"}, {settings: true});
  const prefs = {deviceUse: "personal", rememberService: true};
  expect((await post("/api/settings", {...prefs, apiKey: "sk-test-first"})).ok).toBe(true);
  const {id, session} = await create();
  await pageFor(session).route("https://www.gov.kr/**", r => r.fulfill({contentType: "text/html", body: "<main>Gov24</main>"}));
  const say = async (text: string) => (await post("/api/turn", {sessionId: id, text})).json();
  expect(await say("정부24 열어줘")).toMatchObject({intentType: "OPEN_SITE"});
  expect(runtime.settings?.lastService).toEqual(["정부24", ""]);
  expect((await post("/api/settings", {...prefs, apiKey: "sk-test-rotation", region: "서울", speed: 1.6, deviceUse: "shared"})).ok).toBe(true);
  expect(runtime.settings?.lastService).toBeUndefined(); expect(runtime.settings?.preferences.rememberService).toBe(false);
  expect(await say("시작 안내 다시 읽어줘")).toMatchObject({intentType: "READ_START_GUIDE"});
  expect(session.deps.llm).toBe(runtime.understandLlm); expect(session.profile.ctpv).toBe("서울특별시");
  expect(session.publicTask.agency).toBe("정부24"); expect(runtime.tts.speed).toBe(1.6); expect(settings().lastService).toBeUndefined();
});

it("test_reads_legacy_portal_without_mistaking_a_notice_for_login", async () => {
  const {session, page} = await open();
  const body = `<title>고용24</title><main><form><h1>실업급여 신청 안내</h1><a href="#news">간편인증 서비스 점검 안내(11.22)</a>
    <div style="display:none">접속이 차단되었습니다</div><textarea>작성 중인 개인 정보</textarea><p>이 안내에서 필요한 서류를 확인하세요.</p></form></main>
    <script>const filter = Array.prototype.filter;Array.prototype.filter = function(fn){return filter.call(this,(v,i)=>fn(v,i));};</script>`;
  await page.route("https://www.work24.go.kr/**", r => r.fulfill({contentType: "text/html; charset=utf-8", body}));
  expect((await session.handleTurn("고용24 열어줘")).state).toBe("BROWSING");
  const text = session.web.currentView?.outline?.mainText;
  expect(text).toContain("필요한 서류"); expect(text).not.toMatch(/차단|작성 중인/u); expect((await session.handleTurn("시작 안내 다시 읽어줘")).intentType).toBe("READ_START_GUIDE");
});

it("test_speech_repair_waits_for_agreement_and_accepts_a_correction", async () => {
  const transcripts = ["주민등록 등봉 발급 방법 알려줘", "아니요", "주민등록본 발급 방법 알려줘", "1번", "장학제단에서 국가장학금 신청 방법 찾아줘", "뉘엿 뭉개", "네", ""];
  const {app, session: create} = await service({PRACTICE_MODE: "false"}, {stt: {supported: true, name: "fixture", async transcribe() {return {text: transcripts.shift() ?? ""};}}});
  const {session, id} = await create();
  const model = new FakeLlm({speech_repair: {suggestion: "고용24 열어줘"}, browse_step: step("answer", null, "서류를 확인하세요.", ["서류를 확인하세요."])}); withLlm(session, model);
  for (const host of ["www.gov.kr", "www.kosaf.go.kr", "www.work24.go.kr"]) await pageFor(session).route("https://" + host + "/**", r =>
    r.fulfill({contentType: "text/html; charset=utf-8", body: "<title>공식 안내</title><main>서류를 확인하세요.</main>"}));
  const shape = z.object({speech: z.string().optional(), message: z.string().optional(), actions: z.array(z.unknown()).optional(),
    semanticAction: z.string().optional(), publicSuggestions: z.array(z.string()).optional(), observation: z.object({url: z.string()}).optional()});
  const say = async () => shape.parse(await (await app.request("/api/audio/turn?sessionId=" + id, {method: "POST", body: new Uint8Array(500), headers: {"content-type": "audio/wav"}})).json());
  const ask = await say(); expect(ask.speech).toContain("주민등록등본"); expect(ask).toMatchObject({semanticAction: "clarify", actions: [], publicSuggestions: ["주민등록등본"]});
  expect((await say()).actions).toEqual([]); const choice = await say();
  expect(choice.speech).toContain("등본"); expect(choice.speech).toContain("초본"); expect(choice.actions).toEqual([]);
  expect(new Set(choice.publicSuggestions)).toEqual(new Set(["주민등록등본", "주민등록초본"]));
  expect((await say()).observation?.url).toContain("https://www.gov.kr/"); expect((await say()).observation?.url).toContain("https://www.kosaf.go.kr/");
  const guess = await say(); expect(guess.speech).toContain("고용24"); expect(guess.actions).toEqual([]); expect(guess.publicSuggestions).toBeUndefined();
  const call = model.calls.find(c => c.schemaName === "speech_repair")!;
  expect(JSON.parse(call.user)).toMatchObject({context: {service: "국가장학금"}});
  expect((await say()).observation?.url).toContain("https://www.work24.go.kr/"); expect((await say()).message).toContain("고용24");
});
