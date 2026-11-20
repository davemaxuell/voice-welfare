import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { FAKE_OVERLAY } from "./avatar-overlay-fixture.ts";
import {
  bubbleState, createCharacter, immediate, loseGpu, menuMid, menuSetup, resetSnapshot, swapChoice,
} from "./avatar-animation-scripts.ts";
import { startUi } from "./web-ui-fixtures.ts";

// 데스크톱 아바타 창이 만든 자세와 WebGL 그림판 복구를 시험한다.
// 아바타 창 문서(/avatar/)와 그 스크립트가 웹 화면 패키지에서 옮겨진 뒤에 통과한다.
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
}, 30_000);
beforeEach(async () => { page = await browser.newPage({ locale: "ko-KR" }); });
afterEach(async () => { await page?.close(); await ui?.reset(); });

// Vite의 public 폴더는 /avatar/ 같은 디렉터리 주소에 index.html을 내주지 않고 앱 첫 화면을 내주므로 파일 이름까지 적는다.
const AVATAR_DOCUMENT = "avatar/index.html";
// Playwright의 JS 클라이언트는 문자열로 준 함수를 부르지 않는다(Python 클라이언트는 부른다). 문자열 함수는 부르는 식으로 감싸 보낸다.
const invoke = (source: string, arg?: unknown) => `(${source})(${arg === undefined ? "" : JSON.stringify(arg)})`;
const finishedAnimations = (element: Element) => Promise.all(element.getAnimations().map(animation => animation.finished));
const near = (actual: number, expected: number, tolerance: number) => Math.abs(actual - expected) <= tolerance;

it("test_interrupt_land_and_restore_current_pose", async () => {
  await page.goto(ui.url + "avatar/still.png");
  await page.evaluate(invoke(createCharacter));
  expect(await page.evaluate("Boolean(character && gpu)")).toBe(true);
  await page.evaluate("character.cue('welcome', 'listening'); character.pose('listening')");
  expect(await page.evaluate("currentPose.clip")).toBe("welcome");
  await page.evaluate("character.pose('auth-handoff')");
  expect(await page.evaluate("currentPose.clip")).toBe("auth-handoff");
  await page.evaluate("character.pose('complete')");
  await page.waitForFunction("currentPose.clip === 'complete' && currentPose.pose === 'still'");
  expect(near(Number(await page.evaluate("bodyRig.position.y")), 0.002, 0.001)).toBe(true);
  expect(near(Number(await page.evaluate("bodyRig.scale.y")), 1, 0.001)).toBe(true);

  await page.evaluate("gpu.loseContext()");
  await page.waitForFunction("surfaces.at(-1) === false");
  await page.evaluate("character.pose('listening'); gpu.restoreContext()");
  await page.waitForFunction("surfaces.at(-1) === true");
  expect(await page.evaluate("restoredPixels && character.surfaceAvailable")).toBe(true);
  expect(await page.evaluate("currentPose")).toEqual({ pose: "still", clip: "listening" });
  await page.evaluate("character.pose('sleeping', { interrupt: true })");
  expect(await page.evaluate("currentPose.pose")).toBe("sleeping");
  await page.evaluate("character.dispose()");
});

it("test_bubble_reverses_mid_pop_and_preserves_the_latest_choice", async () => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(FAKE_OVERLAY);
  await page.goto(ui.url + AVATAR_DOCUMENT);
  const state = z.object({
    rising: z.number(), leaving: z.number(), falling: z.number(), renewed: z.number(), closingInert: z.boolean(), reopenedInert: z.boolean(),
  }).parse(await page.evaluate(invoke(bubbleState)));
  expect(state.rising > 0 && state.rising < 1, JSON.stringify(state)).toBe(true);
  expect(near(state.leaving, state.rising, 0.035), JSON.stringify(state)).toBe(true);
  expect(state.falling > 0 && state.falling < state.rising, JSON.stringify(state)).toBe(true);
  expect(near(state.renewed, state.falling, 0.035), JSON.stringify(state)).toBe(true);
  expect(state.closingInert && !state.reopenedInert).toBe(true);
  await page.locator(".bubble").evaluate(finishedAnimations);
  await browserExpect(page.locator("#card")).toBeVisible();
  // 보이는 카드를 바꿔 끼워도 그 면은 화면에 그대로 남아야 한다
  expect(await page.evaluate(invoke(swapChoice))).toEqual(["1", 0]);
  await page.getByRole("button", { name: "확인", exact: true }).click();
  expect(await page.evaluate("__calls.filter(c => c[0]==='choose')")).toEqual([["choose", "latest", "ok"]]);
});

it("test_avatar_and_menu_reverse_together_and_honor_reduced_motion", async () => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(FAKE_OVERLAY);
  await page.goto(ui.url + AVATAR_DOCUMENT);
  await page.evaluate(invoke(menuSetup));
  await page.locator(".bubble").evaluate(finishedAnimations);
  const mid = z.object({
    fading: z.array(z.number()), reversing: z.array(z.number()), acks: z.array(z.tuple([z.string(), z.number()])),
  }).parse(await page.evaluate(invoke(menuMid)));
  expect(mid.fading.every(opacity => opacity > 0 && opacity < 1), JSON.stringify(mid)).toBe(true);
  expect(mid.reversing.length === mid.fading.length && mid.reversing.every((opacity, index) => near(opacity, mid.fading[index] ?? NaN, 0.035)),
    JSON.stringify(mid)).toBe(true);
  expect(mid.acks).not.toContainEqual(["visibilityDone", 11]);
  expect(await page.evaluate("__calls.filter(c => c[0] === 'stop')")).toEqual([["stop"]]);
  await page.locator("#overlay").evaluate(finishedAnimations);
  await browserExpect(page.locator("#stop")).toBeEnabled();
  expect(await page.evaluate("__calls")).not.toContainEqual(["visibilityDone", 11]);

  for (const [prefs, media] of [[true, "no-preference"], [false, "reduce"]] as const) {
    await page.emulateMedia({ reducedMotion: media });
    expect(await page.evaluate(invoke(immediate, prefs))).toEqual({ animations: 0, acks: [["visibilityDone", 14], ["visibilityDone", 15]] });
  }
});

it("test_overlay_refits_on_display_change_and_preserves_pose_during_gpu_reset", async () => {
  await page.addInitScript(FAKE_OVERLAY);
  await page.goto(ui.url + AVATAR_DOCUMENT);
  const prefs = { corner: "bottom-right", still: false };
  await page.evaluate(invoke("(p) => window.__send('prefs', p)", prefs));
  const figure = page.locator("#figure");
  await browserExpect(figure).toHaveAttribute("data-renderer", "webgl");
  const metrics = await page.context().newCDPSession(page);
  for (const scale of [1.25, 1.5, 2, 1]) {
    await metrics.send("Emulation.setDeviceMetricsOverride", { width: 640, height: 400, mobile: false, deviceScaleFactor: scale });
    await page.waitForFunction(ratio => window.devicePixelRatio === ratio, scale);
    // 창 크기가 그대로여도 Electron은 디스플레이가 바뀌었다고 알린다
    await page.evaluate(invoke("(p) => window.__send('prefs', p)", prefs));
    for (const [attribute, size] of [["width", 146], ["height", 162]] as const) {
      await browserExpect(page.locator("#character")).toHaveAttribute(attribute, String(Math.floor(size * scale + 0.5)));
    }
  }
  await page.evaluate(invoke(loseGpu));
  await browserExpect(figure).toHaveAttribute("data-renderer", "image");
  await page.evaluate(invoke(resetSnapshot));
  await browserExpect(page.locator("#still")).toHaveAttribute("src", "/avatar/poses/screen-reading.webp");
  await page.locator("#still").evaluate(image => image instanceof HTMLImageElement ? image.decode() : undefined);
  await page.evaluate("avatarGpu.restoreContext()");
  await browserExpect(figure).toHaveAttribute("data-renderer", "webgl");
  await browserExpect(figure).toHaveAttribute("data-clip", "screen-reading");
});
