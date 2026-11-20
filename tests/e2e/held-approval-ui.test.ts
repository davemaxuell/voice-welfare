import { chromium, expect as screen, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { recordCues, startUi } from "./web-ui-fixtures.ts";

let ui: Awaited<ReturnType<typeof startUi>>, browser: Browser, page: Page;
beforeAll(async () => { ui = await startUi(false, { REQUIRE_CONSENT: "false" }); browser = await chromium.launch(); });
beforeEach(async () => { page = await browser.newPage({ locale: "ko-KR" }); });
afterEach(async () => { await page.close(); await ui.reset(); });
afterAll(async () => { await browser?.close(); await ui?.close(); });

const box = () => page.locator("#command");
const send = async (text: string) => {
  await screen(page.locator("#send")).toBeEnabled();
  await box().fill(text);
  await box().press("Enter");
};

it("test_typed_vault_reply_is_bound_when_typing_starts", async () => {
  const question = "내 이름은 박하늘이라고 저장해줘", answers: string[] = [];
  let received!: () => void, resume!: () => void;
  const ready = new Promise<void>(resolve => { received = resolve; });
  const release = new Promise<void>(resolve => { resume = resolve; });
  await page.route("**/api/turn", async route => {
    const body = z.object({ text: z.string(), actionId: z.string() }).parse(route.request().postDataJSON());
    if (body.text !== question) {
      answers.push(body.actionId);
      await route.continue();
      return;
    }
    const response = await route.fetch();
    received();
    await release;
    await route.fulfill({ response });
  });
  await page.goto(ui.url);
  try { await send(question); await ready; await box().fill("응"); }
  finally { resume(); }
  const panel = page.locator("#confirm-panel");
  await screen(panel).toBeVisible();
  await screen(page.locator("#send")).toBeEnabled();
  await box().press("Enter");
  await screen(page.locator("#log")).toContainText("확인할 작업이 바뀌었어요");
  expect(answers).toEqual([""]);
  await screen(panel).toBeVisible();
  await send("응");
  await screen(panel).toBeHidden();
  expect(answers[1]).toBeTruthy();
});

it("test_held_sign_in_cancel_cannot_apply_to_another_handoff", async () => {
  const handoff = z.object({ authHandoff: z.object({ id: z.string(), status: z.string() }) });
  await page.goto(ui.url);
  const cancel = page.locator("#auth-cancel");
  async function say(text: string) {
    const response = page.waitForResponse(r => r.url().endsWith("/api/turn"));
    await send(text);
    return handoff.parse(await (await response).json()).authHandoff;
  }
  const first = await say("로그인하고 싶어");
  await screen(cancel).toBeEnabled();
  await cancel.hover();
  await page.mouse.down();
  await say("인증 취소");
  await screen(cancel).toBeHidden();
  const second = await say("로그인하고 싶어");
  expect(first.id).not.toBe(second.id);
  await screen(cancel).toBeEnabled();
  await cancel.hover();
  await page.mouse.up();
  expect(await say("화면 설명해줘")).toMatchObject({ status: "waiting", id: second.id });
  await cancel.press("Enter");
  await screen(cancel).toBeHidden();
});

it("test_pointer_held_on_old_vault_prompt_cannot_approve_its_replacement", async () => {
  await page.goto(ui.url);
  const button = page.locator("#confirm-yes");
  await send("내 이름은 구름별이라고 저장해줘");
  await screen(button).toBeEnabled();
  await button.hover();
  await page.mouse.down();
  await send("내 이름은 여름별이라고 저장해줘");
  await screen(page.locator("#log")).toContainText("이름 여름별");
  await screen(button).toBeEnabled();
  await button.hover();
  await page.mouse.up();
  await send("내 정보 알려줘");
  await screen(page.locator("#log")).toContainText("저장된 정보가 없어요.");
});

it("test_one_shot_api_recording_reports_listening", async () => {
  const voice = await startUi(true);
  try {
    await recordCues(page, true);
    await page.goto(voice.url);
    await page.getByRole("button", { name: "안내 듣고 시작하기 (Enter)" }).click();
    await page.getByRole("button", { name: "동의하고 시작 (Enter)" }).click();
    await page.locator("#conv-end").click();
    await page.locator("#mic-btn").click();
    await screen(page.locator("#phase")).toContainText("듣고 있어요");
    await screen(page.locator("#conv-end")).toBeHidden();
    const request = page.waitForRequest(r => r.method() === "POST" && r.url().includes("/api/audio/turn"));
    await page.getByRole("button", { name: "말하기 끝 (보내기)" }).click();
    await request;
  } finally { await page.close(); await voice.close(); }
});
