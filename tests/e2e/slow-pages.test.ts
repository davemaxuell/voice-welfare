import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { stillBuilding } from "../../src/agents/web/effect.ts";
import { createTestRuntime } from "./session-runtime.ts";

const runtime = createTestRuntime({navigationTimeoutMs: 15_000});
afterEach(runtime.closeSessions);
afterAll(runtime.close);

async function slowPage() {
  const gate = new EventEmitter();
  const requested = once(gate, "requested");
  const disconnected = once(gate, "disconnected");
  const release = once(gate, "release");
  const server = createServer((req, res) => {
    if (req.url === "/blocking.js") {
      res.once("close", () => { if (!res.writableFinished) gate.emit("disconnected"); });
      gate.emit("requested");
      void release.then(() => {
        res.writeHead(200, {"Content-Type": "application/javascript", "Cache-Control": "no-store"});
        res.end("document.documentElement.dataset.ready = 'yes';");
      });
      return;
    }
    res.writeHead(200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"});
    res.end('<!doctype html><title>느린 화면</title><main><h1>느린 화면</h1><p>방문 시간은 오후 네 시까지예요.</p></main><script src="/blocking.js"></script>');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("임시 서버 주소가 없습니다.");
  return {
    url: `http://127.0.0.1:${address.port}/page`, requested, disconnected, release: () => gate.emit("release"),
    async close() {
      gate.emit("release");
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

it("opens a slow page and reads its content when ready", async () => {
  const site = await slowPage();
  try {
    const {session, page} = await runtime.createBrowserSession();
    // Leave enough time to connect on CI. Only shorten the DOM-ready wait after commit.
    const wait = page.waitForLoadState.bind(page);
    vi.spyOn(page, "waitForLoadState").mockImplementation((state, opts) =>
      wait(state, state === "domcontentloaded" && opts?.timeout === 15_000 ? {...opts, timeout: 400} : opts));
    const result = await session.handleTurn(site.url + " 열어줘");
    expect(result.semanticAction).toBe("open-site");
    expect(result.state).toBe("BROWSING");
    expect(result.observation?.title).toBe("느린 화면");
    const view = session.web.currentView;
    if (!view) throw new Error("The slow page produced no observation");
    expect(view.outline?.mainText).toContain("방문 시간은 오후 네 시까지예요.");
    if (stillBuilding(view)) {
      expect(result.speech).toContain("화면이 아직 다 열리지 않았어요");
    } else {
      expect(result.speech).toContain("느린 화면");
      expect(result.speech).toContain("방문 시간은 오후 네 시까지예요.");
    }
    expect(page.url()).toBe(site.url);
    expect(await page.evaluate(() => document.readyState)).toBe("loading");
    site.release();
    await page.waitForLoadState("domcontentloaded");
    expect(await page.locator("html").getAttribute("data-ready")).toBe("yes");
    const read = await session.handleTurn("본문 읽어줘");
    expect(read.observation?.title).toBe("느린 화면");
    expect(read.speech).toContain("방문 시간은 오후 네 시까지예요.");
  } finally { await site.close(); }
});

it("stopping a slow navigation cancels the outstanding script and keeps the session stopped", async () => {
  const site = await slowPage();
  try {
    const {session, page} = await runtime.createBrowserSession({navigationTimeoutMs: 10_000});
    const navigation = session.handleTurn(site.url + " 열어줘");
    await Promise.race([site.requested, navigation.then(result => {
      throw new Error(`느린 스크립트 요청 전에 턴이 끝났습니다: ${result.speech}`);
    })]);
    const stop = await session.handleTurn("멈춰");
    expect(stop.state).toBe("STOPPED");
    expect((await navigation).state).toBe("STOPPED");
    await site.disconnected;
    site.release();
    expect(await page.evaluate(() => document.documentElement.dataset.ready)).toBeUndefined();
    expect(session.state).toBe("STOPPED");
    expect((await session.handleTurn("지금 어디까지 했어?")).actions).toEqual([]);
  } finally { await site.close(); }
});
