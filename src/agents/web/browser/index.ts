import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, errors, type Browser, type BrowserContext, type Download, type Locator, type Page, type Request, type Route } from "playwright";
import { z } from "zod";
import { parseObservation, type Action, type ActionResult, type ActionTarget, type ExecutionErrorCode } from "../../../core/actions.ts";
import { browserAsset } from "../../../core/assets.ts";
import { raceAbort } from "../../../core/abort.ts";
import { MaskReport, Picture, pngSize } from "../../../core/picture.ts";
import { parseUrl, tryUrl } from "../../../core/url.ts";
import { strip } from "../../../core/text.ts";
import { isInspectionUrl, type InspectionBinding } from "../../../safety/guard.ts";
import { loadsBokjiroSearchResults } from "../playbook.ts";
import { REFUSAL_SPEECH, ShotRefusal, judgeMarks, planShot, type ShotPlan } from "../shot.ts";
import type { Download as DownloadRecord, DownloadStore } from "../downloads.ts";

import { markBlocks } from "./blocks.ts";
import { drawCursor, type CursorMode } from "./cursor.ts";
import { fullPageLayout } from "./full_page.ts";
import { observePage, type ControlQuery } from "./observe.ts";
import { restingCursor } from "./rest_cursor.ts";

const waitingHtml = readFileSync(browserAsset("waiting.html"), "utf8");
// Native Node erases the types on import. Bundled Electron uses these same self-contained function bodies.
const observeFunction = observePage.toString();
const blocksFunction = markBlocks.toString();
const fullPageFunction = fullPageLayout.toString();
// 일부 포털은 브라우저 드라이버가 객체를 돌려받을 때 쓰는 내장 함수를 바꿔 둔다. 관찰은 글(JSON)로 받는다.
const observeJson = `JSON.stringify((${observeFunction})())`;
const controlsJson = (query: ControlQuery) => `JSON.stringify((${observeFunction})(${JSON.stringify(query)}))`;
// Node의 page.evaluate는 함수 글을 부르지 않으므로 인자를 JSON으로 넣어 부르는 식으로 보낸다.
const callScript = (script: string, arg: unknown) => `(${script})(${JSON.stringify(arg)})`;
// 사진을 찍는 동안만 글 조각에 붙였다 떼는 표시
const SHOT_ATTR = "data-cheongeum-shot";
export const browserPatterns = { attributeQuotes: /["\\]/gu, spaces: /\p{White_Space}+/gu };
const cssEscape = (value: string) => value.replace(browserPatterns.attributeQuotes, ch => "\\" + ch);

export type { CursorMode };
// 초점만 옮기는 동작은 누르라는 말(승인)이나 사용자의 입력을 기다리는 때이고, 나머지는 움직여 가거나 누르는 때다
const CURSOR_MODE: Partial<Record<Action["type"], CursorMode>> = { focus: "wait", click: "click", check: "click", press: "click" };

/**
 * 시연용 가상 커서: 마우스 화살표가 대상 위치로 미끄러져 가고, 누를 때 눌리며 물결이 퍼지고, 기다릴 때 갸웃거리며 말풍선 점이 뛴다.
 * 페이지 DOM은 건드리지 않는 오버레이다.
 */
export function cursorScript(x: number, y: number, mode: CursorMode): string {
  return callScript(drawCursor.toString(), { x, y, mode });
}

// Chromium이 압축 안 된 그림을 만들기 전에 크기를 묶는다(32M CSS 픽셀 ≈ 128 MB).
const MAX_SHOT_PIXELS = 32_000_000;
const MAX_SHOT_SIDE = 32_767;
const MAX_SHOT_BYTES = 20_000_000;
const PageSizeSchema = z.object({ width: z.number(), height: z.number(), step: z.number(), x: z.number(), y: z.number(), url: z.string() });
type PageSize = z.infer<typeof PageSizeSchema>;
const pageSize = () => {
  const roots = [document.documentElement, document.body].filter(Boolean);
  return {
    width: Math.max(...roots.flatMap(e => [e.scrollWidth, e.offsetWidth, e.clientWidth])),
    height: Math.max(...roots.flatMap(e => [e.scrollHeight, e.offsetHeight, e.clientHeight])),
    step: Math.max(1, innerHeight), x: scrollX, y: scrollY, url: location.href,
  };
};

function fitsPicture(size: PageSize): boolean {
  const { width, height } = size;
  return Math.min(width, height) > 0 && Math.max(width, height) <= MAX_SHOT_SIDE && width * height <= MAX_SHOT_PIXELS;
}

const MarksSchema = z.object({
  url: z.string(),
  blocks: z.array(z.object({ id: z.string(), text: z.string() })),
  frames: z.array(z.object({ src: z.string(), shown: z.boolean() })),
  inputs: z.int(), passwords: z.int(), overlays: z.int(),
});

const InspectionControlSchema = z.union([
  z.object({ kind: z.literal("navigation"), href: z.string(), signature: z.string() }),
  z.object({ kind: z.enum(["disclosure", "ambiguous", "blocked"]), href: z.string().optional(), signature: z.string() }),
]);
const ControlItemSchema = z.looseObject({
  ref: z.string(), role: z.string(), name: z.string(), region: z.string(), disabled: z.boolean(),
  context: z.string().optional(), pictureMasked: z.boolean().optional(), inspection: InspectionControlSchema.optional(),
});
const ControlWindowSchema = z.object({ url: z.string(), items: z.array(ControlItemSchema), more: z.boolean() });
const InspectionSearchSchema = z.object({ url: z.string(), destination: z.string(), parameter: z.string(), signature: z.string() });
export type ControlItem = z.infer<typeof ControlItemSchema>;
export type ControlWindow = z.infer<typeof ControlWindowSchema>;

export class AdapterError extends Error {
  readonly code: ExecutionErrorCode;
  constructor(code: ExecutionErrorCode, message: string = code) { super(message); this.code = code; }
}

// Playwright는 대부분의 실패를 꾸미지 않은 Error로, 시간 초과는 TimeoutError로 던진다.
function fromPlaywright(error: unknown): error is Error {
  return error instanceof errors.TimeoutError || (error instanceof Error && error.constructor === Error);
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
  // 설치본은 보이는 창과 headless 모두에 Chromium 전체 실행 파일을 싣는다.
  const channel = (process.env.CHEONGEUM_DESKTOP_RUNTIME ?? "") !== "" ? "chromium" : undefined;
  return launch(() => chromium.launch({ channel, headless, slowMo: slowMoMs }));
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
export type BrowserSource = () => Promise<Browser | BrowserContext>;
type Options = (
  | { browser: Browser; context?: never; browserSource?: never }
  | { context: BrowserContext; browser?: never; browserSource?: never }
  | { browserSource: BrowserSource; browser?: never; context?: never }
) & {
  allowedOrigins: readonly string[]; readOnlyWeb?: boolean; visualCursor?: boolean;
  actionTimeoutMs?: number; navigationTimeoutMs?: number; downloads?: DownloadSink;
};
type Completed = Pick<ActionResult, "ok" | "verified" | "readValue">;
const ok = { ok: true, verified: true };
const WEB_SCHEMES = ["http:", "https:"];
// 화면을 채우는 요청: 자료(XHR·fetch), 뒤늦게 받는 스크립트, 안쪽 프레임 문서. 그림·글꼴·통계는 화면 글을 바꾸지 않는다.
const BUILDING_TYPES = new Set(["xhr", "fetch", "script", "document"]);
// 이보다 오래 가는 요청은 화면을 채우는 요청이 아니라 열어 둔 연결(롱 폴링)로 본다
const FETCH_FRESH_MS = 10_000;
const prepared = new WeakMap<BrowserContext, Promise<void>>();
const claimed = new WeakSet<Page>();
const closingTabs = new WeakMap<BrowserContext, Promise<void>>();

interface PageLoad {
  method: string;
  // 결과를 채우는 것으로 확인된 요청(undefined)은 끝날 때까지 센다.
  fetching: Map<Request, number | undefined>;
}

const hostOf = (url: string) => tryUrl(url)?.hostname ?? "";
const closedError = () => new AdapterError("NOT_SUPPORTED", "브라우저 세션이 종료됐어요.");

function call<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return work().then(value => { signal.throwIfAborted(); return value; });
}
async function optional<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T | undefined> {
  try { return await call(signal, work); }
  catch { signal.throwIfAborted(); return undefined; }
}
type InspectionRequests = { blocked: number };

async function guardedInspection<T>(
  context: BrowserContext, owns: (page: Page) => boolean, run: (state: InspectionRequests) => Promise<T>,
): Promise<T> {
  const state: InspectionRequests = { blocked: 0 };
  const guard = async (route: Route) => {
    const request = route.request();
    try {
      const source = request.frame().page();
      const opener = owns(source) ? null : await source.opener();
      if (!owns(source) && (opener === null || !owns(opener))) {
        await route.fallback();
        return;
      }
    } catch { /* The first request in a new popup has no frame yet. */ }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) ||
      ((request.isNavigationRequest() || ["xhr", "fetch"].includes(request.resourceType())) && !isInspectionUrl(request.url()))) {
      state.blocked++;
      await route.abort("blockedbyclient");
    } else await route.fallback();
  };
  // Context routing also sees the initial request of a popup triggered by a control.
  await context.route("**/*", guard);
  try { return await run(state); }
  finally { await context.unroute("**/*", guard).catch(() => {}); }
}

/** 기록 이동이 양식(POST)을 다시 보내지 않게 한다. 자동화된 크롬은 '양식 다시 제출 확인' 없이 그냥 다시 보낸다. */
async function guardedHistory<T>(page: Page, run: (blocked: string[]) => Promise<T>): Promise<T> {
  const blocked: string[] = [];
  const guard = async (route: Route) => {
    const request = route.request();
    if (request.isNavigationRequest() && request.method() !== "GET") {
      blocked.push(request.url());
      await route.abort("blockedbyclient");
    } else await route.fallback();
  };
  await page.route("**/*", guard);
  try { return await run(blocked); }
  finally { await page.unroute("**/*", guard).catch(() => {}); }
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
  #shared = false;
  #closed = false;
  #lastDownload?: DownloadRecord;
  #nativeDialogs: string[] = [];
  readonly #loads = new Map<Page, PageLoad>();
  #onPage?: (page: Page) => void;
  #lifecycle = Promise.resolve();

  constructor(options: Options) {
    this.#options = options;
    this.#actionTimeout = options.actionTimeoutMs ?? 5000;
    this.#navigationTimeout = options.navigationTimeoutMs ?? 10_000;
    this.downloads = options.downloads;
  }

  /** 허용 출처이거나, 읽기 전용 웹이면 http(s) 어디든. 입력·제출을 막는 것은 PolicyGuard 몫. */
  #mayLoad(url: string): boolean {
    const parsed = tryUrl(url);
    return parsed !== undefined && (this.#options.allowedOrigins.includes(parsed.origin) ||
      (this.#options.readOnlyWeb === true && WEB_SCHEMES.includes(parsed.protocol)));
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.reject(closedError());
    return this.#schedule(() => this.#start());
  }
  close(): Promise<void> {
    this.#closed = true;
    return this.#schedule(() => this.#close());
  }
  #schedule(work: () => Promise<void>): Promise<void> {
    const next = this.#lifecycle.then(work);
    this.#lifecycle = next.catch(() => {});
    return next;
  }

  async #start(): Promise<void> {
    if (this.#closed) throw closedError();
    if (this.context !== undefined) return;
    const opts = this.#options;
    let { browser, context } = opts;
    if (opts.browserSource !== undefined) {
      const source = await opts.browserSource();
      if (this.#closed) throw closedError();
      if ("newContext" in source) browser = source;
      else context = source;
    }
    // 테스트용 Chromium: 세션마다 별도 컨텍스트(쿠키·저장소 분리). 실제 크롬: 공유 영구 프로필.
    this.#shared = context !== undefined;
    if (context === undefined && browser === undefined) throw new AdapterError("NOT_SUPPORTED", "어댑터가 시작되지 않았습니다.");
    const ctx = context ?? await browser!.newContext({ locale: "ko-KR", viewport: { width: 1100, height: 860 }, acceptDownloads: true });
    this.context = ctx;
    try {
      await this.#prepare(ctx);
      this.#onPage = page => {
        // 내 탭이 연 새 탭만 따라간다(공유 프로필의 다른 세션 탭은 무시)
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
      // 동의 전에는 아무 사이트도 열지 않는다. 빈 창 대신 이 창이 무엇인지 알려 주는 대기 화면을 보인다.
      await page.setContent(waitingHtml).catch(() => {});
    } catch (error) { await this.#close(); throw error; }
  }

  #prepare(context: BrowserContext): Promise<void> {
    const previous = prepared.get(context);
    if (previous !== undefined) return previous;
    // 요청을 가로채는 동안 Playwright는 브라우저 캐시를 끈다. 복지로는 화면마다 파일 100여 개를 다시 받아 15~50초가 걸렸다.
    // 읽기 전용 웹은 http(s)를 모두 허용해 가로챌 것이 없으니 걸지 않는다(그 밖의 주소로 가는 이동은 #perform이 거른다).
    const pending = this.#options.readOnlyWeb === true ? Promise.resolve() : context.route("**/*", async (route: Route) => {
      try {
        const url = route.request().url();
        if (url.startsWith("data:") || url.startsWith("blob:") || this.#mayLoad(url)) await route.continue();
        else await route.abort("blockedbyclient");
      } catch { /* 페이지가 닫힌 뒤 늦게 온 요청 */ }
    }).then(() => {}, error => { prepared.delete(context); throw error; });
    prepared.set(context, pending);
    return pending;
  }

  #attach(page: Page): void {
    this.page = page;
    claimed.add(page);
    const load: PageLoad = { method: "GET", fetching: new Map() };
    this.#loads.set(page, load);
    page.on("request", request => {
      let main = false;
      try { main = request.isNavigationRequest() && request.frame() === page.mainFrame(); }
      catch { /* 팝업의 첫 이동은 프레임보다 먼저 올 수 있다. */ }
      if (main) {
        load.method = request.method();
        load.fetching.clear();
      } else if (BUILDING_TYPES.has(request.resourceType()) && hostOf(request.url()) === hostOf(page.url())) {
        load.fetching.set(request, loadsBokjiroSearchResults(request.url()) ? undefined : performance.now());
      }
    });
    const ended = (request: Request) => { load.fetching.delete(request); };
    page.on("requestfinished", ended);
    page.on("requestfailed", ended);
    page.on("dialog", dialog => {
      this.#nativeDialogs.push(Array.from(dialog.message()).slice(0, 200).join(""));
      void dialog.dismiss().catch(() => {});
    });
    page.on("close", () => {
      this.#loads.delete(page);
      if (this.page === page) this.page = [...this.#loads.keys()].at(-1);
    });
    page.on("download", download => { void this.#saveDownload(download).catch(() => {}); });
  }

  async #saveDownload(download: Download): Promise<void> {
    const now = Date.now() / 1000;
    const name = basename(download.suggestedFilename().replaceAll("\\", "/"));
    const suggested = name.length > 0 ? name : "download-" + Math.trunc(now);
    const store = this.downloads;
    if (store?.folder !== undefined && store.folder !== "") {
      // 세션이 달라도 같은 이름의 파일이 승인 대기 중인 다운로드를 덮어쓰지 않는다.
      const dest = join(store.folder, `${randomUUID()}-${suggested}`);
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
    await this.start();
    const page = this.page;
    if (page !== undefined) await optional(signal, () => page.bringToFront());
  }

  async observe(signal = new AbortController().signal) {
    await this.start();
    const page = this.#requirePage();
    const load = this.#loads.get(page);
    const text = z.string().parse(await call(signal, () => page.evaluate(observeJson)));
    const raw = z.looseObject({ errors: z.array(z.string()).optional() }).parse(JSON.parse(text));
    signal.throwIfAborted();
    const errors = [...raw.errors ?? [], ...this.#nativeDialogs.splice(0).map(msg => "브라우저 경고창: " + msg)];
    const fresh = performance.now() - FETCH_FRESH_MS;
    const loading = [...load?.fetching.values() ?? []].some(sent => sent === undefined || sent > fresh) || undefined;
    return parseObservation({ ...raw, errors, loading, platform: "pc", capturedAt: new Date().toISOString() });
  }

  #inspectionRequests?: InspectionRequests;

  async withInspection<T>(work: () => Promise<T>): Promise<T> {
    if (this.#inspectionRequests !== undefined) return work();
    await this.start();
    return guardedInspection(this.#requirePage().context(), page => this.#loads.has(page), async state => {
      this.#inspectionRequests = state;
      try { return await work(); }
      finally { this.#inspectionRequests = undefined; }
    });
  }

  async execute(action: Action, signal = new AbortController().signal, inspection?: InspectionBinding): Promise<ActionResult> {
    const started = performance.now();
    const done = (result: Omit<ActionResult, "actionId" | "latencyMs">) => ({
      actionId: action.id, latencyMs: Math.trunc(performance.now() - started), ...result,
    });
    if (signal.aborted) return done({ ok: false, verified: false, errorCode: "ABORTED" });
    let page: Page | undefined;
    try {
      await raceAbort(() => this.start(), signal);
      page = this.#requirePage();
      const current = page;
      const result = await raceAbort(async active => {
        const result = inspection === undefined
          ? await this.#perform(current, action, active)
          : await this.withInspection(async () => {
            const state = this.#inspectionRequests;
            const before = state?.blocked;
            const completed = await this.#perform(current, action, active, inspection);
            if (inspection.kind === "control" && inspection.control.kind === "ambiguous" && state?.blocked !== before) {
              throw new AdapterError("NOT_SUPPORTED", "화면을 확인하는 범위를 벗어난 사이트 동작을 막았어요.");
            }
            return completed;
          });
        // 시연용 가상 커서: 페이지를 옮기면(새 문서·새 탭) 커서가 사라지므로 지금 화면에 다시 놓는다
        if (this.#options.visualCursor === true && result.ok && action.type !== "read") await this.#restCursor(active);
        return result;
      }, signal);
      return done(result);
    } catch (error) {
      if (signal.aborted) {
        if (page !== undefined) await this.#stopLoading(page);
        return done({ ok: false, verified: false, errorCode: "ABORTED", message: "ABORTED" });
      }
      if (error instanceof AdapterError) return done({ ok: false, verified: false, errorCode: error.code, message: error.message });
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.message.includes("Timeout"));
      return done({ ok: false, verified: false, errorCode: timedOut ? "TIMEOUT" : action.type === "navigate" ? "NAVIGATION_FAILED" : "UNKNOWN" });
    }
  }

  /**
   * 멈춤으로 끊긴 조작이 시작한 이동을 크롬에서도 끊는다. 기다림만 버리면 크롬은 늦게 온 문서를 그대로 화면에 올린다.
   * window.stop()은 이동이 끝나야 실행되므로(evaluate가 그때까지 기다린다) CDP로 보낸다. 이미 바뀐 화면은 되돌리지 않는다.
   */
  async #stopLoading(page: Page): Promise<void> {
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.stopLoading");
      await cdp.detach();
    } catch { /* 닫힌 탭 */ }
  }

  async #domReady(page: Page, signal: AbortSignal): Promise<void> {
    await optional(signal, () => page.waitForLoadState("domcontentloaded", { timeout: this.#navigationTimeout, signal }));
  }

  /**
   * 주소를 연다. 응답이 들어오면(commit) 열린 것이고, 화면 글이 다 그려지기(DOMContentLoaded)는 같은 시간까지만 기다린다.
   * 공공 누리집은 응답이 바로 와도 막는 스크립트 때문에 첫 방문에 다 그리기까지 10초쯤 걸린다(복지로).
   */
  async #open(page: Page, url: string, signal: AbortSignal): Promise<void> {
    await call(signal, () => page.goto(url, { timeout: this.#navigationTimeout, signal, waitUntil: "commit" }));
    await this.#domReady(page, signal);
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
          await this.#domReady(page, signal);
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
      let response = null;
      // 응답이 들어오면(commit) 돌아간 것이다. 다 그려지기를 기다리다 시간이 넘으면 '못 갔다'로 알려져 한 번 더 뒤로 간다.
      try {
        response = await call(signal, () => page.goBack({ waitUntil: "commit", timeout: this.#navigationTimeout, signal }));
      } catch (error) {
        signal.throwIfAborted();
        if (blocked.length === 0) throw error;
      }
      const [resent] = blocked;
      if (resent !== undefined) {
        // 막은 이동은 크롬 오류 화면으로 끝나고, 그 화면이 들어서기 전에는 앞으로 갈 수 없다.
        // 있던 화면도 양식 결과면 앞으로 가기도 막히므로, 그때는 그 주소를 GET으로 다시 연다.
        await errorPageSettled(page, signal);
        await stepAndSettle(page, signal, () => page.goForward({ waitUntil: "commit", timeout: this.#navigationTimeout, signal }));
        if (page.url() !== here) await optional(signal, () => this.#open(page, here, signal));
        throw new AdapterError("RESUBMIT_BLOCKED", resent);
      }
      if (response !== null) await this.#domReady(page, signal);
      return { ok: true, verified: response !== null };
    });
  }

  async #perform(page: Page, action: Action, signal: AbortSignal, inspection?: InspectionBinding): Promise<Completed> {
    signal.throwIfAborted();
    const { type, target } = action;
    const opts = { timeout: this.#actionTimeout, signal };
    if (inspection !== undefined && inspection.kind !== "start" && page.url() !== inspection.url) {
      throw new AdapterError("VERIFY_FAILED");
    }
    if (inspection?.kind === "search") {
      const fresh = await call(signal, () => this.inspectionSearch(inspection.fieldId));
      if (this.page !== page || fresh?.signature !== inspection.signature || fresh.url !== inspection.url ||
        fresh.destination !== inspection.destination || fresh.parameter !== inspection.parameter ||
        !isInspectionUrl(fresh.destination) || !this.#mayLoad(fresh.destination)) throw new AdapterError("VERIFY_FAILED");
      const url = new URL(fresh.destination);
      url.search = "";
      url.searchParams.set(fresh.parameter, action.value ?? "");
      if (!isInspectionUrl(url.href)) throw new AdapterError("NOT_SUPPORTED");
      await this.#open(page, url.href, signal);
      return ok;
    }
    if (type === "navigate") {
      const url = action.url;
      if (url === undefined || url === "" || !this.#mayLoad(url)) throw new AdapterError("NAVIGATION_FAILED");
      const prev = page.url(), wasForm = (this.#loads.get(page)?.method ?? "GET") !== "GET";
      try { await this.#open(page, url, signal); }
      catch (error) {
        signal.throwIfAborted();
        // 내려받기 등으로 이동이 취소된 것(ERR_ABORTED)은 오류 화면을 남기지 않는다
        if (String(error).includes("net::ERR_") && !String(error).includes("ERR_ABORTED")) {
          await this.#returnTo(page, prev, url, wasForm, signal);
        }
        throw error;
      }
      // 실제 사이트는 내용을 늦게 그리는 경우가 많아 잠깐(최대 3초) 네트워크가 잠잠해지길 기다린다.
      const origin = parseUrl(url).origin;
      if (!this.#options.allowedOrigins.includes(origin)) {
        await optional(signal, () => page.waitForLoadState("networkidle", { timeout: 3000, signal }));
      }
      return { ok: true, verified: parseUrl(page.url()).origin === origin };
    }
    if (type === "back" && action.url !== undefined && action.url !== "") {
      // 양식 결과 화면(바로 뒤 칸)을 건너뛰어 그 앞 화면으로 두 칸 돌아간다. 그 화면이 action의 주소가 아니면 실패다.
      const blocked = await guardedHistory(page, async resent => {
        await stepAndSettle(page, signal, () => page.evaluate("history.go(-2)"));
        return resent.length > 0;
      });
      if (blocked || page.url() !== action.url) throw new AdapterError("NAVIGATION_FAILED");
      await this.#domReady(page, signal);
      return ok;
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
    if (inspection?.kind === "control" && inspection.control.kind === "blocked") throw new AdapterError("NOT_SUPPORTED");
    if (inspection?.kind === "control" && inspection.control.kind === "navigation") {
      await this.#verifyInspectionControl(page, inspection, target, signal);
      const href = inspection.control.href;
      if (!isInspectionUrl(href) || !this.#mayLoad(href)) throw new AdapterError("NOT_SUPPORTED");
      // Read a native link's destination without dispatching a page click handler.
      await this.#open(page, href, signal);
      return ok;
    }
    if (this.#options.visualCursor === true && type !== "read") {
      await this.#showCursor(page, loc, CURSOR_MODE[type] ?? "move", signal);
    }
    if (target?.ref !== undefined && type !== "read" && (this.#options.visualCursor === true || type === "click")) {
      // Waiting for actionability can outlast the identity check. A relabelled
      // button must be rejected before the real click, including after cursor motion.
      if (type === "click") await call(signal, () => loc.click({ ...opts, trial: true }));
      loc = await this.#resolveRef(page, target, signal);
    }
    if (inspection?.kind === "control") {
      await this.#verifyInspectionControl(page, inspection, target, signal);
      if (inspection.control.kind === "disclosure") {
        await call(signal, () => loc.evaluate(element => {
          const details = element.parentElement;
          if (!(details instanceof HTMLDetailsElement) || details.querySelector(":scope > summary") !== element) {
            throw new Error("Disclosure changed");
          }
          details.open = !details.open;
        }));
        return ok;
      }
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
      case "capture":
        throw new AdapterError("NOT_SUPPORTED");
    }
  }

  /**
   * 링크 이름(화면 글자)과 접근성 이름이 다른 사이트(aria-label, "새창" 덧붙임 등)나 접힌 메뉴 속 링크:
   * 접근성 이름으로 못 찾을 때만 화면에 보이는 같은 이름의 링크 하나를 누르고, 보이지 않으면 그 링크 주소(http/https)로 이동한다.
   */
  async #linkFallback(page: Page, name: string, signal: AbortSignal): Promise<boolean> {
    const byRole = page.getByRole("link", { name, exact: true }).filter({ visible: true });
    if (await call(signal, () => byRole.count()) > 0) return false;
    const window = await this.controlWindow(name, 0, { exact: true });
    const links = window.items.filter(item => item.role === "link");
    if (links.length > 1 || window.more) throw new AdapterError("AMBIGUOUS_TARGET");
    const [link] = links;
    if (link !== undefined) {
      let loc = await this.#resolveRef(page, link, signal);
      if (this.#options.visualCursor === true) {
        await this.#showCursor(page, loc, "click", signal);
        loc = await this.#resolveRef(page, link, signal);
      }
      await call(signal, () => loc.click({ signal, timeout: this.#actionTimeout }));
      return true;
    }
    const hidden = z.array(z.string()).parse(await call(signal, () => page.locator("a[href]").evaluateAll((anchors, wanted) => {
      const compact = (text: string | null) => (text ?? "").replace(/\s+/g, "");
      return [...new Set(anchors.filter(a => compact(a.textContent) === compact(wanted) &&
        (a.getClientRects().length === 0 || getComputedStyle(a).visibility === "hidden"))
        .map(a => a instanceof HTMLAnchorElement ? a.href : ""))].slice(0, 2);
    }, name)));
    if (hidden.length > 1) throw new AdapterError("AMBIGUOUS_TARGET");
    const [href] = hidden;
    if (href === undefined || href === "") return false;
    let url;
    try { url = parseUrl(href, page.url()); } catch { return false; }
    if (!WEB_SCHEMES.includes(url.protocol)) return false;
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

  async #resolveRef(page: Page, target: { ref?: string; role?: string; name?: string }, signal: AbortSignal): Promise<Locator> {
    const ref = target.ref ?? "";
    const raw = ControlWindowSchema.parse(JSON.parse(z.string().parse(await call(signal, () => page.evaluate(controlsJson({ ref }))))));
    const item = raw.items.find(it => it.ref === ref);
    if (item === undefined) throw new AdapterError("TARGET_NOT_FOUND");
    if (item.role !== target.role || item.name !== target.name) {
      throw new AdapterError("VERIFY_FAILED", "누르려던 요소의 이름이나 역할이 바뀌었습니다.");
    }
    const loc = page.locator('[data-cheongeum-ref="' + cssEscape(ref) + '"]').filter({ visible: true });
    if (await call(signal, () => loc.count()) !== 1) throw new AdapterError("AMBIGUOUS_TARGET");
    return loc;
  }

  async #verifyInspectionControl(page: Page, binding: Extract<InspectionBinding, {kind: "control"}>, target: ActionTarget | undefined, signal: AbortSignal): Promise<void> {
    if (this.page !== page || page.url() !== binding.url) throw new AdapterError("VERIFY_FAILED");
    const fresh = await call(signal, () => this.controlWindow("", 0, { ref: binding.ref, inspection: true }));
    const [item] = fresh.items;
    if (fresh.url !== binding.url || item?.ref !== binding.ref || item.disabled || item.role !== target?.role ||
      item.name !== target?.name || item.inspection?.kind !== binding.control.kind ||
      item.inspection.signature !== binding.control.signature || item.inspection.href !== binding.control.href) {
      throw new AdapterError("VERIFY_FAILED");
    }
  }

  async inspectionSearch(fieldId: string): Promise<z.infer<typeof InspectionSearchSchema> | undefined> {
    const page = this.#requirePage();
    return InspectionSearchSchema.safeParse(JSON.parse(z.string().parse(
      await page.evaluate(controlsJson({ searchField: fieldId })),
    ))).data;
  }

  /** 현재 문서에서 실제로 보이는 조작 대상만 적은 수씩 돌려준다. */
  async controlWindow(text = "", offset = 0, { ref, exact = false, inspection, destination }: {
    ref?: string; exact?: boolean; inspection?: boolean; destination?: string;
  } = {}): Promise<ControlWindow> {
    const page = this.#requirePage();
    const query = { text: [...text].slice(0, 100).join(""), offset: Math.max(0, offset), limit: ref === undefined ? 24 : 1,
      ref: ref ?? null, exact, inspection, destination };
    return ControlWindowSchema.parse(JSON.parse(z.string().parse(await page.evaluate(controlsJson(query)))));
  }

  /** 커서가 없는 화면(방금 연 페이지)이면 큰 제목이나 본문 위에 놓아 둔다. 있으면 그대로(마지막 조작 위치) 둔다. */
  async #restCursor(signal: AbortSignal): Promise<void> {
    const page = this.#requirePage();
    await optional(signal, () => page.waitForLoadState("domcontentloaded", { timeout: 3000, signal }));
    const spot = z.object({ x: z.number(), y: z.number() }).safeParse(await optional(signal, () => page.evaluate(restingCursor)));
    if (spot.success) await optional(signal, () => page.evaluate(cursorScript(spot.data.x, spot.data.y, "move")));
  }

  async #showCursor(page: Page, loc: Locator, mode: CursorMode, signal: AbortSignal): Promise<void> {
    await optional(signal, () => loc.scrollIntoViewIfNeeded({ timeout: 2000, signal }));
    if (mode === "click") await call(signal, () => loc.hover({ timeout: this.#actionTimeout, signal }));
    const box = await optional(signal, () => loc.boundingBox({ signal }));
    if (box == null) return;
    const evenRound = (value: number) => value % 2 === 0.5 ? Math.floor(value) : Math.round(value);
    const x = evenRound(box.x + box.width / 2), y = evenRound(box.y + box.height / 2);
    await optional(signal, () => page.evaluate(cursorScript(x, y, mode)));
    await delay(mode === "click" ? 650 : 450, undefined, { signal });
  }

  /** 안쪽 판만 스크롤하는 사이트는 촬영하는 동안 그 판을 펼친다. 끝나면 사이트의 모양·스크롤·초점을 되돌린다. */
  async fullPageLayout<T>(work: () => Promise<T>): Promise<T> {
    const page = this.#requirePage();
    const attr = "data-cheongeum-fullpage-" + randomUUID();
    try {
      await page.evaluate(callScript(fullPageFunction, { attr }));
      return await work();
    } catch (error) {
      if (fromPlaywright(error)) throw new AdapterError("UNKNOWN", "페이지 전체를 촬영하지 못했어요.");
      throw error;
    } finally {
      // 닫히거나 바뀐 문서는 임시 모양을 이미 버렸다.
      if (!page.isClosed()) await page.evaluate(callScript(fullPageFunction, { attr, restore: true })).catch(() => {});
    }
  }

  /** 가리기 전에 늦게 그려지는 부분을 불러오고, 읽던 스크롤 위치로 되돌린다. */
  async prepareFullPage(url: string, signal: AbortSignal): Promise<ShotRefusal | undefined> {
    const page = this.#requirePage();
    const original = PageSizeSchema.parse(await page.evaluate(pageSize));
    let size = original;
    const deadline = performance.now() + 10_000;
    let top = 0;
    let scrolled = false;
    try {
      for (;;) {
        if (signal.aborted || size.url !== url || this.page !== page) return new ShotRefusal("changed", REFUSAL_SPEECH.changed);
        if (!fitsPicture(size) || performance.now() > deadline) return new ShotRefusal("too-large", REFUSAL_SPEECH["too-large"]);
        if (size.height <= size.step) break;
        top = Math.min(top, size.height - size.step);
        await page.evaluate((y: number) => { scrollTo({ top: y, behavior: "instant" }); }, top);
        scrolled = true;
        // 스크롤·교차 관찰 처리기가 그리게 두되 상관없는 네트워크는 기다리지 않는다.
        await delay(80);
        size = PageSizeSchema.parse(await page.evaluate(pageSize));
        if (top + size.step >= size.height) break;
        top += size.step;
      }
      if (signal.aborted || size.url !== url) return new ShotRefusal("changed", REFUSAL_SPEECH.changed);
      try {
        await page.waitForFunction(() => Array.from(document.images).every(img => img.complete || img.currentSrc === "" ||
          img.getClientRects().length === 0 || getComputedStyle(img).visibility === "hidden"), undefined, { timeout: 2000, polling: 100 });
      } catch (error) {
        if (error instanceof errors.TimeoutError) return new ShotRefusal("loading", REFUSAL_SPEECH.loading);
        throw error;
      }
      return undefined;
    } finally {
      if (scrolled && !page.isClosed() && page.url() === url) {
        await page.evaluate(([x, y]) => { scrollTo({ left: x, top: y, behavior: "instant" }); }, [original.x, original.y] as const);
      }
    }
  }

  /**
   * 지금 탭의 스크롤 가능한 문서 전체를 가리고 한 장으로 찍는다. plan은 방금 관찰한 화면으로 만든 것(planShot), mainText는 그 관찰의 본문이다.
   * 찍는 것은 이 세션의 탭 하나뿐이고, 탭을 앞으로 가져오지 않는다(뒤에 있는 탭도 찍힌다).
   * 가릴 글을 다 찾지 못했거나 그사이 비밀번호 칸·보안문자 틀이 생겼으면 찍지 않고 ShotRefusal을 돌려준다.
   * 찍지 못하면 AdapterError(TIMEOUT·UNKNOWN).
   */
  async capture(plan: ShotPlan, mainText: string): Promise<Picture | ShotRefusal> {
    const page = this.#requirePage();
    const changed = new ShotRefusal("changed", REFUSAL_SPEECH.changed);
    let size: PageSize, marks: z.infer<typeof MarksSchema>, flagged: string[], png: Buffer;
    try {
      size = PageSizeSchema.parse(await page.evaluate(pageSize));
      if (!fitsPicture(size)) return new ShotRefusal("too-large", REFUSAL_SPEECH["too-large"]);
      const token = randomUUID();
      marks = MarksSchema.parse(await page.evaluate(callScript(blocksFunction, { token, attr: SHOT_ATTR, mask: plan.mask, hide: plan.hide })));
      const judged = judgeMarks(marks, mainText);
      if (judged instanceof ShotRefusal) return judged;
      flagged = judged;
      if (marks.url !== plan.url) return changed;
      const current = await this.observe();
      const currentPlan = planShot(current);
      if (currentPlan instanceof ShotRefusal) return currentPlan;
      if ((current.outline?.mainText ?? "") !== mainText || currentPlan.url !== plan.url) return changed;
      const selectors = [...plan.mask, ...flagged.map(id => `[${SHOT_ATTR}="${id}"]`)];
      png = await page.screenshot({
        type: "png", fullPage: true,
        mask: selectors.length > 0 ? [page.locator(selectors.join(", "))] : [],
        maskColor: "#000000",
        ...(plan.hide.length > 0 ? { style: `${plan.hide.join(", ")} { display: none !important; }` } : {}),
        scale: "css", animations: "disabled", caret: "initial", timeout: this.#actionTimeout,
      });
      if (this.page !== page || await page.evaluate(callScript(blocksFunction, { verify: token })) !== true) return changed;
    } catch (error) {
      if (fromPlaywright(error)) throw new AdapterError(error instanceof errors.TimeoutError ? "TIMEOUT" : "UNKNOWN", "화면 사진을 찍지 못했습니다.");
      throw error;
    } finally {
      // 그사이 화면이 넘어갔으면 뗄 표시도 없다
      await page.evaluate(callScript(blocksFunction, null)).catch(() => {});
    }
    if (png.length > MAX_SHOT_BYTES) return new ShotRefusal("too-large", REFUSAL_SPEECH["too-large"]);
    const [width, height] = pngSize(png);
    if (width !== size.width || height !== size.height) return changed;
    const masks = new MaskReport(marks.inputs, marks.frames.filter(frame => frame.shown).length, flagged.length, marks.overlays > 0);
    return Picture._sealed(png, { source: "web", width, height, masks });
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
      if (!this.#shared) await ctx.close();
      else {
        // 공유 크롬의 마지막 탭을 닫으면 크롬이 꺼지기 시작해, 곧바로 만든 다음 세션이 탭을 열지 못한다. 빈 탭을 먼저 연다.
        const page = this.page;
        if (page !== undefined) await withSharedTabs(ctx, async () => {
          if (ctx.pages().every(other => other === page)) await ctx.newPage();
          await page.close();
        });
      }
    } catch { /* 사용자가 크롬 창을 먼저 닫을 수 있다. */ }
    this.#loads.clear();
    this.page = undefined;
  }
}

function withSharedTabs<T>(ctx: BrowserContext, operation: () => Promise<T>): Promise<T> {
  const previous = closingTabs.get(ctx) ?? Promise.resolve();
  const result = previous.then(operation);
  closingTabs.set(ctx, result.then(() => {}, () => {}));
  return result;
}
