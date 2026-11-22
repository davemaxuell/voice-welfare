import { chromium, expect as browserExpect, type Browser, type Page, type Route } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type * as Speaker from "../../web/src/speaker.ts";
import { axeScript } from "../../src/core/assets.ts";
import { latch } from "./browser-cases.ts";
import { recordCues, startUi } from "./web-ui-fixtures.ts";

let browser: Browser;
let ui: Awaited<ReturnType<typeof startUi>>;
let page: Page;

beforeAll(async () => {
  ui = await startUi();
  browser = await chromium.launch();
}, 90_000);
afterAll(async () => {
  await browser?.close();
  await ui?.close();
});
beforeEach(async () => { page = await browser.newPage({ locale: "ko-KR" }); });
afterEach(async () => { await page?.close(); await ui?.reset(); });

const heading = "안내 듣고 시작하기 (Enter)";
const command = () => page.getByLabel("명령 입력 (말하듯이 입력하세요)");
const state = () => page.locator("#st-state");
const turnTimeout = { timeout: 20_000 };
const speaker = () => page.evaluateHandle<typeof Speaker>("import('/src/speaker.ts')");
const cueNames = () => page.evaluate(() => (window.__cues ?? []).map(([kind]) => kind));

async function openConsent(url = ui.url) {
  await page.goto(url);
  const hear = page.getByRole("button", { name: heading });
  await browserExpect(hear).toBeEnabled({ timeout: 15_000 });
  return hear;
}

async function consent(url = ui.url) {
  const hear = await openConsent(url);
  await browserExpect(hear).toBeFocused();
  await hear.click();
  const yes = page.getByRole("button", { name: "동의하고 시작 (Enter)" });
  await browserExpect(yes).toBeVisible();
  await yes.click();
  await browserExpect(page.locator("#consent-panel")).toBeHidden();
}

async function send(text: string) {
  await command().fill(text);
  await command().press("Enter");
}

async function fillToApproval() {
  await send("장애인연금 신청 도와줘");
  await browserExpect(state()).toHaveText("신청서 작성 중", turnTimeout);
  await send("이름은 김하늘, 주소는 부산광역시 예시구 예시로 10");
  await browserExpect(page.locator("#fields")).toContainText("입력됨: 김하늘", turnTimeout);
  await send("제출해");
  await browserExpect(state()).toHaveText("승인 대기", turnTimeout);
}

it("두 번 끊긴 하트비트는 초안을 보존하고 다시 연결해도 대화를 반복하지 않는다", async () => {
  await page.clock.install();
  await consent();
  await command().fill("입력하던 연습 질문");
  const count = await page.locator("#log li").count();
  let beats = 0;
  await page.route("**/api/session/*/heartbeat", route => { beats++; return route.abort("internetdisconnected"); });
  await page.clock.fastForward(15_100);
  await browserExpect.poll(() => beats).toBe(1);
  await browserExpect(page.locator("#task-label")).not.toContainText("연결이 끊겼");
  await page.clock.fastForward(15_100);
  await browserExpect(page.locator("#task-label")).toHaveText("연결이 끊겼어요");
  await browserExpect(command()).toHaveValue("입력하던 연습 질문");
  await page.unroute("**/api/session/*/heartbeat");
  await page.getByRole("button", { name: "다시 연결" }).click();
  await browserExpect(page.locator("#task-label")).toHaveText("기다리고 있어요.");
  await browserExpect(command()).toHaveValue("입력하던 연습 질문");
  await browserExpect(page.locator("#log li")).toHaveCount(count);
});

it("서버가 처리한 턴의 응답만 유실되면 현재 상태를 읽되 같은 요청은 보내지 않는다", async () => {
  await consent();
  let turns = 0, reads = 0;
  await page.route("**/api/turn", async route => { turns++; await route.fetch(); await route.abort("connectionreset"); });
  page.on("request", req => { if (new URL(req.url()).pathname.endsWith("/state")) reads++; });
  await send("장애인연금이 뭐야");
  await browserExpect(page.locator("#error")).toContainText("요청 결과를 확인하지 못했어요.");
  await browserExpect.poll(() => reads).toBe(1);
  expect(turns).toBe(1);
  await browserExpect(command()).toHaveValue("장애인연금이 뭐야");
});

it("서버가 여전히 기다리는 승인은 새 카드로 확인하고 이전 요청은 자동으로 반복하지 않는다", async () => {
  await consent();
  const pending = { actionId: "연습-확인", kind: "field-entry", purpose: "지역 입력", site: "연습 양식", values: [{ label: "지역", value: "예시 지역" }] };
  await page.route("**/api/turn", async route => {
    const result = await route.fetch();
    const turn = await result.json() as Record<string, unknown>;
    await route.fulfill({ json: { ...turn, state: "WAITING_FOR_USER_CONFIRMATION", pendingConfirmation: pending } });
  });
  await send("장애인연금이 뭐야");
  const approve = page.locator("#confirm-yes");
  await browserExpect(approve).toBeVisible();
  let sends = 0;
  await page.route("**/api/session/*/confirm", route => { sends++; return route.abort("connectionreset"); });
  await page.route("**/api/session/*/state", route => route.fulfill({ json: { state: "WAITING_FOR_USER_CONFIRMATION", pendingConfirmation: pending } }));
  await approve.click();
  await browserExpect(page.locator("#error")).toContainText("요청 결과를 확인하지 못했어요.");
  await browserExpect(approve).toBeEnabled();
  expect(sends).toBe(1);
  await approve.click();
  await browserExpect.poll(() => sends).toBe(2);
});

it("멈춤 확인이 두 번 실패하면 이 기기는 멈춰 있고 사용자가 확인을 다시 요청한다", async () => {
  await consent();
  let cancels = 0;
  await page.route("**/api/session/*/cancel", async route => {
    cancels++;
    if (cancels <= 2) await route.fulfill({ status: 500, json: { message: "연습용 서버 내부 오류" } });
    else await route.continue();
  });
  await page.locator("#stop-all").click();
  const retry = page.getByRole("button", { name: "다시 멈춤 요청" });
  await browserExpect(retry).toBeVisible();
  expect(cancels).toBe(2);
  await browserExpect(page.locator("#task-label")).toHaveText("멈췄어요.");
  await browserExpect(page.locator("#error")).not.toContainText("연습용 서버 내부 오류");
  await browserExpect(page.locator("#send")).toBeDisabled();
  await retry.click();
  await browserExpect(retry).toBeHidden();
  expect(cancels).toBe(3);
  await browserExpect(state()).toHaveAttribute("data-state", "STOPPED");
});

it("test_consent_then_text_command", async () => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await consent();
  await browserExpect(page.getByRole("log", { name: "대화 기록" })).toContainText("동의해 주셔서 감사합니다");

  await send("장애인연금 신청 도와줘");
  await browserExpect(state()).toHaveText("신청서 작성 중", turnTimeout);
  await browserExpect(page.locator("#st-step")).toContainText("1/3");
  await browserExpect(command()).toHaveValue("");
  await browserExpect(page.locator("#fields")).toContainText("성명");

  await send("이름은 김하늘");
  await browserExpect(page.locator("#fields")).toContainText("입력됨: 김하늘", turnTimeout);
  await browserExpect(page.locator("#actions")).toContainText("성공");
  expect(errors).toEqual([]);
});

it("test_decline_and_high_contrast", async () => {
  await (await openConsent()).click();
  await page.keyboard.press("Escape");
  await browserExpect(page.locator("#log")).toContainText("복지 제도 질문에만 답할게요");
  await browserExpect(page.getByRole("button", { name: "대화 시작 (Enter)" })).toBeDisabled();
  await page.getByRole("button", { name: "고대비 꺼짐" }).click();
  await browserExpect(page.locator("#app")).toHaveClass("app high-contrast");
});

it("멈춘 뒤 늦게 온 응답은 기록하거나 읽지 않는다", async () => {
  const voice = await startUi(true, { REQUIRE_CONSENT: "false" });
  const received = latch(), release = latch();
  const late = "늦게 도착한 연습 응답입니다.";
  const speech: string[] = [];
  try {
    await page.route("**/api/turn", async route => {
      const response = await route.fetch();
      const json: unknown = await response.json();
      if (typeof json !== "object" || json === null) throw new Error("시험 응답이 없습니다.");
      received.resolve();
      await release.promise;
      await route.fulfill({ json: { ...json, speech: late } });
    });
    page.on("request", r => { if (new URL(r.url()).pathname === "/api/audio/speak") speech.push(r.postData() ?? ""); });
    await page.goto(voice.url);
    await browserExpect(page.locator("#send")).toBeEnabled(turnTimeout);
    await send("장애인연금이 뭐야");
    await received.promise;
    await page.locator("#stop-all").click();
    await browserExpect(state()).toHaveText("중단됨", turnTimeout);
    const messages = await page.locator("#log .assistant").allTextContents();
    release.resolve();
    await browserExpect(page.locator("#send")).toBeEnabled(turnTimeout);
    expect(await page.locator("#log .assistant").allTextContents()).toEqual(messages);
    expect(speech.some(text => text.includes(late))).toBe(false);
  } finally { release.resolve(); await page.close(); await voice.close(); }
});

it("test_sound_cues_stay_under_mic_detector_limits", async () => {
  await openConsent();
  const { levels, micOpen } = await (await speaker()).evaluate(async m => {
    await m.preloadCues();
    const rate = 48_000;
    const levels: Array<{ kind: string; peak: number; crest: number; loudMs: number }> = [];
    for (const kind of m.CUE_KINDS) {
      const context = new OfflineAudioContext(1, rate * 3, rate);
      m.renderCue(kind, context, context.destination, 0);
      const samples = (await context.startRendering()).getChannelData(0);
      let peak = 0;
      for (const value of samples) peak = Math.max(peak, Math.abs(value));
      // 박수 감지기가 쓰는 512개 표본 창에서 봉우리/RMS를 잰다.
      let crest = 0;
      for (let i = 0; i + 512 <= samples.length; i += 256) {
        let localPeak = 0, sum = 0;
        for (const value of samples.subarray(i, i + 512)) {
          localPeak = Math.max(localPeak, Math.abs(value));
          sum += value * value;
        }
        if (localPeak >= peak * 0.25) crest = Math.max(crest, localPeak / Math.sqrt(sum / 512));
      }
      const frame = rate / 20;
      const rms: number[] = [];
      for (let i = 0; i < samples.length; i += frame) {
        let sum = 0;
        for (const value of samples.subarray(i, i + frame)) sum += value * value;
        rms.push(Math.sqrt(sum / frame));
      }
      const threshold = Math.max(...rms) * 10 ** (-30 / 20);
      levels.push({ kind, peak, crest, loudMs: rms.filter(value => value > threshold).length * 50 });
    }
    return { levels, micOpen: m.MIC_OPEN_CUES };
  });
  expect(levels).toHaveLength(12);
  expect([...micOpen].sort((a, b) => a.localeCompare(b, "en"))).toEqual(["done", "stopped", "thinking", "working"]);
  for (const { kind, peak, crest, loudMs } of levels) {
    expect(peak, kind).toBeGreaterThan(0.05);
    expect(crest, kind).toBeLessThan(4);
    if (micOpen.includes(kind)) expect(loudMs, kind).toBeLessThan(200);
  }
});

it("test_transition_cue_only_on_state_change", async () => {
  await openConsent();
  const cues = await (await speaker()).evaluate(({ transitionCue: t }) => [
    t("APPLICATION_OPEN", "WAITING_FOR_USER_CONFIRMATION"), t("BROWSING", "AUTH_HANDOFF"),
    t("APPLICATION_OPEN", "MOCK_SUBMITTED"), t("APPLICATION_OPEN", "RECOVERING"),
    t("APPLICATION_OPEN", "VALIDATION_ERROR"), t("APPLICATION_OPEN", "STOPPED"),
    t("MOCK_SUBMITTED", "MOCK_SUBMITTED"), t("STOPPED", "STOPPED"),
    t("WAITING_FOR_USER_CONFIRMATION", "WAITING_FOR_USER_CONFIRMATION"),
    t("IDLE", "APPLICATION_OPEN"), t("APPLICATION_OPEN", "DONE"),
  ]);
  expect(cues).toEqual(["approve", "handoff", "success", "problem", "problem", "stopped",
    undefined, undefined, undefined, undefined, undefined]);
});

it("test_earcon_always_resolves", async () => {
  await openConsent();
  const hung = await (await speaker()).evaluate(async m => {
    await m.preloadCues();
    const hung = [];
    for (const kind of m.CUE_KINDS) {
      const ok = await Promise.race([m.earcon(kind).then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 2500))]);
      if (ok !== true) hung.push(kind);
    }
    return hung;
  });
  expect(hung).toEqual([]);
});

it("test_approval_plays_its_cue_once", async () => {
  await recordCues(page);
  await consent();
  await browserExpect(page.locator("#tts-toggle")).toHaveText("음성 안내 켜짐");
  await fillToApproval();
  expect(await cueNames()).toEqual(["approve"]);
});

it("test_stop_plays_stopped_once_even_with_voice_guidance_off", async () => {
  await recordCues(page);
  await consent();
  await page.getByRole("button", { name: "음성 안내 켜짐" }).click();
  await fillToApproval();
  expect(await cueNames()).toEqual([]);
  await page.getByRole("button", { name: "멈춰 (모든 동작 중단)" }).click();
  await browserExpect(state()).toHaveText("중단됨", turnTimeout);
  expect(await cueNames()).toEqual(["stopped"]);
});

it("test_command_focus_and_value_survive_rerender", async () => {
  await consent();
  const input = command();
  await input.fill("장애인연금 신청");
  await input.press("ArrowLeft");
  const original = await input.evaluateHandle(node => node);
  // 포커스는 입력창에 둔 채 실제 화면 설정을 변경한다.
  await page.getByRole("button", { name: "고대비 꺼짐" }).dispatchEvent("click");
  await browserExpect(page.locator("#app")).toHaveClass("app high-contrast");
  await browserExpect(input).toBeFocused();
  await browserExpect(input).toHaveValue("장애인연금 신청");
  expect(await original.evaluate(node => node === document.activeElement)).toBe(true);
  await page.keyboard.insertText("재");
  await browserExpect(input).toHaveValue("장애인연금 신재청");
});

/** 화면 낭독기는 aria-live 영역의 DOM이 바뀔 때만 읽는다. 그 바뀜을 센다. */
async function watchLiveRegion(id: string, repliesOnly = false) {
  await page.evaluate(({ id, repliesOnly }) => {
    const w = window as unknown as { __mutations: Record<string, number> };
    w.__mutations = { ...w.__mutations, [id]: 0 };
    new MutationObserver(records => {
      const count = repliesOnly ? records.filter(r => [...r.addedNodes].some(n => n instanceof Element && n.matches("li.assistant"))).length : records.length;
      w.__mutations[id] = (w.__mutations[id] ?? 0) + count;
    })
      .observe(document.getElementById(id)!, { childList: true, characterData: true, subtree: true });
  }, { id, repliesOnly });
  return {
    count: () => page.evaluate(id => (window as unknown as { __mutations: Record<string, number> }).__mutations[id] ?? 0, id),
    reset: () => page.evaluate(id => { (window as unknown as { __mutations: Record<string, number> }).__mutations[id] = 0; }, id),
  };
}

it("test_repeated_announcement_reaches_screen_reader", async () => {
  await consent();
  await send("장애인연금 신청 도와줘");
  await browserExpect(state()).toHaveText("신청서 작성 중", turnTimeout);
  await browserExpect(page.locator("#send")).toBeEnabled(turnTimeout);
  const announce = await watchLiveRegion("announce");
  const replies = await watchLiveRegion("log", true);
  await browserExpect(page.getByRole("log", { name: "대화 기록" })).toHaveAttribute("aria-live", "polite");
  await send("이름은 김하늘");
  await browserExpect(page.locator("#fields")).toContainText("입력됨: 김하늘", turnTimeout);
  await browserExpect(page.locator("#send")).toBeEnabled(turnTimeout);
  expect(await replies.count()).toBe(1);
  expect(await announce.count()).toBe(0);
  await announce.reset();
  await page.getByRole("button", { name: "고대비 꺼짐" }).click();
  await browserExpect(page.locator("#app")).toHaveClass("app high-contrast");
  expect(await announce.count()).toBe(0);
});

it("test_repeated_error_reaches_screen_reader", async () => {
  await consent();
  await page.route("**/language", route => route.fulfill({
    status: 500, contentType: "application/json", body: JSON.stringify({ message: "언어를 바꾸지 못했습니다." }),
  }));
  const select = page.locator("#lang-select");
  await select.selectOption("en");
  await browserExpect(page.locator("#error")).toHaveText("언어를 바꾸지 못했습니다.");
  const alert = await watchLiveRegion("error");
  await select.selectOption("zh");
  await browserExpect.poll(alert.count).toBe(1);
  await browserExpect(page.locator("#error")).toHaveText("언어를 바꾸지 못했습니다.");
});

it("test_language_choice_stays_while_request_runs", async () => {
  await consent();
  const requested: unknown[] = [];
  let answered = 0;
  page.on("response", response => { if (response.url().endsWith("/language")) answered++; });
  await page.route("**/language", async route => {
    requested.push(route.request().postDataJSON());
    await new Promise(resolve => setTimeout(resolve, 1500));
    await route.continue();
  });
  const select = page.locator("#lang-select");
  await select.focus();
  await page.keyboard.press("ArrowDown");
  await browserExpect(select).toHaveValue("en");
  await page.keyboard.press("ArrowDown");
  await browserExpect(select).toHaveValue("zh");
  await browserExpect.poll(() => answered, turnTimeout).toBe(2);
  expect(requested).toEqual([{ lang: "en" }, { lang: "zh" }]);
  await browserExpect(select, "언어 모델이 없는 시험 서버는 세션 언어를 한국어로 둔다").toHaveValue("ko");
});

it("test_failed_language_change_restores_session_language", async () => {
  await consent();
  await page.route("**/language", async route => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "언어를 바꾸지 못했습니다." }) });
  });
  const select = page.locator("#lang-select");
  await select.selectOption("en");
  await browserExpect(select).toHaveValue("en");
  await browserExpect(page.locator("#error")).toHaveText("언어를 바꾸지 못했습니다.");
  await browserExpect(select).toHaveValue("ko");
});

async function expectAccessible() {
  await page.addScriptTag({ path: axeScript });
  const violations = await page.evaluate<Array<{ id: string; nodes: string[][] }>>(`(async () => {
    const result = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }));
  })()`);
  expect(violations).toEqual([]);
}

it("어두운 테마에서 대화, 환경 설정, 조사와 처음 설정을 읽을 수 있다", async () => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  let setup = false;
  await page.route("**/api/health", route => route.fulfill({ json: {
    settingsAvailable: true, workspaceAvailable: true, setupRequired: setup, practiceMode: true,
    stt: { provider: "fixture", supported: false }, tts: { provider: "fixture", supported: false },
  } }));
  await page.route("**/api/settings", route => route.fulfill({ json: {
    language: "ko", region: "", regions: [], speed: 1.35, deviceUse: "personal", browser: "separate",
    sharedDevice: false, rememberService: false, hasKey: false, loadError: false, browserFallback: false,
  } }));
  await consent();
  await expectAccessible();
  await page.locator("#open-settings").click();
  await browserExpect(page.locator("#settings-dialog")).toBeVisible();
  await expectAccessible();
  await page.keyboard.press("Escape");
  await page.locator("#workflow-title").click();
  await browserExpect(page.locator("#workflow-panel")).toHaveAttribute("open", "");
  await expectAccessible();
  setup = true;
  await page.reload();
  await browserExpect(page.locator("#first-run")).toBeVisible();
  await expectAccessible();
});

it.each([false, true])("test_web_ui_axe_violations (고대비 %s)", async highContrast => {
  if (highContrast) await page.addInitScript(() => {
    document.addEventListener("animationstart", event => {
      if (!(event.target instanceof HTMLElement) || !event.target.matches(".consent-details") || event.animationName !== "fade-in") return;
      const fade = event.target.getAnimations().find(a => a instanceof CSSAnimation && a.animationName === "fade-in");
      if (fade?.effect !== null && fade?.effect !== undefined) {
        fade.pause();
        fade.currentTime = Number(fade.effect.getTiming().delay) + 30;
      }
    });
  });
  await openConsent();
  if (highContrast) {
    await page.getByRole("button", { name: "고대비 꺼짐" }).click();
    await browserExpect(page.locator("#app")).toHaveClass("app high-contrast");
  }
  await expectAccessible();
});

it("test_progress_cues_never_play_over_speech", async () => {
  const voiceUi = await startUi(true);
  try {
    await recordCues(page, true);
    await consent(voiceUi.url);
    await page.waitForFunction(() => (window.__talking?.length ?? 0) >= 4 &&
      (window.__cues ?? []).filter(([kind]) => kind === "listen").length >= 2, undefined, { timeout: 40_000 });
    await browserExpect(page.locator("#log")).toContainText("지금 어디까지 했어?");
    const cues = await cueNames();
    expect(cues).not.toContain("thinking");
    expect(cues).not.toContain("working");
  } finally {
    await page.close();
    await voiceUi.close();
  }
});

const progressRoute = "**/api/session/*/progress";
const finishedStep = "연습 누리집에서 안내를 확인했어요.";
const finishedReport = { seq: 17, backend_status: finishedStep };
const pollFallback = () => page.route("**/progress/stream", route => route.fulfill({ status: 503, body: "" }));

it("shows backend progress in place without adding or announcing chat messages", async () => {
  await recordCues(page);
  await consent();
  const speech: string[] = [];
  page.on("request", req => { if (new URL(req.url()).pathname === "/api/audio/speak") speech.push(req.postData() ?? ""); });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let progress = { seq: 1, backend_status: "공식 자료를 찾고 있어요." };
  const first = progress.backend_status;
  await page.route("**/progress/stream", route => route.fulfill({
    contentType: "text/event-stream", body: "data: " + JSON.stringify(progress) + "\n\n",
  }));
  await page.route("**/progress", route => route.fulfill({ json: progress }));
  await page.route("**/turn", async route => { await pending; await route.continue(); });
  const status = page.locator(".conversation #backend-status");
  try {
    await send("장애인연금이 뭐야");
    await browserExpect(status).toHaveText(first);
    await browserExpect(status).toHaveAttribute("aria-live", "off");
    const original = await status.elementHandle();
    progress = { seq: 2, backend_status: "공식 자료에서 신청 방법을 확인하고 있어요." };
    await browserExpect(status).toHaveText(progress.backend_status);
    expect(await status.evaluate((element, previous) => element === previous, original)).toBe(true);
    await browserExpect(page.locator("#log")).not.toContainText(first);
    await browserExpect(page.locator("#log")).not.toContainText(progress.backend_status);
    await browserExpect(page.locator("#announce")).not.toContainText(progress.backend_status);
    expect(speech.some(request => request.includes(first) || request.includes(progress.backend_status))).toBe(false);
    await browserExpect(command()).toBeFocused();
  } finally {
    finish();
  }
  await browserExpect(status).toBeHidden(turnTimeout);
  await browserExpect(page.locator("#log")).toContainText("장애인연금이 뭐야", turnTimeout);
});

it("shows recorded input progress quietly and clears it before the answer", async () => {
  const voice = await startUi(true, { REQUIRE_CONSENT: "false", PRACTICE_MODE: "false" });
  try {
    await recordCues(page, true);
    await pollFallback();
    await page.route(progressRoute, route => route.fulfill({ json: finishedReport }));
    await page.goto(voice.url);
    const mic = page.locator("#mic-btn");
    await browserExpect(mic).toBeEnabled();
    await mic.click();
    await browserExpect(mic).toHaveAttribute("aria-pressed", "true");
    const request = holdNext("**/api/audio/turn?**");
    await mic.click();
    const status = page.locator("#backend-status");
    await browserExpect(status).toHaveText(finishedStep);
    const turn = await request;
    await browserExpect(page.locator("#log")).not.toContainText(finishedStep);
    await browserExpect(page.locator("#announce")).not.toContainText(finishedStep);
    expect(await cueNames()).not.toContain("working");
    await turn.continue();
    await browserExpect(status).toBeHidden(turnTimeout);
    await browserExpect(page.locator("#log .user").last()).toContainText("기초연금", turnTimeout);
  } finally { await page.close(); await voice.close(); }
});

it("shows delegated backend work while Live remains open and clears it when the call ends", async () => {
  await page.route("**/api/health", async route => {
    const response = await route.fetch();
    const health: unknown = await response.json();
    if (health === null || typeof health !== "object") throw new Error("Invalid health response");
    await route.fulfill({ json: { ...health, stt: { supported: true, provider: "test" }, voiceEdge: "test" } });
  });
  await page.route(url => url.pathname === "/src/voice-edge.ts", route => route.fulfill({
    contentType: "text/javascript", body: "export class LiveConversation { audio = { muted: true, paused: true }; async start() {} stop() {} updateAudio() {} setLanguage() {} }",
  }));
  let progress = { seq: 1, backend_status: "" };
  await page.route("**/progress/stream", route => route.fulfill({ status: 503, body: "" }));
  await page.route("**/progress", route => route.fulfill({ json: progress }));
  await consent();
  const status = page.locator("#backend-status");
  await browserExpect(page.locator("#phase")).toHaveClass(/phase-listening/);
  await browserExpect(status).toBeHidden();
  progress = { seq: 2, backend_status: "최신 공고를 확인하고 있어요." };
  await browserExpect(status).toHaveText(progress.backend_status);
  await browserExpect(page.locator("#log")).not.toContainText(progress.backend_status);
  progress = { seq: 3, backend_status: "" };
  await browserExpect(status).toBeHidden();
  await browserExpect(page.locator("#conv-end")).toBeVisible();
  progress = { seq: 4, backend_status: "다음 페이지를 읽고 있어요." };
  await browserExpect(status).toHaveText(progress.backend_status);
  await page.locator("#conv-end").click();
  await browserExpect(status).toBeHidden();
});

function holdNext(pattern: string) {
  return new Promise<Route>((resolve, reject) => {
    page.route(pattern, route => { resolve(route); }, { times: 1 }).catch(reject);
  });
}

async function heldTurn(text = "도움말") {
  const pending = holdNext("**/api/turn");
  await send(text);
  return pending;
}

async function afterProgress(route: Route) {
  await route.fulfill({ json: finishedReport });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

it("진행 조회가 열 초 지연되어도 요청은 하나만 보낸다", async () => {
  await pollFallback();
  await consent();
  let waiting = 0;
  await page.route(progressRoute, () => { waiting++; });
  await heldTurn();
  await new Promise(resolve => setTimeout(resolve, 10_250));
  expect(waiting).toBe(1);
});

it("멈춘 뒤 도착한 진행 응답은 화면과 복구 기록을 바꾸지 않는다", async () => {
  await pollFallback();
  const personal = await startUi(false, { PILOT_PROFILE: "personal" });
  try {
    await page.goto(personal.url);
    await page.getByRole("button", { name: "복구 켜고 시작" }).click();
    await page.getByRole("button", { name: heading }).click();
    await page.getByRole("button", { name: "동의하고 시작 (Enter)" }).click();
    await browserExpect(page.locator("#consent-panel")).toBeHidden();
    const progress = holdNext(progressRoute);
    await heldTurn();
    const pending = await progress;
    await page.locator("#stop-all").click();
    await browserExpect(state()).toHaveText("중단됨");
    const log = await page.locator("#log").innerText();
    const stored = () => page.evaluate(() => sessionStorage.getItem("cheongeum.progressSeq"));
    const previous = await stored();
    await afterProgress(pending);
    expect({ visible: await page.locator("#backend-status").isVisible(), stored: await stored(), log: await page.locator("#log").innerText() })
      .toEqual({ visible: false, stored: previous, log });
  } finally {
    await page.close();
    await personal.close();
  }
});

it("새 작업은 멈춘 조회를 기다리지 않고 새로운 진행 상태를 읽는다", async () => {
  await consent();
  await pollFallback();
  const reports: Route[] = [];
  await page.route(progressRoute, route => { reports.push(route); });
  const first = await heldTurn();
  await browserExpect.poll(() => reports.length).toBe(1);
  await first.continue();
  await browserExpect(page.locator("#send")).toBeEnabled();
  const second = await heldTurn();
  await browserExpect.poll(() => reports.length).toBe(2);
  await afterProgress(reports[0]!);
  await browserExpect(page.locator("#backend-status")).toBeHidden();
  await afterProgress(reports[1]!);
  await browserExpect(page.locator("#backend-status")).toHaveText(finishedStep);
  await second.continue();
});

it("대화 중 말로 멈춘 뒤 도착한 진행 응답은 표시하거나 읽지 않는다", async () => {
  await pollFallback();
  const voice = await startUi(true, { PRACTICE_MODE: "false" });
  try {
    await recordCues(page, true);
    await page.addInitScript(() => localStorage.setItem("cheongeum.voiceMode", "dictate"));
    const audio = holdNext("**/api/audio/turn?**");
    const progress = holdNext(progressRoute);
    const interrupt = holdNext("**/api/audio/stop?**");
    await consent(voice.url);
    const [pendingAudio, pendingProgress, spokenStop] = await Promise.all([audio, progress, interrupt]);
    const clip = Buffer.alloc(2048, 32);
    clip.write("멈춰");
    const response = await spokenStop.fetch({
      headers: { ...spokenStop.request().headers(), "content-type": "audio/webm" }, postData: clip,
    });
    expect(await response.json()).toMatchObject({ stopped: true });
    await spokenStop.fulfill({ response });
    await browserExpect(state()).toHaveText("중단됨");
    const log = await page.locator("#log").innerText();
    await afterProgress(pendingProgress);
    expect(await page.locator("#backend-status").isVisible()).toBe(false);
    expect(await page.locator("#log").innerText()).toBe(log);
    await pendingAudio.fulfill({ status: 409, json: { message: "중단된 작업이에요." } });
  } finally {
    await page.close();
    await voice.close();
  }
});

it("진행 상황을 물어도 실행 중인 작업의 단계는 계속 표시한다", async () => {
  await pollFallback();
  const voice = await startUi(true, { PRACTICE_MODE: "false" });
  try {
    await recordCues(page, true);
    await page.addInitScript(() => localStorage.setItem("cheongeum.voiceMode", "dictate"));
    const audio = holdNext("**/api/audio/turn?**");
    const question = holdNext("**/api/audio/stop?**");
    let polls = 0;
    await page.route(progressRoute, route => {
      polls++;
      return route.fulfill({ json: finishedReport });
    });
    await consent(voice.url);
    const [pendingAudio, pendingQuestion] = await Promise.all([audio, question]);
    const activity = page.locator("#backend-status");
    await browserExpect(activity).toHaveText(finishedStep);
    await pendingQuestion.continue();
    await browserExpect(page.locator("#log .user").last()).toContainText("어디까지");
    const before = polls;
    await browserExpect.poll(() => polls).toBeGreaterThan(before);
    await browserExpect(activity).toBeVisible();
    await browserExpect(activity).toHaveText(finishedStep);
    await pendingAudio.fulfill({ status: 409, json: { message: "시험을 마쳤어요." } });
  } finally {
    await page.close();
    await voice.close();
  }
});
