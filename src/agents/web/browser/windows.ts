import type { Browser, BrowserContext, Page } from "playwright";

const MAX_TABS = 10;
const headed = new WeakSet<Browser>();
const windows = new WeakMap<Browser, Set<number>>();
const managers = new WeakMap<Browser | BrowserContext, BrowserTabs>();

/** 탭이 닫힐 때까지 CDP 연결을 유지한다. 먼저 끊으면 Playwright의 모의 초점이 돌아온다. */
export async function nativeTabFocus(page: Page, focused?: (windowId: number) => void) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", {enabled: false});
  const {windowId} = await cdp.send("Browser.getWindowForTarget");
  if (focused !== undefined) {
    const world = "cheongeum-window-focus";
    const name = "cheongeumWindowFocused";
    cdp.on("Runtime.bindingCalled", event => { if (event.name === name) focused(windowId); });
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Runtime.addBinding", {name, executionContextName: world});
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {worldName: world, runImmediately: true, source: `
      if (window === window.top) {
        const report = () => { if (document.hasFocus()) globalThis.cheongeumWindowFocused(""); };
        window.addEventListener("focus", e => { if (e.isTrusted) report(); }, true);
        report();
      }`});
    if (await page.evaluate(() => document.hasFocus())) focused(windowId);
  }
  return windowId;
}

export function markHeaded(resource: Browser | BrowserContext) {
  const browser = "contexts" in resource ? resource : resource.browser();
  if (browser) headed.add(browser);
}

export const isHeaded = (browser: Browser | null | undefined) => browser != null && headed.has(browser);

export async function maximizeWindow(page: Page) {
  const browser = page.context().browser();
  if (!browser || !isHeaded(browser)) return;
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    const seen = windows.get(browser) ?? new Set<number>();
    if (seen.has(windowId)) return;
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } });
    seen.add(windowId);
    windows.set(browser, seen);
  } finally { await cdp.detach(); }
}

/** 한 Chromium의 컨텍스트들이 생성 순서와 보호 중인 탭을 함께 관리한다. */
class BrowserTabs {
  readonly pages = new Set<Page>();
  readonly contexts = new WeakSet<BrowserContext>();
  readonly pins = new Set<(page: Page) => boolean>();
  readonly focus = new WeakMap<Page, Promise<number | undefined>>();
  readonly active = new Map<number, Page>();
  private pending = Promise.resolve();

  watch(context: BrowserContext) {
    if (this.contexts.has(context)) return;
    this.contexts.add(context);
    const add = (page: Page) => {
      this.pages.add(page);
      if (isHeaded(context.browser())) this.focus.set(page, nativeTabFocus(page, id => {
        if (this.active.get(id) === page) return;
        this.active.set(id, page);
        this.changed();
      }).catch(() => undefined));
      page.once("close", () => {
        this.pages.delete(page);
        for (const [id, active] of this.active) if (active === page) this.active.delete(id);
      });
      this.changed();
    };
    for (const page of context.pages()) add(page);
    context.on("page", add);
  }

  changed() {
    if (this.pages.size > MAX_TABS) this.pending = this.pending.then(() => this.trim()).catch(() => {});
  }

  private protected(page: Page) {
    for (const pin of this.pins) if (pin(page)) return true;
    return false;
  }

  private async trim() {
    const pages = [...this.pages];
    // 새 탭이 열리는 순간부터 팝업 소유자와 화면 초점이 정해질 때까지 그 탭도 보호한다.
    for (const page of pages.slice(0, -1)) {
      if (this.pages.size <= MAX_TABS) break;
      if (page.isClosed() || this.protected(page)) continue;
      const native = this.focus.get(page);
      if (native !== undefined) {
        const id = await native;
        if (id === undefined || !this.active.has(id) || this.active.get(id) === page ||
            await page.evaluate(() => document.hasFocus()).catch(() => true)) continue;
      }
      if (!this.protected(page)) await page.close().catch(() => {});
    }
  }
}

export function trackTabs(context: BrowserContext, pin: (page: Page) => boolean) {
  const host = context.browser() ?? context;
  const tabs = managers.get(host) ?? new BrowserTabs();
  managers.set(host, tabs);
  tabs.pins.add(pin);
  tabs.watch(context);
  return {
    changed: () => tabs.changed(),
    release() { tabs.pins.delete(pin); tabs.changed(); },
  };
}
