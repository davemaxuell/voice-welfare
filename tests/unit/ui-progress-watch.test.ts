import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchProgress } from "../../web/src/progress-watch.ts";

const report = { running: true, seq: 3, spoken: true, activity: "연습 안내를 확인했어요." };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function start(poll: () => Promise<typeof report>, isCurrent = () => true) {
  const apply = vi.fn(), considerSpeech = vi.fn();
  const stop = watchProgress({
    poll, isCurrent, apply, considerSpeech,
    wait(next) {
      const timer = setTimeout(next, 2000);
      return () => clearTimeout(timer);
    },
  });
  return { apply, considerSpeech, stop };
}

it("이전 요청이 끝나고 이 초가 지나야 다음 조회를 시작한다", async () => {
  let finish = () => {};
  const poll = vi.fn(() => new Promise<typeof report>(resolve => { finish = () => resolve(report); }));
  const watch = start(poll);
  await vi.advanceTimersByTimeAsync(12_000);
  expect(poll).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(1999);
  expect(poll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(poll).toHaveBeenCalledTimes(2);
  watch.stop();
});

it.each(["멈춤", "세션 교체"])("%s 뒤의 응답은 화면이나 음성에 반영하지 않는다", async reason => {
  let session = "처음";
  let finish = () => {};
  const poll = vi.fn(() => new Promise<typeof report>(resolve => { finish = () => resolve(report); }));
  const watch = start(poll, () => session === "처음");
  await vi.advanceTimersByTimeAsync(2000);
  expect(poll).toHaveBeenCalledTimes(1);
  if (reason === "멈춤") watch.stop();
  else session = "다음";
  finish();
  await vi.advanceTimersByTimeAsync(6000);
  expect(watch.apply).not.toHaveBeenCalled();
  expect(watch.considerSpeech).not.toHaveBeenCalled();
  expect(poll).toHaveBeenCalledTimes(1);
});

it("같은 진행 응답은 화면에 한 번만 반영하고 미뤘던 음성은 다시 확인한다", async () => {
  const poll = vi.fn().mockResolvedValue(report);
  const watch = start(poll);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(watch.apply).toHaveBeenCalledTimes(1);
  expect(watch.considerSpeech).toHaveBeenCalledTimes(5);
  poll.mockResolvedValue({ ...report, activity: "연습 안내를 다시 확인했어요." });
  await vi.advanceTimersByTimeAsync(2000);
  expect(watch.apply).toHaveBeenCalledTimes(2);
  watch.stop();
});

it("진행 조회가 세 번 실패해도 다음 응답을 표시한다", async () => {
  const poll = vi.fn().mockRejectedValueOnce(new Error()).mockRejectedValueOnce(new Error())
    .mockRejectedValueOnce(new Error()).mockResolvedValue(report);
  const watch = start(poll);
  await vi.advanceTimersByTimeAsync(8000);
  expect(watch.apply.mock.calls).toEqual([[report]]);
  expect(watch.considerSpeech.mock.calls).toEqual([[report]]);
  watch.stop();
});
