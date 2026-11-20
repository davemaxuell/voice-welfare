import { chromium, expect as check, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { REPO_ROOT, axeScript } from "../../src/core/assets.ts";
import { FAKE_OVERLAY } from "./avatar-overlay-fixture.ts";
import { startUi } from "./web-ui-fixtures.ts";

let ui: Awaited<ReturnType<typeof startUi>>, voice: Awaited<ReturnType<typeof startUi>>;
let browser: Browser, page: Page;
beforeAll(async () => {
  ui = await startUi(); voice = await startUi(true); browser = await chromium.launch();
}, 90_000);
afterAll(async () => { await browser?.close(); await voice?.close(); await ui?.close(); }, 30_000);
beforeEach(async () => { page = await browser.newPage({ locale: "ko-KR" }); });
afterEach(async () => { await page?.close(); await ui?.reset(); await voice?.reset(); });

const base = { connected: true, instance: "first", mode: "ready", state: "IDLE", capture: "off", speaking: false, busy: false,
  lang: "ko", status: "기다리고 있어요.", choices: [], message: null, site: null, pending: false };
const send = (kind: "snapshot" | "prefs" | "focus", value?: unknown) => page.evaluate("window.__send(" + JSON.stringify(kind) + "," + (JSON.stringify(value) ?? "undefined") + ")");
const snap = (revision: number, changes: Record<string, unknown> = {}) => send("snapshot", { ...base, revision, ...changes });
const calls = (kind: string) => page.evaluate<unknown[]>("window.__calls.filter(c => c[0] === " + JSON.stringify(kind) + ")");
const button = (name: string) => page.getByRole("button", { name, exact: true });
async function overlay(reduced = true) {
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(FAKE_OVERLAY);
  await page.goto(ui.url + "avatar/index.html");
}
async function command(text: string) {
  const box = page.getByLabel("명령 입력 (말하듯이 입력하세요)");
  await box.fill(text); await box.press("Enter");
}
async function requestFill() {
  await command("127.0.0.1:5174/external.html 열어줘");
  await check(page.locator("#st-access")).toContainText("읽기 전용");
  await command("이름 칸에 김하늘 써줘");
  await check(button("입력 승인")).toBeEnabled();
}
const fakeDesktop = `
window.__published = [];
window.cheongeumDesktop = {
  isDesktop: true, onTalk() {},
  publish: s => window.__published.push(JSON.parse(JSON.stringify(s))),
  onAction: cb => { window.__act = cb; },
};`;
const snapshot = z.object({ mode: z.string(), choices: z.array(z.object({ label: z.string() })), choiceSetId: z.string().nullish(),
  prompt: z.string().nullish(), revision: z.number(), sleeping: z.boolean(), message: z.unknown() });
async function latest() { return snapshot.parse(await page.evaluate("window.__published.at(-1)")); }
const choose = (id: string | null | undefined, key: string, times = 1) => page.evaluate(
  "for (let i=0; i<" + times + "; ++i) window.__act(" + JSON.stringify({ type: "choose", choiceSetId: id, key }) + ")"
);
const approval = { mode: "choice", status: "선택을 기다리고 있어요.", prompt: "<b>누르기</b>", site: "127.0.0.1:5174",
  choiceSetId: "a-1", choices: [{ key: "approve", label: "<i>입력 승인</i>" }, { key: "review", label: "내용 확인", open: "confirm" }, { key: "reject", label: "취소" }] };

async function pixels(element: Element) {
  if (!(element instanceof HTMLImageElement)) throw Error("Expected a portrait image");
  await element.decode();
  const { width, height, top } = element.getBoundingClientRect();
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(element, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  let foot = -1, head = -1;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! <= 32) continue;
    foot = Math.floor(i / 4 / width);
    if (head < 0) head = foot;
  }
  return { src: element.src, width, height, w: element.naturalWidth, h: element.naturalHeight, foot, head: top + head };
}

it("test_all_animation_frames_fit_the_desktop_portrait", async () => {
  await overlay(false); await send("prefs", { corner: "top-right", still: true });
  const probe = "/@fs/" + REPO_ROOT.replaceAll("\\", "/") + "/tests/e2e/avatar-portrait-probe.ts";
  const margins = z.record(z.string(), z.number()).parse(await page.evaluate("import(" + JSON.stringify(probe) + ").then(m => m.animationMargins())"));
  for (const clip of ["complete", "sleeping", "speaking", "ready"]) expect(margins).toHaveProperty(clip);
  for (const [clip, margin] of Object.entries(margins)) expect(margin, clip).toBeGreaterThanOrEqual(3);
}, 60_000);

it("test_static_poses_match_the_frame_and_ground_line", async () => {
  await overlay();
  const cases: [string, Record<string, unknown>][] = [
    ["ready", {}], ["sleeping", { sleeping: true }], ["listening", { mode: "listening" }], ["thinking", { mode: "working" }],
    ["speaking", { speaking: true }], ["confirmation", { state: "NEEDS_CLARIFICATION" }], ["auth-handoff", { mode: "auth-handoff" }],
    ["screen-reading", { state: "OBSERVING", mode: "working" }], ["screen-reading", { state: "BROWSING", reading: true }],
    ["try-again", { state: "VALIDATION_ERROR" }], ["stopped", { state: "PAUSED" }], ["complete", { state: "DONE" }],
  ];
  const feet: Record<string, number> = {};
  for (const [i, [pose, changes]] of cases.entries()) {
    await snap(i + 1, changes);
    const img = page.locator("#figure img:visible");
    await check(img).toHaveCount(1);
    const result = await img.evaluate(pixels);
    expect(result.src.endsWith("/" + pose + (pose === "sleeping" ? ".png" : ".webp"))).toBe(true);
    expect(result.w * result.height).toBe(result.h * result.width);
    expect(result.foot, pose).toBeGreaterThan(0); feet[pose] = result.foot;
  }
  expect(Math.abs(feet.ready! - feet.sleeping!)).toBeLessThanOrEqual(2);
  expect(Math.abs(feet.complete! - feet.ready!)).toBeLessThanOrEqual(2);
});

it("test_controller_cards_carry_no_values_and_dispatch_once", async () => {
  await page.addInitScript(fakeDesktop);
  let confirms = 0, consents = 0;
  page.on("request", r => {
    if (r.url().endsWith("/confirm")) confirms++;
    if (r.url().endsWith("/consent")) consents++;
  });
  await page.goto(ui.url + "?desktop=1");
  const first = await page.waitForFunction("window.__published.find(s => s.choices.some(c => c.key === 'consent-yes'))");
  const consent = snapshot.parse(await first.jsonValue());
  expect(consent.choices.map(c => c.label)).toEqual(["동의하고 음성 대화 시작", "동의하지 않음", "안내 보기"]);
  await choose(consent.choiceSetId, "consent-yes", 2);
  await check(page.locator("#consent-panel")).toBeHidden();
  await check(page.locator("#log")).toContainText("동의해 주셔서 감사합니다");
  expect(consents).toBe(1);
  await requestFill();
  const card = await latest();
  expect(card.mode).toBe("choice"); expect(card.choices.map(c => c.label)).toEqual(["입력 승인", "내용 확인", "취소"]);
  expect(card.prompt).toBe("입력란을 채울까요?");
  const published = () => page.evaluate<string>("JSON.stringify(window.__published)");
  expect(await published()).not.toContain("김하늘"); expect(await published()).not.toContain("actionId");
  const ids = await page.evaluate<string[]>("window.__published.map(s => s.message?.id).filter(Boolean)");
  await choose(card.choiceSetId, "approve", 2);
  await check(page.locator("#confirm-panel")).toBeHidden(); await check(page.locator("#fields")).toContainText("입력됨: 김하늘");
  expect(confirms).toBe(1);
  const reply = await page.waitForFunction("window.__published.find(s => !s.busy && !s.choices.length && s.message?.text && s.message.id && !" + JSON.stringify(ids) + ".includes(s.message.id))");
  const message = z.object({ message: z.strictObject({ id: z.string(), text: z.string() }) });
  message.parse(await reply.jsonValue()); expect(await published()).not.toContain("김하늘");
  await choose(card.choiceSetId, "approve");
  await check(page.locator("#log")).toContainText("선택지가 바뀌었어요"); expect(confirms).toBe(1);
  await page.locator("#stop-all").click(); await page.waitForFunction("window.__published.at(-1)?.state === 'STOPPED'");
  const stopped = await latest(); expect(stopped.message).toBeNull(); expect(stopped.sleeping).toBe(true);
  const response = page.waitForResponse(r => r.url().endsWith("/api/turn"));
  await command("장애인연금 지원 대상이 누구야?");
  await page.waitForFunction("window.__published.some(s => s.revision > " + stopped.revision + " && s.sleeping === false)");
  const answer = z.object({ state: z.string(), speech: z.string(), answerCard: z.object({ grounded: z.boolean() }) }).parse(await (await response).json());
  expect(answer.state).not.toBe("STOPPED"); expect(answer.answerCard.grounded).toBe(true); expect(answer.speech).toMatch(/18세|십팔\s*세|열여덟/u);
  await check(page.locator("#log li").last()).toContainText(answer.speech);
});

it("test_avatar_page_renders_cards_as_text_and_passes_axe", async () => {
  await overlay(false); await send("prefs", { corner: "bottom-right", still: true });
  const choice = { ...approval, instance: "a" };
  await snap(2, choice); await check(page.locator("#card-prompt")).toHaveText("<b>누르기</b>");
  await check(button("<i>입력 승인</i>")).toBeVisible(); await check(page.locator("#card-site")).toHaveText("대상: 127.0.0.1:5174");
  await snap(1, { instance: "a" }); await check(page.locator("#card")).toBeVisible();
  await button("<i>입력 승인</i>").click(); await button("내용 확인").click();
  expect(await page.evaluate("window.__calls.filter(c => c[0] === 'choose' || c[0] === 'open')")).toEqual([["choose","a-1","approve"],["open","confirm"]]);
  await snap(3, { ...choice, pending: true, prompt: "누르기", choices: [{ key: "approve", label: "입력 승인" }, { key: "review", label: "내용 확인", open: "confirm" }] });
  await check(button("<i>입력 승인</i>")).toBeDisabled(); await check(button("내용 확인")).toBeEnabled();
  await page.addScriptTag({ path: axeScript });
  for (const state of [
    { ...base, instance: "a", revision: 4, mode: "auth-handoff", status: "사이트에서 직접 진행해 주세요.", prompt: "localhost:5174에서 직접 로그인해 주세요.",
      choiceSetId: "a-2", choices: [{ key: "auth-done", label: "로그인했어요" }, { key: "auth-cancel", label: "인증 취소" }] },
    { ...base, instance: "a", revision: 5, mode: "speaking", capture: "on", speaking: true, status: "말하는 중이에요." }, { connected: false },
  ]) {
    await send("snapshot", state);
    const result = z.object({ violations: z.array(z.object({ id: z.string(), help: z.string() })), passes: z.array(z.unknown()) })
      .parse(await page.evaluate("axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}})"));
    expect(result.violations).toEqual([]); expect(result.passes.length).toBeGreaterThanOrEqual(5);
  }
  await check(page.locator("#mic-text")).toHaveText("마이크 꺼짐"); await check(button("말하기")).toBeDisabled();
  await snap(1, { instance: "b", mode: "consent", status: "시작 전에 동의가 필요해요.", prompt: "시작 전 안내를 듣고 동의해 주세요.",
    choiceSetId: "b-1", choices: [{ key: "consent-yes", label: "동의하고 음성 대화 시작" }] });
  await check(button("말하기")).toBeDisabled();
  const idle = await page.evaluate<Record<string, unknown>>("import('/src/companion.ts').then(m => m.desktopView({ sessionId:'s', consent:'granted',state:'IDLE'},{ capture:'off',speaking:false }))");
  await snap(2, { ...idle, instance: "b" }); await check(page.locator("#card")).toBeHidden();
  await snap(3, { instance: "b", mode: "choice", busy: true, status: "처리하는 중이에요.", prompt: "버튼을 누를까요?",
    choiceSetId: "b-2", choices: [{ key: "approve", label: "누르기 승인" }, { key: "review", label: "내용 확인", open: "confirm" }] });
  await check(button("누르기 승인")).toBeDisabled(); await check(button("내용 확인")).toBeEnabled();
});

function figureBounds() {
  const figure = document.getElementById("figure")!;
  const { x, y, width, height } = figure.getBoundingClientRect(), painted: string[] = [];
  for (let el: HTMLElement | null = figure; el !== null; el = el.parentElement) {
    const css = getComputedStyle(el);
    if (css.backgroundColor !== "rgba(0, 0, 0, 0)" || css.backgroundImage !== "none") painted.push(el.id.length > 0 ? el.id : el.tagName);
  }
  return { x, y, width, height, painted };
}
it("test_avatar_keeps_its_transparent_stopped_pose_in_every_corner", async () => {
  await overlay();
  for (const corner of ["bottom-right", "top-right", "bottom-left", "top-left"]) {
    await send("prefs", { corner, still: true }); await snap(1, { instance: corner, state: "STOPPED", resting: true });
    const ref = await page.evaluate(figureBounds);
    expect(ref.painted).toEqual([]); expect(ref.width).toBeGreaterThanOrEqual(120); expect(ref.height).toBeGreaterThanOrEqual(100);
    const modes = ["starting","consent","working","speaking","listening","choice","auth-handoff","problem","ended","offline"];
    for (const [i, mode] of modes.entries()) {
      const hasChoices = ["consent","choice","auth-handoff"].includes(mode);
      await snap(i + 2, { instance: corner, mode, connected: mode !== "offline", busy: mode === "working", speaking: mode === "speaking",
        capture: mode === "listening" ? "on" : "off", choiceSetId: hasChoices ? String(i + 2) : null,
        choices: hasChoices ? [{ key: "review", label: "내용 확인", open: "confirm" }] : [], prompt: hasChoices ? "이 내용을 확인할까요?" : null });
      await check(page.locator("#overlay")).toHaveAttribute("data-mode", mode); expect(await page.evaluate(figureBounds)).toEqual(ref);
      if (!hasChoices) continue;
      const card = await page.locator("#card").boundingBox();
      expect(card?.x).toBeGreaterThanOrEqual(0); expect(card?.y).toBeGreaterThanOrEqual(0);
      const { head } = await page.locator("#figure img:visible").evaluate(pixels);
      const tip = await page.locator(".bubble").evaluate(el => {
        const box = el.getBoundingClientRect(), style = getComputedStyle(el), tail = getComputedStyle(el, "::after");
        const matrix = new DOMMatrix(tail.transform), w = parseFloat(tail.width), h = parseFloat(tail.height);
        return { x: box.left + parseFloat(style.borderLeftWidth) + parseFloat(tail.left) + w / 2 + matrix.e,
          y: box.bottom - parseFloat(style.borderBottomWidth) - parseFloat(tail.bottom) - h / 2 + matrix.f + (Math.abs(matrix.b) * w + Math.abs(matrix.d) * h) / 2 };
      });
      expect(head - tip.y).toBeGreaterThanOrEqual(2); expect(head - tip.y).toBeLessThanOrEqual(21);
      expect(Math.abs(tip.x - ref.x - ref.width / 2)).toBeLessThanOrEqual(2);
    }
  }
});

it("test_long_choice_scrolls_inside_the_bubble_on_a_short_display", async () => {
  await page.setViewportSize({ width: 320, height: 316 }); await overlay();
  for (const corner of ["top-left","bottom-right"]) {
    await send("prefs", { corner, maxWidth: 320, maxHeight: 316, still: true });
    await snap(1, { instance: corner, mode: "choice", prompt: "신청 내용을 확인해 주세요. ".repeat(20), choiceSetId: corner,
      choices: [{ key: "review", label: "서류 검토" }, { key: "ok", label: "확인" }] });
    expect(await page.locator(".bubble-body").evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const dock = (await page.locator(".dock").boundingBox())!, card = (await page.locator("#card").boundingBox())!;
    expect(card.y).toBeGreaterThanOrEqual(0); expect(card.y + card.height).toBeLessThan(dock.y + 30);
    expect(dock.x).toBeGreaterThanOrEqual(0); expect(dock.x + dock.width).toBeLessThanOrEqual(320); expect(dock.y + dock.height).toBeLessThanOrEqual(316);
    await button("확인").click(); expect((await calls("choose")).at(-1)).toEqual(["choose",corner,"ok"]);
  }
});

it("test_message_bubbles_expire_once_and_choices_stay_available", async () => {
  await page.clock.install(); await overlay(); await send("prefs", { corner:"bottom-right", still:true });
  const message = { id: "reply-1", text: "<b>정부24에서 확인할 수 있어요.</b>" };
  const publish = (revision: number, changes: Record<string, unknown> = {}) => snap(revision, { message, ...changes });
  const balloon = page.locator("#card");
  await publish(1); await check(balloon).toBeVisible(); await check(balloon).toContainText(message.text);
  await check(balloon.locator("b")).toHaveCount(0); await check(page.locator("#choices button")).toHaveCount(0);
  await balloon.hover(); await page.clock.fastForward(120000); await check(balloon).toBeVisible();
  await page.locator("#avatar").hover(); await page.clock.fastForward(120000); await check(balloon).toBeHidden();
  await publish(2, { mode: "listening", capture: "on" }); await check(balloon).toBeHidden();
  await publish(3, { message: { ...message, id:"reply-2" } }); await check(balloon).toBeVisible();
  await publish(4, { mode: "choice", choiceSetId: "set-1", prompt: "계속할까요?", choices: [{ key: "ok", label: "계속" }] });
  await check(balloon).toContainText("계속할까요?"); await check(balloon).not.toContainText(message.text);
  await page.clock.fastForward(120000);
  const next = button("계속"); await check(next).toBeVisible(); await send("focus"); await check(next).toBeFocused();
  await next.press("Enter"); expect(await calls("choose")).toEqual([["choose","set-1","ok"]]);
});

it("test_sleep_wake_keeps_the_first_action_and_respects_reduced_motion", async () => {
  await overlay(); await send("prefs", { corner:"bottom-right", still:false });
  const publish = (revision: number, changes: Record<string, unknown> = {}) => snap(revision, { state: "STOPPED", status: "멈췄어요.", ...changes });
  const figure = page.locator("#figure"), picture = figure.locator("img:visible");
  await publish(1, { state:"IDLE", sleeping:false }); const awake = await picture.getAttribute("src");
  await publish(2, { mode:"speaking", speaking:true, sleeping:true }); await check(figure).toHaveAttribute("data-sleeping","true"); await check(figure).toHaveAttribute("data-pose","still");
  await picture.evaluate(el => (el as HTMLImageElement).decode());
  expect(await picture.evaluate(el => el.getAnimations().length)).toBe(0);
  const asleep = await picture.getAttribute("src"); expect(asleep).not.toBe(awake);
  await publish(3, { sleeping:true }); expect(await picture.getAttribute("src")).toBe(asleep);
  await button("말하기").press("Enter"); expect(await calls("talk")).toEqual([["talk"]]);
  await publish(4, { mode:"listening", capture:"on", sleeping:false }); await check(figure).toHaveAttribute("data-sleeping","false");
  await check(picture).toHaveAttribute("src", /\/poses\/listening\.webp$/u);
  await publish(5, { sleeping:true }); await check(figure).toHaveAttribute("data-sleeping","true");
  await publish(6, { state:"IDLE", sleeping:false }); await check(figure).toHaveAttribute("data-sleeping","false"); await check(figure).toHaveAttribute("data-renderer","image");
  expect(await picture.getAttribute("src")).toBe(awake);
});

async function voicePage() {
  await page.route(url => url.pathname === "/src/mic.ts" && !url.searchParams.has("original"), route => route.fulfill({
    contentType: "text/javascript", body: `
      export * from "/src/mic.ts?original";
      export async function startRecording() { throw Error("no microphone"); }
      export async function listMicrophones() { return []; }
      export function preferredMicrophone() {}
      export class VoiceLoop {
        constructor(open) { this.open = open; }
        async start() {}
        get deviceLabel() { return "시험 마이크"; }
        async isSilent() { return false; }
        async startClapDetector() {}
        listenOnce() {
          return new Promise(resolve => {
            this.pending = resolve;
            window.__listening = true;
            window.__say = text => {
              window.__listening = false; this.pending = undefined;
              const receipt = this.open(), bytes = new Uint8Array(2048).fill(32);
              bytes.set(new TextEncoder().encode(text)); receipt.append(bytes.buffer); resolve(receipt);
            };
          });
        }
        cancelListening() { window.__listening = false; this.pending?.(null); this.pending = undefined; }
        watchBargeIn() { return () => {}; }
        async listenAfterBarge() { return null; }
        endUtterance() {}
        stop() { this.cancelListening(); }
      }`
  }));
  await page.route(url => url.pathname === "/src/speaker.ts" && !url.searchParams.has("original"), route => route.fulfill({
    contentType: "text/javascript", body: `export * from "/src/speaker.ts?original";
      export const serverTts = { cancel() {}, async speak() { await new Promise(r => setTimeout(r, 50)); return "played"; } };`
  }));
  await page.goto(voice.url);
  await page.getByRole("button", { name: /안내 듣고 시작하기/u }).click();
  await page.getByRole("button", { name: /동의하고 시작/u }).click();
  await page.waitForFunction("window.__listening === true");
}
it("test_first_spoken_request_after_stop_opens_the_requested_form", async () => {
  await voicePage();
  const stopped = page.waitForResponse(r => r.url().endsWith("/cancel"));
  await page.locator("#stop-all").click();
  expect(z.object({ state:z.string() }).parse(await (await stopped).json()).state).toBe("STOPPED");
  await page.waitForFunction("window.__listening === false");
  await page.locator("#conv-start").click(); await page.waitForFunction("window.__listening === true");
  const spoken = page.waitForResponse(r => r.url().includes("/api/audio/turn?"));
  await page.evaluate("window.__say('장애인연금 신청 도와줘')");
  const answer = z.object({ state:z.string(), speech:z.string() }).parse(await (await spoken).json());
  expect(answer.state, answer.speech).toBe("APPLICATION_OPEN"); await check(page.locator("#fields")).toContainText("성명");
});

it("test_voice_approval_binds_to_the_decision_shown_when_listening_began", async () => {
  await voicePage(); await requestFill();
  await page.evaluate("window.__say('응')"); await check(page.locator("#log")).toContainText("확인할 작업이 바뀌었어요", { timeout:20000 });
  await check(page.locator("#fields")).not.toContainText("입력됨: 김하늘");
  await page.waitForFunction("window.__listening === true");
  await page.evaluate("window.__say('응')"); await check(page.locator("#fields")).toContainText("입력됨: 김하늘", { timeout:20000 });
});
