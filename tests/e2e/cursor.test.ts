import { createServer, type Server } from "node:http";
import type { Browser } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import type { Action } from "../../src/core/actions.ts";
import { PlaywrightExecutionAdapter, cursorScript, launchBrowser, stopPlaywright } from "../../src/agents/web/browser/index.ts";

// 시연용 가상 커서: 초점만 옮길 때(승인·입력을 기다리는 때)와 누를 때 모양이 다르고, 페이지가 읽는 내용과 클릭을 방해하지 않는다.
const PAGE = "<!doctype html><title>처음</title><body><main><h1>안내</h1>" +
  "<button id=go style='margin:80px 0 0 120px;width:160px;height:48px' onclick=\"document.title='눌림'\">신청하기</button>" +
  "</main></body>";
const BUTTON = { role: "button", name: "신청하기" };

let browser: Browser;
let server: Server;
let adapter: PlaywrightExecutionAdapter;
let count = 0;
const act = (type: Action["type"], params: Partial<Action> = {}): Action =>
  ({ id: `c${++count}`, type, risk: "low", reason: "cursor test", requiresConfirmation: false, ...params });

beforeAll(async () => {
  browser = await launchBrowser(true);
  server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(PAGE); });
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
});
afterAll(async () => {
  try { await stopPlaywright(); }
  finally {
    await new Promise<void>(resolve => { server.close(() => { resolve(); }); server.closeAllConnections(); });
  }
}, 60000);
afterEach(() => adapter.close());

async function opened() {
  adapter = new PlaywrightExecutionAdapter({ browser, allowedOrigins: [], readOnlyWeb: true, visualCursor: true });
  await adapter.start();
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("임시 서버 주소가 없습니다.");
  expect((await adapter.execute(act("navigate", { url: `http://127.0.0.1:${address.port}/` }))).ok).toBe(true);
  if (adapter.page === undefined) throw new Error("브라우저 탭이 없습니다.");
  return adapter.page;
}

const CursorState = z.object({ mode: z.string(), bubble: z.string(), dx: z.number(), dy: z.number(), hidden: z.string().nullable(), over: z.string() });
async function cursorState(page: NonNullable<PlaywrightExecutionAdapter["page"]>) {
  return CursorState.parse(await page.evaluate(() => {
    const cursor = document.getElementById("__cheongeum_cursor");
    const button = document.getElementById("go");
    const bubble = cursor?.shadowRoot?.querySelector(".bubble");
    if (cursor === null || button === null || bubble === null || bubble === undefined) throw new Error("커서나 단추가 없습니다.");
    const rect = button.getBoundingClientRect();
    const x = parseFloat(cursor.style.left), y = parseFloat(cursor.style.top);
    return {
      mode: cursor.dataset.mode, bubble: getComputedStyle(bubble).display,
      dx: x - (rect.left + rect.width / 2), dy: y - (rect.top + rect.height / 2),
      hidden: cursor.getAttribute("aria-hidden"), over: document.elementFromPoint(x, y)?.id ?? "",
    };
  }));
}

it("test_waiting_shows_the_bubble_and_the_click_clears_it", async () => {
  const page = await opened();
  expect((await adapter.execute(act("focus", { target: BUTTON }))).ok).toBe(true);
  const waiting = await cursorState(page);
  expect(waiting.mode).toBe("wait");
  expect(waiting.bubble).toBe("flex");
  expect([Math.round(waiting.dx), Math.round(waiting.dy)]).toEqual([0, 0]);

  expect((await adapter.execute(act("click", { target: BUTTON }))).ok).toBe(true);
  expect(await page.title()).toBe("눌림");
  const pressed = await cursorState(page);
  expect(pressed.mode).toBe("click");
  expect(pressed.bubble).toBe("none");
});

it("test_cursor_does_not_get_in_the_way", async () => {
  const page = await opened();
  await page.getByRole("button", { name: BUTTON.name }).focus();
  const before = await adapter.observe();
  await adapter.execute(act("focus", { target: BUTTON }));
  const state = await cursorState(page);
  expect(state.hidden).toBe("true");
  expect(state.over).toBe("go");
  const after = await adapter.observe();
  expect(after.outline).toEqual(before.outline);
});

it("특정 항목으로 스크롤할 때 가리키고 화면만 내려 읽을 때는 그 자리에 남는다", async () => {
  const page = await opened();
  expect((await adapter.execute(act("scroll", { target: BUTTON }))).ok).toBe(true);
  const cursor = await cursorState(page);
  expect([cursor.mode, Math.round(cursor.dx), Math.round(cursor.dy)]).toEqual(["move", 0, 0]);
  expect((await adapter.execute(act("scroll"))).ok).toBe(true);
  expect(await cursorState(page)).toEqual(cursor);
});

it("마지막으로 가리킨 자리를 다음 화면, 새로고침, 새 탭에서도 유지한다", async () => {
  const page = await opened();
  const cursor = "#__cheongeum_cursor";
  const point = (tab: typeof page) => tab.locator(cursor).evaluate(el => {
    const { x, y } = el.getBoundingClientRect();
    return { x, y };
  }, undefined, { timeout: 3000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect((await adapter.execute(act("focus", { target: BUTTON }))).ok).toBe(true);
  const last = await point(page);
  expect((await adapter.execute(act("navigate", { url: page.url() + "?next" }))).ok).toBe(true);
  expect(await point(page)).toEqual(last);
  await page.reload();
  expect(await point(page)).toEqual(last);
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.evaluate(() => { window.open("?popup", "_blank"); })]);
  expect(await point(popup)).toEqual(last);
});

it("작아진 화면 가장자리에서도 가리킨 끝과 캐릭터가 모두 보인다", async () => {
  const page = await opened();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(cursorScript(1050, 830, "move"));
  await page.setViewportSize({ width: 480, height: 360 });
  await expect.poll(() => page.locator("#__cheongeum_cursor svg").first().evaluate(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  })).toBe(true);
});

it("사이트의 대화상자가 열려도 커서가 가려지거나 키보드 초점을 가져가지 않는다", async () => {
  const page = await opened();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    const modal = document.createElement("dialog");
    modal.style.cssText = "width:280px;height:150px;background:white;";
    const button = document.createElement("button");
    button.textContent = "계속";
    modal.append(button);
    document.body.append(modal);
    modal.showModal();
  });
  expect((await adapter.execute(act("focus", { target: { role: "button", name: "계속" } }))).ok).toBe(true);
  const button = page.getByRole("button", { name: "계속" });
  expect(await button.evaluate(el => el === document.activeElement)).toBe(true);
  const shown = await page.locator("dialog").screenshot();
  const hidden = await page.locator("dialog").screenshot({ style: "#__cheongeum_cursor { visibility: hidden !important; }" });
  expect(shown.equals(hidden)).toBe(false);
});
