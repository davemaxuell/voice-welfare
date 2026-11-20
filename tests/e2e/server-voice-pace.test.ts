import { expect, it } from "vitest";
import { launchBrowser } from "../../src/agents/web/browser/index.ts";
import { apiFixture, serveFixture } from "./runtime-http-fixture.ts";

it("test_saved_slow_rate_reaches_the_server_voice", async () => {
  const { api, close } = apiFixture({ REQUIRE_CONSENT: "true" }, { web: true, tts: {
    name: "fake-server-tts", supported: true, async synthesize() { return { audio: Uint8Array.of(255, 243), mimeType: "audio/mpeg" }; },
  } });
  const service = await serveFixture(api);
  const browser = await launchBrowser(true, 0);
  try {
    const page = await browser.newPage({ locale: "ko-KR" });
    const rates: unknown[] = [];
    page.on("request", req => { if (req.url().endsWith("/api/audio/speak")) rates.push(Reflect.get(Object(req.postDataJSON()), "rate")); });
    await page.goto(service.origin);
    await page.getByRole("button", { name: "안내 듣고 시작하기 (Enter)" }).click({ timeout: 15000 });
    await page.getByRole("button", { name: "동의하고 시작 (Enter)" }).click();
    const box = page.getByLabel("명령 입력 (말하듯이 입력하세요)");
    await box.fill("천천히 말해줘"); await box.press("Enter");
    await expect.poll(() => rates.includes(0.9), { timeout: 15000 }).toBe(true);
    expect(rates[0]).toBe(1.25 * 1.12);
  } finally { await browser.close(); await service.closeServer(); await close(); }
});
