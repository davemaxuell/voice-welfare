import { expect, it } from "vitest";
import { raceAbort } from "../../src/core/abort.ts";
import { TurnQueue } from "../../src/core/mutex.ts";
import { Progress } from "../../src/core/progress.ts";
import { getOpcodes } from "../../src/core/sequence_matcher.ts";
import { jsRound, todayIso } from "../../src/core/time.ts";
import { parseUrl, tryUrl } from "../../src/core/url.ts";

it("한글 주소는 원래 표기를 유지하고 질의 값과 상대 경로를 해석한다", () => {
  const base = "HTTPS://복지.한국:443/안내/항목";
  const link = parseUrl("../신청?이름=김+하늘&이름=나&빈=", base);
  expect(link.href).toBe("https://복지.한국:443/신청?이름=김+하늘&이름=나&빈=");
  expect(link.origin).toBe("https://복지.한국");
  expect(link.param("이름")).toBe("김 하늘");
  expect(link.param("빈")).toBe("");
  expect(link.param("없음")).toBeUndefined();
  expect(link.query["이름"]).toEqual(["김 하늘", "나"]);
  expect(tryUrl("https://예시／위장")).toBeUndefined();
  expect(tryUrl("ſtp://예시")).toBeUndefined();
  expect(parseUrl("http://[::1]:5174").host).toBe("[::1]:5174");
});

it("같은 줄이 반복돼도 Python과 같은 변경 구간을 찾는다", () => {
  expect(getOpcodes(["가", "나"], ["가", "다", "가", "나"])).toEqual([
    ["insert", 0, 0, 0, 2], ["equal", 0, 2, 2, 4],
  ]);
  expect(getOpcodes([], [])).toEqual([]);
});

it("중단 시 대기 중인 턴을 무효화하고 뒤에 온 턴을 순서대로 실행한다", async () => {
  const queue = new TurnQueue();
  const initialEpoch = queue.epoch;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = queue.enqueue(() => gate.then(() => "진행"), () => "취소");
  await Promise.resolve();
  const stale = queue.enqueue(async () => { throw Error("이미 중단한 턴"); }, () => "취소");
  queue.invalidate();
  const delayed = queue.enqueue(async () => "실행", () => "취소", initialEpoch);
  const next = queue.enqueue(async () => "다음", () => "취소");
  release();
  expect(await Promise.all([first, stale, delayed, next])).toEqual(["진행", "취소", "취소", "다음"]);
});

it("중단된 작업은 시작하지 않고 실행 중인 작업에는 신호를 전한다", async () => {
  const controller = new AbortController();
  let running: AbortSignal | undefined;
  const pending = raceAbort(signal => {
    running = signal;
    return new Promise<void>(() => {});
  }, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(running?.aborted).toBe(true);
  let called = false;
  await expect(raceAbort(async () => { called = true; }, controller.signal)).rejects.toThrow();
  expect(called).toBe(false);
});

it("한국 자정에 날짜를 바꾸고 음수의 소수점도 Python 기준에 맞춘다", () => {
  expect(todayIso(new Date("2026-11-17T14:59:59Z"))).toBe("2026-11-17");
  expect(todayIso(new Date("2026-11-17T15:00:00Z"))).toBe("2026-11-18");
  expect(jsRound(-0.5)).toBe(0);
});

it("새 목표에서 단계만 지우고 전체 진행 번호를 이어 센다", () => {
  const progress = new Progress();
  progress.start();
  progress.add("첫 화면을 열었어요.");
  progress.finish();
  expect(progress.latest).toBe("첫 화면을 열었어요.");
  progress.start();
  expect(progress.snapshot()).toEqual({ running: true, seq: 1, latest: null, spoken: true, activity: null, activitySpoken: false });
});
