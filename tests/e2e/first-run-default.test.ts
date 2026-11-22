import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect as screen } from "@playwright/test";
import { expect, it } from "vitest";
import { z } from "zod";
import { REPO_ROOT } from "../../src/core/assets.ts";
import { LINES } from "../../src/orchestrator/first_run_text.ts";
import { Seal } from "../../src/personal/seal.ts";
import { AgentRuntime, loadConfig } from "../../src/server/runtime.ts";
import { SettingsInput, SettingsStore } from "../../src/server/settings.ts";
import { SETTLE_MS } from "../../web/src/first-run.ts";
import { startUi } from "./web-ui-fixtures.ts";

it("finishes sound setup once with default consent settings and accepts a foreground request instead of the mic exercise", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cheongeum-first-run-default-"));
  const settingsPath = join(directory, "preferences.json");
  const seal = () => new Seal({ key: Buffer.alloc(32, 77) });
  const settings = new SettingsStore(settingsPath, seal);
  settings.save(SettingsInput.parse({ apiKey: "sk-test-onboarding", language: "en", deviceUse: "personal" }));
  // 설치본은 실제 사이트 모드로 시작하며 동의와 조작 정책은 실행 기본값을 쓴다.
  const config = loadConfig({ CHEONGEUM_DATA_DIR: directory, PRACTICE_MODE: "false" });
  const runtime = new AgentRuntime(config, undefined, undefined, async () => { throw new Error("Unexpected provider request"); }, settings);
  runtime.sealFactory = seal;
  const ui = await startUi(false, {}, runtime);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const consentRequests: string[] = [];
    const speech: { text: string; lang: string }[] = [];
    await page.route("**/api/audio/speak", async route => {
      speech.push(z.object({ text: z.string(), lang: z.string() }).parse(route.request().postDataJSON()));
      await route.fulfill({ contentType: "audio/mpeg", path: join(REPO_ROOT, "web/public/setup-audio/en/lang-en.mp3") });
    });
    page.on("request", request => {
      if (new URL(request.url()).pathname.endsWith("/consent")) consentRequests.push(request.url());
    });
    await page.goto(ui.url);
    await page.locator('#first-run [data-step="sound"] .first-run-choice').first().click({ delay: SETTLE_MS + 50 });
    await page.locator('#first-run [data-step="speed"] .first-run-choice').nth(1).click({ delay: SETTLE_MS + 50 });
    await screen(page.locator("#recovery-panel")).toBeVisible();
    expect(new SettingsStore(settingsPath, seal).firstRun).toBe("sound-complete");
    await page.reload();
    await screen(page.locator("#recovery-panel")).toBeVisible();
    await screen(page.locator("#first-run")).toBeHidden();
    const session = page.waitForResponse(response => new URL(response.url()).pathname === "/api/session");
    await page.locator("#recovery-no").click();

    expect(await (await session).json()).toMatchObject({ consentRequired: false, lang: "en", firstRunPrompt: { en: LINES.mic.en } });
    const mic = page.locator("#log li.assistant").filter({ hasText: LINES.mic.en });
    const spokenPrompt = () => speech.filter(part => part.lang === "en" && LINES.mic.en.includes(part.text)).map(part => part.text).join(" ");
    await screen(mic).toHaveCount(1);
    await expect.poll(spokenPrompt).toBe(LINES.mic.en);
    await screen(page.locator("#consent-panel")).toBeHidden();
    expect(new SettingsStore(settingsPath, seal).firstRun).toBe("mic");

    const turn = page.waitForResponse(response => new URL(response.url()).pathname === "/api/turn");
    await page.locator("#command").fill("Speak Korean");
    await page.locator("#command").press("Enter");
    expect(z.object({ semanticAction: z.string(), lang: z.string() }).parse(await (await turn).json()))
      .toEqual({ semanticAction: "set-language", lang: "ko" });
    await screen(mic).toHaveCount(1);
    expect(new SettingsStore(settingsPath, seal).firstRun).toBe("done");

    const reopened = page.waitForResponse(response => new URL(response.url()).pathname === "/api/session");
    await page.reload();
    expect(await (await reopened).json()).not.toHaveProperty("firstRunPrompt");
    await screen(page.locator("#command")).toBeEnabled();
    await screen(page.locator("#first-run")).toBeHidden();
    await screen(mic).toHaveCount(0);
    expect(spokenPrompt()).toBe(LINES.mic.en);
    expect(consentRequests).toEqual([]);
  } finally {
    await browser.close();
    await ui.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
