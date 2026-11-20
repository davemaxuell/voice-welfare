import { expect, it } from "vitest";
import { FakeLlm, withLlm } from "../helpers.ts";
import { browserCases } from "./browser-cases.ts";

const open = browserCases();
const url = "http://127.0.0.1:5174/pilot-public-guide.html", title = "복지서비스 상세 | 복지로";
const html = "<title>" + title + '</title><div class="util"><button>공동인증서 내보내기</button><button>로그인</button></div>'
  + "<h1>기초연금</h1><p>기초연금은 가까운 동 주민센터나 국민연금공단 지사에서 신청할 수 있어요.</p>";
async function guide() {
  const { session, page } = await open();
  await page.route(url, route => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  return session;
}

it("test_public_guide_with_certificate_button_keeps_guidance", async () => {
  const session = await guide();
  const first = await session.handleTurn(url + " 열어줘");
  expect(first.state).not.toBe("AUTH_HANDOFF");
  expect(first.authHandoff).toBeUndefined();
  expect(first.observation?.title).toBe(title);
  const read = await session.handleTurn("본문 읽어줘");
  expect(read.state).not.toBe("AUTH_HANDOFF");
  expect(read.speech).toContain("주민센터");
});

it("test_english_follow_up_on_public_guide_is_answered_in_english", async () => {
  const session = await guide(), question = "Please read the page to me";
  withLlm(session, new FakeLlm(({ schemaName, user }) => {
    if (schemaName === "translate_in" && user === question) return { text: "본문 읽어줘" };
    if (schemaName === "translate_out") return { text: "[en] " + user };
    return undefined;
  }));
  await session.handleTurn(url + " 열어줘");
  await session.handleTurn("영어로 말해줘");
  const read = await session.handleTurn(question);
  expect(read.intentType).not.toBe("SECRET_DISCLOSURE");
  expect(read.state).not.toBe("AUTH_HANDOFF");
  expect(read.lang).toBe("en");
  expect(read.speech.startsWith("[en] ")).toBe(true);
  expect(read.speech).toContain("주민센터");
});
