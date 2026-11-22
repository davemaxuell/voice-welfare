import { createServer, type ServerResponse } from "node:http";
import { afterAll, afterEach, expect, it } from "vitest";
import { createTestRuntime } from "./session-runtime.ts";

// 멈춤과 열리던 화면: 응답을 기다리는 중에 멈추면 그 화면은 열리지 않고, 있던 화면이 그대로 남는다.
// 응답이 이미 들어와 화면이 바뀐 뒤(막을 수 없음)에 멈췄으면 더 불러오지 않고, 다시 시작할 때 화면이 바뀌었다고 말한다.
// 멈춤 대답은 하던 일이 있었는데 '대기 중인 작업이 없다'고 하지 않는다.
// 이 시험은 웹 에이전트와 세션 패키지의 멈춤 처리(열리던 화면 되돌리기·막기)가 옮겨진 뒤에 통과한다.
const runtime = createTestRuntime();
afterEach(runtime.closeSessions);
afterAll(runtime.close);

const FIRST = '<title>첫 화면</title><body><main><h1>첫 화면</h1><p>먼저 열린 화면입니다.</p><a href="/held">늦는 안내</a></main></body>';
const LATE = "<title>늦은 화면</title><body><main><h1>늦은 화면</h1><p>뒤늦게 온 화면입니다.</p></main></body>";
const DOCUMENT_START = '<!doctype html><link rel="icon" href="data:,">';
// 머리와 첫 글은 바로 보내고(화면이 바뀜) 나머지는 붙잡아 둔다
const PARTIAL_HEAD = DOCUMENT_START + "<title>반쯤 열린 화면</title><body><main><h1>반쯤 열린 화면</h1><p>먼저 온 글입니다.</p>" + " ".repeat(2048);
const NO_PENDING = "대기 중인 브라우저 작업은 없습니다";

function latch() {
  let open = () => {};
  const done = new Promise<void>(resolve => { open = resolve; });
  return { open, done };
}

/** /held는 응답 전체를, /partial은 응답의 뒷부분을 release 때까지 붙잡는다. */
async function heldSite() {
  const hits = new Map<string, number>();
  const arrived = latch(), release = latch(), answered = latch();
  const head = (res: ServerResponse, length?: number) => {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...(length === undefined ? {} : { "Content-Length": length }),
    });
  };
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const finish = () => { if (path === "/held" || path === "/partial") answered.open(); };
    res.on("close", finish);
    void (async () => {
      if (path === "/partial") {
        head(res);
        res.write(PARTIAL_HEAD);
        arrived.open();
        await Promise.race([release.done, new Promise(resolve => setTimeout(resolve, 30_000))]);
        res.end("<p>늦게 온 글입니다.</p></main></body>");
        return;
      }
      if (path === "/held") {
        arrived.open();
        await Promise.race([release.done, new Promise(resolve => setTimeout(resolve, 30_000))]);
      }
      const body = Buffer.from(DOCUMENT_START + (path === "/held" ? LATE : FIRST));
      head(res, body.length);
      res.end(body);
    })().catch(() => { res.destroy(); });
  });
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("임시 서버 주소가 없습니다.");
  const host = `127.0.0.1:${address.port}`;

  async function reached(event: { done: Promise<void> }, what: string) {
    await Promise.race([event.done, new Promise<never>((_, reject) => setTimeout(() => { reject(new Error(`${what} 안 됨`)); }, 10_000))]);
  }
  return {
    hits, arrived, host, url: `http://${host}`, reached,
    /** 붙잡은 응답을 보내고, 크롬이 받은 문서를 화면에 올릴 틈을 준다. */
    async letGo() {
      release.open();
      await reached(answered, "붙잡은 응답 보내기");
      await new Promise(resolve => setTimeout(resolve, 700));
    },
    async close() {
      release.open();
      server.closeAllConnections();
      await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    },
  };
}

let site: Awaited<ReturnType<typeof heldSite>> | undefined;
afterEach(async () => { await site?.close(); site = undefined; });

async function openedFirst() {
  site = await heldSite();
  const opened = await runtime.createBrowserSession();
  const first = await opened.session.handleTurn(`${site.host}/first 열어줘`);
  expect(first.observation?.url).toBe(`${site.url}/first`);
  return { ...opened, site };
}

async function stopBy(session: Awaited<ReturnType<typeof openedFirst>>["session"], how: "button" | "voice") {
  if (how === "button") return session.cancel();
  return Promise.race([session.handleTurn("멈춰"), new Promise<never>((_, reject) => setTimeout(() => { reject(new Error("멈춤 답이 5초 안에 없음")); }, 5000))]);
}

const within = <T>(work: Promise<T>, seconds: number) =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => { reject(new Error(`${seconds}초 안에 끝나지 않음`)); }, seconds * 1000))]);

it.each(["button", "voice"] as const)("test_stop_before_the_page_answers_keeps_the_screen_that_was_open", async how => {
  const { session, page, site } = await openedFirst();
  const opening = session.handleTurn(`${site.host}/held 열어줘`);
  await site.reached(site.arrived, "늦는 화면 요청");
  const stopped = await stopBy(session, how);
  expect(stopped.state).toBe("STOPPED");
  expect(stopped.speech).not.toContain(NO_PENDING);
  expect(stopped.speech).toContain("멈췄");
  expect(stopped.speech).toContain("다시 시작");
  expect(stopped.speech).not.toContain("바뀌었");
  expect((await within(opening, 5)).state).toBe("STOPPED");
  await site.letGo();
  expect(page.url()).toBe(`${site.url}/first`);
  const resumed = await session.handleTurn("다시 시작해줘");
  expect(resumed.observation?.url).toBe(`${site.url}/first`);
  expect(resumed.speech).toContain("첫 화면");
  expect(resumed.speech).not.toContain("늦은 화면");
  expect(resumed.speech).not.toContain("바뀌었");
  expect(site.hits.get("/held")).toBe(1);
});

it("test_stop_drops_what_was_queued_behind_the_page_that_was_opening", async () => {
  const { session, page, site } = await openedFirst();
  const opening = session.handleTurn(`${site.host}/held 열어줘`);
  await site.reached(site.arrived, "늦는 화면 요청");
  const queued = session.handleTurn("화면 설명해줘");
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(session.cancel().state).toBe("STOPPED");
  expect((await within(opening, 5)).state).toBe("STOPPED");
  const dropped = await within(queued, 5);
  expect(dropped.state).toBe("STOPPED");
  expect(dropped.actions).toEqual([]);
  expect(dropped.speech).toContain("실행하지 않았습니다");
  await site.letGo();
  expect(page.url()).toBe(`${site.url}/first`);
  const blocked = await session.handleTurn("화면 설명해줘");
  expect(blocked.state).toBe("STOPPED");
  expect(blocked.actions).toEqual([]);
  expect(site.hits.get("/held")).toBe(1);
});

it("test_stop_after_a_link_was_pressed_keeps_the_screen_that_was_open", async () => {
  const { session, page, site } = await openedFirst();
  const pressing = session.handleTurn("늦는 안내 눌러줘");
  await site.reached(site.arrived, "늦는 화면 요청");
  const stopped = session.cancel();
  expect(stopped.speech).not.toContain(NO_PENDING);
  expect((await within(pressing, 10)).state).toBe("STOPPED");
  await site.letGo();
  expect(page.url()).toBe(`${site.url}/first`);
  const resumed = await session.handleTurn("다시 시작해줘");
  expect(resumed.observation?.url).toBe(`${site.url}/first`);
  expect(resumed.speech).not.toContain("늦은 화면");
});

it("test_stop_after_the_page_already_changed_says_so_on_resume", async () => {
  const { session, page, site } = await openedFirst();
  const opening = session.handleTurn(`${site.host}/partial 열어줘`);
  await site.reached(site.arrived, "반쯤 열린 화면 요청");
  while (page.url() !== `${site.url}/partial`) {
    const finished = await Promise.race([opening.then(() => true), new Promise<boolean>(resolve => setTimeout(() => { resolve(false); }, 10))]);
    expect(finished, "화면이 바뀌기 전에 턴이 끝남").toBe(false);
  }
  const stopped = session.cancel();
  expect(stopped.state).toBe("STOPPED");
  expect(stopped.speech).not.toContain(NO_PENDING);
  // 멈춤 답에서 바로 알린다(주인 결정 2026-11-19): 되돌리지 않고 바뀐 사실을 말한다
  expect(stopped.speech).toContain("바뀌었어요");
  expect((await within(opening, 5)).state).toBe("STOPPED");
  await site.letGo();
  // 이미 바뀐 화면은 되돌리지 않는다(멈춘 뒤에 또 움직이지 않음). 대신 더 불러오지 않는다.
  expect(page.url()).toBe(`${site.url}/partial`);
  expect(await page.innerText("body")).not.toContain("늦게 온 글");
  const resumed = await session.handleTurn("다시 시작해줘");
  expect(resumed.observation?.url).toBe(`${site.url}/partial`);
  expect(resumed.speech.startsWith("다시 시작합니다. 멈추는 사이에 화면이 바뀌었어요.")).toBe(true);
  expect(resumed.speech).toContain("반쯤 열린 화면");
  expect(Object.fromEntries(site.hits)).toEqual({ "/first": 1, "/partial": 1 });
});
