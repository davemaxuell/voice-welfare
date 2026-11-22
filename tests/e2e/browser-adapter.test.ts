import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Browser, BrowserContext, Locator } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ACTION_TYPES, type Action } from "../../src/core/actions.ts";
import { ExecContext, WebExecutionAgent } from "../../src/agents/web/agent.ts";
import { createMockWelfareProfile } from "../../src/agents/web/profile.ts";
import { DownloadStore } from "../../src/agents/web/downloads.ts";
import { PlaywrightExecutionAdapter, closeLaunchedBrowser, launchBrowser, launchChromeProfile, stopPlaywright } from "../../src/agents/web/browser/index.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";

let browser: Browser;
const adapters: PlaywrightExecutionAdapter[] = [];
const cleanup: Array<() => Promise<unknown>> = [];
const portal = "http://127.0.0.1:5174/portal2.html";
beforeAll(async () => { browser = await launchBrowser(true); });
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
afterAll(() => stopPlaywright());

type AdapterOptions = ConstructorParameters<typeof PlaywrightExecutionAdapter>[0];
async function start(options: AdapterOptions = { browser, allowedOrigins: [], readOnlyWeb: true }) {
  const adapter = new PlaywrightExecutionAdapter(options);
  adapters.push(adapter);
  await adapter.start();
  if (adapter.page === undefined) throw new Error("Missing browser page");
  return { adapter, page: adapter.page };
}
function action(type: Action["type"], params: Partial<Action> = {}): Action {
  return { id: "test", type, risk: "low", reason: "browser test", requiresConfirmation: false, ...params };
}
async function temp() {
  const folder = await mkdtemp(join(tmpdir(), "cheongeum-browser-test-"));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  return folder;
}
async function formSite() {
  let posts = 0;
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/slow.js") {
      void delay(1500).then(() => { res.writeHead(200, { "Content-Type": "application/javascript" }); res.end("void 0"); });
      return;
    }
    if (path === "/download") {
      res.writeHead(200, { "Content-Disposition": 'attachment; filename="guide.txt"' });
      res.end("synthetic guide");
      return;
    }
    let title = path.slice(1), body = "";
    if (req.method === "POST") {
      posts++;
      req.resume();
      title = "보냄";
      body = '<form method="post" action="/submit2"><button id="go2">다음</button></form>';
    } else if (path === "/form") body = '<form method="post" action="/submit"><input name="q" value="x"><button id="go">보내기</button></form>';
    else if (path === "/slow") body = '<script src="/slow.js"></script>';
    else if (path === "/files") body = '<a href="/download">안내 파일</a>';
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>" + title + "</title><main><h1>" + title + "</h1>" + body + "</main>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("Missing server port");
  const close = async () => {
    if (!server.listening) return;
    await new Promise<void>((done, fail) => {
      server.close(error => error === undefined ? done() : fail(error)); server.closeAllConnections();
    });
  };
  cleanup.push(close);
  return { url: "http://127.0.0.1:" + addr.port, close, posts: () => posts };
}
async function formFixture() {
  const site = await formSite();
  const { adapter, page } = await start({ browser, allowedOrigins: [site.url], readOnlyWeb: true });
  const nav = (url: string) => adapter.execute(action("navigate", { url }));
  async function submit() {
    await nav(site.url + "/form");
    await page.locator("#go").click();
    await page.waitForURL("**/submit");
    expect(site.posts()).toBe(1);
  }
  return { site, adapter, page, nav, submit };
}
const dead = "http://127.0.0.1:9/";

it("test_back_onto_a_form_result_does_not_send_the_form_again", async () => {
  const { site, adapter, page, nav, submit } = await formFixture();
  await submit(); await nav(site.url + "/other");
  expect((await adapter.execute(action("back"))).errorCode).toBe("RESUBMIT_BLOCKED");
  expect(site.posts()).toBe(1);
  expect(page.url()).toBe(site.url + "/other");
});
it("test_back_through_ordinary_pages_still_works", async () => {
  const { site, adapter, page, nav } = await formFixture();
  await nav(site.url + "/a"); await nav(site.url + "/b");
  expect((await adapter.execute(action("back"))).ok).toBe(true);
  expect(page.url()).toBe(site.url + "/a");
});
it("test_failed_load_after_a_form_result_does_not_send_the_form_again", async () => {
  const { site, page, nav, submit } = await formFixture();
  await submit();
  expect((await nav(dead)).errorCode).toBe("NAVIGATION_FAILED");
  expect(site.posts()).toBe(1);
  expect(page.url()).toBe(site.url + "/submit");
});
it("test_failed_reload_of_the_current_page_does_not_jump_further_back", async () => {
  const { site, page, nav } = await formFixture(), other = await formSite();
  await nav(site.url + "/a"); await nav(other.url + "/x");
  await other.close();
  expect((await nav(other.url + "/x")).errorCode).toBe("NAVIGATION_FAILED");
  expect(page.url()).not.toBe(site.url + "/a");
});
it("test_back_still_works_after_a_failed_load", async () => {
  const { site, page, nav, adapter } = await formFixture();
  await nav(site.url + "/a"); await nav(site.url + "/b"); await nav(dead);
  expect(page.url()).toBe(site.url + "/b");
  expect((await adapter.execute(action("back"))).ok).toBe(true);
  expect(page.url()).toBe(site.url + "/a");
});
it("test_back_between_two_form_results_sends_neither_again", async () => {
  const { site, page, adapter, submit } = await formFixture();
  await submit(); await page.locator("#go2").click(); await page.waitForURL("**/submit2");
  expect((await adapter.execute(action("back"))).errorCode).toBe("RESUBMIT_BLOCKED");
  expect(site.posts()).toBe(2);
  expect(page.url()).not.toMatch(/^chrome-error:/u);
});
it("test_footer_text_is_the_site_footer_not_article_footers", async () => {
  const { adapter, page } = await start();
  const cards = Array.from({ length: 30 }, (_, n) => "<article><h2>소식 " + n + "</h2><footer>조회수 100</footer></article>").join("");
  await page.setContent("<main><h1>소식 목록</h1>" + cards + "</main><footer>대표번호 국번없이 1355</footer>");
  const footer = (await adapter.observe()).outline?.footerText;
  expect(footer).toContain("대표번호 국번없이 1355");
  expect(footer).not.toContain("조회수");
});

async function shared() {
  const ctx = await launchChromeProfile(await temp(), 0, undefined, { channel: "chromium", headless: true });
  cleanup.push(() => closeLaunchedBrowser(ctx));
  return ctx;
}
const options = (context: BrowserContext) => ({ context, allowedOrigins: [], readOnlyWeb: true });
it("test_closing_the_last_shared_tab_leaves_a_tab_for_the_next_session", async () => {
  const ctx = await shared();
  for (let i = 0; i < 2; i++) {
    const { page, adapter } = await start(options(ctx));
    expect(ctx.pages()).toEqual([page]);
    await adapter.close();
    expect(ctx.pages()).toHaveLength(1);
  }
});
it("test_two_shared_sessions_closing_at_once_leave_a_tab", async () => {
  const ctx = await shared(), [a, b] = await Promise.all([start(options(ctx)), start(options(ctx))]);
  expect(a.page).not.toBe(b.page);
  await Promise.all([a.adapter.close(), b.adapter.close()]);
  expect(ctx.pages()).toHaveLength(1);
});
it("test_closing_one_of_two_shared_sessions_closes_only_its_tab", async () => {
  const ctx = await shared(), a = await start(options(ctx)), b = await start(options(ctx));
  expect(ctx.pages()).toHaveLength(2);
  await a.adapter.close();
  expect(ctx.pages()).toEqual([b.page]);
});

it("test_a_page_that_answers_but_builds_slowly_counts_as_opened", async () => {
  const site = await formSite(), { page, adapter } = await start({ browser, allowedOrigins: [], readOnlyWeb: true, navigationTimeoutMs: 300 });
  expect((await adapter.execute(action("navigate", { url: site.url + "/slow" }))).ok).toBe(true);
  expect(page.url()).toBe(site.url + "/slow");
});
it("test_failed_load_returns_to_a_slow_previous_page_not_a_blank_one", async () => {
  const site = await formSite(), { page, adapter } = await start({ browser, allowedOrigins: [], readOnlyWeb: true, navigationTimeoutMs: 300 });
  await adapter.execute(action("navigate", { url: site.url + "/slow" }));
  expect((await adapter.execute(action("navigate", { url: dead }))).errorCode).toBe("NAVIGATION_FAILED");
  expect(page.url()).toBe(site.url + "/slow");
});
it("test_changed_element_is_not_clicked", async () => {
  const { page, adapter } = await start();
  await adapter.execute(action("navigate", { url: portal }));
  const item = (await adapter.observe()).outline?.items?.find(item => item.name === "관련 법령 보기");
  if (item === undefined) throw new Error("Missing portal link");
  await page.locator('[data-cheongeum-ref="' + item.ref + '"]').evaluate(el => { el.textContent = "회원 탈퇴"; });
  expect((await adapter.execute(action("click", { target: { ref: item.ref, role: item.role, name: item.name } }))).errorCode).toBe("VERIFY_FAILED");
  expect(await page.title()).toBe("[테스트] 복지 포털 2 - 보조기기 지원 상세");
});

it("멈춘 뒤에는 기다리던 클릭이 실행되지 않고 후속 페이지 호출도 없다", async () => {
  const { page, adapter } = await start();
  await page.setContent('<button data-testid="go" onclick="document.title=String(321)">신청</button><div id="cover" style="position:fixed;inset:0"></div>');
  // 화면에 가린 요소의 실제 클릭 또는 Stagehand 클릭 전 적중 검사를 기다릴 때 멈춘다.
  const button = page.locator("button");
  const locator = Object.getPrototypeOf(button) as Locator;
  const originalClick = locator.click;
  const signal = new AbortController();
  const callsAfterStop: PropertyKey[] = [];
  adapter.page = new Proxy(page, {
    get(original, key) {
      const method: unknown = Reflect.get(original, key);
      if (typeof method !== "function") return method;
      return (...args: unknown[]) => {
        if (signal.signal.aborted) callsAfterStop.push(key);
        return Reflect.apply(method, original, args);
      };
    },
  });
  let entered!: () => void;
  const clicking = new Promise<void>(done => { entered = done; });
  const call = vi.spyOn(locator, "click").mockImplementation(function (this: Locator, opts) {
    const pending = originalClick.call(this, opts); entered(); return pending;
  });
  const evaluations = vi.spyOn(page, "evaluate");
  const running = adapter.execute(action("click", { target: { testId: "go" } }), signal.signal);
  await clicking;
  await delay(80);
  signal.abort("멈춰");
  expect((await running).errorCode).toBe("ABORTED");
  await page.locator("#cover").evaluate(el => el.remove());
  await delay(250);
  expect(await page.title()).not.toBe("321");
  expect(call).toHaveBeenCalledTimes(1);
  expect(evaluations).not.toHaveBeenCalled();
  expect((await adapter.execute(action("click", { target: { testId: "go" } }), signal.signal)).errorCode).toBe("ABORTED");
  expect(call).toHaveBeenCalledTimes(1);
  // 멈춘 뒤에는 크롬에 이동 중단(CDP Page.stopLoading)만 보낸다.
  expect(callsAfterStop).toEqual(["context"]);
});

it("커서를 놓은 뒤 이름이 바뀐 단추를 누르지 않는다", async () => {
  const { page, adapter } = await start({ browser, allowedOrigins: [new URL(portal).origin], visualCursor: true });
  await adapter.execute(action("navigate", { url: portal }));
  expect(await page.locator("#__cheongeum_cursor").count()).toBe(1);
  await page.setContent('<main><button onclick="document.title=String(321)">예시 단추</button></main>');
  const item = (await adapter.observe()).outline?.items?.[0];
  if (item === undefined) throw new Error("Missing button");
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      if (document.getElementById("__cheongeum_cursor")?.dataset.mode !== "click") return;
      document.querySelector("button")!.textContent = "다른 단추";
      observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, attributes: true, attributeFilter: ["data-mode"], subtree: true });
  });
  const result = await adapter.execute(action("click", { target: { ref: item.ref, role: item.role, name: item.name } }));
  expect(result.errorCode).toBe("VERIFY_FAILED");
  expect(await page.title()).not.toBe("321");
});
it("입력·선택·체크와 암호 칸 보호를 실제 양식에서 확인한다", async () => {
  const { page, adapter } = await start();
  await page.setContent('<label>이름<input id="a"></label><input type="password" id="p" value="secret">' +
    '<select id="s"><option value="a">남</option><option value="b">여</option></select><input id="c" type="checkbox">' +
    '<button onclick="document.title=String(123)">누르기</button>');
  const run = (type: Action["type"], id: string, rest: Partial<Action> = {}) => adapter.execute(action(type, { target: { fieldId: id }, ...rest }));
  expect((await run("fill", "a", { value: "김하늘" })).readValue).toBe("김하늘");
  expect((await run("fill", "p", { value: "없음" })).errorCode).toBe("NOT_SUPPORTED");
  expect((await run("read", "p")).readValue).toBe("");
  expect((await run("select", "s", { value: "여" })).verified).toBe(true);
  expect((await run("read", "s")).readValue).toBe("여");
  expect((await run("check", "c", { checked: true })).readValue).toBe("예");
  expect((await adapter.execute(action("click", { target: { role: "button", name: "누르기" } }))).ok).toBe(true);
  expect(await page.title()).toBe("123");
});
it("다운로드를 지정 폴더에 저장하고 안내는 한 번만 읽는다", async () => {
  const folder = await temp(), store = new DownloadStore(folder), site = await formSite();
  const { adapter } = await start({ browser, downloads: store, allowedOrigins: [site.url] });
  await adapter.execute(action("navigate", { url: site.url + "/files" }));
  expect((await adapter.execute(action("click", { target: { role: "link", name: "안내 파일" } }))).ok).toBe(true);
  await vi.waitFor(() => expect(store.latest()?.name).toBe("guide.txt"));
  // 세션이 달라도 같은 이름의 파일을 덮어쓰지 않게 앞에 고유한 이름을 붙인다.
  const saved = store.latest()?.path ?? "";
  expect(saved.startsWith(folder) && saved.endsWith("-guide.txt")).toBe(true);
  expect(await readFile(saved, "utf8")).toBe("synthetic guide");
  expect(adapter.takeDownloadNotice()).toContain("'guide.txt'");
  expect(adapter.takeDownloadNotice()).toBeUndefined();
});
it("허용하지 않은 출처의 탐색을 차단한다", async () => {
  const site = await formSite(), other = await formSite();
  const { adapter, page } = await start({ browser, allowedOrigins: [site.url] });
  expect((await adapter.execute(action("navigate", { url: site.url + "/a" }))).ok).toBe(true);
  expect((await adapter.execute(action("navigate", { url: other.url + "/blocked" }))).errorCode).toBe("NAVIGATION_FAILED");
  expect(page.url()).toBe(site.url + "/a");
});

it("현재 사이트의 저장소와 쿠키만 지우고 다른 사이트의 쿠키는 보존한다", async () => {
  const site = await formSite();
  const { page, adapter } = await start({ browser, allowedOrigins: [site.url] });
  await adapter.execute(action("navigate", { url: site.url + "/a" }));
  await page.context().addCookies([{ name: "ours", value: "yes", url: site.url }, { name: "other", value: "yes", url: "http://elsewhere.invalid" }]);
  await page.evaluate(() => { localStorage.setItem("login", "1"); sessionStorage.setItem("login", "1"); });
  expect(await adapter.clearSiteLogin()).toEqual(["127.0.0.1"]);
  expect((await page.context().cookies()).map(c => c.name)).toEqual(["other"]);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

it("공유 브라우저에서 각 세션은 자신이 연 팝업만 따라간다", async () => {
  const ctx = await shared(), a = await start(options(ctx)), b = await start(options(ctx));
  await a.page.setContent('<a href="about:blank" target="_blank">팝업</a>');
  const [popup] = await Promise.all([ctx.waitForEvent("page"), a.page.locator("a").click()]);
  await vi.waitFor(() => expect(a.adapter.page).toBe(popup));
  expect(b.adapter.page).toBe(b.page);
  await popup.close();
  await vi.waitFor(() => expect(a.adapter.page).toBe(a.page));
});

it("distinguishes native navigation from an ambiguous link and a disguised form submit", async () => {
  const { adapter, page, site, nav } = await formFixture();
  const home = site.url + "/inspection";
  await nav(home);
  await page.setContent(`
    <a id="link" href="/guide">안내</a>
    <a href="/details" data-action="toggle-details">자세히 보기</a>
    <form method="post" action="/submit"><button>다음</button></form>
    <details><summary>펼치기</summary><p>추가 설명</p></details>
  `);
  await page.locator("#link").evaluate(el => el.addEventListener("click", () => sessionStorage.setItem("click-fired", "yes")));
  const seen = await adapter.controlWindow("", 0, { inspection: true });
  for (const [name, kind] of [["안내", "navigation"], ["자세히 보기", "ambiguous"], ["다음", "blocked"], ["펼치기", "disclosure"]]) {
    expect(seen.items.find(item => item.name === name)?.inspection?.kind, name).toBe(kind);
  }
  const link = seen.items.find(item => item.name === "안내")!;
  const click = action("click", { target: { ref: link.ref, role: link.role, name: link.name } });
  const proof = { kind: "control", url: home, ref: link.ref, control: link.inspection! } as const;
  await page.locator("#link").evaluate(el => el.setAttribute("data-confirm", "위험"));
  expect(await adapter.execute(click, undefined, proof)).toMatchObject({ ok: false, errorCode: "VERIFY_FAILED" });
  await page.locator("#link").evaluate(el => el.removeAttribute("data-confirm"));
  expect(await adapter.execute(click, undefined, proof)).toMatchObject({ ok: true, verified: true });
  expect(page.url()).toBe(site.url + "/guide");
  expect(await page.evaluate(() => sessionStorage.getItem("click-fired"))).toBeNull();
});

it("reads a verified same-site search form as a GET without filling or submitting the page", async () => {
  const { adapter, page, site, nav } = await formFixture();
  const home = site.url + "/inspection";
  await nav(home);
  await page.setContent(`
    <form id="search" method="get" action="/search">
      <label for="q">검색</label><input id="q" type="search" name="q"><button>찾기</button>
    </form>
  `);
  const search = await adapter.inspectionSearch("q");
  expect(search).toMatchObject({ url: home, destination: site.url + "/search", parameter: "q" });
  const proof = { kind: "search", fieldId: "q", ...search! } as const;
  const run = () => adapter.execute(action("press", { target: { fieldId: "q", role: "searchbox" }, value: "배송 안내" }), undefined, proof);
  await page.locator("#search").evaluate(el => el.insertAdjacentHTML("beforeend", '<input type="hidden" name="account" value="123">'));
  expect(await adapter.inspectionSearch("q")).toBeUndefined();
  expect(await run()).toMatchObject({ ok: false, errorCode: "VERIFY_FAILED" });
  await page.locator("input[type=hidden]").evaluate(el => el.remove());
  await page.locator("#search").evaluate(el => el.addEventListener("submit", () => sessionStorage.setItem("submit-fired", "yes")));
  expect(await run()).toMatchObject({ ok: true, verified: true });
  expect(new URL(page.url()).searchParams.get("q")).toBe("배송 안내");
  expect(await page.evaluate(() => sessionStorage.getItem("submit-fired"))).toBeNull();
  expect(site.posts()).toBe(0);
});

it("Stagehand 개인 조회 검색은 같은 칸과 양식을 다시 확인하고 GET으로만 이동한다", async () => {
  const site = await formSite(), home = site.url + "/inspection";
  const stagehand = await launchBrowser(true, 0, "stagehand");
  cleanup.push(() => closeLaunchedBrowser(stagehand));
  const { adapter, page } = await start({ browser: stagehand, driver: "stagehand", allowedOrigins: [], readOnlyWeb: true });
  await page.goto(home);
  const form = `<form method="get" action="/search" onsubmit="sessionStorage.setItem('사용', '제출')">
    <label for="q">검색어</label><input id="q" name="q" type="search" oninput="sessionStorage.setItem('사용', '입력')"
    onkeydown="sessionStorage.setItem('사용', '키')"><button>찾기</button></form>`;
  await page.setContent(form);
  const guard = new PolicyGuard({ allowedOrigins: [], allowedActionTypes: ACTION_TYPES, allowedFieldIds: [], secretFieldIds: [],
    maxActionsPerTurn: 12, readOnlyWeb: true });
  const web = new WebExecutionAgent(adapter, guard, createMockWelfareProfile("http://localhost:5174"));
  const ctx = new ExecContext({ browsingScope: "personal-inspection", isStopped: () => false, signal: new AbortController().signal, trace() {} });
  const search = () => web.withInspection(ctx, () => web.search("배송 안내", ctx));
  const requests: string[] = [];
  page.on("request", req => { if (req.isNavigationRequest()) requests.push(req.method() + " " + req.url()); });
  const perform = adapter.execute.bind(adapter), execute = vi.spyOn(adapter, "execute");
  await web.observe(ctx);
  const proof = { kind: "search", fieldId: "q", ...(await adapter.inspectionSearch("q"))! } as const;
  const extra = action("press", { target: { fieldId: "q", role: "searchbox", nth: 0 }, url: proof.destination, value: "배송 안내" });
  expect(await web.run(extra, ctx, [], undefined, proof)).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();

  for (const change of [
    () => page.locator("label").evaluate(el => { el.textContent = "다른 칸"; }),
    () => page.locator("input").evaluate(el => el.replaceWith(el.cloneNode(true))),
    () => page.locator("form").evaluate(el => el.setAttribute("action", "/other")),
  ]) {
    execute.mockImplementationOnce(async (...args) => { await change(); return perform(...args); });
    const result = await search();
    expect(result.actions[0]).toMatchObject({ policy: { code: "ALLOWED_INSPECTION" }, result: { ok: false, errorCode: "VERIFY_FAILED" } });
    expect(page.url()).toBe(home);
    await page.setContent(form);
  }
  const result = await search();
  expect(result.status).toBe("ok");
  const [checked, , binding] = execute.mock.lastCall!;
  expect(binding?.kind).toBe("search");
  expect(checked.target).toEqual({ fieldId: "q", role: "searchbox", ref: expect.any(String), name: "검색어", label: "검색어" });
  expect(binding).toMatchObject({ field: { ref: checked.target?.ref, name: "검색어" } });
  const destination = new URL("/search", site.url);
  destination.searchParams.set("q", "배송 안내");
  expect(requests).toEqual(["GET " + destination.href]);
  expect(await page.evaluate(() => sessionStorage.getItem("사용"))).toBeNull();
  expect(site.posts()).toBe(0);
});

it("holds the inspection request guard through delayed page effects and releases it for the resident", async () => {
  const { adapter, page, site, nav } = await formFixture();
  const url = site.url + "/inspection";
  await nav(url);
  await page.setContent('<button id="more" type="button">더 보기</button><p id="result"></p>');
  await page.locator("#more").evaluate(el => el.addEventListener("click", () => {
    setTimeout(() => {
      void fetch("/interaction", { method: "POST" }).then(
        () => { document.querySelector("#result")!.textContent = "sent"; },
        () => { document.querySelector("#result")!.textContent = "blocked"; },
      );
    }, 300);
  }));
  const [item] = (await adapter.controlWindow("더 보기", 0, { inspection: true })).items;
  expect(item?.inspection?.kind).toBe("ambiguous");
  const click = action("click", { target: { ref: item!.ref, role: item!.role, name: item!.name } });
  await adapter.withInspection(async () => {
    await adapter.execute(click, undefined, { kind: "control", url, ref: item!.ref, control: item!.inspection! });
    await page.getByText("blocked", { exact: true }).waitFor();
    expect(site.posts()).toBe(0);
  });
  await page.locator("#more").click();
  await page.getByText("sent", { exact: true }).waitFor();
  expect(site.posts()).toBe(1);
});
