import { afterAll, expect, it } from "vitest";
import { AgentRuntime, loadConfig } from "../../src/server/runtime.ts";
import { PlaywrightExecutionAdapter } from "../../src/agents/web/browser/index.ts";
import { redactText } from "../../src/safety/privacy.ts";
import { LinkChoices } from "../../src/agents/web/link_choices.ts";
import { FakeLlm } from "../helpers.ts";

const runtime = new AgentRuntime(loadConfig({ HEADLESS: "true", LLM_PROVIDER: "mock", PRACTICE_MODE: "false" }));
afterAll(() => runtime.close(), 60_000);

async function site(body: string) {
  const session = await runtime.createSession();
  const adapter = session.web.adapter as PlaywrightExecutionAdapter;
  await adapter.start();
  const page = adapter.page!;
  await page.route("https://service.example/**", route => route.fulfill({
    contentType: "text/html; charset=utf-8", body: '<main><h1>민원 안내</h1>' + body + '</main>',
  }));
  await page.goto("https://service.example/");
  await session.web.observe(session.beginTurn(redactText("[화면]")).ctx);
  return { session, page };
}

it("첫 요청 한 번으로 입력하고, 사이트의 확인창이 있어도 요청한 단추를 한 번만 누른다", async () => {
  const {session, page} = await site(`<label for="alias">별칭</label><input id="alias">
    <button onclick="this.dataset.count = Number(this.dataset.count || 0) + 1; if (confirm('계속할까요?')) document.querySelector('p').textContent='반영했습니다'">설정 저장</button><p></p>`);
  try {
    expect(session.consentStatus).toBe("granted");
    const fill = await session.handleTurn("별칭에 민들레 입력해줘", {fromVoice: true});
    expect(fill.pendingConfirmation).toBeUndefined();
    expect(await page.locator("#alias").inputValue()).toBe("민들레");
    const result = await session.handleTurn("설정 저장 부탁해요", {fromVoice: true});
    expect(result.pendingConfirmation).toBeUndefined();
    expect(await page.locator("button").getAttribute("data-count")).toBe("1");
    expect(await page.locator("p").textContent()).toBe("반영했습니다");
  } finally { await session.close(); }
});

it("로그인으로 이동한 뒤 비밀번호 입력만 사용자에게 넘긴다", async () => {
  const {session, page} = await site(`<a href="/account">로그인</a>`);
  try {
    await page.route("https://service.example/account", route => route.fulfill({contentType: "text/html; charset=utf-8",
      body: '<main><h1>회원 로그인</h1><label>비밀번호<input type="password"></label><button onclick="location.href=\'/complete\'">로그인</button></main>'}));
    const opened = await session.handleTurn("로그인하고 싶어", {fromVoice: true});
    expect(opened.pendingConfirmation).toBeUndefined();
    expect(opened.authHandoff).toMatchObject({kind: "login", status: "waiting"});
    expect(await page.locator("input").inputValue()).toBe("");
    await page.locator("input").fill("fixture-value");
    const completed = await session.handleTurn("다 입력했어", {fromVoice: true});
    expect(page.url()).toBe("https://service.example/complete");
    expect(completed.authHandoff?.status).toBe("completed");
    expect(completed.pendingConfirmation).toBeUndefined();
    expect(JSON.stringify(completed)).not.toContain("fixture-value");
  } finally { await session.close(); }
});

it("이미 허용한 사이트에서 칸 채우기를 부탁하면 저장된 값을 쓰고 모르는 값만 묻는다", async () => {
  const {session, page} = await site('<label>이름<input id="name"></label><label>별칭<input id="alias"></label>');
  try {
    session.personal.saveVault({name: "김하늘"});
    session.personal.allowSite("https://service.example");
    await session.handleTurn("입력 칸을 채워야 하나요?");
    await session.handleTurn("여기에 전부 입력하지 말아 주세요");
    expect(await page.locator("#name").inputValue()).toBe("");
    const result = await session.handleTurn("입력 칸 하나씩 채워줘");
    expect(result.pendingConfirmation).toBeUndefined();
    expect(await page.locator("#name").inputValue()).toBe("김하늘");
    expect(result.speech).toContain("별칭");
    await session.handleTurn("민들레");
    expect(await page.locator("#alias").inputValue()).toBe("민들레");
  } finally { await session.close(); }
});

it("기다리던 입력칸의 문서가 바뀌면 이름이 같은 새 칸에 대답을 쓰지 않는다", async () => {
  const {session, page} = await site('<label>별칭<input id="alias"></label>');
  try {
    await session.handleTurn("입력 칸 하나씩 채워줘");
    await page.reload();
    await session.handleTurn("민들레");
    expect(await page.locator("#alias").inputValue()).toBe("");
  } finally { await session.close(); }
});

it("제출 요청은 사이트의 확인 단추까지 진행하고 검토 요청이나 관계없는 삭제는 실행하지 않는다", async () => {
  const {session, page} = await site(`<button id="submit" onclick="document.querySelector('dialog').showModal()">신청서 제출</button>
    <dialog aria-labelledby="dialog-title"><h2 id="dialog-title">신청서 제출</h2><p>신청서를 제출할까요?</p>
    <button onclick="document.querySelector('output').textContent += '완료';this.closest('dialog').close()">확인</button>
    <button onclick="this.closest('dialog').close()">취소</button></dialog><output></output>
    <button onclick="if(confirm('계정을 삭제할까요?'))document.querySelector('output').textContent='삭제'">안내 보기</button>`);
  try {
    await session.handleTurn("최종 확인할게");
    expect(await page.locator("dialog").isVisible()).toBe(false);
    const result = await session.handleTurn("신청서 제출해 주세요", {fromVoice: true});
    expect(result.pendingConfirmation).toBeUndefined();
    expect(await page.locator("output").textContent()).toBe("완료");
    expect(await page.locator("dialog").isVisible()).toBe(false);
    const unrelated = await session.handleTurn("안내 보기 버튼 눌러줘");
    expect(unrelated.pendingConfirmation).toBeUndefined();
    expect(await page.locator("output").textContent()).toBe("완료");
  } finally { await session.close(); }
});

it("마지막에 실제로 제시한 링크만 자연스러운 대답으로 열고, 취소와 바뀐 선택을 구별한다", async () => {
  const {session, page} = await site('<a href="/guide">이용 안내</a><a href="/map">위치 안내</a>');
  try {
    const propose = async () => {
      const list = await session.handleTurn("링크 목록 알려줘");
      const choices = session.browse.linkChoices;
      expect(choices).toBeInstanceOf(LinkChoices);
      const offer = await session.handleTurn("첫 번째 링크 이름이 뭐야", {fromVoice: true, linkOfferId: list.turnId});
      expect(session.browse.linkChoices?.proposed).toBe(1);
      return offer.turnId;
    };
    const first = await propose();
    await session.handleTurn("그건 지금 열지 말아 주세요", {fromVoice: true, linkOfferId: first});
    expect(page.url()).toBe("https://service.example/");
    const current = await propose();
    await session.handleTurn("네, 그렇게 해 주세요", {fromVoice: true, linkOfferId: first});
    expect(page.url()).toBe("https://service.example/");
    const valid = current === session.linkOfferId ? current : await propose();
    session.deps.webLlm = new FakeLlm({proposed_action_reply: {decision: "accept"}});
    await session.handleTurn("말씀하신 쪽으로 맡길게요", {fromVoice: true, linkOfferId: valid});
    expect(page.url()).toBe("https://service.example/guide");
  } finally { await session.close(); }
});

it("화면 조작을 묻거나 하지 말라고 한 발화로는 그 조작을 실행하지 않는다", async () => {
  const {session, page} = await site('<button onclick="document.querySelector(\'output\').textContent += \'실행\'">계정 삭제</button><output></output>');
  try {
    await session.handleTurn("계정 삭제 버튼을 눌러도 돼?");
    await session.handleTurn("계정 삭제 버튼 눌러주지 마세요");
    expect(await page.locator("output").textContent()).toBe("");
    await session.handleTurn("계정 삭제 버튼 눌러 주세요");
    expect(await page.locator("output").textContent()).toBe("실행");
    await session.handleTurn("계정 삭제 버튼을 눌러도 돼요.", {fromVoice: true});
    expect(await page.locator("output").textContent()).toBe("실행실행");
  } finally { await session.close(); }
});

it("말로 허락한 동작은 현재 제안한 링크에서 바로 실행한다", async () => {
  const {session, page} = await site('<a href="/guide">이용 안내</a><a href="/map">위치 안내</a>');
  try {
    const list = await session.handleTurn("링크 목록 알려줘");
    const offer = await session.handleTurn("첫 번째 링크 이름이 뭐야", {fromVoice: true, linkOfferId: list.turnId});
    const result = await session.handleTurn("그 링크 열어도 돼요", {fromVoice: true, linkOfferId: offer.turnId});
    expect(result.pendingConfirmation).toBeUndefined();
    expect(page.url()).toBe("https://service.example/guide");
  } finally { await session.close(); }
});
