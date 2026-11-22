import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { browserCases } from "./browser-cases.ts";

const open = browserCases();
const address = "http://approval.test/account";
beforeAll(() => { vi.stubEnv("BROWSER_DRIVER", "stagehand"); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { vi.unstubAllEnvs(); });

async function screen(markup: string) {
  const result = await open();
  const { page, session } = result;
  await page.addInitScript(() => { Math.random = () => 0.25; });
  await page.route("http://approval.test/**", route => route.fulfill({ contentType: "text/html; charset=utf-8",
    body: '<!doctype html><html lang="ko"><title>주민 안내</title><main><h1>주민 안내</h1>' + markup + '</main></html>' }));
  await page.goto(address);
  await session.deps.web.observe();
  return result;
}

it.each(["로그인", "확인"])("번호와 이름이 같아도 문서를 다시 열면 이전에 물은 %s 단추를 누르지 않는다", async name => {
  const button = '<button onclick="document.body.dataset.clicked=String(1)">' + name + '</button>';
  const markup = name === "로그인" ? button :
    '<div role="dialog" aria-labelledby="title"><h2 id="title">시설 이용 안내</h2><p>이용 시간이 바뀌었어요.</p>' + button + '</div>';
  const { adapter, page, session } = await screen(markup);
  if (name === "확인") {
    const execute = adapter.execute.bind(adapter);
    vi.spyOn(adapter, "execute").mockImplementation(async (action, signal, inspection, grants) => {
      if (grants?.notice) await page.locator("p").evaluate(el => { el.textContent = "이전 안내를 정정했어요."; });
      return execute(action, signal, inspection, grants);
    });
  }
  const ask = await session.handleTurn(name === "로그인" ? "로그인해줘" : "확인 버튼 눌러줘");
  expect(ask.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(ask.speech).toContain(name);
  if (name === "확인") expect(ask.actions).toContainEqual(expect.objectContaining({
    policy: expect.objectContaining({ code: "ALLOWED_NOTICE" }), result: expect.objectContaining({ errorCode: "VERIFY_FAILED" }),
  }));
  const approval = session.dialogue.approval;
  if (approval?.kind !== "click") throw new Error("누르기 승인이 필요해요.");
  const target = approval.action.target;
  await page.reload();
  expect((await adapter.observe()).outline?.items).toContainEqual(expect.objectContaining({
    ref: target?.ref, role: "button", name,
  }));
  const answered = await session.handleTurn("눌러");
  expect(answered.actions).toContainEqual(expect.objectContaining({ policy: expect.objectContaining({ code: "DENIED_TARGET_CHANGED" }) }));
  expect(await page.locator("body").getAttribute("data-clicked")).toBeNull();
});

it("한 번에 물은 순서도 문서가 다시 열리면 첫 단추부터 누르지 않는다", async () => {
  const labels = ["글자 크기 변경", "정렬 수정"];
  const { session, page, adapter } = await screen(labels.map(name => '<button type="button" aria-expanded="false" ' +
    'onclick="this.setAttribute(\'aria-expanded\',\'true\')">' + name + '</button>').join(""));
  session.deps.publicPlanning = false;
  expect((await session.handleTurn(address + " 열어줘")).state).toBe("BROWSING");
  const ask = await session.handleTurn(labels.map(name => name + " 버튼 눌러줘").join(", "), { fromVoice: true });
  expect(ask.pendingConfirmation?.kind).toBe("plan");
  expect(adapter.page).toBe(page);
  const previous = (await adapter.observe()).outline?.items;
  await page.reload();
  expect((await adapter.observe()).outline?.items).toEqual(previous);
  const answer = await session.handleTurn("네", { fromVoice: true, approvalId: ask.pendingConfirmation?.actionId });
  expect(answer.state).toBe("NEEDS_CLARIFICATION");
  expect(answer.speech).toContain("남은 순서를 멈췄어요");
  expect(await page.locator('[aria-expanded="true"]').count()).toBe(0);
});

it.each(["그대로", "값 변경", "옵션 교체"])("지역 칸 승인은 사용자가 들은 옵션에만 적용한다 (%s)", async change => {
  const { page, session } = await screen('<select id="city" aria-label="지역" onchange="document.body.dataset.changed=String(1)">' +
    '<option value="busan">부산</option><option value="seoul">서울</option></select>');
  const ask = await session.handleTurn("지역 칸에 서울 써줘");
  expect(ask.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(ask.speech).toContain("서울");
  const option = page.locator("option").nth(1);
  if (change === "값 변경") await option.evaluate(el => { el.setAttribute("value", "updated-office"); });
  if (change === "옵션 교체") await option.evaluate(el => el.replaceWith(el.cloneNode(true)));
  const answered = await session.handleTurn("응");
  expect(await page.locator("select").inputValue()).toBe(change === "그대로" ? "seoul" : "busan");
  expect(await page.locator("body").getAttribute("data-changed")).toBe(change === "그대로" ? "1" : null);
  expect(answered.actions.some(entry => entry.action.type === "select" && entry.result?.ok === true)).toBe(change === "그대로");
});
