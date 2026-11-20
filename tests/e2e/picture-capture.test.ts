import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { practiceSite } from "../../src/core/assets.ts";
import { Picture } from "../../src/core/picture.ts";
import { PlaywrightExecutionAdapter, cursorScript, launchBrowser, stopPlaywright } from "../../src/agents/web/browser/index.ts";
import { ShotRefusal, planShot } from "../../src/agents/web/shot.ts";

// 화면 사진 찍기(어댑터 capture): 입력 칸·개인정보 글·내장 문서는 검게 가려지고, 청음의 커서는 찍히지 않고,
// 로그인 화면은 찍지 않는다. 사진의 점 색은 페이지 안 canvas로 읽는다.
// 확인용 화면(picture.html)의 글자색은 순검정이 아니어서, 사진에서 순검정은 가린 자리뿐이다.
// 연습 사이트에 picture.html이 아직 없어 같은 문서를 이 시험의 임시 서버가 낸다.
const pages: Record<string, string> = {
  "/picture.html": readFileSync(new URL("../fixtures/webagent/picture.html", import.meta.url), "utf8"),
  "/login.html": readFileSync(join(practiceSite, "login.html"), "utf8"),
};
const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];
const MARKS = "[data-cheongeum-shot]";

let browser: Browser;
let server: Server;
let site = "";
let adapter: PlaywrightExecutionAdapter;

beforeAll(async () => {
  browser = await launchBrowser(true);
  server = createServer((req, res) => {
    const body = pages[(req.url ?? "").split("?")[0] ?? ""];
    res.writeHead(body === undefined ? 404 : 200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body ?? "");
  });
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("임시 서버 주소가 없습니다.");
  site = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  try { await stopPlaywright(); }
  finally {
    await new Promise<void>(resolve => { server.close(() => { resolve(); }); server.closeAllConnections(); });
  }
}, 60000);
afterEach(async () => {
  vi.restoreAllMocks();
  await adapter.close();
});

async function opened(path: string): Promise<Page> {
  adapter = new PlaywrightExecutionAdapter({ browser, allowedOrigins: [site] });
  await adapter.start();
  await openPage(path);
  if (adapter.page === undefined) throw new Error("브라우저 탭이 없습니다.");
  return adapter.page;
}

async function openPage(path: string) {
  const result = await adapter.execute({ id: "open", type: "navigate", url: site + path, risk: "low", reason: "picture test", requiresConfirmation: false });
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

async function shoot() {
  const view = await adapter.observe();
  const plan = planShot(view);
  if (plan instanceof ShotRefusal) return plan;
  return adapter.capture(plan, view.outline?.mainText ?? "");
}

async function center(page: Page, selector: string): Promise<[number, number]> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector}가 화면에 없습니다.`);
  return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];
}

async function colors(page: Page, url: string, points: Array<readonly [number, number]>) {
  return z.array(z.array(z.number())).parse(await page.evaluate(async ({ url, points }) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("canvas를 쓸 수 없습니다.");
    context.drawImage(img, 0, 0);
    return points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3)));
  }, { url, points }));
}

function picture(value: Picture | ShotRefusal): Picture {
  if (value instanceof ShotRefusal) throw new Error(value.speech);
  return value;
}

it("test_personal_details_inputs_and_frames_are_black", async () => {
  const page = await opened("/picture.html");
  await page.fill("#memo", "홍길동 010-1234-5678");
  const shot = picture(await shoot());
  expect([shot.source, shot.width, shot.height]).toEqual(["web", 1100, 860]);
  const hidden = await Promise.all(["#memo", "#rrn", "#account", "#frame"].map(selector => center(page, selector)));
  expect(await colors(page, shot.dataUrl(), hidden)).toEqual([BLACK, BLACK, BLACK, BLACK]);
  const kept = await colors(page, shot.dataUrl(), await Promise.all(["#plain", "#office", "#notice"].map(selector => center(page, selector))));
  expect(kept).not.toContainEqual(BLACK);
  expect(shot.masks.inputs).toBe(1);
  expect(shot.masks.frames).toBe(1);
  expect(shot.masks.blocks).toBe(2);
  expect(shot.masks.cursorHidden).toBe(false);
});

it("test_the_page_is_left_unmarked", async () => {
  const page = await opened("/picture.html");
  expect(await shoot()).toBeInstanceOf(Picture);
  expect(await page.locator(MARKS).count()).toBe(0);
});

it("test_cursor_overlay_is_not_in_the_picture", async () => {
  const page = await opened("/picture.html");
  const spot = [800, 300] as const;
  const sample = [spot[0] + 2, spot[1] + 4] as const;
  await page.evaluate(cursorScript(spot[0], spot[1], "move"));
  await page.waitForTimeout(700);
  const plain = "data:image/png;base64," + (await page.screenshot({ scale: "css" })).toString("base64");
  expect(await colors(page, plain, [sample]), "커서가 그 자리에 보이지 않아 시험이 아무것도 확인하지 못합니다").not.toEqual([WHITE]);
  const shot = picture(await shoot());
  expect(await colors(page, shot.dataUrl(), [sample])).toEqual([WHITE]);
  expect(shot.masks.cursorHidden).toBe(true);
  expect(await page.locator("#__cheongeum_cursor svg").first().isVisible()).toBe(true);
});

it("test_login_page_is_refused_before_capture", async () => {
  await opened("/login.html");
  const refusal = await shoot();
  expect(refusal instanceof ShotRefusal ? refusal.reason : "picture").toBe("login");
});

it("test_password_field_that_appears_after_planning_is_refused", async () => {
  const page = await opened("/picture.html");
  const plan = planShot(await adapter.observe());
  if (plan instanceof ShotRefusal) throw new Error(plan.speech);
  await openPage("/login.html");
  const refusal = await adapter.capture(plan, "");
  expect(refusal instanceof ShotRefusal ? refusal.reason : "picture").toBe("password");
  expect(await page.locator(MARKS).count()).toBe(0);
});

it("test_secret_in_main_text_that_no_block_holds_is_refused", async () => {
  await opened("/picture.html");
  const view = await adapter.observe();
  const plan = planShot(view);
  if (plan instanceof ShotRefusal) throw new Error(plan.speech);
  const refusal = await adapter.capture(plan, (view.outline?.mainText ?? "") + "\n계좌번호 999-888-777666");
  expect(refusal instanceof ShotRefusal ? refusal.reason : "picture").toBe("unmaskable");
});

it("test_new_auth_screen_on_the_same_url_is_refused_before_capture", async () => {
  const page = await opened("/picture.html");
  const view = await adapter.observe();
  const plan = planShot(view);
  if (plan instanceof ShotRefusal) throw new Error(plan.speech);
  await page.evaluate("document.title = '본인인증'");
  const screenshot = vi.spyOn(page, "screenshot").mockRejectedValue(new Error("called screenshot on an authentication screen"));
  const result = await adapter.capture(plan, view.outline?.mainText ?? "");
  expect(result instanceof ShotRefusal ? result.reason : "picture").toBe("verification");
  expect(screenshot).not.toHaveBeenCalled();
});

it("test_mutation_during_screenshot_discards_bytes_and_cleans_up", async () => {
  const page = await opened("/picture.html");
  const original = page.screenshot.bind(page);
  vi.spyOn(page, "screenshot").mockImplementation(async options => {
    await page.locator("#plain").evaluate(el => { el.textContent = "새로 표시된 글"; });
    return original(options);
  });
  const result = await shoot();
  expect(result instanceof ShotRefusal ? result.reason : "picture").toBe("changed");
  expect(await page.locator(MARKS).count()).toBe(0);
});

it("test_single_png_contains_both_ends_and_masks_below_the_fold", async () => {
  const page = await opened("/picture.html");
  await page.setContent(`<body style="margin:0"><header style="height:50px;background:#da1234"></header>
    <div style="height:1800px"></div><input id="field" value="개인 메모"><p id="email">qa@example.test</p>
    <p id="phone">010-1234-5678</p><iframe id="embed" srcdoc="<p>내장 문서</p>"></iframe>
    <footer style="height:90px;background:#1256da"></footer></body>`);
  await page.evaluate("scrollTo(0, 700)");
  const original = await page.evaluate(() => scrollY);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const hidden = z.array(z.tuple([z.number(), z.number()])).parse(await page.locator("#field,#email,#phone,#embed").evaluateAll(
    elements => elements.map(e => { const b = e.getBoundingClientRect(); return [Math.floor(b.x + b.width / 2), Math.floor(b.y + scrollY + b.height / 2)]; }),
  ));
  const shot = picture(await shoot());
  expect(shot.height).toBe(height);
  expect(height).toBeGreaterThan(2 * 860);
  expect(await colors(page, shot.dataUrl(), [[2, 5], [2, height - 5], ...hidden])).toEqual([
    [218, 18, 52], [18, 86, 218], BLACK, BLACK, BLACK, BLACK,
  ]);
  expect(await page.evaluate(() => scrollY)).toBe(original);
});
