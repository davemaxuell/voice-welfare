// 만든 웹 화면(dist/web)을 Python 기준 서버에 붙여 첫 실행 → 동의 → 글 한 턴 → 멈춤 → 이용 설정을 걷고,
// 같은 서버가 내놓는 예전 화면과 글을 견준다. 기본 시험 묶음에는 들어가지 않는다.
//   npm run build:web
//   CHEONGEUM_API_ORIGIN=http://127.0.0.1:18787 UI_SMOKE_OUT=<사진 폴더> node tests/ui-smoke/smoke.ts
// 서버에는 키 없는 완료된 설정 파일(credential "")을 둔다. 첫 실행의 키 확인과 저장은 이 스크립트가 가로채므로
// OpenAI나 Windows 자격 증명 저장소에 닿지 않는다.
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { webStatic } from "../../src/core/assets.ts";

const apiOrigin = process.env.CHEONGEUM_API_ORIGIN ?? "http://127.0.0.1:18787";
const out = process.env.UI_SMOKE_OUT ?? join(tmpdir(), "cheongeum-ui-smoke");
const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".glb": "model/gltf-binary",
};
mkdirSync(out, { recursive: true });

function check(ok: boolean, message: string) {
  if (!ok) throw new Error(`실패: ${message}`);
  process.stdout.write(`ok - ${message}\n`);
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? "");
const text = async (page: Page, selector: string) => (await page.locator(selector).first().textContent())?.trim() ?? "";
const settle = (page: Page) => page.waitForTimeout(350);
/** 화면에 보이는 글(innerText). 원본 HTML의 들여쓰기 공백은 화면 글에 들어가지 않는다. */
const shown = async (page: Page, selector: string) => (await page.locator(selector).first().innerText()).replace(/[ \t]+/g, " ").trim();
async function same(old: Page, page: Page, selector: string) {
  const [before, after] = [await shown(old, selector), await shown(page, selector)];
  const detail = before === after ? "" : `\n  예전: ${JSON.stringify(before)}\n  새것: ${JSON.stringify(after)}`;
  check(before === after, `${selector} 글이 예전 화면과 같다${detail}`);
}

/** 기준 서버와 같은 출처에서 새 화면 파일(dist/web)을 내준다. /api/는 서버로 그대로 간다(출처 검사·WebSocket도 그대로). */
async function serveBuild(context: BrowserContext) {
  await context.route(`${apiOrigin}/**`, async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith("/api/")) return route.fallback();
    let file = join(webStatic, decodeURIComponent(pathname));
    if (pathname.endsWith("/")) file = join(file, "index.html");
    try {
      if (!statSync(file).isFile()) throw new Error(file);
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
}
// 중간에 멈춰도 서버의 세션 자리(최대 세 개)를 비우도록 연 세션을 적어 두었다가 끝에 닫는다.
const opened: string[] = [];
async function remember(context: BrowserContext) {
  context.on("response", response => {
    if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/session") return;
    void response.json().then((body: unknown) => {
      if (typeof body === "object" && body !== null && "sessionId" in body && typeof body.sessionId === "string") opened.push(body.sessionId);
    }).catch(() => undefined);
  });
}
const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await serveBuild(context);
  await remember(context);
  const ui = await context.newPage();
  const errors: string[] = [];
  ui.on("pageerror", error => errors.push(error.message));
  let setupDone = false;
  await ui.route("**/api/health", async route => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    await route.fulfill({ response, json: typeof body === "object" && body !== null ? { ...body, setupRequired: !setupDone } : body });
  });
  await ui.route("**/api/settings/check-key", route => route.fulfill({ json: { result: "ok" } }));
  await ui.route("**/api/settings", async route => {
    if (route.request().method() !== "POST") return route.continue();
    setupDone = true;
    return route.fulfill({ json: { saved: true } });
  });

  await ui.goto(`${apiOrigin}/`);
  await ui.locator('#first-run[open] [data-step="language"]').waitFor();
  check(await text(ui, "#first-run h2") === "대화 언어 · Language", "첫 실행은 언어 고르기부터 연다");
  await shot(ui, "01-first-run-language");
  await settle(ui);
  await ui.keyboard.press("1");
  await ui.locator('[data-step="who"]').waitFor();
  check(await ui.evaluate(() => document.activeElement?.tagName === "H2"), "단계가 바뀌면 제목에 초점이 간다");
  await settle(ui);
  await ui.keyboard.press("1");
  await ui.locator('[data-step="key"]').waitFor();
  check(await focusedId(ui) === "first-run-key", "키 단계는 입력란에 초점을 둔다");
  await ui.keyboard.type("sk-smoke-test-key");
  await settle(ui);
  await ui.keyboard.press("Enter");
  await ui.locator('[data-step="pc"]').waitFor();
  await settle(ui);
  await ui.keyboard.press("1");
  await ui.locator('[data-step="sound"]').waitFor();
  await shot(ui, "02-first-run-sound");
  await settle(ui);
  await ui.keyboard.press("Enter");
  await ui.locator('[data-step="speed"]').waitFor();
  await settle(ui);
  await ui.keyboard.press("3");
  check(await text(ui, ".first-run-speed") === "1.6×", "3번은 한 단계 빠르게 한다");
  await ui.keyboard.press("2");
  await ui.locator("#consent-panel:not([hidden])").waitFor();
  check(await ui.locator("#first-run[open]").count() === 0, "설정을 마치면 첫 실행 창이 닫힌다");
  await shot(ui, "03-consent");

  const firstFocus = await focusedId(ui);
  check(firstFocus === "consent-hear" || firstFocus === "consent-yes", `동의 단추에 초점이 있다 (${firstFocus})`);
  if (firstFocus === "consent-hear") {
    await ui.keyboard.press("Enter");
    await ui.locator("#consent-yes:not([hidden])").waitFor();
    check(await focusedId(ui) === "consent-yes", "안내를 들은 뒤 동의 단추로 초점이 간다");
  }
  const consentText = await text(ui, "#consent-text");
  await ui.keyboard.press("Enter");
  await ui.locator("#dictation-hint:not([hidden])").waitFor();
  check(await focusedId(ui) === "command", "음성 키가 없으면 동의 뒤 입력란에 초점이 간다");
  check(await ui.locator("#conv-start").isDisabled(), "음성 키가 없으면 대화 시작을 누를 수 없다");
  await shot(ui, "04-granted");

  const before = await ui.locator(".msg.assistant").count();
  await ui.locator("#command").fill("장애인연금 얼마 받아?");
  await ui.keyboard.press("Enter");
  await ui.waitForFunction(n => document.querySelectorAll(".msg.assistant").length > n, before);
  check(await ui.locator("#command").inputValue() === "", "보낸 뒤 입력란을 비운다");
  await ui.waitForFunction(() => document.querySelector("#send")?.getAttribute("aria-busy") === "false");
  check(await focusedId(ui) === "command", "글로 보낸 뒤에도 입력란에 초점이 남는다");
  const answer = await ui.locator(".msg.assistant").last().textContent();
  const afterTurn = { status: await shown(ui, ".work-status"), form: await shown(ui, "#command-form"), side: await shown(ui, "#sources-panel") };
  check((await text(ui, "#announce")).startsWith("상태: "), "응답 상태를 화면 낭독기에 알린다");
  await shot(ui, "05-text-turn");

  await ui.locator("#stop-all").click();
  await ui.waitForFunction(() => document.querySelector("#st-state")?.textContent === "중단됨");
  check(true, "멈춰를 누르면 중단됨 상태가 된다");
  await shot(ui, "06-stopped");

  await ui.locator("#open-settings").click();
  await ui.locator("#settings-dialog[open] #setup-save:enabled").waitFor();
  check(await focusedId(ui) === "setup-key", "이용 설정을 열면 키 입력란에 초점이 간다");
  await ui.locator("#setup-language").selectOption("en");
  check(await text(ui, "#settings-title") === "Cheongeum settings", "설정 창 글은 고른 언어로 바뀐다");
  check(await text(ui, "#setup-save") === "Save and continue", "대화 중에는 '저장하고 계속' 단추가 된다");
  await shot(ui, "07-settings-en");
  await ui.locator("#setup-cancel").click();
  await ui.locator("#settings-dialog[open]").waitFor({ state: "detached" }).catch(() => undefined);
  check(await ui.locator("#settings-dialog[open]").count() === 0, "취소하면 설정 창이 닫힌다");
  check(errors.length === 0, `페이지 오류가 없다 ${errors.join(" | ")}`);

  // 같은 서버의 예전 화면과 글을 견준다(같은 응답이면 같은 글이어야 한다).
  const oldContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await remember(oldContext);
  const old = await oldContext.newPage();
  await old.goto(`${apiOrigin}/`);
  await old.locator("#consent-panel:not([hidden])").waitFor();
  if (await old.locator("#consent-hear:not([hidden])").count() > 0) await old.locator("#consent-hear").click();
  await old.locator("#consent-yes:not([hidden])").waitFor();
  check(await text(old, "#consent-text") === consentText, "동의 안내 전문이 예전 화면과 같다");
  for (const selector of [".app-header", "#examples", "#unsupported", ".settings[aria-labelledby=\"sound-title\"]"]) {
    await same(old, ui, selector);
  }
  const starters = (page: Page) => page.locator("#starter-actions button").evaluateAll(buttons =>
    buttons.map(b => `${b.textContent.trim()}|${b.getAttribute("data-request") ?? ""}|${b.getAttribute("data-consent") ?? ""}`));
  check(JSON.stringify(await starters(old)) === JSON.stringify(await starters(ui)), "요청 예시 단추가 예전 화면과 같다");
  await old.locator("#consent-yes").click();
  await old.locator("#dictation-hint:not([hidden])").waitFor();
  await same(old, ui, "#dictation-hint");
  check(await focusedId(old) === "command", "예전 화면도 동의 뒤 입력란에 초점을 둔다");
  const oldBefore = await old.locator(".msg.assistant").count();
  await old.locator("#command").fill("장애인연금 얼마 받아?");
  await old.keyboard.press("Enter");
  await old.waitForFunction(n => document.querySelectorAll(".msg.assistant").length > n, oldBefore);
  check(await old.locator(".msg.assistant").last().textContent() === answer, "같은 질문의 답 글이 예전 화면과 같다");
  await old.waitForFunction(() => document.querySelector("#send")?.getAttribute("aria-busy") === "false");
  check(await shown(old, ".work-status") === afterTurn.status, "답한 뒤 현재 작업 칸이 예전 화면과 같다");
  check(await shown(old, "#command-form") === afterTurn.form, "답한 뒤 입력 칸이 예전 화면과 같다");
  check(await shown(old, "#sources-panel") === afterTurn.side, "답한 뒤 근거 자료가 예전 화면과 같다");
  await shot(old, "08-old-ui-text-turn");
  await old.locator("#session-end").click();
  await old.locator("#session-new:not([hidden])").waitFor();

  await ui.locator("#session-end").click();
  await ui.locator("#session-new:not([hidden])").waitFor();
  check(await focusedId(ui) === "session-new", "이용을 마치면 '새 작업 시작'에 초점이 간다");
  check(await ui.locator("#log li").count() === 0, "이용을 마치면 대화 기록을 지운다");
  await shot(ui, "09-ended");
  process.stdout.write(`스크린샷: ${out}\n`);
} finally {
  await browser.close();
  for (const sid of opened) await fetch(apiOrigin + "/api/session/" + sid, { method: "DELETE" }).catch(() => undefined);
}
