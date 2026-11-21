import { expect, it } from "vitest";
import { PORTAL2, scripted, step } from "../helpers.ts";
import { browserCases } from "./browser-cases.ts";

const open = browserCases();

it("현재 화면에서 열린 공지를 닫고 그 내용을 말한다", async () => {
  const { session, page } = await open();
  await session.handleTurn(PORTAL2 + " 열어줘");
  await page.setContent(`<main><h1>이용 안내</h1>
    <button onclick="document.querySelector('dialog').showModal()">더보기</button>
    <dialog aria-label="점검 공지"><p>토요일에는 상담실을 쉽니다.</p>
    <button type="button" onclick="this.closest('dialog').close()">확인</button></dialog></main>`);
  const reply = await session.handleTurn("더보기 눌러줘");
  expect(await page.locator("dialog").isVisible(), reply.speech).toBe(false);
  expect(reply.speech.match(/토요일에는 상담실을 쉽니다/gu)).toHaveLength(1);
  expect(reply.speech).toContain("닫았어요");
});

it("현재 화면에서 열린 두 단추 질문은 읽고 사용자의 선택을 기다린다", async () => {
  const { session, page } = await open();
  await session.handleTurn(PORTAL2 + " 열어줘");
  await page.setContent(`<main><h1>이용 안내</h1>
    <button onclick="document.querySelector('dialog').showModal()">더보기</button>
    <dialog aria-label="목록 선택"><p>다음 목록을 볼까요?</p>
    <button>확인</button><button>취소</button></dialog></main>`);
  const reply = await session.handleTurn("더보기 눌러줘");
  expect(await page.locator("dialog").isVisible()).toBe(true);
  expect(reply.speech).toContain("다음 목록을 볼까요");
  expect(reply.speech).toContain("확인");
  expect(reply.speech).toContain("취소");
  expect(reply.state).toBe("NEEDS_CLARIFICATION");
  expect(reply.pendingConfirmation).toBeUndefined();
  const picked = await session.handleTurn("1번 눌러줘");
  expect(picked.pendingConfirmation?.kind).toBe("click");
  expect(await page.locator("dialog").isVisible()).toBe(true);
});

it("목표 도중 사이트가 확인과 취소 중 고르라고 하면 모델이 다음 단추를 고르기 전에 멈춘다", async () => {
  const {session, page} = await open();
  const url = "127.0.0.1:5174/popup-choice.html";
  await page.route("**/popup-choice.html", route => route.fulfill({contentType: "text/html; charset=utf-8",
    body: `<main><h1>이용 안내</h1><button onclick="document.querySelector('dialog').showModal()">더보기</button>
    <dialog aria-label="목록 선택"><p>다음 목록을 볼까요?</p><button>확인</button><button>취소</button></dialog></main>`}));
  const calls = scripted(session, [step("open_url", url), step("click", "더보기"), step("click", "확인")]);
  const reply = await session.handleTurn(url + "에서 안내 찾아줘");
  expect(calls).toHaveLength(2);
  expect(reply.state).toBe("NEEDS_CLARIFICATION");
  expect(reply.speech).toContain("다음 목록을 볼까요?");
  expect(reply.speech).toContain("취소");
  expect(reply.pendingConfirmation).toBeUndefined();
  expect(await page.locator("dialog").isVisible()).toBe(true);
});

it("안내를 닫다가 사이트의 확인 창이 뜨면 취소한 사실을 알리고 사용자가 직접 이어가게 한다", async () => {
  const {session, page} = await open();
  await session.handleTurn(PORTAL2 + " 열어줘");
  await page.setContent(`<main><h1>이용 안내</h1><button onclick="document.querySelector('dialog').showModal()">더보기</button>
    <dialog aria-label="점검 공지"><p>토요일에는 상담실을 쉽니다.</p>
    <button type="button" onclick="if (confirm('다음 쪽으로 이동할까요?')) this.closest('dialog').close()">확인</button></dialog></main>`);
  const reply = await session.handleTurn("더보기 눌러줘");
  expect(reply.speech).toContain("제가 취소했어요");
  expect(reply.speech).toContain("직접 확인");
  expect(reply.pendingConfirmation).toBeUndefined();
  expect(await page.locator("dialog").isVisible()).toBe(true);
});

it("팝업 안쪽의 닫힌 섀도 DOM에 입력 칸이 있으면 확인 단추를 누르기 전에 묻는다", async () => {
  const { session, page } = await open();
  await session.handleTurn(PORTAL2 + " 열어줘");
  await page.setContent(`<main><h1>이용 안내</h1><dialog open aria-label="방문 안내"><p>방문 안내입니다.</p>
    <div id="field"></div><button type="button" onclick="this.closest('dialog').close()">확인</button></dialog></main>`);
  await page.locator("#field").evaluate(host => {
    const input = document.createElement("input");
    input.setAttribute("aria-label", "방문 시간");
    host.attachShadow({ mode: "closed" }).append(input);
  });
  const reply = await session.handleTurn("확인 눌러줘");
  expect(reply.state, reply.speech).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(await page.locator("dialog").isVisible()).toBe(true);
});
