import { expect, it, vi } from "vitest";
import { FakeLlm, withLlm } from "../helpers.ts";
import { browserCases, latch } from "./browser-cases.ts";

const open = browserCases();

it("test_spoken_secret_never_reaches_planner", async () => {
  const { session } = await open();
  await session.handleTurn("로그인하고 싶어");
  const model = new FakeLlm();
  withLlm(session, model);
  expect((await session.handleTurn("사과나무")).intentType).toBe("SECRET_DISCLOSURE");
  expect(model.calls).toEqual([]);
});

it("test_stop_interrupts_intent_plan_before_routing", async () => {
  const { session } = await open();
  const reached = latch();
  const cancelled = latch();
  withLlm(session, new FakeLlm(async ({ schemaName, signal }) => {
    if (schemaName !== "intent_plan") return undefined;
    if (!signal) throw new Error("Planner needs a cancellation signal");
    signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    reached.resolve();
    await cancelled.promise;
    return undefined;
  }));
  const route = vi.spyOn(session, "route");
  const pending = session.handleTurn("문의사항 눌러줘");
  try {
    await reached.promise;
    expect((await session.handleTurn("멈춰")).state).toBe("STOPPED");
    expect((await pending).state).toBe("STOPPED");
    await cancelled.promise;
    expect(route).not.toHaveBeenCalled();
  } finally {
    cancelled.resolve();
    await pending;
  }
}, 12_000);
