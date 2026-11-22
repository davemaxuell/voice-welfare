import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type BrowserContext } from "playwright";
import { expect, it } from "vitest";
import { attachStagehand, stagehandLaunchOptions, stagehandTab } from "../../src/agents/web/browser/stagehand_browser.ts";

async function withProfile(work: (context: BrowserContext, marker: string, record: string) => Promise<void>) {
  const profile = await mkdtemp(join(tmpdir(), "cheongeum-cdp-test-"));
  try {
    const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, ...await stagehandLaunchOptions() });
    try {
      const marker = join(profile, "DevToolsActivePort");
      const read = () => readFile(marker, "utf8").catch(() => "");
      await expect.poll(read, { timeout: 10_000 }).toMatch(/\/devtools\/browser\/[\da-f-]{36}/u);
      await work(context, marker, await read());
    } finally { await context.close(); }
  } finally { await rm(profile, { recursive: true, force: true }); }
}

it("크롬이 연결 정보를 늦게 기록해도 처음 연 탭에 Stagehand를 연결한다", async () => {
  await withProfile(async (context, marker, record) => {
    const page = context.pages()[0]!;
    await page.setContent("<title>청음 연결 시험</title>");
    await unlink(marker);
    const restore = async () => {
      await delay(150);
      await writeFile(marker, record.slice(0, record.indexOf("\n") + 1));
      await delay(100);
      await writeFile(marker, record);
    };
    const [attached, restored] = await Promise.allSettled([attachStagehand(context.browser()!, false), restore()]);
    expect(restored.status).toBe("fulfilled");
    expect(attached).toEqual({ status: "fulfilled", value: undefined });
    const { tab } = await stagehandTab(page);
    expect(await tab.evaluate(() => document.title)).toBe("청음 연결 시험");
  });
});

it("실제 크롬 포트와 다른 형식의 브라우저 주소를 섞은 파일은 거부한다", async () => {
  await withProfile(async (context, marker, record) => {
    await writeFile(marker, record.replace("/devtools/browser/", "/다른경로/"));
    await expect(attachStagehand(context.browser()!, false)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });
});
