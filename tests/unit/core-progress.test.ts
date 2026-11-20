import { expect, it } from "vitest";
import { Progress } from "../../src/core/progress.ts";

it("검토하는 동안에는 자동 음성 안내만 멈추고 최신 단계는 그대로 읽을 수 있다", async () => {
  const progress = new Progress();
  progress.start();
  progress.add("복지로를 열었어요.");
  expect(progress.snapshot()).toEqual({ running: true, seq: 1, latest: "복지로를 열었어요.", spoken: true });
  let during: ReturnType<Progress["snapshot"]> | undefined;
  await progress.review(() => { during = progress.snapshot(); });
  expect(during).toEqual({ running: true, seq: 1, latest: "복지로를 열었어요.", spoken: false });
  expect(progress.snapshot().spoken).toBe(true);
});

it("검토가 겹치면 모두 끝날 때까지 보류하고 말하기를 끈 값은 그대로 끈 채다", async () => {
  const progress = new Progress();
  const states: boolean[] = [];
  await progress.review(async () => {
    await progress.review(async () => { states.push(progress.snapshot().spoken); });
    states.push(progress.snapshot().spoken);
  });
  states.push(progress.snapshot().spoken);
  expect(states).toEqual([false, false, true]);
  progress.spoken = false;
  expect(progress.snapshot().spoken).toBe(false);
});

it("검토 중에 오류가 나도 보류가 풀린다", async () => {
  const progress = new Progress();
  await expect(progress.review(() => { throw new Error("검토 실패"); })).rejects.toThrow("검토 실패");
  expect(progress.snapshot().spoken).toBe(true);
});

it("검토한 일의 결과를 그대로 돌려준다", async () => {
  await expect(new Progress().review(async () => 7)).resolves.toBe(7);
});
