import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { Action } from "../../src/core/actions.ts";
import { browserCases, latch } from "./browser-cases.ts";

const open = browserCases(), resultText = "기초연금 신청 방법은 주민센터와 국민연금공단에서 안내합니다.";
const pages: Record<string, string> = {
  "/page": "<title>느린 화면</title><body><main><h1>느린 화면</h1><p>본문입니다.</p></main><script src=\"/slow.js\"></script></body>",
  "/home": "<title>늦는 누리집</title><body><main><h1>늦는 누리집</h1><form action=\"/results\"><input type=\"search\" name=\"q\" aria-label=\"검색어\"><button>검색</button></form></main></body>",
  "/post-home": "<title>양식 검색 누리집</title><body><main><h1>양식 검색 누리집</h1><form method=\"post\" action=\"/results\"><input type=\"search\" name=\"q\" aria-label=\"검색어\"><button>검색</button></form></main></body>",
  "/no-search": "<title>검색</title><main><input type=\"search\"><p>첫 화면입니다.</p></main>",
  "/inline": "<title>검색</title><main><input type=\"search\" onkeydown=\"if(event.key==='Enter') document.querySelector('p').textContent='일치하는 결과가 없습니다.'\"><p>검색할 수 있습니다.</p></main>",
  "/results": "<title>검색 결과</title><body><nav><a href=\"/home\">처음</a> <a href=\"/notice\">공지사항</a></nav><main><h1>검색 결과</h1><div id=\"list\"></div></main><script>fetch('/data').then((r) => r.json()).then((d) => { document.getElementById('list').innerHTML = '<p>' + d.text + '</p>'; });</script></body>"
};
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function site(holdResults = false) {
  const script = latch(), data = latch(), request = latch(), hits = new Map<string, number>();
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname, id = (req.method === "POST" ? "POST " : "") + path;
    hits.set(id, (hits.get(id) ?? 0) + 1);
    let html = pages[path] ?? `<title>빠른 화면</title><body><main><h1>빠른 화면</h1><p>${path}</p></main><script src="/lib.js"></script></body>`;
    let mime = "text/html; charset=utf-8", cache = "no-store";
    if (path === "/slow.js") { request.resolve(); await script.promise; html = "document.title = document.title;"; mime = "application/javascript"; }
    else if (path === "/lib.js") { html = "window.lib = 1;"; mime = "application/javascript"; cache = "max-age=3600"; }
    else if (path === "/data" || path === "/next-result") {
      await (holdResults ? data.promise : delay(2_000)); html = JSON.stringify({text: resultText}); mime = "application/json";
    } else if (path === "/results" && holdResults) {
      // Keep a second part of the results outstanding through the native 12-second search wait.
      html += "<script>setTimeout(()=>fetch('/next-result'),7000)</script>";
    }
    if (!res.destroyed) {res.writeHead(200, {"content-type": mime, "cache-control": cache}); res.end(mime.startsWith("text/html") ? "<!doctype html>" + html : html);}
  });
  // Keep the fixture in the migration's reserved local server range.
  const port = 18541;
  server.listen(port, "127.0.0.1"); await once(server, "listening");
  cleanups.push(async () => {script.resolve(); data.resolve(); const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed;});
  return {url: "http://127.0.0.1:" + port, hits, script, data, request};
}
let serial = 0;
function action(type: Action["type"], url?: string): Action {
  return {id: "slow-" + (++serial), type, url, reason: "test", risk: "low", requiresConfirmation: false};
}
async function adapterSite() {
  const slow = await site(), opened = await open({navigationTimeoutMs: 15_000});
  const wait = opened.page.waitForLoadState.bind(opened.page);
  vi.spyOn(opened.page, "waitForLoadState").mockImplementation((state, opts) =>
    wait(state, state === "domcontentloaded" && opts?.timeout === 15_000 ? {...opts, timeout: 500} : opts));
  return {...opened, ...slow};
}

it("test_back_onto_a_slow_page_is_done_when_the_page_answers", async () => {
  const {adapter, url, page} = await adapterSite();
  await adapter.execute(action("navigate", url + "/page")); await adapter.execute(action("navigate", url + "/fast"));
  expect((await adapter.execute(action("back"))).ok).toBe(true); expect(page.url()).toBe(url + "/page");
});
it("test_files_stay_cached_from_one_page_to_the_next", async () => {
  const {adapter, url, hits} = await adapterSite();
  await adapter.execute(action("navigate", url + "/fast")); await adapter.execute(action("navigate", url + "/fast2"));
  expect(hits.get("/fast")).toBe(1); expect(hits.get("/fast2")).toBe(1); expect(hits.get("/lib.js")).toBe(1);
});
it("test_returning_from_a_popup_restores_the_openers_pending_search", async () => {
  const {adapter, page, url} = await adapterSite(); await page.goto(url + "/fast");
  const started = latch(), release = latch();
  await page.route("**/held", async r => {started.resolve(); await release.promise; await r.fulfill({json: {}});});
  try {
    await page.evaluate(() => {void fetch("/held");}); await started.promise;
    expect((await adapter.observe()).loading).toBe(true);
    const popupEvent = page.waitForEvent("popup"); await page.evaluate(() => {window.open("/fast2");});
    const popup = await popupEvent; await popup.waitForLoadState("load");
    expect((await adapter.observe()).url).toBe(popup.url()); expect((await adapter.observe()).loading).toBeFalsy();
    await popup.close(); expect((await adapter.observe()).url).toBe(page.url()); expect((await adapter.observe()).loading).toBe(true);
  } finally {release.resolve();}
});
it("test_the_adapter_opens_web_addresses_only", async () => {
  const {adapter, page, url} = await adapterSite();
  const dir = await mkdtemp(join(tmpdir(), "cheongeum-slow-file-")); cleanups.push(() => rm(dir, {recursive:true, force:true}));
  const file = join(dir, "secret.txt"); await writeFile(file, "비밀");
  expect(await adapter.execute(action("navigate", url + "/fast"))).toMatchObject({ok: true, verified: true});
  expect((await adapter.execute(action("navigate", pathToFileURL(file).href))).ok).toBe(false);
  expect(page.url()).toBe(url + "/fast");
});
it("test_bokjiro_does_not_call_a_pending_result_a_completed_search", async () => {
  const {session, page} = await open(), ready = latch(), endpoint = "/ssis-tbu/TWZZ01000M/twatzzza/intgSearch/selectTwzzIntgSearchList.do";
  const results = pages["/results"]!.replace("/data", endpoint).replace("document.getElementById('list').innerHTML = '<p>' + d.text + '</p>';",
    "document.body.dataset.received='yes'; setTimeout(() => document.getElementById('list').textContent = d.text, 300);");
  await page.route("https://www.bokjiro.go.kr/**", async route => {
    const url = route.request().url(); if (url.includes(endpoint)) {await ready.promise; await route.fulfill({json: {text: resultText}});}
    else await route.fulfill({contentType: "text/html; charset=utf-8", body: url.includes("/results") ? results : pages["/home"]});
  });
  try {
    const result = await session.handleTurn("복지로에서 기초연금 검색해줘");
    expect(result.speech).toContain("아직 다 열리지 않았어요"); expect(result.speech).not.toContain("검색했어요");
  } finally { ready.resolve(); }
  await page.waitForFunction(() => document.body.dataset.received === "yes");
  expect((await session.handleTurn("본문 읽어줘")).speech).toContain(resultText);
});
it("test_search_waits_for_results_that_come_after_the_page", async () => {
  const {session} = await open(), {url} = await site(); await session.handleTurn(url + "/home 열어줘");
  const r = await session.handleTurn("기초연금 검색해줘"); expect(r.semanticAction).toBe("search"); expect(r.speech).toContain(resultText);
});
it("test_search_does_not_announce_success_on_an_unchanged_page", async () => {
  const {session} = await open(), {url} = await site(); await session.handleTurn(url + "/no-search 열어줘");
  const r = await session.handleTurn("기초연금 검색해줘");
  expect(r.speech).not.toContain("검색했어요"); expect(r.speech).toContain("확인하지 못했"); expect(r.observation?.url).toBe(url + "/no-search");
});
it("test_an_inline_empty_result_is_a_completed_search", async () => {
  const {session} = await open(), {url} = await site(); await session.handleTurn(url + "/inline 열어줘");
  const r = await session.handleTurn("기초연금 검색해줘"); expect(r.speech).toContain("검색했어요"); expect(r.speech).toContain("일치하는 결과가 없습니다");
});
it("test_search_says_results_are_not_in_yet_and_reading_waits_for_them", async () => {
  const {session} = await open(), {url, data} = await site(true); await session.handleTurn(url + "/home 열어줘");
  try {
    const r = await session.handleTurn("기초연금 검색해줘"); expect(r.speech).toContain("아직 다 열리지 않았어요"); expect(r.speech).not.toContain(resultText);
  } finally {data.resolve();}
  expect((await session.handleTurn("본문 읽어줘")).speech).toContain(resultText);
});
it("test_back_onto_a_page_that_fetches_its_content_describes_that_content", async () => {
  const {session} = await open(), {url} = await site(); await session.handleTurn(url + "/results 열어줘"); await session.handleTurn(url + "/fast 열어줘");
  const r = await session.handleTurn("뒤로 가줘"); expect(r.semanticAction).toBe("back"); expect(r.observation?.url).toBe(url + "/results");
  expect(r.speech).not.toContain("아직 다 열리지 않았어요"); expect(r.speech).toContain(resultText);
});
it("test_back_to_results_of_a_form_search_runs_that_search_again", async () => {
  const {session} = await open(), {url, hits} = await site(); await session.handleTurn(url + "/post-home 열어줘");
  expect((await session.handleTurn("기초연금 검색해줘")).speech).toContain(resultText);
  await session.handleTurn("공지사항 눌러줘"); const result = await session.handleTurn("뒤로 가줘");
  expect(result.semanticAction).toBe("back"); expect(result.observation?.url).toBe(url + "/results");
  expect(result.speech).toContain("'기초연금'"); expect(result.speech).toContain(resultText); expect(hits.get("POST /results")).toBe(2);
  expect((await session.handleTurn("뒤로 가줘")).observation?.url).toBe(url + "/post-home");
  expect((await session.handleTurn("뒤로 가줘")).observation?.url).toMatch(/^http:\/\/localhost:5174/u);
});
it("test_back_onto_some_other_form_result_stays_and_does_not_say_try_again", async () => {
  const {session} = await open(), {url, hits} = await site(); await session.handleTurn(url + "/post-home 열어줘");
  await session.handleTurn("검색 버튼 눌러줘"); await session.handleTurn("공지사항 눌러줘");
  const result = await session.handleTurn("뒤로 가줘"); expect(hits.get("POST /results")).toBe(1); expect(result.observation?.url).toBe(url + "/notice");
  expect(result.speech).toContain("다시 보내지 않도록"); expect(result.speech).not.toContain("다시 시도");
});
