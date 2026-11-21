import { expect, expectTypeOf, it } from "vitest";
import { ClientTiming, type Stage } from "../../web/src/perf.ts";

it("측정 단계에는 사용자의 입력 문자열을 넣을 수 없다", () => {
  expectTypeOf<"사용자가 한 말">().not.toExtend<Stage>();
  expectTypeOf<ClientTiming["mark"]>().parameter(0).toEqualTypeOf<Stage>();
});

it("멈춘 작업의 기록에 취소 표시를 남기고 늦은 결과를 버린다", () => {
  const t = new ClientTiming();
  const completed = t.begin("input-received");
  t.measure(completed, "result-applied");
  const input = t.begin("input-received");
  const sent = t.measure(input, "turn-sent");
  t.stop();
  t.measure(sent, "result-applied");
  expect(t.data.records.filter(r => r.turn === input.record.turn).map(r => [r.stage, r.cancelled]))
    .toEqual([["input-received", true], ["turn-sent", true]]);
  expect(completed.record.cancelled).toBe(false);
});

it("브라우저에 내보내는 기록의 문자열은 정해진 단계 이름뿐이다", () => {
  const t = new ClientTiming();
  const input = t.begin("input-received");
  t.measure(t.measure(input, "turn-sent"), "result-applied");
  expect(t.data.records.flatMap(r => Object.values(r).filter(v => typeof v === "string")))
    .toEqual(["input-received", "turn-sent", "result-applied"]);
  expect(t.data.records.map(r => Object.keys(r))).toEqual(Array(3).fill(["stage", "durationMs", "turn", "cancelled"]));
});

it("세션을 닫은 뒤 새 마이크 요청은 이전 세션의 취소에 묶이지 않는다", () => {
  const t = new ClientTiming();
  const previous = t.mark("microphone-requested");
  t.cancelPending();
  const next = t.mark("microphone-requested");
  expect(t.measure(previous, "track-live")).toBeUndefined();
  expect(t.measure(next, "track-live")?.record.turn).toBe(next.record.turn);
});
