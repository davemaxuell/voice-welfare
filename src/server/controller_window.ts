import type { Browser, Page } from "playwright";
import { maximizeWindow, trackTabs } from "../agents/web/browser/windows.ts";

/** 명령줄에서 직접 연 대화 탭에 다시 초점을 보낼 수 있게 한다. */
export async function openControllerWindow(browser: Browser, url: string): Promise<Page> {
  const context = await browser.newContext({locale: "ko-KR", viewport: null});
  try {
    const page = await context.newPage();
    const tabs = trackTabs(context, other => other === page);
    context.once("close", () => tabs.release());
    const origin = new URL(url).origin;
    await page.exposeBinding("cheongeumFocusWindow", async ({frame}) => {
      if (frame === page.mainFrame() && new URL(frame.url()).origin === origin) await page.bringToFront();
    });
    await maximizeWindow(page);
    await page.goto(url);
    page.once("close", () => { void context.close().catch(() => {}); });
    return page;
  } catch (error) { await context.close(); throw error; }
}
