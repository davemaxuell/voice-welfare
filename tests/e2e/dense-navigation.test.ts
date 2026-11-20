import { expect, it } from "vitest";
import { z } from "zod";
import { ExecContext } from "../../src/agents/web/agent.ts";
import { Autopilot, reviewPage } from "../../src/agents/web/autopilot.ts";
import { FakeLlm, step } from "../helpers.ts";
import { browserCases } from "./browser-cases.ts";
import { pageFor, runtimeCases } from "./browser-runtime-cases.ts";

const open = browserCases(), service = runtimeCases();
const ctx = () => new ExecContext({ signal: new AbortController().signal, isStopped: () => false, trace() {}, publicLookup: true });

it("test_deep_catalog_uses_trusted_clicks_and_the_correct_identically_named_link", async () => {
  const chrome = process.env.DENSE_NAV_CHROME === "1";
  const desktop = await service({ VISUAL_CURSOR: "true", PRACTICE_MODE: "true",
    ...(chrome ? { PILOT_PROFILE: "personal", BROWSER_MODE: "chrome", HEADLESS: "false" } : {}) });
  const { session } = await desktop.session();
  if (chrome) {
    expect(session.deps.sharedBrowser).toBe(true);
    expect(desktop.runtime.browserFallback).toBe(false);
  }
  const page = pageFor(session);
  const root = "https://catalog.example.org", depth = 5, passage = "도담 센터의 방문 시간은 오후 네 시까지입니다.";
  await page.addInitScript(() => document.addEventListener("click", event => {
    const a = event.target instanceof Element ? event.target.closest("a") : null;
    if (a) sessionStorage.setItem("clicks", JSON.stringify([...JSON.parse(sessionStorage.getItem("clicks") ?? "[]"), [a.pathname, event.isTrusted, event.detail]]));
  }, true));
  await page.route(root + "/**", route => {
    const path = new URL(route.request().url()).pathname.slice(1);
    const row = (title: string, href: string) => `<li><h3>${title}</h3><a href="${href}">자세히 보기</a></li>`;
    let body = "<p>다른 자료예요.</p>";
    if (path === String(depth)) body = "<p>" + passage + "</p>";
    else if (/^\d+$/u.test(path)) body = "<ul>" + [
      ...Array.from({length: 600}, (_, i) => row("기타 자료 " + i, "/wrong/" + i)),
      ...Array.from({length: 26}, (_, i) => row("도담 참고 " + i, "/wrong/" + i)),
      row("도담 방문 안내", "/" + (Number(path) + 1)),
    ].join("") + "</ul>";
    return route.fulfill({contentType: "text/html; charset=utf-8", body: "<title>자료 " + path + "</title><main>" + body + "</main>"});
  });
  const data = z.object({ page: z.object({ mainText: z.string(), moreLinks: z.boolean().optional(), linkMatches:
    z.array(z.object({ context: z.string(), name: z.string(), ref: z.string() })).optional() }) });
  const model = new FakeLlm(({ user }) => {
    const { page: view } = data.parse(JSON.parse(user));
    if (view.mainText === passage) return step("answer", null, passage, [passage]);
    if (!view.linkMatches) return step("find_links", "도담");
    const match = view.linkMatches.find(item => item.context.includes("도담 방문 안내"));
    if (match) { expect(match.name).toBe("자세히 보기"); return step("click", match.ref); }
    expect(view.moreLinks).toBe(true);
    expect(view.linkMatches).toHaveLength(24);
    return step("more_links");
  });
  const pilot = new Autopilot(session.deps.web, model, {searchUrl: () => root, maxSteps: 3 * depth + 2});
  const result = await pilot.run("도담 방문 시간을 찾아줘", ctx(), undefined, {startUrl: root + "/0"});
  expect([result.status, result.reviewQuotes, result.iterations]).toEqual(["answered", [passage], 3 * depth + 2]);
  expect(result.quoteSources.get(passage)).toEqual([root + "/" + depth]);
  expect(result.actions.every(a => a.policy.allowed && a.result?.ok === true && a.result.verified)).toBe(true);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("clicks") ?? "[]"))).toEqual(
    Array.from({length: depth}, (_, i) => ["/" + (i + 1), true, 1]));
});

it("test_replaced_catalog_row_is_rejected_and_never_clicked", async () => {
  const { page, adapter, session } = await open();
  await page.goto("http://localhost:5174/external.html");
  await page.setContent('<main><ul><li><h3>원래 센터</h3><a href="/wrong">자세히 보기</a></li></ul></main>');
  const window = await adapter.controlWindow("원래 센터");
  expect(window.items).toHaveLength(1);
  const item = window.items[0]!;
  await page.locator("h3").evaluate(el => { el.textContent = "다른 센터"; });
  const out = await session.deps.web.followLink(item.name, ctx(), false, { matchedControl: { ...item, url: window.url } });
  expect(out.status).toBe("needs-clarification");
  expect(out.actions).toEqual([]);
  expect(page.url()).toBe(window.url);
});

it("test_requested_tabs_are_visited_even_when_the_first_page_has_the_answer", async () => {
  const { page, session } = await open();
  const root = "https://www.gov.kr", deadline = "안내 창구는 금요일까지 운영합니다.";
  await page.route(root + "/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<title>창구 안내</title><main><h1>민원 데스크</h1>
    <div role="tablist"><button role="tab" aria-selected="true">지원대상</button><button role="tab" aria-selected="false">서비스 내용</button></div>
    <p>${deadline}</p></main><script>const [a,b] = document.querySelectorAll('button'); b.onclick=()=>{
      a.setAttribute('aria-selected','false');b.setAttribute('aria-selected','true');document.querySelector('h1').textContent='서비스 내용 안내';}</script>` }));
  const model = new FakeLlm(({ user }) => {
    const { history } = z.object({ history: z.array(z.string()) }).parse(JSON.parse(user));
    const visited = history.some(row => row.includes("click"));
    return { action: visited ? "answer" : "click", target: visited ? null : "서비스 내용", answer: null,
      claims: visited ? [] : [{ fact: "other", passageId: null, quote: deadline }] };
  });
  const pilot = new Autopilot(session.deps.web, model, { searchUrl: () => root });
  const result = await pilot.run("지원대상을 확인하고 서비스 내용을 열어 운영 기한을 알려줘", ctx(), undefined,
    { startUrl: root + "/guide?private=synthetic-secret", siteUrl: root, requestedFacts: ["other"], conversation: {requestedSteps: ["지원대상", "서비스 내용"]} });
  expect(result.status).toBe("answered");
  expect(result.reviewQuotes).toContain(deadline);
  expect(result.reviewPages.map(r => r.selected)).toEqual([["지원대상"], ["서비스 내용"]]);
  expect(result.reviewPages.map(r => r.afterActionId)).toEqual(result.actions.map(a => a.action.id));
  expect(result.reviewPages.every(r => r.url === root + "/guide" && r.urlKey.length === 64)).toBe(true);
  expect(JSON.stringify(result.reviewPages)).not.toContain("synthetic-secret");
});

it("test_public_page_proof_omits_form_values_and_protected_screens", async () => {
  const { page, session } = await open();
  await page.goto("http://localhost:5174/external.html?record=private-record");
  await page.setContent('<title>자료 synthetic-input</title><main><h1>안내</h1><input aria-label="작성자" value="synthetic-input"><p>synthetic-input 자료입니다.</p></main>');
  const proof = reviewPage(await session.deps.web.observe());
  expect(proof).toBeDefined();
  expect(JSON.stringify(proof)).not.toMatch(/synthetic-input|private-record/u);
  await page.locator("input").evaluate(el => el.setAttribute("type", "password"));
  expect(reviewPage(await session.deps.web.observe())).toBeUndefined();
});
