import { createServer, type Server } from "node:http";
import type { Browser } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import type { Action } from "../../src/core/actions.ts";
import { PlaywrightExecutionAdapter, launchBrowser, stopPlaywright } from "../../src/agents/web/browser/index.ts";

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
    const bubble = cursor?.querySelector(".bubble");
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
