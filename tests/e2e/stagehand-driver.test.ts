import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Browser, Page } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Action } from "../../src/core/actions.ts";
import { createStructuredLlm, ModelConnections } from "../../src/core/llm.ts";
import { launchBrowser, launchChromeProfile, PlaywrightExecutionAdapter } from "../../src/agents/web/browser/index.ts";
import { observedSelectors, stagehandTab } from "../../src/agents/web/browser/stagehand_browser.ts";

let browser: Browser;
const adapters: PlaywrightExecutionAdapter[] = [];
beforeAll(async () => { browser = await launchBrowser(true, 0, "stagehand"); });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});
afterAll(async () => { await browser?.close(); });

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(html: string) {
  const adapter = new PlaywrightExecutionAdapter({ browser, driver: "stagehand", allowedOrigins: [], readOnlyWeb: true });
  adapters.push(adapter);
  await adapter.start();
  const page = adapter.page!;
  await page.setContent(html);
  return { adapter, page };
}
function action(type: Action["type"], target: Action["target"], value?: string): Action {
  return { id: "한번", type, target, value, risk: "low", reason: "시험", requiresConfirmation: false };
}

it("같은 주소를 연 두 세션에서 관찰·입력·클릭은 선택한 탭에만 적용한다", async () => {
  const html = '<button onclick="document.title=this.textContent">공통 안내</button><input id="field">';
  const [a, b] = await Promise.all([fixture(html), fixture(html)]);
  const [first, second] = await Promise.all([stagehandTab(a.page), stagehandTab(b.page)]);
  expect(first.tab.pageId).not.toBe(second.tab.pageId);
  const select = vi.spyOn(second.tab, "evaluate");
  expect((await b.adapter.observe()).outline?.items?.[0]?.name).toBe("공통 안내");
  expect(select).toHaveBeenCalled();
  expect((await a.adapter.execute(action("fill", { fieldId: "field" }, "첫째"))).verified).toBe(true);
  expect(await b.page.locator("input").inputValue()).toBe("");
  const item = (await b.adapter.observe()).outline!.items![0]!;
  expect((await b.adapter.execute(action("click", item))).ok).toBe(true);
  expect(await b.page.title()).toBe("공통 안내");
  expect(await a.page.title()).toBe("");
  await a.page.context().addCookies([{ url: "http://localhost", name: "session", value: "first" }]);
  expect(await b.page.context().cookies()).toEqual([]);
});

it("실제 누르기의 포인터 입력 도중 이름이 바뀌면 이어지는 클릭 핸들러가 실행되지 않는다", async () => {
  const { adapter, page } = await fixture('<button onpointerdown="this.textContent=String(999)" onclick="document.title=String(321)">안내</button>');
  const item = (await adapter.observe()).outline!.items![0]!;
  expect((await adapter.execute(action("click", item))).errorCode).toBe("VERIFY_FAILED");
  expect(await page.locator("button").innerText()).toBe("999");
  expect(await page.title()).toBe("");
});

it("실제 누르기가 가려진 단추를 기다리는 동안 멈추면 앞뒤 어느 단추도 동작하지 않는다", async () => {
  const { page, adapter } = await fixture('<button onclick="document.title=String(1)">앞 단추</button><button id="cover" onclick="document.title=String(2)" hidden>다른 단추</button>');
  const item = (await adapter.observe()).outline!.items![0]!;
  const stopped = new AbortController();
  const arrived = gate();
  const { tab } = await stagehandTab(page);
  const evaluate = tab.evaluate.bind(tab);
  let observations = 0;
  vi.spyOn(tab, "evaluate").mockImplementation(async (source, arg) => {
    const result = await evaluate(source, arg);
    if (typeof source === "string" && source.includes('"ref":"' + item.ref + '"') && ++observations === 2) {
      await page.locator("#cover").evaluate(el => { el.removeAttribute("hidden"); el.style.cssText = "position:fixed;inset:0;z-index:99"; });
      arrived.resolve();
    }
    return result;
  });
  const clicking = adapter.execute(action("click", item), stopped.signal);
  await arrived.promise;
  await delay(80);
  stopped.abort();
  expect((await clicking).errorCode).toBe("ABORTED");
  await page.locator("#cover").evaluate(el => { el.setAttribute("hidden", ""); });
  await delay(120);
  expect(await page.title()).toBe("");
});

it("입력 전에 초점이 비밀번호로 옮겨지거나 원래 칸이 비밀번호로 바뀌면 쓰지 않는다", async () => {
  for (const focus of ["document.getElementById('secret').focus()", "this.type='password'"]) {
    const { adapter, page } = await fixture('<input id="field" onfocus="' + focus + '"><input id="secret" type="password">');
    expect((await adapter.execute(action("fill", { fieldId: "field" }, "민감한 입력"))).errorCode).toBe("VERIFY_FAILED");
    expect(await page.locator("#field").inputValue()).toBe("");
    expect(await page.locator("#secret").inputValue()).toBe("");
  }
});

it("중단된 입력은 늦게 도착해도 값이나 키 입력을 보내지 않는다", async () => {
  const { adapter, page } = await fixture('<input id="field"><input type="password">');
  const { tab } = await stagehandTab(page);
  const evaluate = tab.evaluate.bind(tab);
  const arrived = gate(), release = gate();
  vi.spyOn(tab, "evaluate").mockImplementation(async (source, arg) => {
    if (typeof arg === "object" && arg !== null && "token" in arg) { arrived.resolve(); await release.promise; }
    return evaluate(source, arg);
  });
  const stop = new AbortController();
  const running = adapter.execute(action("fill", { fieldId: "field" }, "입력값"), stop.signal);
  try {
    await arrived.promise;
    stop.abort();
    expect((await running).errorCode).toBe("ABORTED");
  } finally { release.resolve(); }
  await delay(150);
  expect(await page.locator("#field").inputValue()).toBe("");
});

it("실제 SDK 추론에는 해당 탭의 공개된 가린 항목 이름과 번호만 전달한다", async () => {
  const { page } = await fixture('<button>연락 010-5555-0123</button><input value="private-field"><input type="password" value="private-password"><textarea>private-note</textarea><iframe srcdoc="<button>private-frame</button>"></iframe>');
  let calls = 0;
  const pool = new ModelConnections(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const prompt = request.messages.find(item => item.role === "user")!.content;
    expect(prompt).not.toMatch(/private-|010-5555-0123/u);
    const id = prompt.match(/\[(\d+-\d+)\] button: 연락/u)?.[1];
    expect(id).toBeDefined();
    calls++;
    const content = JSON.stringify({ elements: [{ elementId: id, method: "click", arguments: [], description: "임의의 설명" }] });
    return Response.json({ choices: [{ message: { content } }] });
  });
  const llm = createStructuredLlm({ provider: "openai-compatible", model: "시험", baseUrl: "http://127.0.0.1:9" }, { pool })!;
  const result = await observedSelectors(page, "연락 단추", llm, new AbortController().signal);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatch(/^xpath=.*button/u);
  expect(calls).toBe(1);
});

it("앱이 만든 지속 프로필의 실제 탭에도 붙는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cheongeum-b2-"));
  try {
    const ctx = await launchChromeProfile(dir, 0, "stagehand", { channel: "chromium", headless: true });
    try {
      const adapter = new PlaywrightExecutionAdapter({ context: ctx, driver: "stagehand", allowedOrigins: [] });
      try {
        await adapter.start();
        const page: Page = adapter.page!;
        await page.setContent("<title>지속 프로필</title>");
        expect((await adapter.observe()).title).toBe("지속 프로필");
      } finally { await adapter.close(); }
    } finally { await ctx.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
