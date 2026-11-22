import { chromium, expect as screen, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { startUi } from "./web-ui-fixtures.ts";

let browser: Browser;
let ui: Awaited<ReturnType<typeof startUi>>;
let page: Page;

beforeAll(async () => {
  ui = await startUi(false, { REQUIRE_CONSENT: "true" });
  browser = await chromium.launch();
}, 90_000);
afterAll(async () => {
  await browser?.close();
  await ui?.close();
}, 30_000);
beforeEach(async () => {
  page = await browser.newPage({ locale: "ko-KR", viewport: { width: 1280, height: 800 } });
});
afterEach(async () => {
  await page?.close();
  await ui?.reset();
});

async function consent() {
  await page.goto(ui.url);
  const hear = page.locator("#consent-hear");
  await screen(hear).toBeEnabled({ timeout: 15_000 });
  await hear.click();
  await page.locator("#consent-yes").click();
  await screen(page.locator("#consent-panel")).toBeHidden();
}

async function sendText(text: string) {
  const input = page.locator("#command");
  await input.fill(text);
  await input.press("Enter");
  await screen(page.locator("#send")).toBeEnabled({ timeout: 20_000 });
}

async function noHorizontalOverflow() {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

it.each([{ width: 360, height: 740 }, { width: 1280, height: 800 }])("keeps the composer in view from the welcome choices to the first reply at $width px", async viewport => {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await consent();
  await screen(page.locator("#welcome-panel")).toBeVisible();
  const command = page.locator("#command");
  await page.evaluate(() => window.scrollTo(0, 0));
  await screen(command).toBeInViewport({ ratio: 1 });
  const readyTop = await command.evaluate(el => el.getBoundingClientRect().top);
  const starter = page.locator("#starter-actions button:visible").first();
  const request = await starter.getAttribute("data-request");
  await starter.focus();
  await page.keyboard.press("Enter");
  await screen(command).toBeFocused();
  await screen(command).toHaveValue(request!);
  await sendText("장애인연금 지원 대상이 누구야?");
  await screen(page.locator("#answer-panel")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await screen(command).toBeInViewport({ ratio: 1 });
  if (viewport.width === 1280) {
    const answerTop = await command.evaluate(el => el.getBoundingClientRect().top);
    expect(Math.abs(answerTop - readyTop)).toBeLessThan(2);
  }
});

it("closes the examples from their visible height and keeps keyboard focus on the summary", async () => {
  await page.setViewportSize({ width: 960, height: 860 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await consent();
  const examples = page.locator(".conversation > .examples-disclosure");
  const summary = examples.locator("summary");
  await summary.press("Enter");
  const heights = await examples.evaluate(async node => {
    const el = node as HTMLDetailsElement;
    el.getBoundingClientRect();
    await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished));
    const open = el.getBoundingClientRect().height;
    el.open = false;
    const starting = el.getBoundingClientRect().height;
    await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished));
    return { open, starting, closed: el.getBoundingClientRect().height };
  });
  expect(Math.abs(heights.open - heights.starting)).toBeLessThan(2);
  expect(heights.closed).toBeLessThan(heights.open);
  await screen(summary).toBeFocused();
});

it("맨 아래에서는 새 메시지를 따라가고, 위로 올려 두면 자리를 지키며 새 메시지 보기 버튼으로 이동한다", async () => {
  let seq = 0;
  await page.route("**/api/turn", async route => {
    const body = route.request().postDataJSON() as { sessionId: string; text: string };
    seq++;
    await route.fulfill({
      json: {
        sessionId: body.sessionId,
        turnId: `t-${seq}`,
        userUtterance: body.text,
        intentType: "POLICY_QUESTION",
        state: "IDLE",
        semanticAction: "answer",
        speech: `안내 답변 ${seq}: ` + "긴 설명 문장이 이어집니다. ".repeat(14),
        lang: "ko",
        actions: [],
        sources: [],
        missingFields: [],
        pendingActions: 0,
        realSubmission: false,
      },
    });
  });

  await consent();
  // 스레드가 스크롤될 만큼 여러 턴을 채운다 (active 스테이지, 데스크톱에서는 #thread가 스크롤)
  for (let i = 1; i <= 5; i++) await sendText(`질문 ${i}`);

  const scroller = page.locator("#thread");
  const bottomCheck = await scroller.evaluate(el => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    gap: el.scrollHeight - el.scrollTop - el.clientHeight,
  }));
  expect(bottomCheck.scrollHeight).toBeGreaterThan(bottomCheck.clientHeight + 80);
  expect(bottomCheck.gap).toBeLessThanOrEqual(48);
  await screen(page.locator("#jump-latest")).toBeHidden();

  // 위로 스크롤한 뒤 새 응답이 와도 scrollTop은 유지되고 버튼이 개수를 표시한다
  await scroller.evaluate(el => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(50);
  const beforeScrollTop = await scroller.evaluate(el => el.scrollTop);
  await sendText("새 질문 6");
  const afterScrollTop = await scroller.evaluate(el => el.scrollTop);
  expect(afterScrollTop).toBe(beforeScrollTop);
  await screen(page.locator("#jump-latest")).toBeVisible();
  await screen(page.locator("#jump-latest")).toContainText("새 메시지 보기");

  // 버튼을 누르면 맨 아래로 이동하고 버튼이 사라진다
  await page.locator("#jump-latest").click();
  await screen(page.locator("#jump-latest")).toBeHidden();
  const afterJump = await scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
  expect(afterJump).toBeLessThanOrEqual(48);

  // 다시 위로 올려 새 메시지를 받은 뒤 직접 맨 아래로 스크롤해도 버튼이 사라진다
  await scroller.evaluate(el => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(50);
  await sendText("새 질문 7");
  await screen(page.locator("#jump-latest")).toBeVisible();
  await scroller.evaluate(el => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });
  await screen(page.locator("#jump-latest")).toBeHidden();
});

it("320px 화면에서 동의·준비·답변·승인 화면이 가로 스크롤 없이 맞고 대화 영역이 옆 판보다 먼저 온다", async () => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(ui.url);
  await screen(page.locator("#consent-hear")).toBeEnabled({ timeout: 15_000 });

  // 1) 동의 화면
  const atConsent = await noHorizontalOverflow();
  expect(atConsent.scrollWidth, "consent overflow").toBeLessThanOrEqual(atConsent.clientWidth);
  await screen(page.locator("#stop-all")).toBeVisible();

  // 2) 준비 화면
  await page.locator("#consent-hear").click();
  await page.locator("#consent-yes").click();
  await screen(page.locator("#welcome-panel")).toBeVisible();
  const atReady = await noHorizontalOverflow();
  expect(atReady.scrollWidth, "ready overflow").toBeLessThanOrEqual(atReady.clientWidth);
  const order = await page.evaluate(() => {
    const conv = document.querySelector(".primary-column")!.getBoundingClientRect();
    const side = document.querySelector(".side")!.getBoundingClientRect();
    return { convTop: conv.top, sideTop: side.top };
  });
  expect(order.convTop).toBeLessThan(order.sideTop);

  // 3) 복지 답변 화면
  await sendText("장애인연금 지원 대상이 누구야?");
  await screen(page.locator("#answer-panel")).toBeVisible({ timeout: 20_000 });
  const atAnswer = await noHorizontalOverflow();
  expect(atAnswer.scrollWidth, "answer overflow").toBeLessThanOrEqual(atAnswer.clientWidth);

  // 4) 승인 화면
  await sendText("장애인연금 신청 도와줘");
  await sendText("이름은 김하늘, 주소는 부산광역시 예시구 예시로 10");
  await sendText("제출해");
  await screen(page.locator("#confirm-panel")).toBeVisible({ timeout: 20_000 });
  const atApproval = await noHorizontalOverflow();
  expect(atApproval.scrollWidth, "approval overflow").toBeLessThanOrEqual(atApproval.clientWidth);
  await screen(page.locator("#confirm-yes")).toBeVisible();
  await screen(page.locator("#confirm-no")).toBeVisible();
  await screen(page.locator("#stop-all")).toBeVisible();
  await screen(page.locator("#command")).toBeVisible();
});

it.each(["en", "ja"] as const)("360px %s 화면에서 버튼과 시작 타일이 가로로 넘치거나 잘리지 않는다", async lang => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.route("**/api/session/*/language", async route => {
    const response = await route.fetch();
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({ json: { ...body, lang, speech: lang === "en" ? "English enabled." : "日本語で案内します。" } });
  });
  await consent();
  await page.locator("#lang-select").selectOption(lang);
  await screen(page.locator("html")).toHaveAttribute("lang", lang);
  const overflow = await noHorizontalOverflow();
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  const clipped = await page.locator("#starter-actions button:visible").evaluateAll(buttons =>
    buttons.filter(b => b.scrollWidth > b.clientWidth + 2).map(b => b.textContent?.trim()),
  );
  expect(clipped).toEqual([]);
});

it("1280px 200% 확대(640px CSS 너비)에서도 멈춰 버튼과 입력란이 보인다", async () => {
  await page.setViewportSize({ width: 640, height: 400 });
  await consent();
  await sendText("장애인연금 지원 대상이 누구야?");
  const overflow = await noHorizontalOverflow();
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  await screen(page.locator("#stop-all")).toBeVisible();
  await screen(page.locator("#command")).toBeVisible();
});

it("움직임 줄이기 설정에서는 단계 전환 때 애니메이션을 실행하지 않고 상태 라벨을 유지한다", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await consent();
  await sendText("장애인연금 지원 대상이 누구야?");
  await screen(page.locator("#app")).toHaveAttribute("data-stage", "active");
  const runningAnimations = await page.evaluate(() => document.getAnimations().filter(a => a.playState === "running").length);
  expect(runningAnimations).toBe(0);
  await screen(page.locator("#st-state")).toBeVisible();
  await screen(page.locator("#capture-label")).toBeVisible();
  await screen(page.locator("#task-label")).toBeVisible();
});

it("1,000개의 메시지가 있어도 입력란이 포커스를 유지하고 글자가 빠지지 않는다", async () => {
  let turnId = 0;
  await page.route("**/api/turn", async route => {
    const body = route.request().postDataJSON() as { sessionId: string; text: string };
    await route.fulfill({
      json: {
        sessionId: body.sessionId, turnId: `t-${++turnId}`, userUtterance: body.text,
        intentType: "POLICY_QUESTION", state: "IDLE", semanticAction: "answer",
        speech: "간단한 응답입니다.", lang: "ko", actions: [], sources: [],
        missingFields: [], pendingActions: 0, realSubmission: false,
      },
    });
  });
  await consent();
  await sendText("첫 질문");
  // 합성 메시지 1,000개를 DOM 목록에 채운 상태에서 실제 입력과 포커스를 확인한다
  await page.evaluate(() => {
    const ol = document.getElementById("log")!;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 1000; i++) {
      const li = document.createElement("li");
      li.className = i % 2 === 0 ? "msg user" : "msg assistant";
      li.textContent = `합성 메시지 ${i}`;
      frag.appendChild(li);
    }
    ol.appendChild(frag);
  });
  const input = page.locator("#command");
  await input.click();
  await input.type("장애인연금 신청 도와줘");
  await screen(input).toBeFocused();
  await screen(input).toHaveValue("장애인연금 신청 도와줘");
});
