import { afterAll, expect, it } from "vitest";
import { PlaywrightExecutionAdapter } from "../../src/agents/web/browser/index.ts";
import { redactText } from "../../src/safety/privacy.ts";
import { AgentRuntime, loadConfig } from "../../src/server/runtime.ts";

const runtime = new AgentRuntime(loadConfig({HEADLESS:"true", PRACTICE_MODE:"false", BROWSER_DRIVER:process.env.BROWSER_DRIVER}));
afterAll(() => runtime.close(), 60_000);

it.each(["다른 사이트", "같은 주소의 새 문서", "교체한 양식", "누르는 중 바뀐 양식", "누르는 중 비워진 암호", "머리말과 양식", "직접 마친 로그인"])("비밀번호 인계를 시작한 화면과 버튼을 확인한다 (%s)", async scenario => {
  const session = await runtime.createSession();
  try {
    const page = (session.web.adapter as PlaywrightExecutionAdapter).page!;
    const base = "https://resident.example";
    await page.addInitScript(() => { Math.random = () => 0.25; });
    const login = (scenario === "머리말과 양식" ? '<header><input aria-label="사이트 검색"><a href="/header">로그인</a></header>' : '') +
      '<main><form action="/complete"><label>비밀번호<input type="password" required oninput="this.form.querySelector(\'button\').disabled=false"></label><button type="submit" disabled>로그인</button></form></main>';
    await page.route(/https:\/\/(?:resident|second)\.example\//u, route => {
      const pathname = new URL(route.request().url()).pathname;
      return route.fulfill({contentType:"text/html; charset=utf-8", body:pathname === "/start" ? '<a href="/account">로그인</a>' :
        pathname === "/account" ? login : '<main><h1>개인 서비스</h1></main>'});
    });
    await page.goto(base + "/start");
    await session.web.observe(session.beginTurn(redactText("[화면]")).ctx);
    expect((await session.handleTurn("로그인하고 싶어", {fromVoice:true})).authHandoff?.status).toBe("waiting");
    expect(await page.locator('input[type="password"]').evaluate(el => document.activeElement === el)).toBe(true);
    if (scenario === "다른 사이트") await page.goto("https://second.example/account");
    if (scenario === "같은 주소의 새 문서") await page.reload();
    if (scenario === "교체한 양식") await page.locator("form").evaluate(el => el.replaceWith(el.cloneNode(true)));
    if (scenario === "누르는 중 바뀐 양식") await page.locator("button").evaluate(el => { el.addEventListener("pointerdown", () => el.setAttribute("formaction", "/changed")); });
    if (scenario === "누르는 중 비워진 암호") await page.locator("button").evaluate(el => { el.addEventListener("pointerdown", () => { document.querySelector("input")!.value = ""; }); });
    await page.locator('input[type="password"]').fill("가상암호");
    if (scenario === "직접 마친 로그인") await page.getByRole("button", {name:"로그인"}).click();
    const result = await session.handleTurn("다 입력했어", {fromVoice:true});
    if (scenario === "머리말과 양식" || scenario === "직접 마친 로그인") {
      expect(new URL(page.url()).pathname).toBe("/complete");
      expect(result.authHandoff?.status).toBe("completed");
    } else {
      expect(new URL(page.url()).pathname).toBe("/account");
      expect(result.authHandoff?.status).toBe("interrupted");
    }
    expect(result.actions.filter(a => a.action.type === "click" && a.result?.ok === true)).toHaveLength(scenario === "머리말과 양식" ? 1 : 0);
  } finally {await session.close();}
});
