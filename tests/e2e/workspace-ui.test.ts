import { chromium, expect as screen, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { recordCues, startUi } from "./web-ui-fixtures.ts";

let browser: Browser;
let ui: Awaited<ReturnType<typeof startUi>>;
let page: Page;
beforeAll(async () => { ui = await startUi(); browser = await chromium.launch(); });
beforeEach(async () => { page = await browser.newPage({ locale: "ko-KR" }); });
afterEach(async () => { await page.close(); await ui.reset(); });
afterAll(async () => { await browser?.close(); await ui?.close(); });

const button = (name: string) => page.getByRole("button", { name, exact: true });
const box = () => page.locator("#command");
async function send(text: string) {
  await screen(page.locator("#send")).toBeEnabled();
  await box().fill(text);
  await box().press("Enter");
}
async function consent(url = ui.url) {
  await page.goto(url);
  await button("안내 듣고 시작하기 (Enter)").press("Enter");
  await button("동의하고 시작 (Enter)").press("Enter");
  await screen(page.locator("#consent-panel")).toBeHidden();
}

it.each([true, false])("test_starters_match_consent_and_stage_an_editable_question", async granted => {
  await page.goto(ui.url);
  const hear = button("안내 듣고 시작하기 (Enter)");
  await screen(hear).toBeFocused();
  await hear.press("Enter");
  await button(granted ? "동의하고 시작 (Enter)" : "동의하지 않음 (Esc)").press("Enter");
  const starters = page.getByRole("group", { name: "요청 예시 선택" });
  await screen(starters.getByRole("button")).toHaveCount(granted ? 5 : 3);
  if (granted) {
    await screen(page.locator("#log li")).toHaveCount(1);
    await screen(page.locator("#consent-record")).toContainText("동의해 주셔서 감사합니다");
    await screen(page.locator("#dictation-hint")).toBeVisible();
  } else {
    await screen(starters.getByRole("button", { name: "복지로 열기" })).toHaveCount(0);
    await screen(page.locator("#log")).toContainText("복지 제도 질문에만 답할게요");
  }
  const requests: string[] = [];
  page.on("request", request => { if (request.url().endsWith("/api/turn")) requests.push(request.url()); });
  await starters.getByRole("button", { name: granted ? "복지로 열기" : "지원 대상 알아보기" }).press("Enter");
  await screen(box()).toHaveValue(granted ? "복지로 열어줘" : "장애인연금 지원 대상이 누구야?");
  await screen(box()).toBeFocused();
  expect(requests).toEqual([]);
});

it("test_keyboard_welfare_answer_shows_source_date_and_next_action", async () => {
  await consent();
  await send("장애인연금 지원대상이 누구야?");
  const card = page.getByRole("region", { name: "복지 제도 답변" });
  await screen(card).toBeVisible();
  for (const phrase of ["저장된 자료", "2026-11-15", "다음 행동"]) await screen(card).toContainText(phrase);
  await screen(card.getByRole("link")).toHaveAttribute("href", /^https:\/\//u);
  await screen(box()).toBeFocused();
});

it("test_no_key_never_uses_browser_speech", async () => {
  await page.addInitScript(`
    window.browserVoiceCalls = 0;
    window.SpeechRecognition = class {
      static async available() { window.browserVoiceCalls++; return 'available'; }
      start() { window.browserVoiceCalls++; }
    };
    window.speechSynthesis.speak = () => { window.browserVoiceCalls++; };
  `);
  await consent();
  for (const id of ["mic-btn", "conv-start", "tts-toggle"]) await screen(page.locator("#" + id)).toBeDisabled();
  await screen(page.locator("#dictation-hint")).toContainText("API 키");
  await screen(box()).toBeEnabled();
  expect(await page.evaluate("window.browserVoiceCalls")).toBe(0);
});

it("test_field_confirmation_reads_same_destination_and_stale_id_cannot_write", async () => {
  await consent();
  await send("127.0.0.1:5174/external.html 열어줘");
  await screen(page.locator("#st-access")).toContainText("읽기 전용");
  await send("이름 칸에 김하늘 써줘");
  await screen(button("입력 승인")).toBeEnabled();
  const hint = await page.locator("#confirm-hint").innerText();
  for (const value of ["127.0.0.1:5174", "김하늘"]) expect(hint).toContain(value);
  await screen(page.locator("#log")).toContainText(hint);
  await button("거절").press("Enter");
  await screen(page.locator("#confirm-panel")).toBeHidden();
  await screen(page.locator("#fields")).not.toContainText("입력됨: 김하늘");
});

it("test_same_tab_reload_offers_resume_with_microphone_off", async () => {
  const personal = await startUi(false, { PILOT_PROFILE: "personal" });
  try {
    await page.goto(personal.url);
    await button("복구 켜고 시작").press("Enter");
    await button("안내 듣고 시작하기 (Enter)").press("Enter");
    await button("동의하고 시작 (Enter)").press("Enter");
    await send("127.0.0.1:5174/external.html 열어줘");
    await screen(page.locator("#st-access")).toContainText("읽기 전용");
    await send("이름 칸에 김하늘 써줘");
    await screen(button("입력 승인")).toBeVisible();
    const token = () => page.evaluate(() => sessionStorage.getItem("cheongeum.recovery"));
    const before = await token();
    await page.reload();
    const restore = button("이전 작업 이어하기");
    await screen(restore).toBeVisible();
    await screen(box()).toBeDisabled();
    await restore.press("Enter");
    await screen(button("입력 승인")).toBeHidden();
    await screen(button("음성 입력")).toHaveAttribute("aria-pressed", "false");
    await screen(page.locator("#log")).not.toContainText("김하늘");
    expect(await token()).not.toBe(before);
    await button("이용 종료").press("Enter");
    await screen(button("새 작업 시작")).toBeFocused();
    expect(await token()).toBeNull();
  } finally { await page.close(); await personal.close(); }
});

it("test_workspace_language_changes_starter_and_example_payloads", async () => {
  const sessionId = "workspace-smoke";
  await page.route("**/api/session", route => route.fulfill({ json: { sessionId, state: "IDLE", consentRequired: false, lang: "ko" } }));
  await page.route("**/api/session/*/language", route => route.fulfill({ json: { sessionId, state: "IDLE",
    intentType: "SET_LANGUAGE", semanticAction: "set-language", turnId: crypto.randomUUID(),
    lang: z.object({ lang: z.string() }).parse(route.request().postDataJSON()).lang, speech: "", userUtterance: "" } }));
  await page.goto(ui.url);
  await screen(page.locator("#welcome-panel")).toBeVisible();
  for (const [lang, label, placeholder, snippet, start] of [
    ["en", "Find a Government24 service", "Ask Cheongeum", "resident registration", "Start voice chat (Enter)"],
    ["zh", "查找政府24办事服务", "向青音提问", "居民登记誊本", "开始语音对话（Enter）"],
    ["ja", "政府24の行政手続きを探す", "チョンウムに質問する", "住民登録謄本", "音声会話を開始（Enter）"],
    ["ko", "정부24 민원 찾기", "청음에게 물어보세요", "주민등록등본", "대화 시작 (Enter)"],
  ] as const) {
    await page.locator("#lang-select").selectOption(lang);
    await screen(page.locator("html")).toHaveAttribute("lang", lang);
    await screen(box()).toHaveAttribute("placeholder", placeholder);
    await screen(page.locator("#conv-start")).toHaveAccessibleName(start);
    await button(label).press("Enter");
    expect(await box().inputValue()).toContain(snippet);
    await screen(box()).toBeFocused();
  }
  await page.locator("#lang-select").selectOption("en");
  await page.getByText("Show example requests", { exact: true }).click();
  await page.route("**/api/turn", route => route.fulfill({ status: 409, json: { message: "Test finished" } }));
  const sent = page.waitForRequest(req => req.url().endsWith("/api/turn"));
  await button("Read the main text.").click();
  expect((await sent).postDataJSON()).toMatchObject({ text: "Read the main text." });
});

it.each([true, false])("test_private_prompt_never_uses_remote_speech", async localVoice => {
  await recordCues(page);
  await page.addInitScript(`
    window.privateSpeech = [];
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    const voices = [{ name: 'Online', lang: 'ko-KR', localService: false }];
    if (${localVoice}) voices.push({ name: 'Device', lang: 'ko-KR', localService: true });
    speechSynthesis.getVoices = () => voices;
    speechSynthesis.speak = u => { window.privateSpeech.push([u.text, u.voice?.name]); queueMicrotask(() => u.onend?.()); };
  `);
  const remote: string[] = [];
  page.on("request", req => { if (req.url().endsWith("/api/audio/speak")) remote.push(z.object({ text: z.string() }).parse(req.postDataJSON()).text); });
  await consent();
  await send("내 이름은 별구름이라고 저장해줘");
  await screen(page.locator("#log")).toContainText("이름 별구름");
  if (localVoice) await page.waitForFunction("window.privateSpeech.some(([s, voice]) => s.includes('별구름') && voice === 'Device')");
  else {
    await screen(page.locator("#error")).toContainText("기기");
    expect(await page.evaluate("window.privateSpeech")).toEqual([]);
  }
  expect(remote.every(text => !text.includes("별구름"))).toBe(true);
});

async function untranslated(scope: ReturnType<Page["locator"]>) {
  return scope.evaluate(root => {
    const found: string[] = [];
    const check = (element: Element | null, value: string | null) => {
      if (element === null || value === null || !/[가-힣]/u.test(value) || !element.checkVisibility()
          || element.closest("[lang]")?.getAttribute("lang") === "ko") return;
      found.push((element.id.length > 0 ? element.id : element.tagName) + " — " + value.trim());
    };
    const nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (nodes.nextNode()) check(nodes.currentNode.parentElement, nodes.currentNode.textContent);
    for (const el of root.querySelectorAll("*")) {
      for (const attr of ["aria-label", "title", "alt", "placeholder"]) check(el, el.getAttribute(attr));
      for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/u)) {
        const label = document.getElementById(id);
        if (el.checkVisibility() && label !== null) check(label, label.textContent);
      }
    }
    return [...new Set(found)];
  });
}

it.each(["en", "zh", "ja"] as const)("%s 화면과 접근성 이름에서 번역되지 않은 안내를 찾는다", async lang => {
  const prefs = { language: lang, region: "", regions: [], speed: 1.35, rememberService: false, deviceUse: "shared",
    browser: "separate", sharedDevice: true, hasKey: false, loadError: false, browserFallback: false };
  await page.route("**/api/settings", route => route.fulfill({ json: prefs }));
  await page.route("**/api/health", async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), settingsAvailable: true } });
  });
  let sessionId = "";
  await page.route("**/api/session", async route => {
    const response = await route.fetch();
    const session = await response.json();
    sessionId = session.sessionId;
    await route.fulfill({ json: { ...session, lang } });
  });
  await page.goto(ui.url);
  await screen(page.locator("html")).toHaveAttribute("lang", lang);
  const check = async (id: string) => {
    await screen(page.locator(id)).toBeVisible();
    expect(await untranslated(page.locator("body")), id).toEqual([]);
  };
  await check("#consent-hear");
  await page.locator("#consent-hear").click();
  await page.locator("#consent-yes").click();
  await check("#welcome-panel");
  const common = { sessionId, state: "BROWSING", userUtterance: "test", intentType: "TEST", semanticAction: "test", speech: "OK", lang };
  const source = { title: "Practice source", url: "http://localhost/fixture", lastCheckedAt: "2026-01-01" };
  const turns = [
    { state: "WAITING_FOR_USER_CONFIRMATION", pendingConfirmation: { actionId: "test", kind: "field-entry", purpose: "Input", site: "Practice", values: [{ label: "Name", value: "Sample" }] } },
    { state: "AUTH_HANDOFF", authHandoff: { id: "test", taskId: "task", kind: "login", site: "Practice", status: "waiting" } },
    { state: "DONE", answerCard: { serviceName: "Service", answer: "OK", grounded: true, source, dataKind: "stored", dataOrigin: "fixture", nextAction: "Continue" } },
    undefined,
    { intentType: "SETUP_RESTART" },
  ];
  let turnId = 0;
  await page.route("**/api/turn", async route => {
    const turn = turns[turnId++];
    await route.fulfill(turn === undefined ? { status: 503, json: {} } : { json: { ...common, ...turn, turnId: String(turnId) } });
  });
  await page.route("**/api/session/*/confirm", route => route.fulfill({ json: { ...common, turnId: "confirmed", userUtterance: "[승인 버튼]" } }));
  await send("test");
  await check("#confirm-title");
  await page.locator("#confirm-yes").click();
  await screen(page.locator("#confirm-panel")).toBeHidden();
  expect(await untranslated(page.locator("body"))).toEqual([]);
  for (const id of ["#auth-title", "#answer-title", "#error"]) {
    await send("test");
    await check(id);
  }
  await page.locator("#open-settings").click();
  await screen(page.locator("#setup-language")).toHaveValue(lang);
  await check("#settings-dialog");
  await page.locator("#setup-cancel").click();
  await send("test");
  await check('#first-run [data-step="language"]');
});
