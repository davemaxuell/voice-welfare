import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { closeLaunchedBrowser, launchBrowser, PlaywrightExecutionAdapter } from "../../src/agents/web/browser/index.ts";

let browser: Browser;
beforeAll(async () => { browser = await launchBrowser(true); });
afterAll(() => closeLaunchedBrowser(browser));

it("같은 크롬에서 열린 순서대로 탭을 정리하고 작업·인증·새 탭을 보존한다", async () => {
  const context = await browser.newContext();
  let handoff: Page | undefined;
  const protectedTask = new PlaywrightExecutionAdapter({ context, readOnlyWeb: true, allowedOrigins: [],
    protectedTab: page => page === handoff });
  try {
    await protectedTask.start();
    const first = protectedTask.page!;
    handoff = await context.newPage();
    const old = await context.newPage();
    const others: Page[] = [];
    for (let n = 0; n < 9; n++) others.push(await context.newPage());
    await expect.poll(() => context.pages().length).toBe(10);
    expect(first.isClosed()).toBe(false);
    expect(handoff.isClosed()).toBe(false);
    expect(old.isClosed()).toBe(true);
    expect(others[0]!.isClosed()).toBe(true);
    expect(others.at(-1)!.isClosed()).toBe(false);
  } finally { await protectedTask.close(); await context.close(); }
});

it("한 작업이 팝업으로 이동해도 그 작업이 사용한 이전 탭을 작업 종료까지 보호한다", async () => {
  const context = await browser.newContext();
  const adapter = new PlaywrightExecutionAdapter({ context, readOnlyWeb: true, allowedOrigins: [] });
  try {
    await adapter.start();
    const original = adapter.page!;
    await adapter.withTask(async () => {
      const popup = original.waitForEvent("popup");
      await original.evaluate(() => { window.open("about:blank"); });
      const current = await popup;
      await expect.poll(() => adapter.page === current).toBe(true);
      for (let i = 0; i < 10; i++) await context.newPage();
      await expect.poll(() => context.pages().length).toBe(10);
      expect(original.isClosed()).toBe(false);
      expect(current.isClosed()).toBe(false);
    });
    await context.newPage();
    await expect.poll(() => original.isClosed()).toBe(true);
  } finally { await adapter.close(); await context.close(); }
});

it("인증 창에서 다시 연 본인 확인 팝업까지 인계가 끝날 때까지 보존한다", async () => {
  const context = await browser.newContext();
  let auth: Page | undefined;
  const adapter = new PlaywrightExecutionAdapter({ context, readOnlyWeb: true, allowedOrigins: [], protectedTab: page => page === auth });
  try {
    await adapter.start();
    auth = adapter.page!;
    const authPages = [auth];
    for (let i = 0; i < 2; i++) {
      const source = authPages.at(-1)!;
      const popup = source.waitForEvent("popup");
      await source.evaluate(() => { window.open("about:blank"); });
      authPages.push(await popup);
      await expect.poll(() => adapter.page === authPages.at(-1)).toBe(true);
    }
    for (let i = 0; i < 10; i++) await context.newPage();
    await expect.poll(() => context.pages().length).toBe(10);
    expect(authPages.every(page => !page.isClosed())).toBe(true);
    auth = undefined;
    await context.newPage();
    await expect.poll(() => authPages[0]!.isClosed()).toBe(true);
  } finally { await adapter.close(); await context.close(); }
});

it.runIf(process.env.HEADED === "1")("탭과 주소창이 있는 일반 크롬 창을 최대화한다", async () => {
  const visible = await launchBrowser(false);
  const adapter = new PlaywrightExecutionAdapter({ browser: visible, allowedOrigins: [], readOnlyWeb: true });
  try {
    await adapter.start();
    const page = adapter.page!;
    const cdp = await page.context().newCDPSession(page);
    expect((await cdp.send("Browser.getWindowForTarget")).bounds.windowState).toBe("maximized");
    expect(page.viewportSize()).toBeNull();
    const context = page.context();
    const watched = await context.newPage();
    const old = await context.newPage();
    for (let i = 0; i < 7; i++) await context.newPage();
    await watched.bringToFront();
    await expect.poll(() => watched.evaluate(() => document.hasFocus())).toBe(true);
    // 사용자가 보고 있는 탭에 초점을 둔 채 새 탭을 뒤에서 연다.
    const browserSession = await visible.newBrowserCDPSession();
    const {targetInfo} = await cdp.send("Target.getTargetInfo");
    const retainFocus = context.waitForEvent("page");
    await browserSession.send("Target.createTarget", {url: "about:blank", background: true, browserContextId: targetInfo.browserContextId});
    await retainFocus;
    await expect.poll(() => context.pages().length).toBe(10);
    expect(old.isClosed()).toBe(true);
    expect(watched.isClosed()).toBe(false);
  } finally { await adapter.close(); await closeLaunchedBrowser(visible); }
});
