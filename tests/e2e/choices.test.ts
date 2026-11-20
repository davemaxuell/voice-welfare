import { afterAll, afterEach, expect, it } from "vitest";
import { z } from "zod";
import { PORTAL } from "../helpers.ts";
import { apiFixture } from "./runtime-http-fixture.ts";
import { createTestRuntime } from "./session-runtime.ts";

const runtime = createTestRuntime();
afterEach(runtime.closeSessions);
afterAll(runtime.close);

it("test_login_handoff_offers_done_and_cancel_and_resumes_the_form", async () => {
  const { session, page } = await runtime.createBrowserSession();
  expect((await session.handleTurn("장애인연금 신청 도와줘")).offeredChoices ?? []).toEqual([]);
  const handed = await session.handleTurn("로그인하고 싶어");
  expect(handed.state).toBe("AUTH_HANDOFF");
  expect(handed.offeredChoices).toEqual([{ key: "auth-done", label: "로그인했어요" }, { key: "auth-cancel", label: "인증 취소" }]);
  const id = handed.authHandoff?.id;
  const still = await session.choose(handed.turnId, "auth-done", id);
  expect(still).toMatchObject({ state: "AUTH_HANDOFF", userUtterance: "로그인했어요" });
  expect(still?.speech).toContain("아직");
  expect(await session.choose(handed.turnId, "auth-done", id)).toBeUndefined();
  if (still === undefined) throw new Error("Missing refreshed handoff");
  expect(await session.choose(still.turnId, "auth-done", "other-handoff")).toBeUndefined();
  await page.goto("http://localhost:5174/apply.html", { waitUntil: "domcontentloaded" });
  const done = await session.choose(still.turnId, "auth-done", id);
  expect(done).toMatchObject({ intentType: "AUTH_DONE", state: "APPLICATION_OPEN" });
  expect(session.dialogue.awaiting).toBe("applicantName");
  expect(done?.offeredChoices ?? []).toEqual([]);
});

it("test_superseded_handoff_and_cancel", async () => {
  const { session } = await runtime.createBrowserSession();
  const first = await session.handleTurn("로그인하고 싶어");
  const cancelled = await session.choose(first.turnId, "auth-cancel", first.authHandoff?.id);
  expect(cancelled?.authHandoff?.status).toBe("cancelled");
  expect(cancelled?.offeredChoices ?? []).toEqual([]);
  const second = await session.handleTurn("로그인하고 싶어");
  const third = await session.handleTurn("화면 설명해줘");
  expect(third.authHandoff?.id).toBe(second.authHandoff?.id);
  expect(await session.choose(second.turnId, "auth-done", second.authHandoff?.id)).toBeUndefined();
  expect(await session.choose(third.turnId, "auth-done", first.authHandoff?.id)).toBeUndefined();
  expect(session.dialogue.authWaiting).toBe(true);
});

it("test_read_main_offer_is_bound_to_the_page_it_was_offered_for", async () => {
  const { session, page } = await runtime.createBrowserSession();
  const open = () => session.handleTurn(PORTAL + " 열어줘");
  const first = await open();
  expect(first.offeredChoices).toEqual([{ key: "read-main", label: "본문 읽기" }]);
  expect(await session.choose(first.turnId, "read-main")).toMatchObject({ semanticAction: "read-main", userUtterance: "본문 읽어줘" });
  const second = await open();
  await page.goto("http://127.0.0.1:5174/external2.html", { waitUntil: "domcontentloaded" });
  expect(await session.choose(second.turnId, "read-main")).toBeUndefined();
});

it("test_no_offer_while_an_approval_is_pending", async () => {
  const { session } = await runtime.createBrowserSession();
  await session.handleTurn("127.0.0.1:5174/external.html 열어줘");
  const asked = await session.handleTurn("이름 칸에 김하늘 써줘");
  expect(asked.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(asked.offeredChoices ?? []).toEqual([]);
});

it("test_choice_route_validates_and_reports_expired_offers", async () => {
  const api = apiFixture();
  try {
    const { sessionId } = z.object({ sessionId: z.string() }).parse(await (await api.post("/api/session", {})).json());
    const turn = z.object({ turnId: z.string(), authHandoff: z.object({ id: z.string() }) }).parse(
      await (await api.post("/api/turn", { sessionId, text: "로그인하고 싶어", clientPlatform: "pc" })).json());
    const path = "/api/session/" + sessionId + "/choice";
    expect((await api.post(path, { turnId: turn.turnId, key: "submit" })).status).toBe(400);
    const stale = await api.post(path, { turnId: "turn-old", key: "auth-done", handoffId: turn.authHandoff.id });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "CHOICE_EXPIRED" });
    const cancel = () => api.post(path, { turnId: turn.turnId, key: "auth-cancel", handoffId: turn.authHandoff.id }, { "X-Cheongeum-Request": "1" });
    const ok = await cancel();
    expect(ok.status).toBe(200);
    const result = z.object({ turnId: z.string(), authHandoff: z.object({ status: z.literal("cancelled") }) }).parse(await ok.json());
    expect(await (await cancel()).json()).toMatchObject({ turnId: result.turnId });
  } finally { await api.close(); }
});
