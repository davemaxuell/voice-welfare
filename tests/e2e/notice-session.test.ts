import type { Page } from "playwright";
import { expect, it } from "vitest";
import { ExecContext } from "../../src/agents/web/agent.ts";
import { scripted, step } from "../helpers.ts";
import { browserCases } from "./browser-cases.ts";

// A2: 대화(직접 말하기)와 목표 수행 모두에서 안내 팝업은 묻지 않고 닫고 알리며, 사이트의 질문은 사용자에게 알리고 묻는다.
const open = browserCases();
const NOTICE = "127.0.0.1:5174/notice-fixture.html";
const NATIVE = "127.0.0.1:5174/native-fixture.html";

const noticePage = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>안내 시험</title></head><body>
<main><h1>복지 안내</h1><p>이 화면은 안내 팝업을 시험하는 화면입니다.</p><a href="#info">보조기기 안내</a></main>
<div role="dialog" id="pop" aria-labelledby="t">
<h2 id="t">점검 공지</h2>
<p>서버 점검이 있어서 잠시 접속이 느릴 수 있어요.</p>
<button type="button" id="ok">확인</button>
</div>
<script>document.getElementById("ok").addEventListener("click", () => { document.getElementById("pop").remove(); });</script>
</body></html>`;
const nativePage = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>쪽 이동</title></head><body>
<main><h1>쪽 이동</h1><p>이 화면은 사이트의 질문을 시험하는 화면입니다.</p><button type="button" id="go">다음 쪽</button></main>
<script>
window.__moved = 0;
document.getElementById("go").addEventListener("click", () => {
  if (confirm("다음 쪽으로 이동할까요?")) { window.__moved++; location.assign("/native-done.html"); }
});
</script>
</body></html>`;
const nativeDone = "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><title>이동 완료</title></head><body><main><h1>이동 완료</h1><p>다음 쪽에 왔어요.</p></main></body></html>";

async function serve(page: Page, pages: Record<string, string>) {
  for (const [path, body] of Object.entries(pages)) {
    await page.route("**" + path, route => route.fulfill({ contentType: "text/html; charset=utf-8", body }));
  }
}

it("직접 확인을 누르라고 하면 안내 팝업은 '누를까요?' 없이 닫는다", async () => {
  const { session, page } = await open();
  await serve(page, { "/notice-fixture.html": noticePage });
  await session.handleTurn(NOTICE + " 열어줘");
  expect(await page.locator("#pop").count()).toBe(1);
  const result = await session.handleTurn("확인 버튼 눌러줘");
  expect(result.speech).not.toContain("누를까요");
  expect(result.speech.match(/서버 점검이 있어서 잠시 접속이 느릴 수 있어요/gu)).toHaveLength(1);
  expect(session.dialogue.approval).toBeUndefined();
  expect(result.actions.map(entry => entry.policy.code)).toEqual(["ALLOWED_NOTICE"]);
  expect(await page.locator("#pop").count()).toBe(0);
});

it("목표를 수행하다 만난 안내 팝업도 묻지 않고 닫고 무엇이라고 했는지 한 번 알린다", async () => {
  const { session, page } = await open();
  await serve(page, { "/notice-fixture.html": noticePage });
  scripted(session, [step("open_url", NOTICE), step("ask_user", "user_choice", "어느 안내를 볼까요?")]);
  const result = await session.handleTurn(NOTICE + "에서 안내 찾아줘");
  expect(result.speech).toContain("안내 팝업 '점검 공지'가 떠서 닫았어요.");
  expect(result.speech).toContain("서버 점검이 있어서 잠시 접속이 느릴 수 있어요.");
  expect(result.speech).toContain("어느 안내를 볼까요?");
  expect(result.speech).not.toContain("누를까요");
  expect(session.dialogue.approval).toBeUndefined();
  expect(result.actions.some(entry => entry.policy.code === "ALLOWED_NOTICE")).toBe(true);
  expect(await page.locator("#pop").count()).toBe(0);
});

async function openNative() {
  const opened = await open();
  await serve(opened.page, { "/native-fixture.html": nativePage, "/native-done.html": nativeDone });
  await opened.session.handleTurn(NATIVE + " 열어줘");
  return opened;
}
const moved = (page: Page) => page.evaluate(() => Number(Reflect.get(window, "__moved") ?? 0));

it("공개 정보 조회 중 사이트가 물으면 취소 사실을 말하고 승인을 남기지 않는다", async () => {
  const {session, page} = await openNative();
  scripted(session, [step("click", "다음 쪽")]);
  const ctx = new ExecContext({publicLookup: true, signal: new AbortController().signal, isStopped: () => false, trace() {}});
  const reply = await session.browse.runGoal("다음 쪽을 찾아줘", ctx, {continuePage: true});
  expect(reply.speech).toContain("대신 답하지 않고 취소했어요");
  expect(reply.state).toBe("NEEDS_CLARIFICATION");
  expect(session.dialogue.approval).toBeUndefined();
  expect(await moved(page)).toBe(0);
});

it("개인 화면의 승인된 단추가 사이트 질문을 띄우면 질문 내용은 말하지 않고 인계한다", async () => {
  const {session, page} = await openNative();
  const ctx = new ExecContext({browsingScope: "personal-inspection", signal: new AbortController().signal, isStopped: () => false, trace() {}});
  await session.browse.followLink("다음 쪽", ctx);
  const approval = session.dialogue.approval;
  if (approval?.kind !== "click") throw new Error("누르기 승인을 기다려야 합니다.");
  const reply = await ctx.granted([approval.action.id], () => session.browse.clickApproved(approval, ctx));
  expect(reply.speech).toContain("개인 화면이라");
  expect(reply.speech).not.toContain("다음 쪽으로 이동할까요");
  expect(session.dialogue.approval).toBeUndefined();
  expect(await moved(page)).toBe(0);
});

it("직접 누르다 사이트가 물으면 알리고 묻고, '진행해'에 같은 누르기를 한 번 되풀이한다", async () => {
  const { session, page } = await openNative();
  const asked = await session.handleTurn("다음 쪽 눌러줘");
  expect(asked.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(asked.speech).toContain("사이트가 '다음 쪽으로 이동할까요?'라고 물어서 아직 진행하지 않았어요. 진행할까요?");
  expect(asked.pendingConfirmation?.kind).toBe("click");
  expect(await moved(page)).toBe(0);
  const done = await session.handleTurn("진행해");
  expect(page.url()).toMatch(/native-done\.html$/u);
  expect(done.actions.some(entry => entry.policy.code === "ALLOWED_READ_ONLY" && entry.result?.ok === true)).toBe(true);
  expect(session.dialogue.approval).toBeUndefined();
});

it("사이트의 질문에 거절하면 답하지 않고, 그 뒤의 '진행해'는 아무것도 하지 않는다", async () => {
  const { session, page } = await openNative();
  await session.handleTurn("다음 쪽 눌러줘");
  const rejected = await session.handleTurn("거절");
  expect(rejected.speech).toContain("사이트의 질문에 답하지 않았어요");
  expect(session.dialogue.approval).toBeUndefined();
  const later = await session.handleTurn("진행해");
  expect(later.actions).toEqual([]);
  expect(later.pendingConfirmation).toBeUndefined();
  expect(session.dialogue.approval).toBeUndefined();
  expect(page.url()).toMatch(/native-fixture\.html$/u);
  expect(await moved(page)).toBe(0);
});

it("멈춘 뒤에는 이전 질문에 답하지 않는다", async () => {
  const { session, page } = await openNative();
  await session.handleTurn("다음 쪽 눌러줘");
  expect(session.cancel().state).toBe("STOPPED");
  const later = await session.handleTurn("진행해");
  expect(later.state).toBe("STOPPED");
  expect(page.url()).toMatch(/native-fixture\.html$/u);
  expect(await moved(page)).toBe(0);
});

it("목표를 수행하다 사이트가 물어도 사용자에게 알리고 묻는다", async () => {
  const { session, page } = await open();
  await serve(page, { "/native-fixture.html": nativePage, "/native-done.html": nativeDone });
  scripted(session, [step("open_url", NATIVE), step("click", "다음 쪽")]);
  const asked = await session.handleTurn(NATIVE + "에서 다음 쪽 찾아줘");
  expect(asked.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(asked.speech).toContain("사이트가 '다음 쪽으로 이동할까요?'라고 물어서 아직 진행하지 않았어요. 진행할까요?");
  expect(asked.speech).toContain("하신 일을 하다가");
  expect(await moved(page)).toBe(0);
  await session.handleTurn("진행해");
  expect(page.url()).toMatch(/native-done\.html$/u);
});
