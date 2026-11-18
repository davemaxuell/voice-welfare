import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { afterAll, afterEach, expect, it } from "vitest";
import { createTestRuntime } from "./session-runtime.ts";

const runtime = createTestRuntime({navigationTimeoutMs: 400});
afterEach(runtime.closeSessions);
afterAll(runtime.close);

async function slowPage() {
  const gate = new EventEmitter();
  const requested = once(gate, "requested");
  const release = once(gate, "release");
  const server = createServer((req, res) => {
    if (req.url === "/blocking.js") {
      gate.emit("requested");
      void release.then(() => {
        res.writeHead(200, {"Content-Type": "application/javascript", "Cache-Control": "no-store"});
        res.end("document.documentElement.dataset.ready = 'yes';");
      });
      return;
    }
    res.writeHead(200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"});
    res.end('<!doctype html><title>느린 화면</title><main><h1>느린 화면</h1><p>본문입니다.</p></main><script src="/blocking.js"></script>');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("임시 서버 주소가 없습니다.");
  return {
    url: `http://127.0.0.1:${address.port}/page`, requested, release: () => gate.emit("release"),
    async close() {
      gate.emit("release");
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

it("speaks the visible page while its blocking script is still loading", async () => {
  const site = await slowPage();
  try {
    const {session, page} = await runtime.createBrowserSession();
    const result = await session.handleTurn(site.url + " 열어줘");
    expect(result.semanticAction).toBe("open-site");
    expect(result.state).toBe("BROWSING");
    expect(result.speech).toContain("느린 화면");
    expect(result.speech).toContain("본문입니다.");
    expect(page.url()).toBe(site.url);
    expect(await page.evaluate(() => document.readyState)).toBe("loading");
    site.release();
    await page.waitForLoadState("domcontentloaded");
    expect(await page.locator("html").getAttribute("data-ready")).toBe("yes");
  } finally { await site.close(); }
});

it("a stopped slow navigation cannot overwrite the stopped session when the page finishes", async () => {
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
    site.release();
    await page.waitForLoadState("domcontentloaded");
    expect(session.state).toBe("STOPPED");
    expect((await session.handleTurn("지금 어디까지 했어?")).actions).toEqual([]);
  } finally { await site.close(); }
});
