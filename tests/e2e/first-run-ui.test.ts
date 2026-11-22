import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect as screen, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { Seal } from "../../src/personal/seal.ts";
import { AgentRuntime, loadConfig } from "../../src/server/runtime.ts";
import { SettingsInput, SettingsStore } from "../../src/server/settings.ts";
import { testRuntimeEnv } from "../helpers.ts";
import { startUi } from "./web-ui-fixtures.ts";

let directory: string, ui: Awaited<ReturnType<typeof startUi>>, browser: Browser, page: Page;
const spoken: string[] = [];
const silence = Buffer.alloc(844);
silence.write("RIFF"); silence.writeUInt32LE(836, 4); silence.write("WAVEfmt ", 8);
silence.writeUInt32LE(16, 16); silence.writeUInt16LE(1, 20); silence.writeUInt16LE(1, 22);
silence.writeUInt32LE(8000, 24); silence.writeUInt32LE(16000, 28); silence.writeUInt16LE(2, 32);
silence.writeUInt16LE(16, 34); silence.write("data", 36); silence.writeUInt32LE(800, 40);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "cheongeum-ui-onboarding-"));
  const seal = () => new Seal({ key: Buffer.alloc(32, 100) });
  const store = new SettingsStore(join(directory, "preferences.json"), seal);
  store.save(SettingsInput.parse({ apiKey: "sk-test-stage2", deviceUse: "personal" }));
  store.setFirstRun("done");
  const runtime = new AgentRuntime(loadConfig(testRuntimeEnv({ REQUIRE_CONSENT: "true", CHEONGEUM_DATA_DIR: directory })),
    undefined, undefined, async () => { throw new Error("Unexpected provider request"); }, store);
  runtime.sealFactory = seal;
  ui = await startUi(false, {}, runtime);
  browser = await chromium.launch();
});
beforeEach(async () => {
  spoken.length = 0;
  await rm(join(directory, "startup-guide-seen"), { force: true });
  page = await browser.newPage({ locale: "ko-KR" });
  await page.route("**/api/settings/check-key", route => route.fulfill({ json: { result: "ok" } }));
  await page.route("**/api/audio/speak", async route => {
    spoken.push(z.object({ text: z.string() }).parse(route.request().postDataJSON()).text);
    await delay(600);
    await route.fulfill({ contentType: "audio/wav", body: silence });
  });
  await page.route("**/setup-audio/*/*.mp3", route => route.fulfill({ contentType: "audio/wav", body: silence }));
  await page.goto(ui.url);
  await page.getByRole("button", { name: "복구 없이 시작", exact: true }).click();
  await page.getByRole("button", { name: "안내 듣고 시작하기 (Enter)" }).click();
  await page.getByRole("button", { name: "동의하고 시작 (Enter)" }).click();
  await screen(page.locator("#consent-panel")).toBeHidden();
});
afterEach(async () => { await page?.close(); await ui?.reset(); });
afterAll(async () => { await browser?.close(); await ui?.close(); if (directory !== undefined) await rm(directory, { recursive: true, force: true }); });
async function send(text: string) {
  await screen(page.locator("#send")).toBeEnabled();
  const box = page.getByLabel("명령 입력 (말하듯이 입력하세요)");
  await box.fill(text);
  await box.press("Enter");
}
it("test_intro_replay_shows_a_card_per_line_and_esc_skips", async () => {
  await send("청음 소개 다시 해줘");
  const card = page.locator("#intro-card");
  await screen(card).toBeVisible();
  await screen(page.locator("#intro-text")).toHaveText("반가워요! 저는 청음이에요.");
  await screen(card.locator("img")).toHaveAttribute("src", "/avatar/poses/ready.webp");
  await page.keyboard.press("Escape");
  await screen(card).toBeHidden();
  await delay(500);
  expect(spoken).not.toContain("그럼 같이 시작해 볼까요?");
});
it("test_setup_restart_opens_the_wizard", async () => {
  await send("설정 다시 해줘");
  await screen(page.locator('#first-run [data-step="language"]')).toBeVisible();
});
