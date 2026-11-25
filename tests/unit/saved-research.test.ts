import { expect, it } from "vitest";
import type { JobPhase, SavedJob } from "../../src/core/research_desk.ts";
import { fits, plannerView } from "../../src/orchestrator/saved_research.ts";

const job = (id: string, request: string, phase: JobPhase, savedOn = "2026-11-25"): SavedJob => ({ id, request, language: "ko", phase, savedOn });
const same = (text: string) => text;

it("플래너에 보일 목록은 받은 순서대로 j1부터 여덟 건까지 번호를 붙이고, 그 번호만 조사 번호로 되돌린다", () => {
  const jobs = Array.from({ length: 10 }, (_, i) => job(`job-${i + 1}`, `조사 ${i + 1}`, { kind: "ready" }));
  const view = plannerView(jobs, undefined, same);
  expect(view.saved.jobs.map(listed => [listed.ref, listed.request])).toEqual(jobs.slice(0, 8).map((saved, i) => [`j${i + 1}`, saved.request]));
  expect(view.resolve("j1")).toBe("job-1");
  expect(view.resolve("j8")).toBe("job-8");
  for (const unknown of ["j9", "j0", "job-1", ""]) expect(view.resolve(unknown), unknown).toBeUndefined();
  expect(JSON.stringify(view.saved)).not.toContain("job-");
});

it("목록의 요청은 가린 뒤에 120자까지만 싣는다", () => {
  const secret = "010-1234-5678";
  const redact = (text: string) => text.replaceAll(secret, "▒");
  const [short, emoji, straddling] = plannerView([
    job("a", `연락처 ${secret} 관련 조사`, { kind: "ready" }),
    job("b", "😀".repeat(130), { kind: "ready" }),
    job("c", "가".repeat(115) + secret, { kind: "ready" }),
  ], undefined, redact).saved.jobs;
  expect(short?.request).toBe("연락처 ▒ 관련 조사");
  expect(emoji?.request).toBe("😀".repeat(120));
  expect(straddling?.request).toBe("가".repeat(115) + "▒");
});

it("목록에는 맡긴 날과 플래너가 보는 상태가 실리고, 방금 맡긴 조사가 목록에 있을 때만 표시한다", () => {
  const jobs = [
    job("working", "가", { kind: "working" }, "2026-11-26"), job("ready", "나", { kind: "ready" }, "2026-11-25"),
    job("asking", "다", { kind: "asking", revision: 2 }, "2026-11-24"), job("restart", "라", { kind: "asking", revision: undefined }, "2026-11-23"),
    job("ended", "마", { kind: "ended" }, "2026-11-22"),
  ];
  expect(plannerView(jobs, "ready", same).saved.jobs).toEqual([
    { ref: "j1", request: "가", state: "working", savedOn: "2026-11-26" },
    { ref: "j2", request: "나", state: "ready", savedOn: "2026-11-25", lastSaved: true },
    { ref: "j3", request: "다", state: "asking", savedOn: "2026-11-24" },
    { ref: "j4", request: "라", state: "asking-restart", savedOn: "2026-11-23" },
    { ref: "j5", request: "마", state: "ended", savedOn: "2026-11-22" },
  ]);
  expect(JSON.stringify(plannerView(jobs, "지워진 조사", same).saved)).not.toContain("lastSaved");
});

it("읽기는 결과가 있거나 되묻는 조사에만 맞는다", () => {
  const phases: [JobPhase, boolean][] = [
    [{ kind: "ready" }, true], [{ kind: "asking", revision: 1 }, true], [{ kind: "asking", revision: undefined }, true],
    [{ kind: "working" }, false], [{ kind: "ended" }, false],
  ];
  for (const [phase, expected] of phases) expect(fits("read", phase), JSON.stringify(phase)).toBe(expected);
});

it("답하기는 되묻는 조사에만, 취소는 조사 중이거나 되묻는 조사에만 맞는다", () => {
  const phases: [JobPhase, {answer: boolean; cancel: boolean}][] = [
    [{ kind: "working" }, { answer: false, cancel: true }],
    [{ kind: "asking", revision: 1 }, { answer: true, cancel: true }],
    [{ kind: "ready" }, { answer: false, cancel: false }],
    [{ kind: "ended" }, { answer: false, cancel: false }],
  ];
  for (const [phase, expected] of phases) {
    expect({ answer: fits("answer", phase), cancel: fits("cancel", phase) }, JSON.stringify(phase)).toEqual(expected);
  }
});

it("이어서 답을 받을 수 없는 되물음도 답하기와 취소에 맞아, 답하려 하면 없는 조사 취급이 아니라 새로 맡기라는 안내를 받는다", () => {
  const restart: JobPhase = { kind: "asking", revision: undefined };
  expect(fits("answer", restart)).toBe(true);
  expect(fits("cancel", restart)).toBe(true);
  expect(plannerView([job("restart", "라", restart)], undefined, same).saved.jobs[0]?.state).toBe("asking-restart");
});
