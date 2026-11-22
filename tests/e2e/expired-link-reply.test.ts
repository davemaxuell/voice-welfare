import { expect, it } from "vitest";
import { FakeLlm, PORTAL } from "../helpers.ts";
import { browserCases, flat } from "./browser-cases.ts";

const open = browserCases();
async function replaceOffer(renew = false) {
  const opened = await open();
  const { session } = opened;
  await session.handleTurn(PORTAL + " 열어줘");
  await session.handleTurn("링크 목록 알려줘");
  const old = session.linkOfferId;
  expect(old).toBeTruthy();
  await session.handleTurn(PORTAL + " 열어줘");
  if (renew) await session.handleTurn("링크 목록 알려줘");
  expect(session.linkOfferId).not.toBe(old);
  return { ...opened, old };
}

it.each([
  ["첫 번째 링크 열어줘", {}, false],
  ["Open the first link on this page.", { translate_in: { text: "첫 번째 링크 열어줘" } }, false],
  ["Open the first link on this page.", { translate_in: { text: "첫 번째 링크 열어줘" } }, true],
  ["뉴스 눌러줘", {}, false],
  ["뉴스로 들어가 볼래", { intent_plan: { steps: [flat("FOLLOW_LINK", { topic: "뉴스" })] } }, false],
] as const)("test_delayed_reply_cannot_open_a_link_after_the_offer_changed", async (words, answers, renew) => {
  const { session, page, old } = await replaceOffer(renew);
  const model = new FakeLlm(answers);
  if (Object.keys(answers).length > 0) session.deps.llm = model;
  const before = page.url();
  const answer = await session.handleTurn(words, { fromVoice: true, linkOfferId: old });
  expect(page.url()).toBe(before);
  expect(answer.actions).toEqual([]);
  expect(answer.speech).toContain("링크 선택지가 바뀌");
  for (const key of Object.keys(answers)) expect(model.calls.map(call => call.schemaName)).toContain(key);
});

it("test_delayed_independent_request_still_opens_its_named_destination", async () => {
  const { session, page, old } = await replaceOffer();
  await session.handleTurn("푸른마을자료관 홈페이지 열어줘", { fromVoice: true, linkOfferId: old });
  expect([...new URL(page.url()).searchParams]).toEqual([["q", "푸른마을자료관 홈페이지"]]);
});

it("test_delayed_confirmation_does_not_reoffer_an_expired_list", async () => {
  const { session, page } = await open();
  await session.handleTurn(PORTAL + " 열어줘");
  await session.handleTurn("링크 목록 알려줘");
  const old = session.linkOfferId;
  await session.handleTurn("청음 소개해줘");
  expect(old).toBeTruthy();
  expect(session.linkOfferId).toBeFalsy();
  expect(session.browse.linkChoices?.options.length).toBeGreaterThan(0);
  const before = page.url();
  expect((await session.handleTurn("네", { fromVoice: true, linkOfferId: old })).actions).toEqual([]);
  expect(page.url()).toBe(before);
  expect(session.linkOfferId).toBeFalsy();
});
