import { chromium, expect as visible, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startUi } from "./web-ui-fixtures.ts";
import { latch } from "./browser-cases.ts";
import { nativeTabFocus } from "../../src/agents/web/browser/windows.ts";
import { openControllerWindow } from "../../src/server/controller_window.ts";

let browser: Browser;
let ui: Awaited<ReturnType<typeof startUi>>;
beforeAll(async () => { ui = await startUi(); browser = await chromium.launch(); }, 90_000);
afterAll(async () => { await browser?.close(); await ui?.close(); });

it("두 브라우저 프로필에서도 한 대화만 열고 주 창을 닫으면 다음 창이 이어받는다", async () => {
  const first = await browser.newPage();
  const second = await browser.newPage();
  await Promise.all([first, second].map(page => page.addInitScript(() => {
    Object.defineProperty(navigator, "locks", {value: undefined});
  })));
  let sessions = 0;
  const count = (page: Page) => page.on("request", req => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/session") sessions++;
  });
  count(first); count(second);
  try {
    const ready = (page: Page) => visible(page.locator("#consent-hear")).toBeEnabled();
    await first.goto(ui.url);
    await ready(first);
    await second.goto(ui.url);
    await visible(second.getByRole("heading", {name: "청음 대화가 다른 창에 열려 있어요."})).toBeVisible();
    await second.getByRole("button", {name: "대화 창으로 이동"}).press("Enter");
    expect(sessions).toBe(1);
    await first.close();
    await ready(second);
    expect(sessions).toBe(2);
  } finally { await first.close(); await second.close(); await ui.reset(); }
});

it("작업 중에는 단계 표시의 세 점만 움직이고 동작 줄이기에서는 멈춘다", async () => {
  const page = await browser.newPage();
  const release = latch();
  try {
    await page.goto(ui.url);
    await page.locator("#consent-hear").click();
    await page.getByRole("button", {name: "동의하고 시작 (Enter)"}).click();
    await page.route("**/api/turn", async route => { await release.promise; await route.continue(); });
    const command = page.getByLabel("명령 입력 (말하듯이 입력하세요)");
    await command.fill("지금까지의 내용을 들려주세요");
    await command.press("Enter");
    await visible(page.getByRole("status").filter({hasText: "생각 중"})).toHaveCount(0);
    await visible(page.locator("#phase")).toHaveClass(/phase-thinking/);
    const dots = page.locator("#phase .phase-eq i");
    await visible(dots).toHaveCount(3);
    const frames = await dots.first().evaluate(dot => dot.getAnimations().flatMap(a =>
      a.effect instanceof KeyframeEffect ? a.effect.getKeyframes() : []));
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every(frame => Object.keys(frame).every(key =>
      ["offset", "computedOffset", "easing", "composite", "opacity", "transform"].includes(key)))).toBe(true);
    await page.emulateMedia({reducedMotion: "reduce"});
    await expect.poll(() => dots.first().evaluate(dot => dot.getAnimations().length)).toBe(0);
    await visible(page.getByRole("status").filter({hasText: "생각 중"})).toHaveCount(0);
    const settled = page.waitForResponse(response => new URL(response.url()).pathname === "/api/turn");
    release.resolve();
    await (await settled).finished();
    await visible(page.locator("#phase")).not.toHaveClass(/phase-thinking/);
  } finally { release.resolve(); await page.unrouteAll({behavior: "wait"}); await page.close(); await ui.reset(); }
});

it.runIf(process.env.HEADED === "1")("브라우저에서 대화 창으로 이동을 누르면 기존 탭이 실제로 앞에 나타난다", async () => {
  const headed = await chromium.launch({headless: false});
  try {
    const primary = await openControllerWindow(headed, ui.url);
    await nativeTabFocus(primary);
    await visible(primary.locator("#consent-hear")).toBeEnabled();
    const other = await primary.context().newPage();
    await other.goto(ui.url);
    await nativeTabFocus(other);
    await other.bringToFront();
    await expect.poll(() => primary.evaluate(() => document.hasFocus())).toBe(false);
    await other.getByRole("button", {name:"대화 창으로 이동"}).click();
    await expect.poll(() => Promise.all([primary, other].map(page => page.evaluate(() => document.hasFocus())))).toEqual([true, false]);
  } finally { await headed.close(); await ui.reset(); }
});
