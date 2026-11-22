import type { Browser, Page } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ExecContext, WebExecutionAgent, type WebAction } from "../../src/agents/web/agent.ts";
import { PlaywrightExecutionAdapter, launchBrowser, stopPlaywright } from "../../src/agents/web/browser/index.ts";
import { createMockWelfareProfile } from "../../src/agents/web/profile.ts";
import { ACTION_TYPES, type Action, type NativeDialogRecord, type NoticeProof } from "../../src/core/actions.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";

// A2: 안내 팝업은 묻지 않고 닫고, 사이트의 confirm() 질문은 취소한 뒤 사용자에게 알린다. 실제 Chromium과 정책·어댑터를 그대로 쓴다.
const profile = createMockWelfareProfile("http://localhost:5174");
const HOST = "http://notice.test";
let browser: Browser;
const adapters: PlaywrightExecutionAdapter[] = [];
beforeAll(async () => { browser = await launchBrowser(true); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const adapter of adapters.splice(0)) await adapter.close();
});
afterAll(() => stopPlaywright());

async function open(pages: Record<string, string>, { visualCursor = false } = {}) {
  const adapter = new PlaywrightExecutionAdapter({ browser, allowedOrigins: [profile.origin], readOnlyWeb: true, visualCursor });
  adapters.push(adapter);
  await adapter.start();
  const page = adapter.page;
  if (page === undefined) throw new Error("Missing browser page");
  await page.route(HOST + "/**", route => {
    const body = pages[new URL(route.request().url()).pathname];
    return body === undefined ? route.fulfill({ status: 404, body: "" }) : route.fulfill({ contentType: "text/html; charset=utf-8", body });
  });
  const guard = new PolicyGuard({
    allowedOrigins: [profile.origin], allowedActionTypes: ACTION_TYPES, allowedFieldIds: [], secretFieldIds: [], maxActionsPerTurn: 12,
    readOnlyWeb: true, readOnlyClicks: "safe",
  });
  const agent = new WebExecutionAgent(adapter, guard, profile);
  await page.goto(HOST + "/page");
  return { adapter, page, agent };
}

function context(approved: readonly string[] = []) {
  return new ExecContext({ signal: new AbortController().signal, approvals: new Set(approved), isStopped: () => false, trace() {} });
}
const read = (page: Page, key: string) => page.evaluate(name => Reflect.get(window, name) as unknown, key);
const write = (page: Page, key: string, value: unknown) => page.evaluate<void, [string, unknown]>(([name, next]) => { Reflect.set(window, name, next); }, [key, value]);

// ---- 안내 팝업 ----

const popup = (body = "서버 점검이 있어서 잠시 접속이 느릴 수 있어요.", { button = "확인", extra = "" } = {}) =>
  `<div role="dialog" id="pop" aria-labelledby="t">\n<h2 id="t">점검 공지</h2>\n<p>${body}</p>\n${extra}\n<button type="button" id="ok">${button}</button>\n</div>`;
const layer = `<div id="pop" style="position:fixed;left:200px;top:120px;width:360px;height:160px;z-index:100;background:#fff">\n`
  + `<h3>복지 소식</h3>\n<p>이번 달 안내가 바뀌었어요.</p>\n<button type="button" id="ok">닫기</button>\n</div>`;
const NOTICE_SCRIPT = `<script>
window.__clicks = 0;
document.addEventListener("click", e => {
  const el = e.target;
  if (el instanceof Element && el.id === "ok") { window.__clicks++; const pop = el.closest("#pop"); if (pop) pop.remove(); }
});
</script>`;
const html = (inner: string, main = "") => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>안내 시험</title></head><body>
<main><h1>복지 안내</h1><p>이 화면은 안내 팝업을 시험하는 화면입니다.</p><a href="#info">보조기기 안내</a>${main}</main>
${inner}
${NOTICE_SCRIPT}
</body></html>`;
const clicks = (page: Page) => read(page, "__clicks");

it("안내 팝업은 묻지 않고 닫고, 같은 안내는 처음 한 번만 말한다", async () => {
  const { page, agent } = await open({ "/page": html(popup()) });
  const ctx = context();
  const log: WebAction[] = [];
  const view = await agent.observe(ctx);
  expect(view.dialogs).toHaveLength(1);
  const closed = await agent.dismissNotices(view, ctx, log);
  expect(closed.said).toEqual([{ title: "점검 공지", text: "서버 점검이 있어서 잠시 접속이 느릴 수 있어요." }]);
  expect(closed.view.dialogs).toEqual([]);
  expect(await clicks(page)).toBe(1);
  expect(log.map(entry => [entry.action.target?.name, entry.policy.code, entry.result?.ok])).toEqual([["확인", "ALLOWED_NOTICE", true]]);
  // 같은 안내가 다시 뜨면 닫기만 하고 다시 읽지 않는다.
  await page.evaluate(markup => document.body.insertAdjacentHTML("beforeend", markup), popup());
  const again = await agent.dismissNotices(await agent.observe(ctx), ctx, log);
  expect(again.said).toEqual([]);
  expect(await clicks(page)).toBe(2);
});

it("div로 띄운 레이어 안내도 같은 규칙으로 닫는다", async () => {
  const { page, agent } = await open({ "/page": html(layer) });
  const ctx = context();
  const log: WebAction[] = [];
  const closed = await agent.dismissNotices(await agent.observe(ctx), ctx, log);
  expect(closed.said).toEqual([{ title: "복지 소식", text: "이번 달 안내가 바뀌었어요." }]);
  expect(closed.view.dialogs).toEqual([]);
  expect(await clicks(page)).toBe(1);
  expect(log.map(entry => entry.policy.code)).toEqual(["ALLOWED_READ_ONLY"]);
});

const notNotices: [name: string, markup: string][] = [
  ["확인·취소 단추가 둘인 팝업", popup(undefined, { extra: "<button type=\"button\" id=\"no\">취소</button>" })],
  ["입력 칸(오늘 하루 열지 않음)이 든 팝업", popup(undefined, { extra: "<label><input type=\"checkbox\"> 오늘 하루 열지 않음</label>" })],
  ["링크가 든 팝업", popup(undefined, { extra: "<a href=\"#more\">자세히 보기</a>" })],
  ["신청을 말하는 팝업", popup("신청 기간이 곧 끝나요.")],
  ["묻는 말투의 팝업", popup("이 안내를 계속 진행하시겠어요?")],
  ["양식 안의 팝업", `<form action="/x" method="post">${popup()}</form>`],
];
it.each(notNotices)("안내로 확인되지 않으면 닫지 않고 직접 누르라고 해도 묻는다: %s", async (_name, markup) => {
  const { page, agent } = await open({ "/page": html(markup) });
  const ctx = context();
  const log: WebAction[] = [];
  const view = await agent.observe(ctx);
  const closed = await agent.dismissNotices(view, ctx, log);
  expect(closed.said).toEqual([]);
  expect(log).toEqual([]);
  expect(closed.view.dialogs).toHaveLength(1);
  const out = await agent.followLink("확인", ctx);
  expect(out.status).toBe("needs-approval");
  expect(out.pending?.target?.name).toBe("확인");
  expect(out.native).toBeUndefined();
  expect(await clicks(page)).toBe(0);
});

it("직접 '확인'을 누르라고 하면 안내 팝업은 묻지 않고 누른다", async () => {
  const { page, agent } = await open({ "/page": html(popup()) });
  const out = await agent.followLink("확인", context());
  expect(out.status).toBe("ok");
  expect(out.actions.map(entry => entry.policy.code)).toEqual(["ALLOWED_NOTICE"]);
  expect(await clicks(page)).toBe(1);
});

it("같은 이름의 단추가 화면에 또 있으면 어느 것인지 모호해 묻는다", async () => {
  const { page, agent } = await open({ "/page": html(popup(), "<button type=\"button\" id=\"other\">확인</button>") });
  const out = await agent.followLink("확인", context());
  if (process.env.BROWSER_DRIVER === "stagehand") {
    expect(out.status).toBe("needs-clarification");
    expect(out.pending).toBeUndefined();
    expect(out.actions).toHaveLength(0);
  } else {
    expect(out.status).toBe("needs-approval");
  }
  expect(await clicks(page)).toBe(0);
});

async function proofFor(adapter: PlaywrightExecutionAdapter, name = "확인") {
  const observation = await adapter.observe();
  const item = observation.outline?.items?.find(candidate => candidate.name === name);
  if (item === undefined) throw new Error("Missing item: " + name);
  const fresh = await adapter.controlWindow("", 0, { ref: item.ref, notice: true });
  const facts = fresh.items[0]?.notice;
  if (facts === undefined) throw new Error("Missing notice facts");
  const action: Action = { id: "n1", type: "click", target: { ref: item.ref, role: item.role, name: item.name }, reason: "안내 팝업 닫기", risk: "low", requiresConfirmation: false };
  const proof: NoticeProof = { kind: "notice", url: fresh.url, ref: item.ref, role: item.role, name: item.name, facts };
  return { action, proof };
}

it("증명을 만든 뒤 팝업이 바뀌면 어댑터가 누르지 않는다", async () => {
  const { adapter, page } = await open({ "/page": html(popup()) });
  const { action, proof } = await proofFor(adapter);
  await page.evaluate(() => { const text = document.querySelector("#pop p"); if (text) text.textContent = "지금 신청서를 제출합니다."; });
  const result = await adapter.execute(action, undefined, undefined, { notice: proof });
  expect(result).toMatchObject({ ok: false, errorCode: "VERIFY_FAILED" });
  expect(await clicks(page)).toBe(0);
});

it("증명에 있는 팝업 번호가 두 요소에 붙으면 누르지 않는다", async () => {
  const {adapter, page} = await open({"/page": html(popup())});
  const {action, proof} = await proofFor(adapter);
  await page.evaluate(root => {
    const copy = document.createElement("span");
    copy.dataset.cheongeumRef = root;
    document.body.prepend(copy);
  }, proof.facts.root);
  expect(await adapter.execute(action, undefined, undefined, {notice: proof})).toMatchObject({ok: false, errorCode: "VERIFY_FAILED"});
  expect(await clicks(page)).toBe(0);
});

it("기다림과 커서 움직임이 끝난 뒤 누르기 직전에 팝업이 바뀌어도 누르지 않는다", async () => {
  const swap = "<script>document.getElementById(\"ok\").addEventListener(\"mouseover\", () => {"
    + " const text = document.querySelector(\"#pop p\"); if (text) text.textContent = \"지금 신청서를 제출합니다.\"; }, { once: true });</script>";
  const { adapter, page } = await open({ "/page": html(popup() + swap) }, { visualCursor: true });
  const { action, proof } = await proofFor(adapter);
  const result = await adapter.execute(action, undefined, undefined, { notice: proof });
  expect(result).toMatchObject({ ok: false, errorCode: "VERIFY_FAILED" });
  expect(result.message).toContain("안내 팝업");
  expect(await clicks(page)).toBe(0);
});

it("지어낸 증명이나 다른 요소·다른 조작에 붙인 증명은 누르지 않는다", async () => {
  const { adapter, page } = await open({ "/page": html(popup()) });
  const { action, proof } = await proofFor(adapter);
  const forged = { ...proof, facts: { ...proof.facts, signature: "forged" } };
  expect(await adapter.execute(action, undefined, undefined, { notice: forged })).toMatchObject({ ok: false, errorCode: "VERIFY_FAILED" });
  const elsewhere = { ...proof, ref: "r999-none" };
  expect(await adapter.execute(action, undefined, undefined, { notice: elsewhere })).toMatchObject({ ok: false, errorCode: "VERIFY_FAILED" });
  expect(await adapter.execute({ ...action, type: "focus" }, undefined, undefined, { notice: proof })).toMatchObject({ ok: false, errorCode: "VERIFY_FAILED" });
  expect(await clicks(page)).toBe(0);
  // 진짜 증명은 누른다.
  expect(await adapter.execute(action, undefined, undefined, { notice: proof })).toMatchObject({ ok: true });
  expect(await clicks(page)).toBe(1);
});

it("증명이 붙은 누르기는 시간이 넘어도 다시 하지 않고, 어댑터를 건너뛰는 perform으로는 실행하지 않는다", async () => {
  const { adapter, agent, page } = await open({ "/page": html(popup(), "<button type=\"button\" id=\"next\">다음 쪽</button>") });
  const { action, proof } = await proofFor(adapter);
  await agent.observe(context());
  const timedOut = { actionId: action.id, ok: false, verified: false, latencyMs: 0, errorCode: "TIMEOUT" as const };
  const execute = vi.spyOn(adapter, "execute").mockResolvedValue(timedOut);
  const log: WebAction[] = [];
  const result = await agent.run(action, context(), log, undefined, undefined, { notice: proof });
  expect(result?.errorCode).toBe("TIMEOUT");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]?.[3]).toEqual({ notice: proof });
  const perform = vi.fn(async () => ({ actionId: "n2", ok: true, verified: true, latencyMs: 0 }));
  const bypass = await agent.run({ ...action, id: "n2" }, context(), log, perform, undefined, { notice: proof });
  expect(bypass).toBeUndefined();
  expect(perform).not.toHaveBeenCalled();
  expect(log.at(-1)?.policy.code).toBe("DENIED_GRANT_BINDING");
  expect(await clicks(page)).toBe(0);
  // 허가가 없는 저위험 누르기는 지금처럼 시간이 넘으면 한 번 다시 한다.
  execute.mockClear();
  const observation = await adapter.observe();
  const next = observation.outline?.items?.find(item => item.name === "다음 쪽");
  if (next === undefined) throw new Error("Missing next button");
  const plain: Action = { id: "n3", type: "click", target: { ref: next.ref, role: next.role, name: next.name }, reason: "다음 쪽 누르기", risk: "low", requiresConfirmation: false };
  await agent.run(plain, context(), [], undefined, undefined);
  expect(execute).toHaveBeenCalledTimes(2);
});

// ---- 사이트의 confirm() 질문 ----

const NATIVE_SCRIPT = `<script>
window.__asked = 0; window.__moved = 0; window.__late = null; window.__lateAsk = false; window.__navigate = true;
window.__message = "다음 쪽으로 이동할까요?";
document.getElementById("go").addEventListener("click", () => {
  window.__asked++;
  const ok = confirm(window.__message);
  if (window.__lateAsk) setTimeout(() => { window.__late = confirm("뒤늦게 다른 질문을 드려요."); }, 600);
  if (ok) { window.__moved++; if (window.__navigate) location.assign("/done"); }
});
</script>`;
const nativePage = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>쪽 이동</title></head><body>
<main><h1>쪽 이동</h1><p>이 화면은 사이트의 질문을 시험하는 화면입니다.</p><button type="button" id="go">다음 쪽</button></main>
${NATIVE_SCRIPT}
</body></html>`;
const donePage = "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><title>이동 완료</title></head><body><main><h1>이동 완료</h1><p>다음 쪽에 왔어요.</p></main></body></html>";
const nativeSite = { "/page": nativePage, "/done": donePage };

const grantOf = (record: NativeDialogRecord) => ({ native: { tab: record.tab, document: record.document, url: record.url, hash: record.hash, length: record.length } });

async function firstClick(message?: string) {
  const site = await open(nativeSite);
  if (message !== undefined) await write(site.page, "__message", message);
  const ctx = context();
  const out = await site.agent.followLink("다음 쪽", ctx);
  const { pending: click, native } = out;
  if (click === undefined || native === undefined) throw new Error("Expected the site's question: " + JSON.stringify(out.status));
  return { ...site, ctx, out, click, native, grants: grantOf(native.record) };
}

it("사이트의 질문은 취소하고 알린 뒤, 승인하면 같은 질문에만 한 번 답한다", async () => {
  const { page, agent, out, click, native, grants } = await firstClick();
  expect(out.status).toBe("needs-approval");
  expect(native).toMatchObject({ answerable: true, count: 1, record: { preview: "다음 쪽으로 이동할까요?", risk: "routine" } });
  expect(out.message).toContain("사이트가 '다음 쪽으로 이동할까요?'라고 물어서 아직 진행하지 않았어요. 진행할까요?");
  expect(await read(page, "__moved")).toBe(0);
  expect(page.url()).toBe(HOST + "/page");
  const approved = context();
  const done = await approved.granted([click.id], () => agent.clickApproved(click, approved, grants));
  expect(done.status).toBe("ok");
  expect(done.effect).toBe("moved");
  expect(page.url()).toBe(HOST + "/done");
});

it("답하는 동안 글이 달라진 질문에는 허가가 있어도 답하지 않는다", async () => {
  const { page, agent, click, grants } = await firstClick();
  await write(page, "__message", "다른 쪽으로 이동할까요?");
  const approved = context();
  const done = await approved.granted([click.id], () => agent.clickApproved(click, approved, grants));
  expect(await read(page, "__moved")).toBe(0);
  expect(page.url()).toBe(HOST + "/page");
  expect(done.status).toBe("needs-approval");
  expect(done.native).toMatchObject({ answerable: false });
});

it("다른 질문 뒤에 같은 질문을 해도 이미 쓴 허가로 답하지 않는다", async () => {
  const {page, agent, click, grants} = await firstClick();
  await page.locator("#go").evaluate(button => button.addEventListener("click", () => {
    window.confirm("다른 목록을 볼까요?");
  }, {capture: true, once: true}));
  const ctx = context();
  const out = await ctx.granted([click.id], () => agent.clickApproved(click, ctx, grants));
  expect(out.native).toMatchObject({answerable: false, count: 2});
  expect(await read(page, "__moved")).toBe(0);
});

it("다시 눌렀을 때 같은 질문이 나타나지 않으면 성공했다고 하지 않고 다시 누르지 않는다", async () => {
  const {page, agent, click, grants} = await firstClick();
  await page.locator("#go").evaluate(button => button.addEventListener("click", event => {
    event.stopImmediatePropagation();
    button.textContent = "다음 쪽을 읽었습니다";
  }, {capture: true, once: true}));
  const ctx = context();
  const out = await ctx.granted([click.id], () => agent.clickApproved(click, ctx, grants));
  expect(out.status).toBe("failed");
  expect(out.message).toContain("직접 확인");
  expect(out.actions).toHaveLength(1);
  expect(await read(page, "__moved")).toBe(0);
});

it("거절하거나 멈춰서 기록을 버렸다면 승인 모양이 남아 있어도 답하지 않는다", async () => {
  const { page, agent, click, grants } = await firstClick();
  agent.forgetNative();
  const approved = context();
  const done = await approved.granted([click.id], () => agent.clickApproved(click, approved, grants));
  expect(done.status).toBe("failed");
  expect(await read(page, "__asked")).toBe(1);
  expect(await read(page, "__moved")).toBe(0);
});

it("승인(ctx.granted)이 없으면 바로 누를 수 있는 이름이어도 허가만으로 답하지 않는다", async () => {
  const { page, agent, click, grants } = await firstClick();
  const log: WebAction[] = [];
  expect(await agent.run(click, context(), log, undefined, undefined, grants)).toBeUndefined();
  expect(log.at(-1)?.policy.code).toBe("DENIED_NATIVE_BINDING");
  expect(await read(page, "__asked")).toBe(1);
});

it("지어낸 허가는 어댑터가 자기 기록과 맞춰 보고 답하지 않으며, 기록은 한 번 쓰면 사라진다", async () => {
  const { page, adapter, click, native, grants } = await firstClick();
  const elsewhere = await adapter.execute({ ...click, id: "other" }, undefined, undefined, grants);
  expect(elsewhere).toMatchObject({ ok: false, errorCode: "VERIFY_FAILED" });
  const forged = await adapter.execute(click, undefined, undefined, { native: { ...grants.native, hash: "0".repeat(64) } });
  expect(forged).toMatchObject({ ok: false, errorCode: "VERIFY_FAILED" });
  expect(await read(page, "__asked")).toBe(1);
  // 틀린 허가에도 기록을 한 번 썼으니 진짜 허가로도 더는 답하지 않는다.
  const genuine = await adapter.execute(click, undefined, undefined, grantOf(native.record));
  expect(genuine).toMatchObject({ ok: false, errorCode: "VERIFY_FAILED" });
  expect(await read(page, "__asked")).toBe(1);
  expect(await read(page, "__moved")).toBe(0);
});

it("신청·삭제처럼 중요할 수 있는 질문은 묻지 않고 직접 하시게 하며 어댑터도 답하지 않는다", async () => {
  const { page, adapter, click, out, native, grants } = await firstClick("정말 삭제하시겠어요?");
  expect(native).toMatchObject({ answerable: false, count: 1, record: { risk: "consequential" } });
  expect(out.message).toContain("제가 대신 답하지 않았어요");
  const result = await adapter.execute(click, undefined, undefined, grants);
  expect(result).toMatchObject({ ok: false, errorCode: "VERIFY_FAILED" });
  expect(await read(page, "__asked")).toBe(1);
  expect(await read(page, "__moved")).toBe(0);
});

it("소리로 다 읽어 줄 수 없게 긴 질문은 앞부분이 평범해도 대신 답하지 않는다", async () => {
  const { page, adapter, click, out, native, grants } = await firstClick("가".repeat(250));
  expect(native).toMatchObject({ answerable: false, record: { risk: "long", length: 250 } });
  expect(out.message).toContain("긴 안내문");
  expect((await adapter.execute(click, undefined, undefined, grants)).errorCode).toBe("VERIFY_FAILED");
  expect(await read(page, "__moved")).toBe(0);
});

it("문서가 바뀌었으면 같은 글의 질문이어도 답하지 않는다", async () => {
  const { page, adapter, click, grants } = await firstClick();
  await page.reload();
  const result = await adapter.execute(click, undefined, undefined, grants);
  expect(result).toMatchObject({ ok: false, errorCode: "VERIFY_FAILED" });
  expect(await read(page, "__asked")).toBe(0);
});

it("시간이 넘어도 답하는 누르기를 다시 하지 않는다", async () => {
  const { adapter, agent, ctx, click, grants } = await firstClick();
  const timedOut = { actionId: click.id, ok: false, verified: false, latencyMs: 0, errorCode: "TIMEOUT" as const };
  const execute = vi.spyOn(adapter, "execute").mockResolvedValue(timedOut);
  const result = await ctx.granted([click.id], () => agent.run(click, ctx, [], undefined, undefined, grants));
  expect(result?.errorCode).toBe("TIMEOUT");
  expect(execute).toHaveBeenCalledTimes(1);
});

it("조작 밖에서 뒤늦게 뜬 질문은 허가가 있어도 답하지 않는다", async () => {
  const site = await open(nativeSite);
  await write(site.page, "__lateAsk", true);
  await write(site.page, "__navigate", false);
  const ctx = context();
  const out = await site.agent.followLink("다음 쪽", ctx);
  const { pending: click, native } = out;
  if (click === undefined || native === undefined) throw new Error("Expected the site's question");
  // 처음 누른 것이 남긴 뒤늦은 질문은 조작이 끝난 뒤에 떠서 취소된다.
  await site.page.waitForTimeout(1000);
  expect(await read(site.page, "__late")).toBe(false);
  await write(site.page, "__late", null);
  const replay = await ctx.granted([click.id], () => site.agent.run(click, ctx, [], undefined, undefined, grantOf(native.record)));
  expect(replay?.ok).toBe(true);
  expect(await read(site.page, "__moved")).toBe(1);
  // 되풀이한 누르기가 끝난 뒤에 뜬 다른 질문에는 답하지 않는다.
  await site.page.waitForTimeout(1000);
  expect(await read(site.page, "__late")).toBe(false);
  expect(await read(site.page, "__moved")).toBe(1);
  expect(site.adapter.takeNative(click.id)).toMatchObject({ accepted: true, cancelled: [] });
});
