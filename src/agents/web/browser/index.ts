import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, errors, type Browser, type BrowserContext, type CDPSession, type Dialog, type Download, type Page, type Request, type Route } from "playwright";
import { z } from "zod";
import {
  parseObservation, type Action, type ActionResult, type ActionTarget, type ExecuteGrants, type NativeDialogRecord, type NativeGrant,
  type NativeSeen, type NoticeProof,
} from "../../../core/actions.ts";
import { browserAsset } from "../../../core/assets.ts";
import { raceAbort } from "../../../core/abort.ts";
import { MaskReport, Picture, pngSize } from "../../../core/picture.ts";
import { boundPlanClick, revokePlanClick } from "../../../core/plan.ts";
import { parseUrl, tryUrl } from "../../../core/url.ts";
import { confirmsClick, isInspectionUrl, isNotice, matchesInspectionSearchTarget, nativeMessageRisk, planControlAllowed, type InspectionBinding } from "../../../safety/guard.ts";
import { loadsBokjiroSearchResults } from "../playbook.ts";
import { REFUSAL_SPEECH, ShotRefusal, judgeMarks, planShot, type ShotPlan } from "../shot.ts";
import type { Download as DownloadRecord, DownloadStore } from "../downloads.ts";

import { markBlocks } from "./blocks.ts";
import { drawCursor, type CursorMode } from "./cursor.ts";
import { fullPageLayout } from "./full_page.ts";
import { AdapterError, call, optional, playwrightDriver, type ControlWindow, type PageDriver, type ResolvedElement } from "./driver.ts";
import { attachedDriver, attachStagehand, browserDriver, detachStagehand, stagehandLaunchOptions, type BrowserDriver } from "./stagehand_browser.ts";
import { stagehandDriver } from "./stagehand_driver.ts";
import { framesOf } from "./frame_controls.ts";
import { embeddedElement, isEmbeddedRef } from "./embedded_element.ts";
import { restingCursor } from "./rest_cursor.ts";
import { isHeaded, markHeaded, maximizeWindow, trackTabs } from "./windows.ts";

const waitingHtml = readFileSync(browserAsset("waiting.html"), "utf8");
// Native Node erases the types on import. Bundled Electron uses these same self-contained function bodies.
const blocksFunction = markBlocks.toString();
const fullPageFunction = fullPageLayout.toString();
// Node의 page.evaluate는 함수 글을 부르지 않으므로 인자를 JSON으로 넣어 부르는 식으로 보낸다.
const callScript = (script: string, arg: unknown) => `(${script})(${JSON.stringify(arg)})`;
// 사진을 찍는 동안만 글 조각에 붙였다 떼는 표시
const SHOT_ATTR = "data-cheongeum-shot";
export { AdapterError, browserPatterns, type ControlItem, type ControlWindow } from "./driver.ts";
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

async function launchForDriver<T extends Browser | BrowserContext>(driver: BrowserDriver, start: (extra: import("playwright").LaunchOptions) => Promise<T>): Promise<T> {
  return launch(async () => {
    const resource = await start(driver === "stagehand" ? await stagehandLaunchOptions() : {});
    if (driver === "stagehand") {
      try {
        const host: Browser | BrowserContext = resource;
        const browser = "contexts" in host ? host : host.browser();
        if (browser === null) throw new AdapterError("NOT_SUPPORTED");
        await attachStagehand(browser, "newContext" in resource);
      } catch (error) { await resource.close(); throw error; }
    }
    return resource;
  });
}

export function launchBrowser(headless: boolean, slowMoMs = 0, driver = browserDriver()): Promise<Browser> {
  const channel = driver === "stagehand" || (process.env.CHEONGEUM_DESKTOP_RUNTIME ?? "") !== "" ? "chromium" : undefined;
  return launchForDriver(driver, async extra => {
    const browser = await chromium.launch({ channel, headless, slowMo: slowMoMs, ...extra,
      args: headless ? extra.args : [...extra.args ?? [], "--start-maximized"] });
    if (!headless) markHeaded(browser);
    return browser;
  });
}

export function launchChromeProfile(userDataDir: string, slowMoMs = 0, driver = browserDriver(),
  options: { channel?: "chrome" | "chromium"; headless?: boolean } = {}): Promise<BrowserContext> {
  return launchForDriver(driver, async extra => {
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chrome", headless: false, viewport: null, locale: "ko-KR", slowMo: slowMoMs, acceptDownloads: true, ...options, ...extra,
      args: options.headless === true ? extra.args : [...extra.args ?? [], "--start-maximized"],
    });
    if (options.headless !== true) markHeaded(context);
    return context;
  });
}
export async function closeLaunchedBrowser(resource: Browser | BrowserContext): Promise<void> {
  const browser = "contexts" in resource ? resource : resource.browser();
  try { if (browser !== null) await detachStagehand(browser); }
  finally { await resource.close(); }
}

export function stopPlaywright(): Promise<void> {
  return stopping ??= (async () => {
    await Promise.allSettled(launching);
    await Promise.all([...owned].map(closeLaunchedBrowser));
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
  driver?: BrowserDriver;
  protectedTab?: (page: Page) => boolean;
  createPageDriver?: (page: Page, actionTimeoutMs: number) => PageDriver;
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
  fetching: Map<Request | string, number | undefined>;
  network?: Promise<CDPSession>;
  /** 이 탭의 번호(어댑터가 붙인다). confirm() 창에 대신 답하는 허가를 한 탭에 묶는다. */
  tab: string;
  /** 주 프레임이 새 문서로(같은 문서 안의 주소 이동 포함) 바뀔 때마다 늘어난다. 페이지가 바꿀 수 없다. */
  docSeq: number;
}

// 사이트가 띄운 confirm() 창: 취소한 기록은 같은 조작을 사용자가 다시 확인했을 때만 한 번 대신 답하는 근거가 된다.
// 기록(어댑터만 가진 것)과 허가·지금 실행 중인 조작이 모두 맞아야 하고, 어긋나면 늘 취소한다.
// arm: 허가를 어댑터가 기록과 맞춰 본 결과. until(기록이 낡는 때)과 문서 번호는 실제로 누르기 직전에 다시 맞춰 본다. 첫 창이 뜨면(무엇이든) 한 번 쓴 것이다.
interface NativeArm { grant: NativeGrant; used: boolean; until: number; docSeq: number }
// open: 실제로 누르거나 입력하는 동안만 참. 그 밖(기다림·커서 움직임·확인 중)에 뜬 창은 이 조작이 띄운 것이 아니라서 기록도 받아 주지도 않고 늘 취소한다.
interface Flight {
  actionId: string; signal: AbortSignal; open: boolean;
  requested?: { url: string; document: number; target: string; userCommand: boolean };
  revoked?: boolean; acceptance?: Promise<boolean>;
  seen: { cancelled: NativeDialogRecord[]; accepted: boolean }; arm?: NativeArm;
}
interface NativePending { record: NativeDialogRecord; target: ActionTarget; until: number }
// 기록이 낡아 쓸 수 없게 되는 시간. 사용자 승인의 2분(APPROVAL_TTL_S)은 오케스트레이터가 따로 지키고, 이것은 그보다 느슨한 최후의 한계다.
const NATIVE_PENDING_MS = 600_000;
const NATIVE_KEEP = 8;
const sameNative = (a: NativeGrant, b: NativeGrant) =>
  a.tab === b.tab && a.document === b.document && a.url === b.url && a.hash === b.hash && a.length === b.length;
function trimmed(map: Map<string, unknown>): void {
  for (const key of map.keys()) {
    if (map.size <= NATIVE_KEEP) break;
    map.delete(key);
  }
}

const hostOf = (url: string) => tryUrl(url)?.hostname ?? "";

// 기록 이동에서 라우팅을 해제하는 순간 이미 시작된 fetch는 Playwright의 request 이벤트에서 빠질 수 있다.
// 같은 탭의 네트워크 이벤트에서도 본문을 채우는 요청의 번호와 시각만 센다. 차단과 허가는 기존 라우팅이 맡는다.
async function watchPageLoad(page: Page, load: PageLoad): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { frameTree: { frame: { id: mainFrame } } } = await cdp.send("Page.getFrameTree");
    const ended = ({ requestId }: { requestId: string }) => { load.fetching.delete(requestId); };
    cdp.on("Network.requestWillBeSent", ({ requestId, frameId, documentURL, request, type }) => {
      load.fetching.delete(requestId);
      if (frameId === mainFrame && type !== undefined && type !== "Document" && BUILDING_TYPES.has(type.toLowerCase()) &&
          hostOf(request.url) === hostOf(documentURL)) {
        load.fetching.set(requestId, loadsBokjiroSearchResults(request.url) ? undefined : performance.now());
      }
    });
    cdp.on("Network.loadingFinished", ended);
    cdp.on("Network.loadingFailed", ended);
    await cdp.send("Network.enable", { maxPostDataSize: 0 });
    return cdp;
  } catch (error) {
    await cdp.detach().catch(() => {});
    throw error;
  }
}
const closedError = () => new AdapterError("NOT_SUPPORTED", "브라우저 세션이 종료됐어요.");

// CDP DOM.describeNode가 돌려주는 노드 가운데 shadow root를 세는 데 쓰는 부분만(값·속성은 보지 않는다).
interface DomNode {
  shadowRootType?: string; shadowRoots?: DomNode[]; children?: DomNode[]; contentDocument?: DomNode; templateContent?: DomNode;
}
const SHADOW_SCAN_LIMIT = 20_000;
/** 열린·닫힌 shadow root의 수(브라우저 내부 root는 제외). 노드가 너무 많아 다 보지 못했으면 -1. */
export function shadowRootCount(root: DomNode): number {
  let found = 0, visited = 0;
  const pending: DomNode[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (++visited > SHADOW_SCAN_LIMIT) return -1;
    for (const shadow of node.shadowRoots ?? []) {
      if (shadow.shadowRootType !== "user-agent") found++;
      pending.push(shadow);
    }
    for (const child of node.children ?? []) pending.push(child);
    if (node.contentDocument !== undefined) pending.push(node.contentDocument);
    if (node.templateContent !== undefined) pending.push(node.templateContent);
  }
  return found;
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
  #lastCursor?: { x: number; y: number };
  #nativeDialogs: string[] = [];
  /** 탭마다 지금 실행 중인 조작. confirm() 창이 어느 조작 때문에 떴는지는 여기서만 가린다(그 밖에 뜬 창은 늘 취소). */
  readonly #flights = new Map<Page, Flight>();
  /** 조작 번호별로 취소한 confirm() 창의 기록(대신 답할 수 있는 것만). 한 번 쓰면 지운다. */
  readonly #nativePending = new Map<string, NativePending>();
  /** 마지막으로 끝난 조작들이 겪은 confirm() 창. takeNative로 한 번만 가져간다. */
  readonly #nativeSeen = new Map<string, NativeSeen>();
  readonly #drivers = new WeakMap<Page, PageDriver>();
  readonly #targetDocuments = new WeakMap<ActionTarget, {page: Page; document: number | undefined; login?:string}>();
  readonly #loads = new Map<Page, PageLoad>();
  #onPage?: (page: Page) => void;
  readonly #openers = new WeakMap<Page, Page>();
  readonly #opening = new WeakSet<Page>();
  #tabs?: ReturnType<typeof trackTabs>;
  readonly #taskPages = new Set<Set<Page>>();
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
  async withTask<T>(work: () => Promise<T>): Promise<T> {
    const pages = new Set<Page>(this.page === undefined ? [] : [this.page]);
    this.#taskPages.add(pages);
    try { return await work(); }
    finally { this.#taskPages.delete(pages); this.#tabs?.changed(); }
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
    const ctx = context ?? await browser!.newContext({ locale: "ko-KR", viewport: isHeaded(browser) ? null : { width: 1100, height: 860 }, acceptDownloads: true });
    this.context = ctx;
    try {
      await this.#prepare(ctx);
      this.#onPage = page => {
        // 내 탭이 연 새 탭만 따라간다(공유 프로필의 다른 세션 탭은 무시)
        this.#opening.add(page);
        void page.opener().then(opener => {
          if (opener !== null) this.#openers.set(page, opener);
          if (this.context === ctx && opener !== null && opener === this.page) this.#attach(page);
        }).catch(() => {}).finally(() => { this.#opening.delete(page); this.#tabs?.changed(); });
      };
      ctx.on("page", this.#onPage);
      this.#tabs = trackTabs(ctx, page => {
        if (this.page === page || this.#flights.has(page) || this.#opening.has(page) ||
            [...this.#taskPages].some(pages => pages.has(page))) return true;
        // 사용자가 인증하는 동안 새로 열린 본인 확인 팝업도 처음 인계한 탭에 속한다.
        for (let source: Page | undefined = page; source !== undefined; source = this.#openers.get(source)) {
          if (this.#options.protectedTab?.(source) === true) return true;
        }
        return false;
      });
      const page = await withSharedTabs(ctx, async () => {
        const blank = ctx.pages().find(page => !claimed.has(page) && page.url() === "about:blank");
        const selected = blank ?? await ctx.newPage();
        this.#attach(selected);
        return selected;
      });
      // 동의 전에는 아무 사이트도 열지 않는다. 빈 창 대신 이 창이 무엇인지 알려 주는 대기 화면을 보인다.
      await maximizeWindow(page).catch(() => {});
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
    const previous = this.page;
    if (previous !== undefined && previous !== page && this.#drivers.get(previous)?.bindTarget !== undefined) {
      // 새 탭을 고른 뒤 이전 탭에서 기다리던 클릭이나 입력이 도착해도 실행할 수 없다.
      void previous.evaluate(() => {
        const stamp = document.__cheongeumDocument;
        if (stamp !== undefined) stamp.revision++;
      }).catch(() => {});
    }
    this.page = page;
    for (const pages of this.#taskPages) pages.add(page);
    this.#tabs?.changed();
    claimed.add(page);
    const load: PageLoad = { method: "GET", fetching: new Map(), tab: randomUUID(), docSeq: 0 };
    this.#loads.set(page, load);
    if (this.#options.visualCursor === true) {
      // Redirections and new tabs can finish loading after the triggering action has returned.
      const restore = () => {
        if (!this.#closed && this.page === page) void this.#restCursor(page).catch(() => {});
      };
      page.on("domcontentloaded", restore);
      if (previous !== undefined) restore();
    }
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) load.docSeq++; });
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
    page.on("dialog", dialog => this.#onDialog(page, load, dialog));
    page.on("close", () => {
      this.#loads.delete(page);
      if (this.page === page) this.page = [...this.#loads.keys()].at(-1);
    });
    page.on("download", download => { void this.#saveDownload(download).catch(() => {}); });
  }

  /**
   * 사이트의 경고창·확인창. 늘 닫고, 닫은 글은 다음 관찰의 오류 줄로만 알린다.
   * 지금 실행 중인 조작이 실제로 누르다가 띄운 confirm() 창이면 그 조작의 이름으로 기록해 둔다(대신 답할지는 사용자에게 묻는다).
   * 같은 조작을 사용자가 다시 확인해 허가가 붙은 실행에서는, 실제로 누르는 동안 처음 뜬 창 하나만, 그것이 탭·문서·주소·글 전체(해시와 길이)가 기록과 모두 같은 confirm()일 때 받아 준다.
   * 처음 뜬 창이 다른 질문이면 허가는 그 자리에서 버려져 뒤이어 같은 글이 떠도 받지 않는다.
   * 그 밖의 창(누르는 동안이 아닐 때 뒤늦게 뜬 것, 글이 다른 것, alert·prompt·beforeunload, 두 번째 창)은 허가가 있어도 취소하고, 멈춤이 걸렸으면 받지 않는다.
   */
  #onDialog(page: Page, load: PageLoad, dialog: Dialog): void {
    const message = dialog.message();
    const confirm = dialog.type() === "confirm";
    if (!confirm) this.#nativeDialogs.push(Array.from(message).slice(0, 200).join(""));
    const flight = this.#flights.get(page);
    const live = flight !== undefined && flight.open && flight.revoked !== true && !flight.signal.aborted;
    if (flight === undefined || !live) {
      if (flight?.arm !== undefined) flight.arm.used = true;
      void dialog.dismiss().catch(() => {});
      return;
    }
    const url = page.url();
    const requested = flight.requested;
    if (requested !== undefined) {
      flight.requested = undefined;
      if (confirm && this.page === page && requested.document === load.docSeq && requested.url === url &&
          confirmsClick(message, requested.target, requested.userCommand)) {
        flight.acceptance = dialog.accept().then(() => true, () => false);
        return;
      }
    }
    const document = String(load.docSeq);
    const hash = createHash("sha256").update(message, "utf8").digest("hex");
    const length = Array.from(message).length;
    const arm = flight.arm;
    if (arm !== undefined && !arm.used) {
      // 첫 창이 허가를 쓴다. 맞으면 받아 주고, 맞지 않으면 허가는 버려진다.
      arm.used = true;
      if (confirm && this.page === page && performance.now() <= arm.until && arm.grant.tab === load.tab && arm.grant.document === document && arm.grant.url === url &&
        arm.grant.hash === hash && arm.grant.length === length && load.docSeq === arm.docSeq) {
        flight.acceptance = dialog.accept().then(() => true, () => false);
        return;
      }
    }
    if (confirm) {
      flight.seen.cancelled.push({
        tab: load.tab, document, url, hash, length, actionId: flight.actionId,
        preview: Array.from(message).slice(0, 200).join(""), risk: nativeMessageRisk(message),
      });
    }
    void dialog.dismiss().catch(() => {});
  }

  /** 이 조작 중에 취소했거나 받아 준 confirm() 창. 한 번만 가져갈 수 있다. */
  takeNative(actionId: string): NativeSeen | undefined {
    const seen = this.#nativeSeen.get(actionId);
    this.#nativeSeen.delete(actionId);
    return seen;
  }

  /** 이 조작이 confirm() 창을 겪었는지 가져가지 않고 본다(시간이 넘은 조작을 다시 하기 전에, 이미 물었던 조작이면 다시 하지 않으려고). */
  peekNative(actionId: string): NativeSeen | undefined {
    return this.#nativeSeen.get(actionId);
  }

  /** 대신 답할 수 있는 기록을 모두 버린다(멈춤·거절·세션 정리). 지금 실행 중인 조작에 걸린 허가도 그 자리에서 버린다. */
  dropNative(): void {
    this.#nativePending.clear();
    this.#nativeSeen.clear();
    for (const flight of this.#flights.values()) {
      flight.revoked = true;
      if (flight.arm !== undefined) flight.arm.used = true;
    }
  }

  /**
   * 허가를 어댑터가 가진 기록과 맞춰 보고 이번 조작 한 번에만 건다. 기록은 맞든 틀리든 지금 지운다(한 번만).
   * 기록이 없거나 낡았거나, 처음 눌렀던 조작·탭·문서·주소·글이 하나라도 다르거나, 소리로 다 읽어 줄 수 없는 질문이면 거절한다.
   */
  #arm(action: Action, grants: ExecuteGrants, inspection: InspectionBinding | undefined, page: Page): NativeArm {
    const grant = grants.native;
    const pending = this.#nativePending.get(action.id);
    this.#nativePending.delete(action.id);
    const load = this.#loads.get(page);
    if (grant === undefined || pending === undefined || load === undefined || inspection !== undefined || grants.notice !== undefined ||
      action.type !== "click" || action.target?.ref === undefined || !isDeepStrictEqual(pending.target, action.target) ||
      performance.now() > pending.until || pending.record.risk !== "routine" || pending.record.tab !== load.tab ||
      pending.record.document !== String(load.docSeq) || pending.record.url !== page.url() || !sameNative(pending.record, grant)) {
      throw new AdapterError("VERIFY_FAILED", "사이트가 물은 질문이 바뀌었거나 확인할 수 없어서 대신 답하지 않았어요.");
    }
    return {
      grant: { tab: grant.tab, document: grant.document, url: grant.url, hash: grant.hash, length: grant.length },
      used: false, until: pending.until, docSeq: load.docSeq,
    };
  }

  /**
   * 허가를 쓰는 누르기 직전(기다림과 커서 움직임이 끝난 뒤)에 다시 확인한다. 그 사이 문서가 바뀌었거나 기록이 낡았거나 멈춤·거절로 허가가 버려졌으면 누르지 않는다.
   * 누른 뒤에 어긋나는 것은 #onDialog가 창마다 다시 맞춰 보고 받지 않는다.
   */
  #armHolds(page: Page, flight: Flight | undefined): void {
    const arm = flight?.arm;
    if (arm === undefined) throw new AdapterError("VERIFY_FAILED");
    const load = this.#loads.get(page);
    if (arm.used || flight?.signal.aborted === true || this.page !== page || load === undefined || load.docSeq !== arm.docSeq || load.tab !== arm.grant.tab ||
      page.url() !== arm.grant.url || performance.now() > arm.until) {
      throw new AdapterError("VERIFY_FAILED", "사이트가 물은 질문이 바뀌었거나 확인할 수 없어서 대신 답하지 않았어요.");
    }
  }

  /** 실제로 누르거나 입력하는 동안만 confirm() 창을 이 조작이 띄운 것으로 본다. */
  async #acting<T>(page: Page, work: () => Promise<T>): Promise<T> {
    const flight = this.#flights.get(page);
    if (flight === undefined) return work();
    flight.open = true;
    try { return await work(); }
    finally { flight.open = false; }
  }

  /** 조작이 끝난 뒤 그동안 겪은 confirm() 창을 남긴다. 처음 누른 것이고 소리로 다 읽어 줄 수 있는 질문 하나뿐이면 다시 확인받을 때 쓸 기록도 만든다. */
  #noteNative(flight: Flight, action: Action, inspection: InspectionBinding | undefined, grants: ExecuteGrants | undefined): void {
    const seen = flight.seen;
    if (flight.revoked === true || flight.signal.aborted || (seen.cancelled.length === 0 && !seen.accepted)) return;
    this.#nativeSeen.set(action.id, seen);
    trimmed(this.#nativeSeen);
    const [only] = seen.cancelled;
    if ((grants === undefined || grants.plan !== undefined) && inspection === undefined && action.type === "click" && action.target?.ref !== undefined &&
      seen.cancelled.length === 1 && only !== undefined && only.risk === "routine") {
      this.#nativePending.set(action.id, { record: only, target: structuredClone(action.target), until: performance.now() + NATIVE_PENDING_MS });
      trimmed(this.#nativePending);
    }
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

  #driver(page: Page): PageDriver {
    const existing = this.#drivers.get(page);
    if (existing !== undefined) return existing;
    const create = this.#options.createPageDriver ?? ((this.#options.driver ?? attachedDriver(page)) === "stagehand" ? stagehandDriver : playwrightDriver);
    const driver = create(page, this.#actionTimeout);
    this.#drivers.set(page, driver);
    return driver;
  }

  frameOrigins(ref: string) { return framesOf(this.#requirePage()).origins(ref); }
  documentId(): string | undefined {
    const page = this.page;
    return page === undefined || page.isClosed() ? undefined : framesOf(page).documentId();
  }
  hasOpaqueContent() { return framesOf(this.#requirePage()).hasOpaqueContent(); }
  async loginSubmitTarget(url: string, signal: AbortSignal): Promise<ActionTarget | undefined> {
    const page = this.#requirePage();
    const document = this.#loads.get(page)?.docSeq;
    const found = await call(signal, () => this.#driver(page).controlWindow({loginSubmit:true, limit:40}));
    if (found.more || document === undefined || this.page !== page || found.url !== url || page.url() !== url || this.#loads.get(page)?.docSeq !== document) return;
    const rank = Math.min(...found.items.map(item => item.loginSubmit?.rank ?? Infinity));
    const best = found.items.filter(item => item.loginSubmit?.rank === rank);
    const item = best[0];
    if (best.length !== 1 || item?.loginSubmit === undefined) return;
    const target = {ref:item.ref, role:item.role, name:item.name};
    this.#targetDocuments.set(target, {page, document, login:item.loginSubmit.signature});
    return target;
  }
  async #verifyLoginSubmit(page: Page, target: ActionTarget, signature: string, signal: AbortSignal) {
    const found = await call(signal, () => this.#driver(page).controlWindow({ref:target.ref, loginSubmit:true, limit:1}));
    const item = found.items[0];
    if (found.more || !item || item.disabled || item.ref !== target.ref || item.role !== target.role || item.name !== target.name ||
      item.loginSubmit?.signature !== signature || !item.loginSubmit.filled) throw new AdapterError("VERIFY_FAILED");
  }
  get findByMeaning(): PageDriver["findByMeaning"] {
    const page = this.page;
    if (page === undefined) return undefined;
    const driver = this.#driver(page);
    const find = driver.findByMeaning;
    if (find === undefined) return undefined;
    const document = this.#loads.get(page)?.docSeq;
    return async (name, linksOnly, url, picker, signal) => {
      const result = await find.call(driver, name, linksOnly, url, picker, signal);
      return this.page === page && page.url() === url && this.#loads.get(page)?.docSeq === document ? result : undefined;
    };
  }

  get bindTarget(): PageDriver["bindTarget"] {
    const page = this.page;
    if (page === undefined) return undefined;
    const driver = this.#driver(page);
    const bind = driver.bindTarget;
    if (bind === undefined) return undefined;
    const document = this.#loads.get(page)?.docSeq;
    return async (target, signal, optionLabel) => {
      const before = this.#targetDocuments.get(target);
      if (before !== undefined && (before.page !== page || before.document !== document)) throw new AdapterError("VERIFY_FAILED");
      const result = await bind.call(driver, target, signal, optionLabel);
      if (this.page !== page || this.#loads.get(page)?.docSeq !== document) throw new AdapterError("VERIFY_FAILED");
      this.#targetDocuments.set(result, {page, document, login:before?.login});
      return result;
    };
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
    const raw = await this.#driver(page).observe(signal);
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

  /**
   * grants: 이 한 번의 조작에만 붙는 허가(안내 팝업 증명·confirm() 답). 정책 검사를 통과한 뒤에도 어댑터가 새 관찰과 자기 기록으로 다시 확인하고,
   * 맞지 않으면 누르지 않는다(VERIFY_FAILED). 허가가 있는 조작은 어느 경로로도 다시 하지 않는다.
   */
  async execute(action: Action, signal = new AbortController().signal, inspection?: InspectionBinding, grants?: ExecuteGrants): Promise<ActionResult> {
    const started = performance.now();
    const done = (result: Omit<ActionResult, "actionId" | "latencyMs">) => ({
      actionId: action.id, latencyMs: Math.trunc(performance.now() - started), ...result,
    });
    if (signal.aborted) return done({ ok: false, verified: false, errorCode: "ABORTED" });
    let page: Page | undefined;
    let flight: Flight | undefined;
    try {
      await raceAbort(() => this.start(), signal);
      page = this.#requirePage();
      const current = page;
      flight = { actionId: action.id, signal, open: false, seen: { cancelled: [], accepted: false } };
      const load = this.#loads.get(current);
      if (grants?.requestedClick !== undefined && load !== undefined) flight.requested = {
        url: current.url(), document: load.docSeq, target: action.target?.name ?? "", userCommand: grants.requestedClick === "command",
      };
      if (grants?.native !== undefined) flight.arm = this.#arm(action, grants, inspection, current);
      this.#flights.set(current, flight);
      const result = await raceAbort(async active => {
        const result = inspection === undefined
          ? await this.#perform(current, action, active, undefined, grants)
          : await this.withInspection(async () => {
            const state = this.#inspectionRequests;
            const before = state?.blocked;
            const completed = await this.#perform(current, action, active, inspection, grants);
            if (inspection.kind === "control" && inspection.control.kind === "ambiguous" && state?.blocked !== before) {
              throw new AdapterError("NOT_SUPPORTED", "화면을 확인하는 범위를 벗어난 사이트 동작을 막았어요.");
            }
            return completed;
          });
        if (this.#options.visualCursor === true && result.ok) await this.#restCursor(this.#requirePage(), active);
        return result;
      }, signal);
      if (flight.arm !== undefined || flight.acceptance !== undefined) {
        flight.seen.accepted = await flight.acceptance === true;
        if (!flight.seen.accepted) throw new AdapterError("VERIFY_FAILED", "앞서 확인한 사이트 질문에 답했는지 확인하지 못했어요. 화면에서 직접 확인해 주세요.");
      }
      return done(result);
    } catch (error) {
      if (signal.aborted) {
        if (page !== undefined) await this.#stopLoading(page);
        return done({ ok: false, verified: false, errorCode: "ABORTED", message: "ABORTED" });
      }
      if (error instanceof AdapterError) return done({ ok: false, verified: false, errorCode: error.code, message: error.message });
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.message.includes("Timeout"));
      return done({ ok: false, verified: false, errorCode: timedOut ? "TIMEOUT" : action.type === "navigate" ? "NAVIGATION_FAILED" : "UNKNOWN" });
    } finally {
      if (flight !== undefined) {
        if (page !== undefined && this.#flights.get(page) === flight) this.#flights.delete(page);
        this.#tabs?.changed();
        this.#noteNative(flight, action, inspection, grants);
      }
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
    const load = this.#loads.get(page);
    if (load !== undefined && (this.#options.driver ?? attachedDriver(page)) === "stagehand") {
      const network = load.network ??= watchPageLoad(page, load).catch((error: unknown) => { load.network = undefined; throw error; });
      await call(signal, () => network);
    }
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

  async #perform(page: Page, action: Action, signal: AbortSignal, inspection?: InspectionBinding, grants?: ExecuteGrants): Promise<Completed> {
    signal.throwIfAborted();
    const { type, target } = action;
    const bound = target === undefined ? undefined : this.#targetDocuments.get(target);
    const verifyDocument = () => {
      if (bound !== undefined && (this.page !== page || bound.page !== page || bound.document !== this.#loads.get(page)?.docSeq)) {
        throw new AdapterError("VERIFY_FAILED");
      }
    };
    verifyDocument();
    const opts = { timeout: this.#actionTimeout, signal };
    if (inspection !== undefined && inspection.kind !== "start" && page.url() !== inspection.url) {
      throw new AdapterError("VERIFY_FAILED");
    }
    // 허가는 ref로 가리킨 요소를 누르는 조작에만, 하나씩만 붙는다. 화면 확인 범위와는 함께 쓰지 않는다.
    if (grants !== undefined && (type !== "click" || target?.ref === undefined || inspection !== undefined ||
      [grants.notice, grants.native, grants.plan, grants.requestedClick].filter(grant => grant !== undefined).length !== 1)) throw new AdapterError("VERIFY_FAILED");
    if (inspection?.kind === "search") {
      const fresh = await call(signal, () => this.inspectionSearch(inspection.fieldId));
      if (this.page !== page || type !== "press" || fresh === undefined || !matchesInspectionSearchTarget(target, inspection.fieldId, fresh.field) ||
        fresh.signature !== inspection.signature || fresh.url !== inspection.url ||
        fresh.destination !== inspection.destination || fresh.parameter !== inspection.parameter ||
        !isInspectionUrl(fresh.destination) || !this.#mayLoad(fresh.destination)) throw new AdapterError("VERIFY_FAILED");
      const url = new URL(fresh.destination);
      url.search = "";
      url.searchParams.set(fresh.parameter, action.value ?? "");
      if (!isInspectionUrl(url.href)) throw new AdapterError("NOT_SUPPORTED");
      verifyDocument();
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
    const driver = this.#driver(page);
    if (type === "scroll") {
      if (target === undefined) await driver.scroll(signal);
      else {
        const element = await this.#resolve(driver, target, signal);
        await element.scroll();
        if (this.#options.visualCursor === true) await this.#showCursor(page, element, "move", signal);
      }
      return ok;
    }
    if (type === "click" && target?.ref === undefined && target?.role === "link" && target.name !== undefined) {
      if (await this.#linkFallback(page, target.name, signal)) return ok;
    }
    let element = await this.#resolve(driver, target, signal);
    if (inspection?.kind === "control" && inspection.control.kind === "blocked") throw new AdapterError("NOT_SUPPORTED");
    if (inspection?.kind === "control" && inspection.control.kind === "navigation") {
      if (this.#options.visualCursor === true) await this.#showCursor(page, element, "move", signal);
      await this.#verifyInspectionControl(page, inspection, target, signal);
      const href = inspection.control.href;
      if (!isInspectionUrl(href) || !this.#mayLoad(href)) throw new AdapterError("NOT_SUPPORTED");
      // Read a native link's destination without dispatching a page click handler.
      verifyDocument();
      await this.#open(page, href, signal);
      return ok;
    }
    if (this.#options.visualCursor === true && type !== "read") {
      await this.#showCursor(page, element, CURSOR_MODE[type] ?? "move", signal);
    }
    if (target?.ref !== undefined && type !== "read" && (this.#options.visualCursor === true || type === "click")) {
      // Waiting for actionability can outlast the identity check. A relabelled
      // button must be rejected before the real click, including after cursor motion.
      if (type === "click") await element.waitForClick();
      element = await this.#resolve(driver, target, signal);
    }
    if (inspection?.kind === "control") {
      await this.#verifyInspectionControl(page, inspection, target, signal);
      if (inspection.control.kind === "disclosure") {
        verifyDocument();
        await element.toggleDisclosure();
        return ok;
      }
    }
    // 안내 팝업을 묻지 않고 닫는 누르기: 기다림과 커서 움직임이 모두 끝난 지금, 누르기 직전에 팝업을 새로 읽어 증명과 같을 때만 누른다.
    // confirm() 질문에 답하는 누르기도 같은 자리에서 허가가 아직 살아 있는지 다시 확인한다.
    if (grants?.plan !== undefined) {
      const proof = grants.plan;
      const fresh = await call(signal, () => this.controlWindow(proof.step.name, 0, { exact: true, inspection: true }));
      const [item] = fresh.items;
      if (this.page !== page || !boundPlanClick(proof, action, page.url()) || fresh.url !== proof.url || fresh.more || fresh.items.length !== 1 ||
          item?.ref !== proof.ref || item.disabled || item.role !== proof.step.role || item.name !== proof.step.name ||
          !planControlAllowed(item.role, item.name) || (item.inspection?.href !== undefined && !isInspectionUrl(item.inspection.href)) ||
          item.planSignature !== proof.signature) throw new AdapterError("VERIFY_FAILED");
      revokePlanClick(proof);
    }
    if (grants?.notice !== undefined) await this.#verifyNotice(page, grants.notice, target, signal);
    if (grants?.native !== undefined) this.#armHolds(page, this.#flights.get(page));
    if (bound?.login !== undefined && target !== undefined) {
      await this.#verifyLoginSubmit(page, target, bound.login, signal);
      if (driver.bindTarget === undefined && !isEmbeddedRef(target.ref)) element = embeddedElement(page, target, signal, this.#actionTimeout, element);
    }
    verifyDocument();
    switch (type) {
      case "click":
        // 아래 #acting 안(실제로 누르는 동안)에 뜬 confirm() 창만 이 조작의 것으로 본다.
        await this.#acting(page, () => element.click({ grants, inspection, login:bound?.login }));
        return ok;
      case "focus":
        await element.focus();
        return ok;
      case "press":
        await this.#acting(page, () => element.press(action.value === undefined || action.value === "" ? "Enter" : action.value));
        await optional(signal, () => page.waitForLoadState("domcontentloaded", opts));
        return ok;
      case "fill": {
        if (await element.fieldType() === "password") {
          throw new AdapterError("NOT_SUPPORTED", "비밀번호 입력란은 조작하지 않습니다.");
        }
        const value = action.value ?? "";
        await this.#acting(page, () => element.fill(value));
        const readValue = await element.inputValue();
        return { ok: true, verified: readValue === value, readValue };
      }
      case "select": {
        await this.#acting(page, () => element.select(action.value ?? ""));
        const readValue = await element.selectedLabel();
        return { ok: true, verified: readValue === action.value, readValue };
      }
      case "check": {
        const want = action.checked ?? false;
        await this.#acting(page, () => element.check(want));
        const checked = await element.isChecked();
        return { ok: true, verified: checked === want, readValue: checked ? "예" : "아니오" };
      }
      case "read":
        return { ...ok, readValue: await element.read() };
      case "capture":
        throw new AdapterError("NOT_SUPPORTED");
    }
  }

  /**
   * 링크 이름(화면 글자)과 접근성 이름이 다른 사이트(aria-label, "새창" 덧붙임 등)나 접힌 메뉴 속 링크:
   * 접근성 이름으로 못 찾을 때만 화면에 보이는 같은 이름의 링크 하나를 누르고, 보이지 않으면 그 링크 주소(http/https)로 이동한다.
   */
  async #linkFallback(page: Page, name: string, signal: AbortSignal): Promise<boolean> {
    const driver = this.#driver(page);
    if (await driver.hasVisibleLink(name, signal)) return false;
    const window = await this.controlWindow(name, 0, { exact: true });
    const links = window.items.filter(item => item.role === "link" && !isEmbeddedRef(item.ref));
    if (links.length > 1 || window.more) throw new AdapterError("AMBIGUOUS_TARGET");
    const [link] = links;
    if (link !== undefined) {
      let element = await this.#resolve(driver, link, signal);
      if (this.#options.visualCursor === true) {
        await this.#showCursor(page, element, "click", signal);
        element = await this.#resolve(driver, link, signal);
      }
      await this.#acting(page, () => element.click());
      return true;
    }
    const hidden = await driver.hiddenLinkUrls(name, signal);
    if (hidden.length > 1) throw new AdapterError("AMBIGUOUS_TARGET");
    const [href] = hidden;
    if (href === undefined || href === "") return false;
    let url;
    try { url = parseUrl(href, page.url()); } catch { return false; }
    if (!WEB_SCHEMES.includes(url.protocol)) return false;
    await call(signal, () => page.goto(url.href, { waitUntil: "domcontentloaded", timeout: this.#navigationTimeout, signal }));
    return true;
  }

  async #resolve(driver: PageDriver, target: ActionTarget | undefined, signal: AbortSignal): Promise<ResolvedElement> {
    signal.throwIfAborted();
    if (target === undefined) throw new AdapterError("TARGET_NOT_FOUND");
    const ref = target.ref;
    // 입력 칸의 식별자는 누를 수 있는 항목 목록에 없다. 연결한 구동기가 같은 칸을 다시 확인한다.
    if (ref === undefined || target.fieldId !== undefined && driver.bindTarget !== undefined) return driver.resolve(target, signal);
    const fresh = await call(signal, () => driver.controlWindow({ ref }));
    const item = fresh.items.find(it => it.ref === ref);
    if (item === undefined) throw new AdapterError("TARGET_NOT_FOUND");
    if (item.role !== target.role || item.name !== target.name) {
      throw new AdapterError("VERIFY_FAILED", "누르려던 요소의 이름이나 역할이 바뀌었습니다.");
    }
    return driver.resolve(driver.bindTarget === undefined ? { ref, role: item.role, name: item.name } : target, signal);
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

  /**
   * 안내 팝업 증명을 누르기 직전의 새 관찰과 맞춘다. 같은 탭·주소의 같은 요소(ref·역할·이름)가, 같은 팝업(제목·글 전체·단추·다른 조작 요소·입력 칸 수까지 증명에 담은 사실 그대로)에
   * 들어 있고, 지금 다시 같은 판정(isNotice)을 해도 안내일 때만 누른다. 팝업이 바뀌었거나 다시 읽지 못하면 누르지 않는다.
   */
  async #verifyNotice(page: Page, proof: NoticeProof, target: ActionTarget | undefined, signal: AbortSignal): Promise<void> {
    if (this.page !== page || page.url() !== proof.url || target?.ref !== proof.ref || target.role !== proof.role || target.name !== proof.name) {
      throw new AdapterError("VERIFY_FAILED", "안내 팝업이 바뀌어서 누르지 않았어요.");
    }
    const fresh = await call(signal, () => this.controlWindow("", 0, { ref: proof.ref, notice: true }));
    const [item] = fresh.items;
    if (fresh.url !== proof.url || fresh.items.length !== 1 || item === undefined || item.ref !== proof.ref || item.disabled ||
      item.role !== proof.role || item.name !== proof.name || item.notice === undefined || !isDeepStrictEqual(item.notice, proof.facts) ||
      !isNotice(item.notice, item)) {
      throw new AdapterError("VERIFY_FAILED", "안내 팝업이 바뀌어서 누르지 않았어요.");
    }
  }

  async inspectionSearch(fieldId: string) {
    return this.#driver(this.#requirePage()).inspectionSearch(fieldId);
  }

  /** 현재 문서에서 실제로 보이는 조작 대상만 적은 수씩 돌려준다. */
  async controlWindow(text = "", offset = 0, { ref, refs, exact = false, inspection, destination, notice, semanticOnly, spokenName, linksOnly }: {
    ref?: string; refs?: readonly string[]; exact?: boolean; inspection?: boolean; destination?: string; notice?: boolean; semanticOnly?: boolean;
    spokenName?: boolean; linksOnly?: boolean;
  } = {}): Promise<ControlWindow> {
    const page = this.#requirePage();
    const load = this.#loads.get(page);
    const document = load?.docSeq;
    // notice: ref로 찾은 단추가 팝업 안에 있으면 그 팝업의 사실을 새로 읽어 함께 돌려준다(ref가 있을 때만).
    const query = { text: [...text].slice(0, 100).join(""), offset: Math.max(0, offset), limit: ref === undefined ? refs?.length ?? 24 : 1,
      ref: ref ?? null, refs, exact, inspection, destination, semanticOnly, spokenName, linksOnly, notice: ref === undefined ? undefined : notice };
    const window = await this.#driver(page).controlWindow(query);
    // 팝업 사실에는 닫힌 shadow root까지 센 값이 들어간다. 못 읽으면 -1로 두어 안내로 보지 않는다.
    for (const item of window.items) {
      if (item.planSignature !== undefined) {
        item.planSignature = load !== undefined && this.page === page && page.url() === window.url && load.docSeq === document
          ? JSON.stringify([load.tab, document, item.planSignature]) : undefined;
      }
      if (item.notice !== undefined) {
        const shadows = await this.#shadowRoots(page, item.notice.root);
        const current = this.page === page && load !== undefined && load.docSeq === document && page.url() === window.url;
        item.notice.shadows = current ? shadows : -1;
        if (current) item.notice.signature = JSON.stringify([load.tab, document, item.notice.signature]);
      }
    }
    return window;
  }

  /**
   * 팝업 몸통 안(iframe 문서와 열린·닫힌 shadow root까지)에 있는 shadow root의 수. 브라우저가 가진 DOM 정보(CDP)를 읽으므로 닫힌 root도 보인다.
   * 페이지의 스크립트는 거치지 않고, 읽은 노드의 값·속성은 쓰지 않으며(비밀번호 칸의 값도) 개수만 센다. 입력 상자가 쓰는 브라우저 내부 root(user-agent)는 세지 않는다.
   * 팝업을 찾지 못했거나 너무 크거나 CDP를 쓸 수 없는 브라우저면 -1을 돌려준다(속을 알 수 없으니 안내로 보지 않는다).
   */
  async #shadowRoots(page: Page, root: string): Promise<number> {
    if (!/^[\w-]{1,80}$/u.test(root)) return -1;
    let cdp: CDPSession | undefined;
    try {
      cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      const { root: top } = await cdp.send("DOM.getDocument", { depth: 0 });
      const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: top.nodeId, selector: `[data-cheongeum-ref="${root}"]` });
      const [nodeId] = nodeIds;
      if (nodeIds.length !== 1 || nodeId === undefined || nodeId === 0) return -1;
      const { node } = await cdp.send("DOM.describeNode", { nodeId, depth: -1, pierce: true });
      return shadowRootCount(node);
    } catch { return -1; }
    finally { await cdp?.detach().catch(() => {}); }
  }

  /** 새 문서에서도 마지막으로 가리킨 자리를 보여 준다. 첫 화면에만 제목이나 본문을 기준으로 삼는다. */
  async #restCursor(page: Page, signal = new AbortController().signal): Promise<void> {
    const point = callScript(restingCursor.toString(), this.#lastCursor ?? null);
    // Check and mount in one evaluation so a late load cannot overwrite a newer click or wait pose.
    await optional(signal, () => page.evaluate(`(p => { if (p) (${drawCursor.toString()})({...p, mode: "move"}); })(${point})`));
  }

  async #showCursor(page: Page, element: ResolvedElement, mode: CursorMode, signal: AbortSignal): Promise<void> {
    const box = await element.cursorBox(mode === "click");
    if (box == null) return;
    const evenRound = (value: number) => value % 2 === 0.5 ? Math.floor(value) : Math.round(value);
    const x = evenRound(box.x + box.width / 2), y = evenRound(box.y + box.height / 2);
    this.#lastCursor = { x, y };
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
    this.#tabs?.release();
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
    await Promise.allSettled([...this.#loads.values()].map(async load => (await load.network)?.detach()));
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
