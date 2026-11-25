import { chromium, expect as screen, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { latch } from "./browser-cases.ts";
import { startUi } from "./web-ui-fixtures.ts";

let browser: Browser;
let ui: Awaited<ReturnType<typeof startUi>>;
let page: Page;

beforeAll(async () => {
  ui = await startUi(false, { REQUIRE_CONSENT: "false" });
  browser = await chromium.launch();
}, 90_000);
afterAll(async () => {
  await browser?.close();
  await ui?.close();
}, 30_000);
beforeEach(async () => {
  page = await browser.newPage({ locale: "ko-KR" });
  await page.route("**/api/health", async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), workspaceAvailable: true } });
  });
});
afterEach(async () => {
  await page?.close();
  await ui?.reset();
});

const source = { title: "복지로 공식 안내", url: "https://www.bokjiro.go.kr/", lastCheckedAt: "2026-11-20" };

const allStateJobs = [
  { id: "j-queued", prompt: "기초연금 신청 시기", state: "queued" },
  { id: "j-running", prompt: "장애인연금 신청 방법", state: "running" },
  {
    id: "j-completed",
    prompt: "주민등록등본 발급 수수료",
    state: "completed",
    speech: "‘주민등록등본 발급 수수료’ 조사 결과예요. 정부24 온라인 발급은 무료입니다.",
    result: {
      text: "정부24 온라인 발급은 무료입니다.",
      sources: [source],
      data: { kind: "live", origin: "정부24", date: "2026-11-20" },
    },
  },
  {
    id: "j-partial",
    prompt: "국가장학금 서류와 마감일",
    state: "partial",
    result: { text: "신청서와 가족관계증명서가 필요합니다.", missing: ["마감일"], sources: [source] },
  },
  {
    id: "j-incomplete",
    prompt: "지자체 신규 교통비 지원",
    state: "incomplete",
    result: { text: "", missing: ["지원 금액"], sources: [] },
  },
  {
    id: "j-needs",
    prompt: "지역별 바우처 문의",
    state: "needs_input",
    questionRevision: 2,
    result: { text: "거주하시는 시·도를 알려 주세요.", missing: ["지역별 금액"], sources: [] },
  },
  { id: "j-failed", prompt: "통신 오류 조사 예시", state: "failed" },
  { id: "j-cancelled", prompt: "중단한 조사 예시", state: "cancelled" },
];

async function openWorkspace(jobs: unknown[], notes: unknown[] = []) {
  await page.route("**/api/session/*/workspace", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { jobs, notes } });
    return route.continue();
  });
  await page.goto(ui.url);
  await screen(page.locator("#workflow-title")).toBeVisible({ timeout: 15_000 });
}

async function recordResearchSpeech(speech: string[], {playback = Promise.resolve(), interrupted = () => false, shim = ""}: {playback?: Promise<unknown>; interrupted?: () => boolean; shim?: string} = {}) {
  await page.exposeFunction("testHeard", async (line: string) => { speech.push(line); await playback; return interrupted() ? "cancelled" : "played"; });
  await page.route(url => url.pathname === "/src/speaker.ts" && !url.searchParams.has("original"), route =>
    route.fulfill({contentType: "text/javascript", body: `
      export * from '/src/speaker.ts?original';
      export const serverTts = { cancel() {}, async speak(text) { return await window.testHeard(text); } };
      ${shim}
    `}));
  await page.route("**/api/health", async route => {
    const response = await route.fetch();
    await route.fulfill({json: {...await response.json(), workspaceAvailable: true, tts: {supported: true, provider: "test-tts"}}});
  });
}

it("닫힌 조사 목록에서도 대화로 접수한 작업의 결과를 읽고 인수증이 늦어도 다시 말하지 않는다", async () => {
  const speech: string[] = [];
  const answer = "도서관 회원 가입에는 본인 확인이 필요합니다.";
  await recordResearchSpeech(speech);
  let queued = false, acknowledged = 0;
  await page.route("**/api/session/*/workspace/deliveries", route => route.fulfill({json: {pending: queued && acknowledged < 2 ?
    [{id: "research", token: "voice-receipt", state: "completed", language: "ko", speech: answer}] : []}}));
  await page.route("**/api/session/*/workspace/research/research/delivery/voice-receipt", route => {
    acknowledged++;
    return route.fulfill({status: acknowledged === 1 ? 503 : 200, json: {heard: true}});
  });
  await page.route("**/api/turn", async route => {
    const response = await route.fetch();
    queued = true;
    await route.fulfill({json: {...await response.json(), researchDelivery: "queued"}});
  });
  await openWorkspace([]);
  await screen(page.locator("#workflow-panel")).toHaveJSProperty("open", false);
  await page.locator("#command").fill("지금 어디까지 했어?");
  await page.locator("#command").press("Enter");
  await expect.poll(() => speech.filter(line => line === answer).length, {timeout: 18_000}).toBe(1);
  await expect.poll(() => acknowledged, {timeout: 18_000}).toBe(2);
  expect(speech.filter(line => line === answer)).toEqual([answer]);
  await screen(page.locator("#log li").filter({hasText: answer})).toHaveCount(1);
});

it("조사 응답을 받던 연결이 끊기면 명령을 다시 실행하지 않고 끝난 결과를 한 번 읽는다", async () => {
  const answer = "문화센터 이용 시간은 오전 아홉 시부터예요.";
  const speech: string[] = [];
  await recordResearchSpeech(speech);
  let requests = 0, receipts = 0;
  await page.route("**/api/session/*/workspace/deliveries", route => route.fulfill({json: {pending: []}}));
  await page.route("**/api/turn", async route => { requests++; await route.abort("connectionreset"); });
  await page.route("**/api/session/*/research-outcomes", route => route.fulfill({json: {
    working: false, outcomes: receipts === 0 ? [{turnId: "lost-answer", lang: "ko", speech: answer}] : [],
  }}));
  await page.route("**/api/session/*/research-outcomes/lost-answer", route => {
    receipts++;
    return route.fulfill({json: {ok: true}});
  });
  await openWorkspace([]);
  await page.locator("#command").fill("문화센터 운영 시간을 찾아줘.");
  await page.locator("#command").press("Enter");
  await expect.poll(() => receipts, {timeout: 12_000}).toBe(1);
  expect(requests).toBe(1);
  expect(speech.filter(line => line === answer)).toEqual([answer]);
  await screen(page.locator("#log li").filter({hasText: answer})).toHaveCount(1);
});

it("조사 접수 응답만 끊겨도 닫힌 패널의 새 작업을 찾아 읽는다", async () => {
  const answer = "유실된 접수 번호로 시작한 조사를 마쳤어요.";
  const speech: string[] = [];
  await recordResearchSpeech(speech);
  let enqueued = false, received = false;
  await page.route("**/api/session/*/research-outcomes", route => route.fulfill({json: {working: false, outcomes: []}}));
  await page.route("**/api/session/*/workspace/deliveries", route => route.fulfill({json: {pending: enqueued && !received
    ? [{id: "job", token: "recovered-job", state: "completed", language: "ko", speech: answer}] : []}}));
  await page.route("**/api/session/*/workspace/research/job/delivery/recovered-job", route => {
    received = true;
    return route.fulfill({json: {heard: true}});
  });
  await page.route("**/api/turn", async route => {enqueued = true; await route.abort("connectionreset");});
  await openWorkspace([]);
  await page.locator("#command").fill("내일 전시회 운영 시간을 조사해 줘.");
  await page.locator("#command").press("Enter");
  await expect.poll(() => received, {timeout: 16_000}).toBe(true);
  expect(speech.filter(line => line === answer)).toEqual([answer]);
});

const finished = (speech: string) => ({id: "research", token: "quiet-receipt", state: "completed", language: "ko", speech});

async function serveOneDelivery(speech: string) {
  const counts = {polls: 0, receipts: 0};
  await page.route("**/api/session/*/workspace/deliveries", route => {
    counts.polls++;
    return route.fulfill({json: {pending: counts.receipts === 0 ? [finished(speech)] : []}});
  });
  await page.route("**/api/session/*/workspace/research/research/delivery/quiet-receipt", route => {
    counts.receipts++;
    return route.fulfill({json: {heard: true}});
  });
  return counts;
}

it("음성 안내를 끈 사용자는 결과가 대화 기록에 한 줄 써지면 전달한 것으로 치고, 다시 열어도 조용하다", async () => {
  const speech: string[] = [], line = "‘기초연금’ 조사 결과예요. 신분증을 준비하세요.";
  await page.addInitScript(() => localStorage.setItem("cheongeum.narrationMuted", "1"));
  await recordResearchSpeech(speech);
  const counts = await serveOneDelivery(line);
  await openWorkspace([]);
  await expect.poll(() => counts.receipts, {timeout: 15_000}).toBe(1);
  await screen(page.locator("#log li").filter({hasText: line})).toHaveCount(1);
  const before = counts.polls;
  await page.reload();
  await expect.poll(() => counts.polls, {timeout: 15_000}).toBeGreaterThan(before);
  await screen(page.locator("#log li").filter({hasText: line})).toHaveCount(0);
  expect(counts.receipts).toBe(1);
  expect(speech).toEqual([]);
});

it("이 PC에 음성이 없으면 결과를 한 줄 쓴 뒤 한 번 전달한 것으로 치고 더는 확인하지 않는다", async () => {
  const line = "‘기초연금’ 조사 결과예요. 신분증을 준비하세요.";
  await page.clock.install();
  await page.route("**/api/health", async route => {
    const response = await route.fetch();
    await route.fulfill({json: {...await response.json(), workspaceAvailable: true, tts: {supported: false, provider: "none"}}});
  });
  const counts = await serveOneDelivery(line);
  await openWorkspace([]);
  await page.clock.runFor(1000);
  await expect.poll(() => counts.receipts, {timeout: 15_000}).toBe(1);
  await screen(page.locator("#log li").filter({hasText: line})).toHaveCount(1);
  const polls = counts.polls;
  await page.clock.runFor(60_000);
  expect(counts.polls).toBe(polls);
  expect(counts.receipts).toBe(1);
});

it("음성 상태를 아직 모르면 소리가 없다고 단정하지 않아 결과를 전달한 것으로 치지 않는다", async () => {
  const answer = "문화센터 안내를 찾았어요.";
  let receipts = 0;
  await page.route("**/api/health", route => route.fulfill({status: 503, json: {error: "down"}}));
  await page.route("**/api/turn", async route => {
    const response = await route.fetch();
    await route.fulfill({json: {...await response.json(), speech: answer, researchDelivery: "outcome"}});
  });
  await page.route("**/api/session/*/research-outcomes**", route => {
    if (route.request().method() === "DELETE") receipts++;
    return route.fulfill({json: {working: false, outcomes: [], ok: true}});
  });
  await page.goto(ui.url);
  await page.locator("#command").fill("문화센터 안내해 줘");
  await page.locator("#command").press("Enter");
  await screen(page.locator("#log li").filter({hasText: answer})).toHaveCount(1, {timeout: 15_000});
  await page.waitForTimeout(1500);
  expect(receipts).toBe(0);
});

it("패널의 듣기 단추는 자동 전달과 같은 글을 그 조사의 언어로 읽는다", async () => {
  const line = "Results for “Basic pension”. Bring your ID. Source Welfare guide. Agency data. Data date 2026. Source checked 2026-11-24.";
  const heard: [string, string][] = [];
  await page.exposeFunction("testHeard", (text: string, lang: string) => { heard.push([lang, text]); });
  await page.route(url => url.pathname === "/src/speaker.ts" && !url.searchParams.has("original"), route =>
    route.fulfill({contentType: "text/javascript", body: `
      export * from '/src/speaker.ts?original';
      export const serverTts = { cancel() {}, async speak(text, _fetch, _from, _rate, lang) { await window.testHeard(text, lang); return 'played'; } };
    `}));
  await page.route("**/api/health", async route => {
    const response = await route.fetch();
    await route.fulfill({json: {...await response.json(), workspaceAvailable: true, tts: {supported: true, provider: "test-tts"}}});
  });
  let delivered = false;
  await page.route("**/api/session/*/workspace/deliveries", route => route.fulfill({json: {pending: delivered ? [] : [
    {id: "job", token: "english-receipt", state: "completed", language: "en", speech: line}]}}));
  await page.route("**/api/session/*/workspace/research/job/delivery/english-receipt", route => { delivered = true; return route.fulfill({json: {heard: true}}); });
  await openWorkspace([{id: "job", prompt: "Basic pension", state: "completed", language: "en", speech: line, result: {text: "Bring your ID.", sources: [source]}}]);
  await expect.poll(() => heard.length, {timeout: 15_000}).toBe(1);
  await page.locator("#workflow-title").click();
  await page.getByRole("button", {name: "결과 듣기: Basic pension"}).click();
  await expect.poll(() => heard.length, {timeout: 15_000}).toBe(2);
  expect(heard).toEqual([["en", line], ["en", line]]);
});

const READING = "‘기초연금’ 조사 결과예요. 신분증을 준비하세요. 출처 복지로 공식 자료. 출처 확인일 2026년 11월 19일.";

async function serveReading(options: {failFirstReceipt?: true; failReceipts?: true; state?: string} = {}) {
  const token = "reading-receipt";
  const state = {asked: false, heard: false, polls: 0, receipts: [] as string[]};
  await page.route("**/api/session/*/workspace/deliveries", route => {
    state.polls++;
    return route.fulfill({json: {pending: state.heard ? [] : [{id: "job", token, state: state.asked ? "completed" : "running", language: "ko", speech: READING}]}});
  });
  await page.route(`**/api/session/*/workspace/research/job/delivery/${token}`, route => {
    state.receipts.push(route.request().method());
    if (options.failReceipts === true || (options.failFirstReceipt === true && state.receipts.length === 1)) return route.fulfill({status: 503, json: {error: "down"}});
    state.heard = true;
    return route.fulfill({json: {heard: true}});
  });
  await page.route("**/api/turn", async route => {
    const response = await route.fetch();
    state.asked = true;
    await route.fulfill({json: {...await response.json(), ...(options.state === undefined ? {} : {state: options.state}), speech: READING, lang: "ko",
      savedResearch: {jobId: "job", token, reading: true}}});
  });
  return state;
}

async function askToRead() {
  await page.locator("#command").fill("아까 맡긴 조사 읽어 줘");
  await page.locator("#command").press("Enter");
}

it("말로 요청해 읽은 저장한 조사는 한 번 말하고 다 들은 뒤에 인수증을 한 번 보내며, 목록에 남은 줄을 감시가 다시 말하거나 쓰지 않는다", async () => {
  const speech: string[] = [], playback = latch();
  await recordResearchSpeech(speech, {playback: playback.promise});
  const state = await serveReading();
  await openWorkspace([]);
  await askToRead();
  await expect.poll(() => speech.length, {timeout: 15_000}).toBe(1);
  const polls = state.polls;
  await expect.poll(() => state.polls, {timeout: 20_000}).toBeGreaterThan(polls);
  expect(speech).toEqual([READING]);
  expect(state.receipts).toEqual([]);
  playback.resolve();
  await expect.poll(() => state.receipts, {timeout: 15_000}).toEqual(["DELETE"]);
  await page.waitForTimeout(1000);
  expect(speech).toEqual([READING]);
  expect(state.receipts).toEqual(["DELETE"]);
  await screen(page.locator("#log li").filter({hasText: READING})).toHaveCount(1);
});

it("음성 안내를 끈 사용자가 말로 요청해 읽은 저장한 조사는 대화 기록에 줄을 쓴 뒤 바로 인수증을 보내고 소리는 내지 않는다", async () => {
  const speech: string[] = [];
  await page.addInitScript(() => localStorage.setItem("cheongeum.narrationMuted", "1"));
  await recordResearchSpeech(speech);
  const state = await serveReading();
  await openWorkspace([]);
  await askToRead();
  await expect.poll(() => state.receipts, {timeout: 15_000}).toEqual(["DELETE"]);
  await screen(page.locator("#log li").filter({hasText: READING})).toHaveCount(1);
  expect(speech).toEqual([]);
});

it("읽은 저장한 조사의 인수증을 보내지 못해도 다시 말하지 않고 감시가 인수증만 다시 보낸다", async () => {
  const speech: string[] = [];
  await recordResearchSpeech(speech);
  const state = await serveReading({failFirstReceipt: true});
  await openWorkspace([]);
  await askToRead();
  await expect.poll(() => state.receipts, {timeout: 20_000}).toEqual(["DELETE", "DELETE"]);
  await page.waitForTimeout(1000);
  expect(speech).toEqual([READING]);
  expect(state.receipts).toEqual(["DELETE", "DELETE"]);
  await screen(page.locator("#log li").filter({hasText: READING})).toHaveCount(1);
});

it("인수증이 서버에 닿지 않은 저장한 조사를 다시 읽어 달라고 하면 같은 인수증이어도 다시 들려준다", async () => {
  const speech: string[] = [];
  await recordResearchSpeech(speech);
  const state = await serveReading({failReceipts: true});
  await openWorkspace([]);
  await askToRead();
  await expect.poll(() => state.receipts.length, {timeout: 15_000}).toBeGreaterThan(0);
  expect(speech).toEqual([READING]);
  await askToRead();
  await expect.poll(() => speech, {timeout: 15_000}).toEqual([READING, READING]);
});

it("말로 요청해 읽던 저장한 조사의 재생이 끊기면 인수증을 보내지 않고, 감시가 나중에 그 결과를 줄 하나 더 쓰지 않고 다시 들려준다", async () => {
  const speech: string[] = [];
  await recordResearchSpeech(speech, {interrupted: () => speech.length === 1});
  const state = await serveReading();
  await openWorkspace([]);
  await askToRead();
  await expect.poll(() => speech.length, {timeout: 15_000}).toBe(1);
  expect(state.receipts).toEqual([]);
  await expect.poll(() => speech.length, {timeout: 25_000}).toBe(2);
  await expect.poll(() => state.receipts, {timeout: 15_000}).toEqual(["DELETE"]);
  expect(speech).toEqual([READING, READING]);
  await screen(page.locator("#log li").filter({hasText: READING})).toHaveCount(1);
});

it("읽어 주기 전에 다른 응답으로 바뀐 저장한 조사는 감시가 나중에 줄 하나 더 쓰지 않고 한 번 들려주고 인수증을 한 번 보낸다", async () => {
  const speech: string[] = [], parked = latch(), cue = latch();
  await page.exposeFunction("testCue", async () => { parked.resolve(); await cue.promise; });
  await recordResearchSpeech(speech, {shim: `
    import { earcon as playCue } from '/src/speaker.ts?original';
    export const earcon = kind => kind === "problem" ? window.testCue() : playCue(kind);`});
  const state = await serveReading({state: "RECOVERING"});
  await openWorkspace([]);
  await askToRead();
  await parked.promise;
  await page.locator("#lang-select").selectOption("ko");
  await expect.poll(() => speech.length, {timeout: 15_000}).toBe(1);
  expect(speech).not.toContain(READING);
  cue.resolve();
  await expect.poll(() => speech.filter(line => line === READING).length, {timeout: 25_000}).toBe(1);
  await expect.poll(() => state.receipts, {timeout: 15_000}).toEqual(["DELETE"]);
  await page.waitForTimeout(1000);
  expect(speech.filter(line => line === READING)).toEqual([READING]);
  expect(state.receipts).toEqual(["DELETE"]);
  await screen(page.locator("#log li").filter({hasText: READING})).toHaveCount(1);
});

it("패널의 듣기 단추는 다 읽은 뒤에 그 조사의 인수증을 보내고, 인수증이 없는 조사는 읽기만 한다", async () => {
  const speech: string[] = [], playback = latch(), receipts: string[] = [];
  await recordResearchSpeech(speech, {playback: playback.promise});
  await page.route("**/api/session/*/workspace/deliveries", route => route.fulfill({json: {pending: []}}));
  await page.route("**/api/session/*/workspace/research/*/delivery/*", route => {
    receipts.push(new URL(route.request().url()).pathname.split("/").slice(-3).join("/"));
    return route.fulfill({json: {heard: true}});
  });
  const done = (id: string, prompt: string, extra: object) => ({id, prompt, state: "completed", language: "ko", speech: `${prompt} 결과예요.`,
    result: {text: "답입니다.", sources: [source]}, ...extra});
  await openWorkspace([done("fresh", "기초연금", {deliveryToken: "panel-receipt"}), done("heard", "장애인연금", {})]);
  await page.locator("#workflow-title").click();
  await page.getByRole("button", {name: "결과 듣기: 기초연금"}).click();
  await expect.poll(() => speech, {timeout: 15_000}).toEqual(["기초연금 결과예요."]);
  expect(receipts).toEqual([]);
  playback.resolve();
  await expect.poll(() => receipts, {timeout: 15_000}).toEqual(["fresh/delivery/panel-receipt"]);
  await page.getByRole("button", {name: "결과 듣기: 장애인연금"}).click();
  await expect.poll(() => speech, {timeout: 15_000}).toEqual(["기초연금 결과예요.", "장애인연금 결과예요."]);
  await page.waitForTimeout(1000);
  expect(receipts).toEqual(["fresh/delivery/panel-receipt"]);
});

it("기본 조작 모드에서는 조사 시작과 메모 저장을 한 번씩만 요청한다", async () => {
  await page.route("**/api/health", async route => {
    const response = await route.fetch();
    await route.fulfill({json: {...await response.json(), directActions: true, workspaceAvailable: true}});
  });
  const requests: unknown[] = [];
  await page.route("**/api/session/*/workspace/{research,notes}", async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({json: {}});
  });
  await openWorkspace([]);
  await page.locator("#workflow-title").click();
  await screen(page.locator("#research-consent, #note-consent")).toHaveCount(0);
  await page.locator("#research-input").fill("청년 주거 지원");
  await page.locator("#research-add").click();
  await screen(page.locator("#research-input")).toHaveValue("");
  await page.locator("#note-input").fill("전세 지원");
  await page.locator("#note-add").click();
  await screen(page.locator("#note-input")).toHaveValue("");
  expect(requests).toEqual([expect.objectContaining({text: "청년 주거 지원", consent: true}), {text: "전세 지원", consent: true}]);
});

it("여덟 가지 조사 상태를 각기 다른 표시·안내·시각·고유 버튼 이름으로 보여 준다", async () => {
  await openWorkspace(allStateJobs);
  await page.locator("#workflow-title").click();

  const expectedLabels: Record<string, string> = {
    queued: "접수됨", running: "조사 중", completed: "조사 완료", partial: "일부 확인",
    incomplete: "확인하지 못함", needs_input: "질문 보완 필요", failed: "실패", cancelled: "중단됨",
  };
  for (const [state, label] of Object.entries(expectedLabels)) {
    const row = page.locator(`#research-list li[data-state="${state}"]`);
    await screen(row).toHaveCount(1);
    await screen(row.locator(".research-state")).toHaveText(label);
    await screen(row.locator(".research-updated")).toContainText("최근 확인");
    await screen(row.locator(".research-note")).not.toBeEmpty();
  }

  // 완료·일부 확인·실패·중단·추가 질문의 핵심 정보와 버튼
  await screen(page.locator(`#research-list li[data-state="completed"]`)).toContainText("정부24 온라인 발급은 무료입니다.");
  await screen(page.locator(`#research-list li[data-state="completed"]`)).toContainText("2026-11-20");
  await screen(page.locator(`#research-list li[data-state="partial"] .research-missing`)).toContainText("마감일");
  await screen(page.locator(`#research-list li[data-state="cancelled"] .research-note`)).toContainText("되돌리지 않았어요");

  // 모든 버튼의 접근성 이름에 조사 제목이 포함되어 서로 구분된다
  const buttonNames = await page.locator("#research-list button").evaluateAll(buttons =>
    buttons.map(b => b.getAttribute("aria-label") ?? b.textContent?.trim() ?? ""),
  );
  expect(buttonNames.length).toBeGreaterThanOrEqual(12);
  expect(new Set(buttonNames).size).toBe(buttonNames.length);
  expect(buttonNames).toContain("중단: 기초연금 신청 시기");
  expect(buttonNames).toContain("결과 듣기: 주민등록등본 발급 수수료");
  expect(buttonNames).toContain("다시 시도: 통신 오류 조사 예시");
  expect(buttonNames).toContain("조사 이어가기: 지역별 바우처 문의");
});

it("출처마다 자료 종류와 기준일을 보여 주고, 옛 기록은 조사 전체 줄로 보여 주며, 깨진 기록 하나가 목록을 비우지 않는다", async () => {
  const dated = { ...source, data: { kind: "live", origin: "official-api", date: "2026년" } };
  const undated = { title: "복지로 저장 자료", url: "https://www.bokjiro.go.kr/stored", lastCheckedAt: "2026-11-18", data: { kind: "stored", origin: "fixture" } };
  const legacy = { id: "j-legacy", prompt: "옛 형식으로 저장한 조사", state: "completed", result: { text: "신청서가 필요합니다.", sources: [source],
    data: { kind: "private-program", origin: "공공데이터포털", date: "2026-11-18" } } };
  const bare = { id: "j-bare", prompt: "자료 정보가 없는 조사", state: "completed", result: { text: "답입니다.", sources: [source] } };
  await openWorkspace([
    { id: "j-two", prompt: "서류와 지급일", state: "completed", result: { text: "서류와 지급일입니다.", sources: [dated, undated, { title: 7 }] } },
    legacy, bare, { id: 5, prompt: ["깨진 기록"] }, { id: "j-odd", prompt: "결과가 깨진 조사", state: "failed", result: "oops" },
  ]);
  await page.locator("#workflow-title").click();
  const row = (id: string) => page.locator("#research-list li").filter({ hasText: id });
  await screen(page.locator("#research-list li")).toHaveCount(4);
  await screen(row("서류와 지급일").locator(".research-meta")).toHaveText(["기관 자료 · 자료 기준일 2026년", "저장 자료 · 자료 기준일 날짜 기록 없음"]);
  await screen(row("서류와 지급일").locator(".research-sources")).toHaveCount(2);
  await screen(row("옛 형식").locator(".research-meta")).toHaveText("민간 사업 자료 · 자료 기준일 2026-11-18");
  await screen(row("자료 정보가 없는").locator(".research-meta")).toHaveCount(0);
  await screen(row("자료 정보가 없는").locator(".research-sources")).toContainText("복지로 공식 안내");
  await screen(row("결과가 깨진")).toContainText("실패");
});

it("조사 등록 시 작업 이름을 알리고, 오류 코드를 안내한 뒤 다음 새로고침이 성공하면 오류를 지운다", async () => {
  let jobs: unknown[] = [];
  let failNextGet = false;
  let errorCodeToReturn = "PUBLIC_TEXT_REQUIRED";
  await page.route("**/api/session/*/workspace", route => {
    if (route.request().method() === "GET") {
      if (failNextGet) {
        failNextGet = false;
        return route.fulfill({ status: 409, json: { error: errorCodeToReturn } });
      }
      return route.fulfill({ json: { jobs, notes: [] } });
    }
    return route.continue();
  });
  await page.route("**/api/session/*/workspace/research", async route => {
    const body = route.request().postDataJSON() as { text?: string };
    if (body.text === "CONFLICT") return route.fulfill({ status: 409, json: { error: "REQUEST_CONFLICT" } });
    if (body.text === "LIMIT") return route.fulfill({ status: 409, json: { error: "WORKSPACE_LIMIT" } });
    jobs = [{ id: "j-new", prompt: body.text ?? "", state: "queued" }];
    return route.fulfill({ json: { id: "j-new" } });
  });

  await page.goto(ui.url);
  await page.locator("#workflow-title").click();

  await page.locator("#research-input").fill("청년 월세 지원 기준");
  await page.locator("#research-consent").check();
  await page.locator("#research-add").click();
  await screen(page.locator("#workflow-feedback")).toContainText("청년 월세 지원 기준");
  await screen(page.locator(`#research-list li[data-state="queued"]`)).toHaveCount(1);

  // 오류 코드별 안내 확인
  await page.locator("#research-input").fill("CONFLICT");
  await page.locator("#research-consent").check();
  await page.locator("#research-add").click();
  await screen(page.locator("#workflow-feedback")).toContainText("상태가 바뀌었어요");

  await page.locator("#research-input").fill("LIMIT");
  await page.locator("#research-consent").check();
  await page.locator("#research-add").click();
  await screen(page.locator("#workflow-feedback")).toContainText("저장 한도");

  // 새로고침 실패 후 다음 새로고침 성공 시 오류 문구 제거
  failNextGet = true;
  errorCodeToReturn = "WORKSPACE_PERSONAL_REQUIRED";
  await page.locator("#workflow-title").click(); // 닫기
  await page.locator("#workflow-title").click(); // 열기 → 실패
  await screen(page.locator("#workflow-feedback")).toContainText("개인 PC 설정");
  await screen(page.locator("#workflow-feedback")).toHaveText("", { timeout: 6_000 });
});

it("패널이 닫혀 있고 진행 중인 조사가 없으면 요청을 보내지 않고, 진행 중 조사가 끝나면 개인 질문 없이 배지와 상태 줄을 표시한다", async () => {
  await page.clock.install();
  let workspaceGets = 0;
  let currentJobs: unknown[] = [];
  await page.route("**/api/session/*/workspace", route => {
    if (route.request().method() === "GET") {
      workspaceGets++;
      return route.fulfill({ json: { jobs: currentJobs, notes: [] } });
    }
    return route.continue();
  });
  await page.route("**/api/session/*/workspace/research", route => {
    currentJobs = [{ id: "j-secret", prompt: "민감한 질문 제목 숨김 확인", state: "running" }];
    return route.fulfill({ json: { id: "j-secret" } });
  });

  await page.goto(ui.url);
  await screen(page.locator("#workflow-title")).toBeVisible({ timeout: 15_000 });
  // 닫혀 있고 진행 중인 조사가 없으면 30초가 지나도 요청이 0건이다.
  await page.clock.runFor(30_000);
  expect(workspaceGets).toBe(0);

  // 패널을 열어 조사를 등록한 뒤 곧바로 닫는다.
  await page.locator("#workflow-title").click();
  await page.locator("#research-input").fill("민감한 질문 제목 숨김 확인");
  await page.locator("#research-consent").check();
  await page.locator("#research-add").click();
  await screen(page.locator(`#research-list li[data-state="running"]`)).toHaveCount(1);
  await page.locator("#workflow-title").click(); // 닫기

  const beforeClosed = workspaceGets;
  currentJobs = [{
    id: "j-secret",
    prompt: "민감한 질문 제목 숨김 확인",
    state: "completed",
    result: { text: "확인 완료", sources: [source] },
  }];
  await page.clock.runFor(10_500);
  await screen(page.locator("#workflow-badge")).toHaveText("1");
  expect(workspaceGets).toBe(beforeClosed + 1);
  await screen(page.locator("#st-research")).toBeVisible();
  await screen(page.locator("#st-research")).toContainText("1건");
  // 공용 PC 보호: 상태 줄에는 질문 원문이 포함되지 않는다.
  expect(await page.locator("#st-research").textContent()).not.toContain("민감한 질문 제목 숨김 확인");

  // 완료 후 닫힌 상태에서는 더 이상 폴링하지 않는다.
  const afterDone = workspaceGets;
  await page.clock.runFor(25_000);
  expect(workspaceGets).toBe(afterDone);

  // 패널을 열면 배지와 상태 줄이 사라진다.
  await page.locator("#workflow-title").click();
  await screen(page.locator("#workflow-badge")).toHaveCount(0);
  await screen(page.locator("#st-research")).toBeHidden();
});

it.each([
  ["en", "Queued", "Researching", "Completed", "Clarification needed"],
  ["zh", "排队中", "调查中", "已完成", "需要补充说明"],
  ["ja", "受付済み", "調査中", "調査完了", "質問の補足が必要"],
] as const)("%s 언어에서 조사 상태 라벨을 번역해 표시한다", async (lang, queued, running, completed, needsInput) => {
  await page.route("**/api/session/*/language", async route => {
    const response = await route.fetch();
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({ json: { ...body, lang, speech: "ok" } });
  });
  await openWorkspace(allStateJobs);
  await page.locator("#lang-select").selectOption(lang);
  await page.locator("#workflow-title").click();
  await screen(page.locator(`#research-list li[data-state="queued"] .research-state`)).toHaveText(queued);
  await screen(page.locator(`#research-list li[data-state="running"] .research-state`)).toHaveText(running);
  await screen(page.locator(`#research-list li[data-state="completed"] .research-state`)).toHaveText(completed);
  await screen(page.locator(`#research-list li[data-state="needs_input"] .research-state`)).toHaveText(needsInput);
});

it("중단 응답이 cancelled: false이면 상태 변경을 안내하고, 접힘 알림은 실패와 혼합 결과의 개수를 구분한다", async () => {
  await page.clock.install();
  let currentJobs: unknown[] = [
    { id: "j-race", prompt: "이미 끝난 조사", state: "running" },
    { id: "j-a", prompt: "숨길 질문 A", state: "running" },
    { id: "j-b", prompt: "숨길 질문 B", state: "running" },
  ];
  await page.route("**/api/session/*/workspace", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { jobs: currentJobs, notes: [] } });
    return route.continue();
  });
  await page.route("**/api/session/*/workspace/research/j-race/claim", route => {
    currentJobs = [
      { id: "j-race", prompt: "이미 끝난 조사", state: "completed", result: { text: "방금 완료됨", sources: [source] } },
      { id: "j-a", prompt: "숨길 질문 A", state: "running" },
      { id: "j-b", prompt: "숨길 질문 B", state: "running" },
    ];
    return route.fulfill({ json: { cancelled: false } });
  });

  await page.goto(ui.url);
  await page.locator("#workflow-title").click();
  await page.getByRole("button", { name: "중단: 이미 끝난 조사" }).click();
  await screen(page.locator("#workflow-feedback")).toContainText("이미 상태가 바뀌어 중단하지 않았어요");
  await screen(page.locator(`#research-list li[data-state="completed"]`)).toContainText("방금 완료됨");

  // 패널을 닫고 1건은 실패, 1건은 추가 확인 필요로 전환되면 결과별 개수만 정확히 알린다.
  await page.locator("#workflow-title").click(); // 닫기
  currentJobs = [
    { id: "j-race", prompt: "이미 끝난 조사", state: "completed", result: { text: "방금 완료됨", sources: [source] } },
    { id: "j-a", prompt: "숨길 질문 A", state: "failed" },
    { id: "j-b", prompt: "숨길 질문 B", state: "needs_input", questionRevision: 1, result: { text: "추가 질문" } },
  ];
  await page.clock.runFor(10_500);
  await screen(page.locator("#workflow-badge")).toHaveText("2");
  await screen(page.locator("#st-research")).toContainText("자료 조사 1건에 추가 확인이 필요해요.");
  await screen(page.locator("#st-research")).toContainText("자료 조사 1건을 마치지 못했어요.");
  expect(await page.locator("#st-research").textContent()).not.toContain("완료됐어요");
  expect(await page.locator("#st-research").textContent()).not.toContain("숨길 질문");
});
