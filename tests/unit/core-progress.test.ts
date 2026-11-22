import { expect, it } from "vitest";
import { Progress } from "../../src/core/progress.ts";
import { MODEL_STATUS } from "../../src/core/model_status.ts";

it("keeps the active agent visible during transcription and drops interrupted recordings", async () => {
  const progress = new Progress();
  let release!: () => void;
  const recording = progress.transcribing("en", () => new Promise<void>(resolve => { release = resolve; }));
  expect(progress.backendStatus).toBe("Transcribing your recording.");
  await progress.trackBackend(() => "en", () => true, async () => {
    MODEL_STATUS.getStore()!.begin("search", "Reading the guide");
    expect(progress.backendStatus).toBe("Reading the guide");
  });
  expect(progress.backendStatus).toBe("Transcribing your recording.");
  progress.interrupt();
  release();
  await recording;
  expect(progress.backendStatus).toBe("");
});

it("keeps only the newest pass and clears it on Stop, errors and completion", async () => {
  const progress = new Progress();
  const seen: string[] = [];
  progress.watchBackend(state => seen.push(state?.backend_status ?? "closed"));
  let release!: (allowed: boolean) => void;
  const check = new Promise<boolean>(resolve => { release = resolve; });
  await progress.trackBackend(() => "en", line => line === "stale" ? check : line !== "private", async () => {
    const scope = MODEL_STATUS.getStore()!;
    const first = scope.begin("planner", "Planning");
    first("stale");
    const next = scope.begin("search", "Searching");
    release(true);
    next("private");
    await new Promise(resolve => setImmediate(resolve));
    expect(progress.backendStatus).toBe("Searching");
    next("Checking official deadlines");
    await new Promise(resolve => setImmediate(resolve));
    expect(progress.backendStatus).toBe("Checking official deadlines");
    progress.interrupt();
    first("late first");
    next("late second");
    scope.begin("late pass", "Should stay cleared");
    expect(progress.backendStatus).toBe("");
  });
  await expect(progress.trackBackend(() => "en", () => true, async () => {
    MODEL_STATUS.getStore()!.begin("file", "Reading");
    throw Error("aborted");
  })).rejects.toThrow("aborted");
  progress.close();
  expect(seen).toEqual(["", "Planning", "Searching", "Checking official deadlines", "", "Reading", "", "closed"]);
});

it("검토 중에 확인한 단계만 한 번씩 읽고 음성 설정을 존중한다", async () => {
  const progress = new Progress();
  progress.start();
  await progress.review(async () => {
    progress.note("다음 항목을 찾는 중이에요.", true);
    progress.milestone("portal", "요청한 사이트를 열었어요.");
    const first = progress.snapshot();
    progress.milestone("portal", "요청한 사이트를 열었어요.");
    expect(progress.snapshot()).toEqual(first);
    expect(first).toMatchObject({spoken: true, activitySpoken: true});
    expect(progress.shiftSpoken()).toBe(first.latest);
    expect(progress.hasSpoken()).toBe(false);
    progress.spoken = false;
    progress.milestone("return", "사이트로 돌아왔어요.");
    expect(progress.latest).toBe("사이트로 돌아왔어요.");
    expect(progress.hasSpoken()).toBe(false);
  });
});

it("검토하는 동안에는 자동 음성 안내만 멈추고 최신 단계는 그대로 읽을 수 있다", async () => {
  const progress = new Progress();
  progress.start();
  progress.add("복지로를 열었어요.");
  expect(progress.snapshot()).toEqual({ running: true, seq: 1, backend_status: "", latest: "복지로를 열었어요.", spoken: true, activity: null, activitySpoken: false });
  let during: ReturnType<Progress["snapshot"]> | undefined;
  await progress.review(() => { during = progress.snapshot(); });
  expect(during).toEqual({ running: true, seq: 1, backend_status: "", latest: "복지로를 열었어요.", spoken: false, activity: null, activitySpoken: false });
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

it("끝난 단계 문장은 다음 상태 줄이 와도 읽을 때까지 남는다", () => {
  const progress = new Progress();
  progress.start();
  progress.note("'신청'을 누르려고 했어요.", true);
  progress.note("생각하는 중이에요.", false);
  expect(progress.snapshot().activity).toBe("'신청'을 누르려고 했어요.");
  expect(progress.shiftSpoken()).toBe("'신청'을 누르려고 했어요.");
  expect(progress.snapshot().activity).toBe("생각하는 중이에요.");
});

it("새 목표가 시작된 뒤 이전 다시 쓰기는 줄을 되돌리지 않는다", () => {
  const progress = new Progress();
  progress.start();
  progress.note("옛 문장", true);
  const seq = progress.snapshot().seq;
  const generation = progress.generation;
  progress.start();
  expect(progress.generation).not.toBe(generation);
  progress.revise(seq, "옛 문장");
  expect(progress.snapshot().activity).toBeNull();
});

it("상태 줄은 사실 단계를 바꾸지 않고 말하기 여부만 남긴다", () => {
  const progress = new Progress();
  progress.start();
  progress.add("복지로를 열었어요.");
  progress.note("생각하는 중이에요.", false);
  expect(progress.snapshot()).toMatchObject({
    seq: 2, latest: "복지로를 열었어요.", activity: "생각하는 중이에요.", activitySpoken: false,
  });
  progress.note("요청한 일을 실행하는 중이에요.", true);
  expect(progress.snapshot().activitySpoken).toBe(true);
  progress.start();
  expect(progress.snapshot()).toMatchObject({ activity: null, activitySpoken: false, latest: null });
});
