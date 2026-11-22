import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { LANGS, type Lang } from "../src/core/turn.ts";
import { REPO_ROOT } from "../src/core/assets.ts";
import { PORTAL } from "../tests/helpers.ts";
import { recordCues, startUi } from "../tests/e2e/web-ui-fixtures.ts";
import { FAKE_OVERLAY } from "../tests/e2e/avatar-overlay-fixture.ts";
import { SETTLE_MS, type StepName } from "../web/src/first-run.ts";

const out = join(REPO_ROOT, "reports", "ux", "screens");
const widths = [360, 768, 1024, 1440];
const themes = ["light", "dark", "high-contrast"] as const;
const viewport = { width: 1440, height: 900 };
type Screen = "consent" | "ready" | "listening" | "working" | "approval" | "login-handoff" | "answer" | "error";
type Entry = "setup" | "recovery" | "consent" | "ready";

async function capture(page: Page, name: string, fullPage = true) {
  await page.screenshot({ path: join(out, name + ".png"), fullPage, animations: "disabled" });
}

async function matrix(page: Page, lang: Lang, screen: Screen, selector: string) {
  const anchor = page.locator(selector);
  await expect(anchor).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", lang);
  for (const theme of themes) {
    const contrast = page.locator("#contrast-toggle");
    await page.emulateMedia({ colorScheme: theme === "dark" ? "dark" : "light" });
    const high = theme === "high-contrast";
    if ((await contrast.getAttribute("aria-pressed") === "true") !== high) await contrast.click();
    await expect(contrast).toHaveAttribute("aria-pressed", String(high));
    for (const width of widths) {
      await page.setViewportSize({ ...viewport, width });
      await anchor.scrollIntoViewIfNeeded();
      await capture(page, [lang, theme, width, screen].join("-"));
    }
  }
  await page.locator("#contrast-toggle").click();
  await page.setViewportSize(viewport);
}

async function walkthrough(browser: Browser, url: string, lang: Lang) {
  const page = await browser.newPage({ viewport, locale: lang, reducedMotion: "reduce" });
  const avatar = await browser.newPage({ viewport, locale: lang, reducedMotion: "reduce" });
  let entry: Entry = "consent";
  let releaseTurn: (() => void) | undefined;
  let revision = 0;
  const sessionId = "screen-fixture";
  const settings = { language: lang, region: "", speed: 1.35, rememberService: false, deviceUse: "personal",
    browser: "separate", sharedDevice: false, hasKey: false, loadError: false, regions: [], browserFallback: false };
  // 대화 창에서 실제로 발행한 상태를 같은 출처의 아바타 창에 전달한다.
  await page.addInitScript(`window.cheongeumDesktop = { onTalk() {}, setAutoStart() {}, getAutoStart() { return false; },
    publish(s) { window.__screenSnapshot = s; } };`);
  await recordCues(page, true);
  await avatar.addInitScript(FAKE_OVERLAY);
  await avatar.goto(url + "avatar/index.html");
  async function avatarShot(name: string, selector: string) {
    await page.waitForFunction("window.__screenSnapshot?.connected");
    const value: unknown = await page.evaluate("window.__screenSnapshot");
    await avatar.evaluate("window.__send('snapshot'," + JSON.stringify(value) + ")");
    await expect(avatar.locator(selector)).toBeVisible();
    await avatar.locator("#overlay").screenshot({ path: join(out, name + ".png"), animations: "disabled" });
  }
  await page.route("**/api/health", route => route.fulfill({ json: {
    practiceMode: true, setupRequired: entry === "setup", recoveryAvailable: entry === "recovery",
    workspaceAvailable: true, settingsAvailable: true, stt: { supported: true, provider: "test-text" },
    tts: { supported: false, provider: "mock" },
  } }));
  await page.route("**/api/settings", route => route.fulfill({ json: route.request().method() === "GET" ? settings : { saved: true } }));
  await page.route("**/api/settings/check-key", route => route.fulfill({ json: { result: "ok" } }));
  await page.route("**/api/session", route => route.fulfill({ json: { sessionId, lang, firstStartupGuide: false,
    consentRequired: entry === "consent", state: entry === "consent" ? "AWAITING_CONSENT" : "IDLE" } }));
  await page.route("**/api/session/*/workspace", route => route.fulfill({ json: { jobs: [], notes: [] } }));
  await page.route("**/api/session/*/reminders", route => route.fulfill({ json: { text: null } }));
  await page.route("**/api/session/*/heartbeat", route => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/session/*/progress", route => route.fulfill({ json: { seq: 1, running: true, spoken: false } }));
  function reply(speech: string) {
    return { sessionId, lang, turnId: String(++revision), userUtterance: "", intentType: "QUESTION", state: "IDLE", semanticAction: "answer", speech };
  }
  await page.route("**/api/session/*/cancel", route => route.fulfill({ json: { ...reply("멈췄어요."), state: "STOPPED", intentType: "STOP", semanticAction: "stop" } }));
  const input = { approval: "지역 칸에 예시 지역을 입력해 줘", auth: "로그인하고 싶어", answer: "장애인연금이 뭐야", error: "다시 읽어 줘" };
  await page.route("**/api/turn", async route => {
    const text = route.request().postDataJSON()?.text;
    if (text === input.error) return route.fulfill({ status: 503, json: { message: "지금 요청을 처리할 수 없어요." } });
    if (text === input.approval) return route.fulfill({ json: { ...reply("입력할 내용을 확인해 주세요."), state: "WAITING_FOR_USER_CONFIRMATION",
      pendingConfirmation: { actionId: "sample-fill", kind: "field-entry", purpose: input.approval, site: PORTAL, values: [{ label: "지역", value: "예시 지역" }] } } });
    if (text === input.auth) return route.fulfill({ json: { ...reply("연습 페이지에서 직접 로그인해 주세요."), state: "AUTH_HANDOFF",
      authHandoff: { id: "sample-login", taskId: "sample-task", kind: "login", site: PORTAL, status: "waiting" },
      offeredChoices: [{ key: "auth-done", label: "로그인했어요" }, { key: "auth-cancel", label: "인증 취소" }] } });
    if (text !== input.answer) throw new Error("알 수 없는 화면 예시입니다.");
    await new Promise<void>(resolve => { releaseTurn = resolve; });
    const speech = "연습용 장애인연금 안내입니다.";
    return route.fulfill({ json: { ...reply(speech), answerCard: { answer: speech, serviceName: "장애인연금",
      grounded: true, dataKind: "stored", dataOrigin: "fixture", dataDate: "2026-11-21",
      source: { title: "연습용 제도 안내", url, lastCheckedAt: "2026-11-21" }, nextAction: "모의 안내를 읽어 보세요." } } });
  });
  async function open(mode: Entry) {
    entry = mode;
    await page.goto(url);
  }
  async function send(text: string) {
    await expect(page.locator("#send")).toBeEnabled();
    await page.locator("#command").fill(text);
    await page.locator("#command").press("Enter");
  }
  const korean = lang === "ko";
  try {
    if (korean) {
      await open("setup");
      const wizard: [StepName, string, string][] = [
        ["language", "01-setup-language", "1"], ["who", "02-setup-role", "2"], ["key", "03-setup-key", "Enter"],
        ["pc", "04-setup-device", "1"], ["browser", "05-setup-browser", "2"], ["autostart", "06-setup-startup", "2"],
        ["guardian", "07-setup-contact", ""], ["handover", "08-setup-handover", "Enter"],
        ["sound", "09-setup-sound", "Enter"], ["speed", "10-setup-speed", ""],
      ];
      for (const [step, file, key] of wizard) {
        await expect(page.locator(`#first-run [data-step="${step}"]`)).toBeVisible();
        await capture(page, file, false);
        await delay(SETTLE_MS);
        if (step === "key") await page.locator("#first-run-key").fill("sk-test-fixture");
        if (step === "guardian") await page.locator(".first-run-guardian + button").click();
        else if (key.length > 0) await page.keyboard.press(key);
      }
      await open("recovery");
      await expect(page.locator("#recovery-panel")).toBeVisible();
      await capture(page, "00-current-window");
    }
    await open("consent");
    await matrix(page, lang, "consent", "#consent-yes");
    if (korean) {
      await capture(page, "11-consent");
      await page.locator("#consent-panel summary").click();
      await expect(page.locator("#consent-text")).toBeVisible();
      await capture(page, "12-consent-details");
      await avatarShot("14a-avatar-consent", "#choices button:first-child");
    }
    await open("ready");
    await matrix(page, lang, "ready", "#welcome-panel");
    if (korean) {
      await capture(page, "13-conversation-home", false);
      await capture(page, "13a-workspace-full");
      await avatarShot("14-avatar", "#figure");
      await page.locator("#open-settings").click();
      await expect(page.locator("#setup-save")).toBeEnabled();
      await capture(page, "15-settings", false);
      await page.locator("#setup-cancel").click();
      for (const [selector, file] of [["#recording-title", "16-recording"], ["#workflow-title", "17-research-notes"]] as const) {
        await page.locator(selector).click();
        await expect(page.locator(selector).locator("..")).toHaveAttribute("open", "");
        await capture(page, file);
        await page.locator(selector).click();
      }
      await page.locator("#contrast-toggle").click();
      await capture(page, "18-high-contrast");
      await page.locator("#contrast-toggle").click();
    }
    await page.locator("#mic-btn").click();
    await matrix(page, lang, "listening", '#mic-btn[aria-pressed="true"]');
    await page.locator("#stop-all").click();
    await expect(page.locator("#st-state")).toHaveAttribute("data-state", "STOPPED");
    if (korean) await avatarShot("22-avatar-stopped", '#figure[data-sleeping="true"]');
    await open("ready");
    await send(input.answer);
    await matrix(page, lang, "working", "#send:disabled");
    if (releaseTurn === undefined) throw new Error("대기 중인 응답이 없습니다.");
    releaseTurn();
    await matrix(page, lang, "answer", "#answer-panel");
    if (korean) {
      await capture(page, "19a-conversation-answer", false);
      await page.locator(".answer-details summary").click();
      await expect(page.locator("#answer-text")).toBeVisible();
      await capture(page, "19-answer-source");
    }
    await send(input.approval);
    await matrix(page, lang, "approval", "#confirm-panel");
    if (korean) { await capture(page, "21-approval-details"); await avatarShot("21a-approval-avatar", '#choices button[data-key="approve"]'); }
    await open("ready");
    await send(input.auth);
    await matrix(page, lang, "login-handoff", "#auth-panel");
    if (korean) { await capture(page, "20-login-handoff"); await avatarShot("20a-login-avatar", '#choices button[data-key="auth-done"]'); }
    await open("ready");
    await send(input.error);
    await matrix(page, lang, "error", "#error");
    if (korean) {
      await page.locator("#session-end").click();
      await expect(page.locator("#session-new")).toBeVisible();
      await capture(page, "23-session-end");
    }
    console.log(lang, "화면 조합 96개");
  } finally {
    releaseTurn?.();
    await page.close();
    await avatar.close();
  }
}

if (import.meta.main) {
  await mkdir(out, { recursive: true });
  const ui = await startUi();
  try {
    const browser = await chromium.launch();
    try { for (const lang of LANGS) await walkthrough(browser, ui.url, lang); }
    finally { await browser.close(); }
  } finally { await ui.close(); }
}
