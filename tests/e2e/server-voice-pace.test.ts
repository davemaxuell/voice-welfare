import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { soundCues } from "../../src/core/assets.ts";
import { AgentRuntime, loadConfig } from "../../src/server/runtime.ts";
import { testRuntimeEnv } from "../helpers.ts";
import { startUi } from "./web-ui-fixtures.ts";

it("test_saved_slow_rate_reaches_the_server_voice", async (test) => {
  const audio = await readFile(join(soundCues, "done.ogg"));
  const paces: Array<number | undefined> = [];
  const runtime = new AgentRuntime(loadConfig(testRuntimeEnv({ REQUIRE_CONSENT: "true" })), undefined, {
    name: "test-tone", supported: true,
    async synthesize(_text, { pace }) {
      paces.push(pace);
      return { audio, mimeType: "audio/ogg" };
    },
  });
  const ui = await startUi(false, {}, runtime);
  test.onTestFinished(() => ui.close());
  const browser = await chromium.launch();
  test.onTestFinished(() => browser.close());
  const page = await browser.newPage({ locale: "ko-KR" });
  const rates: unknown[] = [];
  page.on("request", req => {
    if (new URL(req.url()).pathname === "/api/audio/speak") rates.push(Reflect.get(Object(req.postDataJSON()), "rate"));
  });

  await page.goto(ui.url);
  await page.getByRole("button", { name: "안내 듣고 시작하기 (Enter)" }).click();
  // 동의 안내도 일반 응답과 같은 빠르기로 재생한다.
  await expect.poll(() => paces[0]).toBe(1);
  await expect.poll(() => rates[0], { timeout: 15_000 }).toBe(1.25);
  await page.getByRole("button", { name: "동의하고 시작 (Enter)" }).click();
  const box = page.getByLabel("명령 입력 (말하듯이 입력하세요)");
  await box.fill("천천히 말해줘");
  await box.press("Enter");
  // The server normalizes the UI rate against its standard 1.25 before calling TTS.
  await expect.poll(() => paces.includes(0.9 / 1.25), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => rates, { timeout: 15_000 }).toContain(0.9);
});
