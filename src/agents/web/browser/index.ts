import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type BrowserContext, type Download, type Locator, type Page, type Route } from "playwright";
import { z } from "zod";
import { parseObservation, type Action, type ActionResult, type ActionTarget, type ExecutionErrorCode } from "../../../core/actions.ts";
import { browserAsset } from "../../../core/assets.ts";
import { raceAbort } from "../../../core/abort.ts";
import { parseUrl, tryUrl } from "../../../core/url.ts";
import { strip } from "../../../core/text.ts";
import { WebObservationSchema } from "../view.ts";
import type { Download as DownloadRecord, DownloadStore } from "../downloads.ts";

const asset = (name: string) => readFileSync(browserAsset(name), "utf8");
const observeScript = asset("observe.js"), restCursorScript = asset("rest_cursor.js");
const cursorTemplate = asset("cursor.js"), waitingHtml = asset("waiting.html");
export const browserPatterns = { attributeQuotes: /["\\]/gu, spaces: /\p{White_Space}+/gu };
const cssEscape = (value: string) => value.replace(browserPatterns.attributeQuotes, ch => "\\" + ch);

export function cursorScript(x: number, y: number, ripple: boolean): string {
  return cursorTemplate.replaceAll("__X__", String(x)).replaceAll("__Y__", String(y)).replaceAll("__RIPPLE__", String(ripple));
}

export class AdapterError extends Error {
  readonly code: ExecutionErrorCode;
  constructor(code: ExecutionErrorCode, message: string = code) { super(message); this.code = code; }
}

const owned = new Set<Browser | BrowserContext>();
const launching = new Set<Promise<Browser | BrowserContext>>();
let stopping: Promise<void> | undefined;

async function launch<T extends Browser | BrowserContext>(start: () => Promise<T>): Promise<T> {
  if (stopping !== undefined) await stopping;
  const pending = start();
  launching.add(pending);
  try {
    const resource = await pending;
    owned.add(resource);
    if ("contexts" in resource) resource.once("disconnected", () => owned.delete(resource));
    else resource.once("close", () => owned.delete(resource));
    return resource;
  } finally { launching.delete(pending); }
}

export function launchBrowser(headless: boolean, slowMoMs = 0): Promise<Browser> {
  return launch(() => chromium.launch({ headless, slowMo: slowMoMs }));
}
export function launchChromeProfile(userDataDir: string, slowMoMs = 0): Promise<BrowserContext> {
  return launch(() => chromium.launchPersistentContext(userDataDir, {
    channel: "chrome", headless: false, viewport: null, locale: "ko-KR", slowMo: slowMoMs, acceptDownloads: true,
  }));
}
export function stopPlaywright(): Promise<void> {
  return stopping ??= (async () => {
    await Promise.allSettled(launching);
    await Promise.all([...owned].map(resource => resource.close()));
  })().finally(() => { stopping = undefined; });
}

type DownloadSink = Pick<DownloadStore, "folder" | "remember">;
type Options = ({ browser: Browser; context?: never } | { context: BrowserContext; browser?: never }) & {
  allowedOrigins: readonly string[]; readOnlyWeb?: boolean; visualCursor?: boolean;
  actionTimeoutMs?: number; navigationTimeoutMs?: number; downloads?: DownloadSink;
};
type Completed = Pick<ActionResult, "ok" | "verified" | "readValue">;
const ok = { ok: true, verified: true };
const prepared = new WeakMap<BrowserContext, Promise<void>>();
const claimed = new WeakSet<Page>();
const closingTabs = new WeakMap<BrowserContext, Promise<void>>();
const historyGuards = new WeakMap<Page, string[]>();

// The map limits non-GET blocking to history traversal on this page. Keeping the
// route installed means that aborting a turn never requires another page command.
function prepare(context: BrowserContext, options: Options): Promise<void> {
  const previous = prepared.get(context);
  if (previous !== undefined) return previous;
  const pending = context.route("**/*", async (route: Route) => {
    try {
      const req = route.request(), url = req.url();
      if (req.isNavigationRequest() && req.method() !== "GET") {
        // A popup's first navigation can start before it has a Frame.
        let blocked: string[] | undefined;
        try { blocked = historyGuards.get(req.frame().page()); } catch { /* no history yet */ }
        if (blocked !== undefined) {
          blocked.push(url);
          await route.abort("blockedbyclient");
          return;
        }
      }
      const parsed = tryUrl(url);
      const allowed = url.startsWith("data:") || url.startsWith("blob:") || (parsed !== undefined &&
        (options.allowedOrigins.includes(parsed.origin) || (options.readOnlyWeb === true && ["http:", "https:"].includes(parsed.protocol))));
      if (allowed) await route.continue();
      else await route.abort("blockedbyclient");
    } catch { /* The page can close during a routed request. */ }
  }).then(() => {}, error => { prepared.delete(context); throw error; });
  prepared.set(context, pending);
  return pending;
}

function call<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return work().then(value => { signal.throwIfAborted(); return value; });
}
async function optional<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T | undefined> {
  try { return await call(signal, work); }
  catch { signal.throwIfAborted(); return undefined; }
}
async function guardedHistory<T>(page: Page, run: (blocked: string[]) => Promise<T>): Promise<T> {
  const blocked: string[] = [];
  historyGuards.set(page, blocked);
  try { return await run(blocked); }
  finally { historyGuards.delete(page); }
}
async function errorPageSettled(page: Page, signal: AbortSignal): Promise<void> {
  await optional(signal, () => page.waitForURL(url => url.href.startsWith("chrome-error://"), { waitUntil: "commit", timeout: 3000, signal }));
}
async function stepAndSettle(page: Page, signal: AbortSignal, step: () => Promise<unknown>): Promise<void> {
  await Promise.all([
    optional(signal, () => page.waitForEvent("framenavigated", { predicate: frame => frame === page.mainFrame(), timeout: 3000, signal })),
    optional(signal, step),
  ]);
}

export class PlaywrightExecutionAdapter {
  readonly platform = "pc";
  readonly #options: Options;
  readonly #actionTimeout: number;
  readonly #navigationTimeout: number;
  context?: BrowserContext;
  page?: Page;
  downloads?: DownloadSink;
  #lastDownload?: DownloadRecord;
  #nativeDialogs: string[] = [];
  #docMethods = new WeakMap<Page, string>();
  #myPages = new Set<Page>();
  #onPage?: (page: Page) => void;
  #lifecycle = Promise.resolve();

  constructor(options: Options) {
    this.#options = options;
    this.#actionTimeout = options.actionTimeoutMs ?? 5000;
    this.#navigationTimeout = options.navigationTimeoutMs ?? 10_000;
    this.downloads = options.downloads;
  }

  start(): Promise<void> { return this.#schedule(() => this.#start()); }
  close(): Promise<void> { return this.#schedule(() => this.#close()); }
  #schedule(work: () => Promise<void>): Promise<void> {
    const next = this.#lifecycle.then(work);
    this.#lifecycle = next.catch(() => {});
    return next;
  }

  async #start(): Promise<void> {
    if (this.context !== undefined) return;
    const opts = this.#options;
    const ctx = opts.context ?? await opts.browser.newContext({ locale: "ko-KR", viewport: { width: 1100, height: 860 }, acceptDownloads: true });
    this.context = ctx;
    try {
      await prepare(ctx, opts);
      this.#onPage = page => {
        void page.opener().then(opener => {
          if (this.context === ctx && opener !== null && opener === this.page) this.#attach(page);
        }).catch(() => {});
      };
      ctx.on("page", this.#onPage);
      const page = await withSharedTabs(ctx, async () => {
        const blank = ctx.pages().find(page => !claimed.has(page) && page.url() === "about:blank");
        const selected = blank ?? await ctx.newPage();
        this.#attach(selected);
        return selected;
      });
      await page.setContent(waitingHtml).catch(() => {});
    } catch (error) { await this.#close(); throw error; }
  }

  #attach(page: Page): void {
    this.page = page;
    claimed.add(page);
    this.#myPages.add(page);
    page.on("request", request => {
      if (!request.isNavigationRequest()) return;
      try {
        if (request.frame() === page.mainFrame()) this.#docMethods.set(page, request.method());
      } catch { /* A popup navigation can arrive before its frame. */ }
    });
    page.on("dialog", dialog => {
      this.#nativeDialogs.push(Array.from(dialog.message()).slice(0, 200).join(""));
      void dialog.dismiss().catch(() => {});
    });
    page.on("close", () => {
      this.#myPages.delete(page);
      if (this.page === page) this.page = [...this.#myPages].at(-1);
    });
    page.on("download", download => { void this.#saveDownload(download).catch(() => {}); });
  }

  async #saveDownload(download: Download): Promise<void> {
    const now = Date.now() / 1000;
    const name = basename(download.suggestedFilename().replaceAll("\\", "/"));
    const suggested = name.length > 0 ? name : "download-" + Math.trunc(now);
    const store = this.downloads;
    if (store?.folder !== undefined && store.folder !== "") {
      const dest = join(store.folder, suggested);
      await download.saveAs(dest);
      this.#lastDownload = store.remember(dest, suggested);
    } else {
      const path = await download.path();
      this.#lastDownload = store !== undefined && path !== null ? store.remember(path, suggested)
        : { name: suggested, path: path ?? "", at: now };
    }
  }
  takeDownloadNotice(): string | undefined {
    const rec = this.#lastDownload;
    this.#lastDownload = undefined;
    return rec === undefined ? undefined : "'" + rec.name + "' 파일을 받았어요. 읽어 드리려면 '받은 파일 읽어줘'라고 하세요.";
  }
  #requirePage(): Page {
    if (this.page === undefined) throw new AdapterError("NOT_SUPPORTED", "어댑터가 시작되지 않았습니다.");
    return this.page;
  }

  async bringToFront(signal = new AbortController().signal): Promise<void> {
    const page = this.page;
    if (page !== undefined) await optional(signal, () => page.bringToFront());
  }

  async observe(signal = new AbortController().signal) {
    const page = this.#requirePage();
    const raw = z.looseObject({ errors: z.array(z.string()).optional() }).parse(await call(signal, () => page.evaluate(observeScript)));
    signal.throwIfAborted();
    const errors = [...raw.errors ?? [], ...this.#nativeDialogs.splice(0).map(msg => "브라우저 경고창: " + msg)];
    return parseObservation({ ...raw, errors, platform: "pc", url: page.url(), capturedAt: new Date().toISOString() });
  }

  async execute(action: Action, signal = new AbortController().signal): Promise<ActionResult> {
    const started = performance.now();
    const done = (result: Omit<ActionResult, "actionId" | "latencyMs">) => ({
      actionId: action.id, latencyMs: Math.trunc(performance.now() - started), ...result,
    });
    if (signal.aborted) return done({ ok: false, verified: false, errorCode: "ABORTED" });
    try {
      const result = await raceAbort(async active => {
        const result = await this.#perform(this.#requirePage(), action, active);
        if (this.#options.visualCursor === true && result.ok && action.type !== "read") await this.#restCursor(active);
        return result;
      }, signal);
      return done(result);
    } catch (error) {
      if (signal.aborted) return done({ ok: false, verified: false, errorCode: "ABORTED", message: "ABORTED" });
      if (error instanceof AdapterError) return done({ ok: false, verified: false, errorCode: error.code, message: error.message });
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.message.includes("Timeout"));
      return done({ ok: false, verified: false, errorCode: timedOut ? "TIMEOUT" : action.type === "navigate" ? "NAVIGATION_FAILED" : "UNKNOWN" });
    }
  }

  async #open(page: Page, url: string, signal: AbortSignal): Promise<void> {
    const opts = { timeout: this.#navigationTimeout, signal };
    await call(signal, () => page.goto(url, { ...opts, waitUntil: "commit" }));
    await optional(signal, () => page.waitForLoadState("domcontentloaded", opts));
  }

  async #returnTo(page: Page, previous: string, failed: string, wasForm: boolean, signal: AbortSignal): Promise<void> {
    await optional(signal, async () => {
      await errorPageSettled(page, signal);
      if (!/^https?:\/\//u.test(previous)) {
        await call(signal, () => page.goto("about:blank", { signal }));
        return;
      }
      if (!wasForm && previous.replace(/\/+$/u, "") !== failed.replace(/\/+$/u, "")) {
        const restored = await guardedHistory(page, async blocked => {
          await stepAndSettle(page, signal, () => page.goBack({ waitUntil: "commit", timeout: this.#navigationTimeout, signal }));
          return blocked.length === 0 && page.url() === previous;
        });
        if (restored) {
          await optional(signal, () => page.waitForLoadState("domcontentloaded", { timeout: this.#navigationTimeout, signal }));
          return;
        }
      }
      try { await this.#open(page, previous, signal); }
      catch (error) {
        if (String(error).includes("net::ERR_")) await call(signal, () => page.goto("about:blank", { signal }));
      }
    });
  }

  async #back(page: Page, signal: AbortSignal): Promise<Completed> {
    const here = page.url();
    return guardedHistory(page, async blocked => {
      let verified = false;
      try {
        verified = await call(signal, () => page.goBack({ waitUntil: "domcontentloaded", timeout: this.#navigationTimeout, signal })) !== null;
      } catch (error) {
        signal.throwIfAborted();
        if (blocked.length === 0) throw error;
      }
      if (blocked.length > 0) {
        await errorPageSettled(page, signal);
        await stepAndSettle(page, signal, () => page.goForward({ waitUntil: "commit", timeout: this.#navigationTimeout, signal }));
        if (page.url() !== here) await optional(signal, () => this.#open(page, here, signal));
        throw new AdapterError("RESUBMIT_BLOCKED");
      }
      return { ok: true, verified };
    });
  }

  async #perform(page: Page, action: Action, signal: AbortSignal): Promise<Completed> {
    signal.throwIfAborted();
    const { type, target } = action;
    const opts = { timeout: this.#actionTimeout, signal };
    if (type === "navigate") {
      const url = action.url;
      if (url === undefined || url === "") throw new AdapterError("NAVIGATION_FAILED");
      const prev = page.url(), wasForm = (this.#docMethods.get(page) ?? "GET") !== "GET";
      try { await this.#open(page, url, signal); }
      catch (error) {
        signal.throwIfAborted();
        if (String(error).includes("net::ERR_") && !String(error).includes("ERR_ABORTED")) {
          await this.#returnTo(page, prev, url, wasForm, signal);
        }
        throw error;
      }
      const origin = parseUrl(url).origin;
      if (!this.#options.allowedOrigins.includes(origin)) {
        await optional(signal, () => page.waitForLoadState("networkidle", { timeout: 3000, signal }));
      }
      return { ok: true, verified: parseUrl(page.url()).origin === origin };
    }
    if (type === "back") return this.#back(page, signal);
    if (type === "scroll") {
      if (target === undefined) await call(signal, () => page.mouse.wheel(0, 600));
      else {
        const loc = await this.#resolve(page, target, signal);
        await call(signal, () => loc.scrollIntoViewIfNeeded({ signal }));
      }
      return ok;
    }
    if (type === "click" && target?.ref === undefined && target?.role === "link" && target.name !== undefined) {
      if (await this.#linkFallback(page, target.name, signal)) return ok;
    }
    let loc = await this.#resolve(page, target, signal);
    if (this.#options.visualCursor === true && type !== "read") {
      await this.#showCursor(page, loc, ["click", "check", "press"].includes(type), signal);
    }
    if (target?.ref !== undefined && type !== "read" && (this.#options.visualCursor === true || type === "click")) {
      // Waiting for actionability can outlast the identity check. A relabelled
      // button must be rejected before the real click, including after cursor motion.
      if (type === "click") await call(signal, () => loc.click({ ...opts, trial: true }));
      loc = await this.#resolveRef(page, target, signal);
    }
    switch (type) {
      case "click":
        await call(signal, () => loc.click(opts));
        return ok;
      case "focus":
        await call(signal, () => loc.focus(opts));
        return ok;
      case "press":
        await call(signal, () => loc.press(action.value === undefined || action.value === "" ? "Enter" : action.value, opts));
        await optional(signal, () => page.waitForLoadState("domcontentloaded", opts));
        return ok;
      case "fill": {
        if (await call(signal, () => loc.getAttribute("type", { signal })) === "password") {
          throw new AdapterError("NOT_SUPPORTED", "비밀번호 입력란은 조작하지 않습니다.");
        }
        const value = action.value ?? "";
        await call(signal, () => loc.fill(value, opts));
        const readValue = await call(signal, () => loc.inputValue(opts));
        return { ok: true, verified: readValue === value, readValue };
      }
      case "select": {
        await call(signal, () => loc.selectOption({ label: action.value ?? "" }, opts));
        const readValue = strip(await call(signal, () => loc.locator("option:checked").textContent(opts)) ?? "");
        return { ok: true, verified: readValue === action.value, readValue };
      }
      case "check": {
        const want = action.checked ?? false;
        await call(signal, () => loc.setChecked(want, opts));
        const checked = await call(signal, () => loc.isChecked(opts));
        return { ok: true, verified: checked === want, readValue: checked ? "예" : "아니오" };
      }
      case "read": {
        const inputType = await call(signal, () => loc.getAttribute("type", { signal }));
        if (inputType === "password") return { ...ok, readValue: "" };
        if (inputType === "checkbox") return { ...ok, readValue: await call(signal, () => loc.isChecked(opts)) ? "예" : "아니오" };
        const hasOptions = await call(signal, () => loc.locator("option").count()) > 0;
        const value = await call(signal, () => loc.inputValue(opts));
        const readValue = hasOptions && value.length > 0
          ? strip(await call(signal, () => loc.locator("option:checked").textContent(opts)) ?? "") : value;
        return { ...ok, readValue };
      }
    }
  }

  async #linkFallback(page: Page, name: string, signal: AbortSignal): Promise<boolean> {
    const byRole = page.getByRole("link", { name, exact: true }).filter({ visible: true });
    if (await call(signal, () => byRole.count()) > 0) return false;
    const normalize = (s: string) => s.replace(browserPatterns.spaces, "");
    const want = normalize(name), anchors = page.locator("a[href]");
    const count = Math.min(await call(signal, () => anchors.count()), 400);
    let hidden: string | null | undefined;
    for (let i = 0; i < count; i++) {
      const a = anchors.nth(i);
      const text = normalize(await optional(signal, () => a.textContent({ signal })) ?? "");
      if (text !== want) continue;
      if (await optional(signal, () => a.isVisible()) === true) {
        if (this.#options.visualCursor === true) await this.#showCursor(page, a, true, signal);
        await call(signal, () => a.click({ signal, timeout: this.#actionTimeout }));
        return true;
      }
      if (hidden == null) hidden = await optional(signal, () => a.getAttribute("href", { signal }));
    }
    if (hidden == null || hidden === "") return false;
    let url;
    try { url = parseUrl(hidden, page.url()); } catch { return false; }
    if (!["http:", "https:"].includes(url.protocol)) return false;
    await call(signal, () => page.goto(url.href, { waitUntil: "domcontentloaded", timeout: this.#navigationTimeout, signal }));
    return true;
  }

  async #resolve(page: Page, target: ActionTarget | undefined, signal: AbortSignal): Promise<Locator> {
    signal.throwIfAborted();
    if (target === undefined) throw new AdapterError("TARGET_NOT_FOUND");
    if (target.ref !== undefined) return this.#resolveRef(page, target, signal);
    let loc: Locator;
    if (target.label !== undefined) loc = page.getByLabel(target.label, { exact: true });
    else if (target.role !== undefined && target.name !== undefined) {
      // Playwright parses this standard role selector at the browser boundary.
      // Only letters enter the selector's role position; serialize the exact name.
      if (!/^[a-z]+$/u.test(target.role)) throw new AdapterError("TARGET_NOT_FOUND");
      loc = page.locator("role=" + target.role + "[name=" + JSON.stringify(target.name) + "s]");
    } else if (target.testId !== undefined) loc = page.getByTestId(target.testId);
    else if (target.fieldId !== undefined) {
      const id = cssEscape(target.fieldId);
      loc = page.locator('[id="' + id + '"], [data-cheongeum-id="' + id + '"]');
    } else throw new AdapterError("TARGET_NOT_FOUND");
    loc = loc.filter({ visible: true });
    if (target.nth !== undefined) {
      const nth = loc.nth(target.nth);
      if (await call(signal, () => nth.count()) === 0) throw new AdapterError("TARGET_NOT_FOUND");
      return nth;
    }
    let count = await call(signal, () => loc.count());
    if (count === 0) {
      await optional(signal, () => loc.first().waitFor({ state: "visible", timeout: 2000, signal }));
      count = await call(signal, () => loc.count());
    }
    if (count === 0) throw new AdapterError("TARGET_NOT_FOUND");
    if (count > 1) throw new AdapterError("AMBIGUOUS_TARGET");
    return loc;
  }

  async #resolveRef(page: Page, target: ActionTarget, signal: AbortSignal): Promise<Locator> {
    const raw = WebObservationSchema.parse(await call(signal, () => page.evaluate(observeScript)));
    const item = raw.outline?.items?.find(it => it.ref === target.ref);
    if (item === undefined) throw new AdapterError("TARGET_NOT_FOUND");
    if (item.role !== target.role || item.name !== target.name) {
      throw new AdapterError("VERIFY_FAILED", "누르려던 요소의 이름이나 역할이 바뀌었습니다.");
    }
    const loc = page.locator('[data-cheongeum-ref="' + cssEscape(target.ref!) + '"]').filter({ visible: true });
    if (await call(signal, () => loc.count()) !== 1) throw new AdapterError("AMBIGUOUS_TARGET");
    return loc;
  }

  async #restCursor(signal: AbortSignal): Promise<void> {
    const page = this.#requirePage();
    await optional(signal, () => page.waitForLoadState("domcontentloaded", { timeout: 3000, signal }));
    const spot = z.object({ x: z.number(), y: z.number() }).safeParse(await optional(signal, () => page.evaluate(restCursorScript)));
    if (spot.success) await optional(signal, () => page.evaluate(cursorScript(spot.data.x, spot.data.y, false)));
  }

  async #showCursor(page: Page, loc: Locator, ripple: boolean, signal: AbortSignal): Promise<void> {
    await optional(signal, () => loc.scrollIntoViewIfNeeded({ timeout: 2000, signal }));
    const box = await optional(signal, () => loc.boundingBox({ signal }));
    if (box == null) return;
    const evenRound = (value: number) => value % 2 === 0.5 ? Math.floor(value) : Math.round(value);
    const x = evenRound(box.x + box.width / 2), y = evenRound(box.y + box.height / 2);
    await optional(signal, () => page.evaluate(cursorScript(x, y, ripple)));
    await delay(ripple ? 650 : 450, undefined, { signal });
  }

  async clearSiteLogin({ currentOnly = true }: { currentOnly?: boolean } = {}, signal = new AbortController().signal): Promise<string[]> {
    const context = this.context, page = this.page;
    if (context === undefined) return [];
    const cookies = await call(signal, () => context.cookies());
    const host = page === undefined ? "" : tryUrl(page.url())?.hostname ?? "";
    if (currentOnly && host.length === 0) return [];
    const hosts = new Set<string>();
    for (const cookie of cookies) {
      const domain = cookie.domain.replace(/^\.+/u, "");
      if (currentOnly && host !== domain.toLowerCase() && !host.endsWith("." + domain.toLowerCase()) && !domain.toLowerCase().endsWith("." + host)) continue;
      if (domain.length > 0) hosts.add(domain);
      await optional(signal, () => context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path.length > 0 ? cookie.path : "/" }));
    }
    if (page !== undefined) await optional(signal, () => page.evaluate(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch { /* storage may be unavailable */ }
    }));
    return [...hosts];
  }

  async #close(): Promise<void> {
    const ctx = this.context;
    if (ctx === undefined) return;
    this.context = undefined;
    if (this.#onPage !== undefined) ctx.off("page", this.#onPage);
    try {
      if (this.#options.context === undefined) await ctx.close();
      else {
        const page = this.page;
        if (page !== undefined) await withSharedTabs(ctx, async () => {
          if (ctx.pages().every(other => other === page)) await ctx.newPage();
          await page.close();
        });
      }
    } catch { /* A user can close the Chrome window first. */ }
    this.#myPages.clear();
    this.page = undefined;
  }
}

function withSharedTabs<T>(ctx: BrowserContext, operation: () => Promise<T>): Promise<T> {
  const previous = closingTabs.get(ctx) ?? Promise.resolve();
  const result = previous.then(operation);
  closingTabs.set(ctx, result.then(() => {}, () => {}));
  return result;
}
