import { strToU8, zipSync } from "fflate";
import { afterAll, afterEach, expect, it } from "vitest";
import { createTestRuntime } from "./session-runtime.ts";

const runtime = createTestRuntime();
afterEach(runtime.closeSessions);
afterAll(runtime.close);

it("reads a downloaded HWPX using its original filename in an ephemeral browser session", async () => {
  const {session, page} = await runtime.createBrowserSession();
  const attachment = zipSync({"Contents/section0.xml": strToU8('<root xmlns:hp="urn:paragraph"><hp:p><hp:t>주민센터에서 서류를 받습니다. 주민등록번호 900101-1234567.</hp:t></hp:p></root>')});
  await page.route("**/guide.hwpx", route => route.fulfill({
    headers: {"Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="guide.hwpx"'},
    body: Buffer.from(attachment),
  }));
  await page.route("**/guide.html", route => route.fulfill({contentType: "text/html; charset=utf-8",
    body: '<!doctype html><title>안내</title><a href="/guide.hwpx">안내문</a>'}));
  await session.handleTurn("127.0.0.1:5174/guide.html 열어줘");
  await page.getByRole("link", {name: "안내문"}).click();
  await expect.poll(() => session.deps.downloads?.latest()?.name).toBe("guide.hwpx");

  const listed = await session.handleTurn("받은 파일 목록 알려줘");
  expect(listed.intentType).toBe("READ_DOWNLOAD");
  expect(listed.speech).toContain("guide.hwpx");
  const read = await session.handleTurn("받은 파일 읽어줘");
  expect(read.intentType).toBe("READ_DOWNLOAD");
  expect(read.speech).toContain("'guide.hwpx'을 읽어요.");
  expect(read.speech).toContain("주민센터에서 서류를 받습니다.");
  expect(session.exportHistory().at(-1)?.text).toContain("[비공개]");
  expect(session.recentDialogue(2).join(" ")).not.toContain("900101");
});
