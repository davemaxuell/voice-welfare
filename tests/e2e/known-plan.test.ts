import { createServer } from "node:http";
import { chromium, expect as screen } from "@playwright/test";
import { expect, it, vi } from "vitest";
import { startUi } from "./web-ui-fixtures.ts";
import { browserCases } from "./browser-cases.ts";

const open = browserCases();
const address = "127.0.0.1:5174/known-plan.html";
const names = ["글자 크기 변경", "정렬 수정", "보기 취소"];
const request = names.map(n => n + " 버튼 눌러줘").join(", ");

function documentHtml(rename: boolean) {
  return `<!doctype html><title>화면 표시</title><main><h1>보기 설정</h1><p>안내 글을 읽는 방법을 고르세요.</p>
      <form id="display"></form>
      ${names.map((n, i) => `<button form="display" type="button" aria-expanded="false" id="b${i}">${n}</button>`).join("")}<p id="output"></p></main>
      <script>document.querySelectorAll('button').forEach((b,i)=>b.addEventListener('click',()=>{
        b.setAttribute('aria-expanded','true'); document.querySelector('#output').append(b.textContent+'|');
        if(i===0 && ${rename}) document.querySelector('#b1').textContent='계정 삭제';
      }))</script>`;
}

async function setup(rename = false) {
  const test = await open();
  const { session, page } = test;
  session.deps.publicPlanning = false;
  await page.route("**/known-plan.html", r => r.fulfill({ contentType: "text/html; charset=utf-8", body: documentHtml(rename) }));
  await session.handleTurn(address + " 열어줘");
  const asked = await session.handleTurn(request, { fromVoice: true });
  expect(asked.pendingConfirmation?.kind).toBe("plan");
  expect(asked.speech).toContain("1번, “글자 크기 변경” 버튼. 2번, “정렬 수정” 버튼. 3번, “보기 취소” 버튼");
  expect(await page.locator("#output").textContent()).toBe("");
  return { ...test, yes: () => session.handleTurn("네", { fromVoice: true, approvalId: asked.pendingConfirmation?.actionId }) };
}

it("음성으로 직접 말한 세 버튼을 한 번 확인받아 각각 정책 검사를 거쳐 순서대로 누른다", async () => {
  const { session, page, yes } = await setup();
  const wrong = await session.handleTurn("네", { fromVoice: true, approvalId: "오래된-승인" });
  expect(wrong.actions).toEqual([]);
  const result = await yes();
  expect(result.speech).toContain("3개 항목을 차례로 눌렀어요");
  expect(result.actions.map(e => [e.action.target?.name, e.policy.code, e.result?.ok])).toEqual(names.map(name => [name, "APPROVED", true]));
  expect(new Set(result.actions.map(a => a.action.id)).size).toBe(3);
  expect(await page.locator("#output").textContent()).toBe(names.join("|") + "|");
  expect(result.pendingConfirmation).toBeUndefined();
});

it("첫 클릭 뒤 두 번째 버튼의 이름이 달라지면 남은 클릭 없이 새로 묻는다", async () => {
  const { page, session, yes } = await setup(true);
  const result = await yes();
  expect(result.state).toBe("NEEDS_CLARIFICATION");
  expect(result.speech).toContain("정렬 수정");
  expect(result.speech).toContain("어떤 항목을 누를까요?");
  expect(result.pendingConfirmation).toBeUndefined();
  await session.handleTurn("네");
  expect(await page.locator("#output").textContent()).toBe(names[0] + "|");
});

it.each(["제출 동작", "가려야 할 내용", "양식에 연결된 비밀번호 칸"])("정책 승인 뒤 클릭 직전에 %s이 생기면 누르지 않는다", async change => {
  const { adapter, page, yes } = await setup();
  const execute = adapter.execute.bind(adapter);
  vi.spyOn(adapter, "execute").mockImplementation(async (action, signal, scope, grants) => {
    if (grants?.plan !== undefined) await page.locator("#b0").evaluate((el, change) => {
      if (change === "제출 동작") el.setAttribute("data-action", "submit");
      else if (change === "가려야 할 내용") el.append(document.createElement("object"));
      else {
        const field = document.createElement("input");
        field.type = "password";
        field.setAttribute("form", "display");
        document.body.append(field);
      }
    }, change);
    return execute(action, signal, scope, grants);
  });
  const result = await yes();
  expect(result.state).toBe("NEEDS_CLARIFICATION");
  expect(result.actions[0]).toMatchObject({ policy: { code: "APPROVED" }, result: { ok: false, errorCode: "VERIFY_FAILED" } });
  expect(await page.locator("#output").textContent()).toBe("");
});

it("승인을 기다리는 동안 영역이 비활성화되면 시도한 조작 없이 다시 묻는다", async () => {
  const { page, yes } = await setup();
  await page.locator("main").evaluate(el => el.setAttribute("aria-disabled", "true"));
  const result = await yes();
  expect(result.state).toBe("NEEDS_CLARIFICATION");
  expect(result.actions).toEqual([]);
  expect(await page.locator("#output").textContent()).toBe("");
});

it("일반 대화창의 계획 승인 카드 하나로 세 단계를 마친다", async () => {
  const site = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(documentHtml(false));
  });
  await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
  const location = site.address();
  if (location === null || typeof location === "string") throw new Error("시험 화면 주소가 없어요.");
  const ui = await startUi(false, { REQUIRE_CONSENT: "false" });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ locale: "ko-KR" });
    await page.goto(ui.url);
    const send = async (text: string) => {
      await screen(page.locator("#send")).toBeEnabled();
      await page.locator("#command").fill(text);
      await page.locator("#command").press("Enter");
    };
    await send(`127.0.0.1:${location.port}/known-plan.html 열어줘`);
    await screen(page.locator("#log")).toContainText("화면 표시");
    await send(request);
    const card = page.locator("#confirm-panel");
    await screen(card).toBeVisible();
    for (const label of names) await screen(card).toContainText(label);
    await page.locator("#confirm-yes").click();
    await screen(page.locator("#log")).toContainText("3개 항목을 차례로 눌렀어요");
    await screen(card).toBeHidden();
  } finally {
    await browser.close();
    await ui.close();
    await new Promise<void>((done, fail) => site.close(e => e ? fail(e) : done()));
  }
});
