import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { researchSummary, type ResearchCheckpoint, type ResearchPlan } from "../../src/core/research.ts";
import type { ResearchDesk } from "../../src/core/research_desk.ts";
import { DIMENSIONS, LEASE_SECONDS, WorkflowRejected, WorkflowStore, canonicalUuid, installationOwner } from "../../src/server/workflow_store.ts";
import { Workflows, publicResult, safeInput, type ResearchOutcome, type ResearchSession } from "../../src/server/workflows.ts";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "cheongeum-workflows-test-"));
  folders.push(dir);
  return dir;
}
const databases = [["sqlite", ""], ["postgres", process.env.CHEONGEUM_TEST_DATABASE_URL ?? ""]] as const;
it("끝난 조사의 음성 인수증은 해당 작업이 전달될 때까지 재시작 후에도 남는다", async () => {
  const [store] = await database("");
  const id = await store.enqueue(randomUUID(), "기관 안내", "ko");
  const pending = await store.pendingDeliveries();
  expect(pending).toEqual([{id, token: expect.any(String), prompt: "기관 안내", language: "ko", state: "queued", result: null}]);
  const token = pending[0]!.token;
  await store.heard(id, token);
  expect(await store.pendingDeliveries()).toEqual(pending);
  const job = await store.claim();
  expect(await store.finish(job!, "failed")).toBe(true);
  const resumed = await WorkflowStore.open(store.path, store.owner);
  const finished = [{...pending[0], state: "failed"}];
  expect(await resumed.pendingDeliveries()).toEqual(finished);
  await resumed.heard(id, randomUUID());
  expect(await resumed.pendingDeliveries()).toEqual(finished);
  await resumed.heard(id, token);
  await resumed.heard(id, token);
  expect(await resumed.pendingDeliveries()).toEqual([]);
});
async function database(dsn: string) {
  const dir = folder();
  const path = join(dir, "queue.db");
  const owner = installationOwner(join(dir, "profile"));
  expect(installationOwner(join(dir, "profile"))).toBe(owner);
  return [await WorkflowStore.open(path, owner, dsn), await WorkflowStore.open(path, randomUUID(), dsn)] as const;
}

describe.each(databases)("%s", (kind, dsn) => {
  const options = { skip: kind === "postgres" && dsn === "" };
  it("only an unexpired holder can renew or publish a result", options, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const [store, otherOwner] = await database(dsn);
      const id = await store.enqueue(randomUUID(), "공개 서류 확인", "ko");
      const job = await store.claim();
      if (job === undefined) throw new Error("Expected a claimed job");
      expect(await otherOwner.renewClaim(job)).toBe(false);
      vi.advanceTimersByTime(LEASE_SECONDS * 1000);
      expect(await store.renewClaim(job)).toBe(false);
      expect(await store.finish(job, "completed")).toBe(false);
      const next = await store.claim();
      if (next === undefined) throw new Error("Expected a replacement claim");
      expect(next.attempts).toBe(2);
      expect(await store.renewClaim(job)).toBe(false);
      expect(await store.cancel(id)).toBe(true);
      expect(await store.renewClaim(next)).toBe(false);
      expect(await store.finish(next, "completed")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("test_claim_cancel_retry_restart_and_isolation", options, async () => {
    const [store, other] = await database(dsn);
    const key = randomUUID();
    const first = await store.enqueue(key, "국가장학금 신청 기간", "ko");
    expect(await store.enqueue(key, "국가장학금 신청 기간", "ko")).toBe(first);
    await expect(store.enqueue(key, "다른 질문", "ko")).rejects.toThrow("conflict");
    expect([await other.jobs(), await other.claim(), await other.cancel(first)]).toEqual([[], undefined, false]);
    const restarted = await WorkflowStore.open(store.path, store.owner, store.dsn);
    const claims = await Promise.all([store, restarted].map(async s => await s.claim(50)));
    const [job, ...rest] = claims.filter(claim => claim !== undefined);
    expect(rest).toEqual([]);
    expect(job?.id).toBe(first);
    if (job === undefined) return;
    const replacement = await restarted.claim(51 + LEASE_SECONDS);
    expect(replacement?.id).toBe(first);
    expect(replacement?.lease).not.toBe(job.lease);
    if (replacement === undefined) return;
    expect(await store.finish(job, "completed", { text: "stale" })).toBe(false);
    expect([await store.cancel(first), await restarted.finish(replacement, "completed")]).toEqual([true, false]);
    expect((await restarted.jobs())[0]?.state).toBe("cancelled");
    expect(await restarted.deleteJob(first)).toBe(true);
    await store.enqueue(randomUUID(), "정부24 발급 안내", "ko");
    for (let i = 0; i < 3; i++) {
      const claimed = await store.claim(5_000_000_000 + i * LEASE_SECONDS);
      expect(claimed).toBeDefined();
      if (claimed !== undefined) await store.retry(claimed);
    }
    expect((await store.jobs())[0]?.state).toBe("failed");
  });

  it("쓰는 사이에 멈춤이 오면 말로 한 답도 취소도 되돌린다", options, async () => {
    const [store] = await database(dsn);
    const id = await store.enqueue(randomUUID(), savedPlan.goal, "ko");
    const job = await store.claim();
    if (job === undefined) throw new Error("Expected a claimed job");
    const plan: ResearchPlan = { ...savedPlan, steps: savedPlan.steps.map(step => step.outcome ? step :
      { ...step, attempts: 1, outcome: { status: "waiting", question: "어떤 지역인가요?" } }) };
    expect(await store.saveProgress(job, 0, { version: 1, plan, activeMs: 0, continuations: 0 })).toBe(true);
    expect(await store.finish(job, "needs_input", { text: "어떤 지역인가요?" })).toBe(true);
    const before = await store.jobs();
    // 첫 문장이 데이터베이스에 다녀오는 사이에 멈춤이 온다.
    let stopped = false;
    const transaction = store.transaction.bind(store);
    const spy = vi.spyOn(store, "transaction").mockImplementation(((body, opts) => transaction(sql => body({ ...sql, run: async (statement, args) => {
      const changed = await sql.run(statement, args);
      stopped = true;
      return changed;
    } }), opts)) as typeof store.transaction);
    expect(await store.answer(id, 1, "서울", () => !stopped)).toBe(false);
    stopped = false;
    expect(await store.cancel(id, () => !stopped)).toBe(false);
    spy.mockRestore();
    expect(await store.jobs()).toEqual(before);
    expect(await store.answer(id, 1, "서울")).toBe(true);
  });

  it("test_semantic_and_keyword_recall_and_forget", options, async () => {
    const [store, other] = await database(dsn);
    const vector = [1, ...Array<number>(DIMENSIONS - 1).fill(0)];
    const model = "text-embedding-3-small";
    const saved = await store.note("Scholarship information in English", vector, model);
    const second = await store.note("Prefer large type", undefined, undefined);
    expect(await store.search("장학금", vector, model)).toEqual([{ id: saved, body: "Scholarship information in English" }]);
    expect((await store.search("large", undefined, undefined))[0]?.id).toBe(second);
    expect([await other.search("장학금", vector, model), await other.deleteNote(saved)]).toEqual([[], false]);
    expect(await store.note("Scholarship information in English", vector, model)).toBe(saved);
    expect(await store.deleteNote(saved)).toBe(true);
    expect(await store.search("장학금", vector, model)).toEqual([]);
  });

  it("결과가 있는 끝난 조사의 인수증은 다시 연 저장소에 결과와 함께 남고, 다른 조사의 번호나 다른 소유자로는 지워지지 않는다", options, async () => {
    const [store, other] = await database(dsn);
    const result = { text: "신청서를 준비하세요.", sources: [firstSource] };
    const ids: string[] = [];
    for (const prompt of ["가 제도의 서류", "나 제도의 마감일"]) {
      ids.push(await store.enqueue(randomUUID(), prompt, "ko"));
      const job = await store.claim();
      if (job === undefined) throw new Error("Expected a claimed job");
      expect(await store.finish(job, "completed", result)).toBe(true);
    }
    const reopened = await WorkflowStore.open(store.path, store.owner, store.dsn);
    const pending = await reopened.pendingDeliveries();
    const [first, second] = ids.map(id => pending.find(row => row.id === id));
    if (first === undefined || second === undefined || pending.length !== 2) throw new Error("Expected two pending deliveries");
    expect([first, second].map(row => [row.state, row.result])).toEqual([["completed", result], ["completed", result]]);
    await reopened.heard(first.id, second.token);
    await other.heard(first.id, first.token);
    expect(await other.pendingDeliveries()).toEqual([]);
    expect(await reopened.pendingDeliveries()).toEqual(pending);
    await reopened.heard(first.id, first.token);
    expect(await store.pendingDeliveries()).toEqual([second]);
  });

  it("답을 받아 다시 줄을 선 조사는 새 인수증 번호를 받고, 예전 번호로는 새 결과의 전달이 지워지지 않는다", options, async () => {
    const [store] = await database(dsn);
    const id = await store.enqueue(randomUUID(), savedPlan.goal, "ko");
    const asking = await store.claim();
    if (asking === undefined) throw new Error("Expected a claimed job");
    const waiting: ResearchPlan = { ...savedPlan, steps: savedPlan.steps.map(step => step.outcome ? step :
      { ...step, attempts: 1, outcome: { status: "waiting", question: "어떤 지역인가요?" } }) };
    expect(await store.saveProgress(asking, 0, { version: 1, plan: waiting, activeMs: 1, continuations: 0 })).toBe(true);
    expect(await store.finish(asking, "needs_input", { text: "어떤 지역인가요?" })).toBe(true);
    const [asked] = await store.pendingDeliveries();
    expect(asked).toMatchObject({ id, state: "needs_input", questionRevision: 1, token: expect.any(String) });

    expect(await store.answer(id, 1, "서울")).toBe(true);
    const [queued] = await store.pendingDeliveries();
    expect(queued).toMatchObject({ id, state: "queued", result: null, token: expect.any(String) });
    expect(queued?.token).not.toBe(asked?.token);

    const resumed = await store.claim();
    if (resumed === undefined) throw new Error("Expected the answered job");
    const result = { text: "금요일에 마감합니다.", sources: [secondSource] };
    expect(await store.finish(resumed, "completed", result)).toBe(true);
    await store.heard(id, asked?.token ?? "");
    expect(await store.pendingDeliveries()).toEqual([{ id, prompt: savedPlan.goal, language: "ko", state: "completed", result, token: queued?.token }]);
    await store.heard(id, queued?.token ?? "");
    expect(await store.pendingDeliveries()).toEqual([]);
  });

  it("그만둔 조사의 인수증은 들었다고 알릴 때까지 같은 번호로 남는다", options, async () => {
    const [store] = await database(dsn);
    const id = await store.enqueue(randomUUID(), "공개 서류 확인", "ko");
    const row = { id, prompt: "공개 서류 확인", language: "ko", result: null };
    const token = (await store.jobs())[0]?.deliveryToken;
    if (token === undefined) throw new Error("Expected a delivery token");
    expect(await store.cancel(id)).toBe(true);
    expect(await store.jobs()).toEqual([{ ...row, state: "cancelled", deliveryToken: token }]);
    expect(await store.pendingDeliveries()).toEqual([{ ...row, state: "cancelled", token }]);
    await store.heard(id, token);
    expect(await store.jobs()).toEqual([{ ...row, state: "cancelled" }]);
    expect(await store.pendingDeliveries()).toEqual([]);
  });

  it("조사 요약은 최근에 맡긴 것부터 limit건을 주고, 맡긴 날은 맡긴 순간의 한국 날짜다", options, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const [store] = await database(dsn);
      vi.setSystemTime(new Date("2026-03-01T14:59:59Z"));
      const evening = await store.enqueue(randomUUID(), "자정 전에 맡긴 조사", "ko");
      vi.setSystemTime(new Date("2026-03-01T15:00:00Z"));
      const midnight = await store.enqueue(randomUUID(), "자정에 맡긴 조사", "en");
      vi.setSystemTime(new Date("2026-03-05T00:00:00Z"));
      const working = { phase: { kind: "working" } };
      expect(await store.summaries(8)).toEqual([
        { ...working, id: midnight, prompt: "자정에 맡긴 조사", language: "en", savedOn: "2026-03-02" },
        { ...working, id: evening, prompt: "자정 전에 맡긴 조사", language: "ko", savedOn: "2026-03-01" },
      ]);
      expect((await store.summaries(1)).map(job => job.id)).toEqual([midnight]);
    } finally {
      vi.useRealTimers();
    }
  });
});

const oracle = z.object({
  safe: z.record(z.string(), z.string().nullable()),
  small: z.record(z.string(), z.string().nullable()),
  public: z.array(z.tuple([z.string(), z.unknown(), z.tuple([z.string(), z.unknown()])])),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/server/workflows.json", import.meta.url), "utf8")));
const outcome = z.object({ text: z.string().nullish(), sources: z.array(z.object({ url: z.string().optional(), title: z.string().nullish() })).optional() });

it("test_only_explicit_public_inputs_and_verified_results_can_be_saved", async () => {
  for (const bad of ["name@example.org", "password is 567812", "https://portal.example/?token=private", "sk-" + "x".repeat(40)]) {
    expect(safeInput(bad, 600), bad).toBeUndefined();
  }
  expect(await publicResult("completed", { text: "unsupported", sources: [] })).toEqual(["incomplete", undefined]);
  expect(await publicResult("completed", { text: "answer", sources: [{ url: "javascript:alert(1)" }] })).toEqual(["incomplete", undefined]);
});
it("safe input and public results match Python on a table", async () => {
  for (const [text, expected] of Object.entries(oracle.safe)) expect(safeInput(text, 600) ?? null, JSON.stringify(text)).toBe(expected);
  for (const [text, expected] of Object.entries(oracle.small)) expect(safeInput(text, 3) ?? null, text).toBe(expected);
  for (const [state, result, [expectedState, expectedOutcome]] of oracle.public) {
    const parsed: ResearchOutcome = outcome.parse(result);
    const [actualState, actualOutcome] = await publicResult(state, parsed);
    expect([actualState, actualOutcome ?? null], JSON.stringify(result).slice(0, 120)).toEqual([expectedState, expectedOutcome]);
  }
});
const cited = { title: "복지로 공식 자료", url: "https://www.bokjiro.go.kr/welfare", lastCheckedAt: "2026-11-24" };
it.each<[string, unknown, unknown]>([
  ["기준일이 날짜인 기관 자료", { kind: "live", origin: "official-api", date: "2026-03-05" }, { kind: "live", origin: "official-api", date: "2026-03-05" }],
  ["기준 연도만 있는 기관 자료", { kind: "live", origin: "official-api", date: "2026년" }, { kind: "live", origin: "official-api", date: "2026년" }],
  ["기준일이 없는 저장 자료", { kind: "stored", origin: "fixture" }, { kind: "stored", origin: "fixture" }],
  ["민간 사업 자료", { kind: "private-program", origin: "공공데이터포털", date: "2026-11-18" }, { kind: "private-program", origin: "공공데이터포털", date: "2026-11-18" }],
  ["자료 정보가 없는 인용", undefined, undefined],
  ["안전하지 않은 기관 이름은 자료 정보를 통째로 뺀다", { kind: "live", origin: "문의 name@example.org", date: "2026년" }, undefined],
  ["종류를 모르면 자료 정보를 통째로 뺀다", { kind: "mystery", origin: "official-api", date: "2026년" }, undefined],
  ["기준일 모양이 틀리면 그 칸만 뺀다", { kind: "live", origin: "official-api", date: "2026-3-5" }, { kind: "live", origin: "official-api" }],
  ["전각 숫자 기준일은 그 칸만 뺀다", { kind: "stored", origin: "fixture", date: "２０２６년" }, { kind: "stored", origin: "fixture" }],
  ["빈 기준일은 그 칸만 뺀다", { kind: "stored", origin: "fixture", date: "" }, { kind: "stored", origin: "fixture" }],
  ["줄바꿈이 붙은 기준일은 그 칸만 뺀다", { kind: "stored", origin: "fixture", date: "2026-03-05\n" }, { kind: "stored", origin: "fixture" }],
  ["백 자를 넘는 기관 이름은 자료 정보를 통째로 뺀다", { kind: "live", origin: "가".repeat(101) }, undefined],
])("저장하는 인용의 자료 정보: %s", async (_name, data, expected) => {
  const [state, saved] = await publicResult("completed", { text: "신청서를 준비하세요.", sources: [{ ...cited, ...(data === undefined ? {} : { data }) }] } as ResearchOutcome);
  expect(state).toBe("completed");
  expect(saved?.sources).toStrictEqual([expected === undefined ? cited : { ...cited, data: expected }]);
});
it("조사 전체에 하나만 적던 자료 정보는 더 이상 저장하지 않는다", async () => {
  const [, saved] = await publicResult("completed", { text: "신청서를 준비하세요.", sources: [cited], data: { kind: "live", origin: "official-api", date: "2026년" } } as ResearchOutcome);
  expect(Object.keys(saved ?? {})).not.toContain("data");
});
it("canonical UUIDs accept Python's spellings", () => {
  const id = "12345678-1234-5678-1234-567812345678";
  for (const spelling of [id, id.toUpperCase(), "{" + id + "}", "urn:uuid:" + id, id.replaceAll("-", "")]) expect(canonicalUuid(spelling)).toBe(id);
  for (const bad of ["None", "", id.slice(1), id + "0", "g".repeat(32)]) expect(() => canonicalUuid(bad), bad).toThrow(RangeError);
});
it("a corrupt database refuses to open and leaves the file as it was", async () => {
  const dir = folder();
  const path = join(dir, "workflows.sqlite3");
  writeFileSync(path, "not a database at all, just text that is long enough to be read as a header");
  await expect(WorkflowStore.open(path, randomUUID())).rejects.toThrow();
  expect(readFileSync(path, "utf8")).toContain("not a database");
});
it("the note and queue limits reject with the Python reasons", async () => {
  const [store] = await database("");
  for (let i = 0; i < 100; i++) await store.note("메모 " + String(i), undefined, undefined);
  await expect(store.note("하나 더", undefined, undefined)).rejects.toMatchObject({ reason: "limit" });
  expect(await store.note("메모 7", undefined, undefined)).toBeTypeOf("string");
  for (let i = 0; i < 50; i++) await store.enqueue(randomUUID(), "질문 " + String(i), "ko");
  await expect(store.enqueue(randomUUID(), "넘침", "ko")).rejects.toBeInstanceOf(WorkflowRejected);
});

function gate() {
  let open = () => {};
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function personalRuntime(research: (prompt: string) => Promise<readonly [string, ResearchOutcome]>) {
  const closed: string[] = [];
  const runtime = {
    settings: { path: join(folder(), "preferences.json"), completed: true, preferences: { deviceUse: "personal" } },
    config: {},
    createSession: async (): Promise<ResearchSession> => ({
      researchPublic: async prompt => await research(prompt),
      cancel: () => { closed.push("cancel"); },
      close: async () => { closed.push("close"); },
    }),
  };
  return { runtime, closed };
}
const session = { consentStatus: "granted", lang: "ko", generation: 1 };
const firstSource = { title: "기관 자료", url: "https://example.go.kr/guide", lastCheckedAt: "2026-11-21" };
const secondSource = { ...firstSource, url: "https://example.go.kr/notice" };
const savedPlan: ResearchPlan = {
  route: "quiet", goal: "가 제도의 서류와 나 제도의 마감일", subject: "", exclusions: [],
  steps: [
    { requirement: "가 제도의 서류", attempts: 1, outcome: { status: "verified", finding: {
      text: "신청서를 준비하세요.", sources: [firstSource], proof: [{ quote: "신청서를 준비하세요.", url: firstSource.url }],
    } } },
    { requirement: "나 제도의 마감일", attempts: 0 },
  ],
};

describe("research worker", () => {
  it("lets another job run between windows and only continues the remaining step", async () => {
    vi.useFakeTimers();
    const held = gate(), release = gate();
    const { runtime } = personalRuntime(async () => ["incomplete", {}]);
    const calls: string[] = [];
    const service = new Workflows({ ...runtime, createSession: async () => ({
      ...await runtime.createSession(),
      async researchPublic(prompt, _language, progress) {
        if (prompt === "다른 공개 질문") {
          calls.push("other");
          return ["completed", { text: "별도 자료", sources: [secondSource] }];
        }
        if (progress === undefined) throw new Error("Expected durable research");
        if (progress.checkpoint === undefined) {
          calls.push("first");
          await progress.save(savedPlan);
          held.open();
          await release.opened;
          return ["incomplete", {}];
        }
        calls.push("remaining");
        const plan = progress.checkpoint.plan;
        const next = await progress.save({ ...plan, steps: plan.steps.map(step => step.outcome ? step : {
          ...step, attempts: 1, outcome: { status: "verified", finding: {
            text: "공고문에 적힌 기한입니다.", sources: [secondSource], proof: [{ quote: "공고문에 적힌 기한입니다.", url: secondSource.url }],
          } },
        }) });
        return researchSummary(next);
      },
    }) });
    try {
      const id = await service.enqueue(session, randomUUID(), savedPlan.goal);
      await held.opened;
      await service.enqueue(session, randomUUID(), "다른 공개 질문");
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      const jobs = await (await service.store()).jobs();
      expect(calls).toEqual(["first", "other", "remaining"]);
      expect(jobs.find(job => job.id === id)).toMatchObject({ state: "completed", result: { sources: [firstSource, secondSource] } });
      expect(service.events.all().map(event => event.errorCode)).toEqual(["budget", "verified", "verified"]);
    } finally {
      release.open();
      await service.close();
      vi.useRealTimers();
    }
  });

  it("reopens checkpoints after a lost process and fences both replacement and resident follow-up", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const [store, other] = await database("");
      const id = await store.enqueue(randomUUID(), savedPlan.goal, "ko");
      const first = await store.claim();
      if (!first) throw new Error("Expected job");
      const checkpoint: ResearchCheckpoint = { version: 1, plan: savedPlan, activeMs: 3, continuations: 0 };
      expect(await store.saveProgress(first, 0, checkpoint)).toBe(true);
      expect(await other.saveProgress(first, 1, checkpoint)).toBe(false);
      expect(await store.saveProgress(first, 0, checkpoint)).toBe(false);
      vi.advanceTimersByTime(LEASE_SECONDS * 1000);
      const reopened = await WorkflowStore.open(store.path, store.owner);
      const rival = await WorkflowStore.open(store.path, store.owner);
      const claims = await Promise.all([reopened.claim(), rival.claim()]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const replacement = claims.find(job => job !== undefined);
      if (!replacement) throw new Error("Expected replacement");
      expect(await reopened.progress(replacement)).toEqual({ revision: 1, checkpoint });
      expect(await store.saveProgress(first, 1, checkpoint)).toBe(false);
      const waiting: ResearchPlan = { ...savedPlan, steps: savedPlan.steps.map(step => step.outcome ? step :
        { ...step, attempts: 1, outcome: { status: "waiting", question: "어떤 지역인가요?" } }) };
      expect(await reopened.saveProgress(replacement, 1, { ...checkpoint, plan: waiting })).toBe(true);
      expect(await reopened.finish(replacement, "needs_input", { text: "어떤 지역인가요?" })).toBe(true);
      expect((await reopened.jobs()).find(job => job.id === id)?.question).toBe("어떤 지역인가요?");
      expect(await other.answer(id, 2, "서울")).toBe(false);
      expect(await reopened.answer(id, 1, "서울")).toBe(false);
      expect(await reopened.answer(id, 2, "서울")).toBe(true);
      expect((await reopened.pendingDeliveries())[0]).toMatchObject({state: "queued", result: null});
      expect(await rival.answer(id, 2, "부산")).toBe(false);
      const resumed = await reopened.claim();
      if (!resumed) throw new Error("Expected resumed job");
      expect((await reopened.progress(resumed))?.checkpoint).toMatchObject({
        plan: { steps: [savedPlan.steps[0], { requirement: "나 제도의 마감일", attempts: 1, clarification: "서울" }] },
      });
      expect(await reopened.cancel(id)).toBe(true);
      expect((await reopened.pendingDeliveries())[0]).toMatchObject({state: "cancelled", result: null});
      expect(await reopened.progress(resumed)).toBeUndefined();
      expect(await reopened.deleteJob(id)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes one slow public lookup across lease windows without restarting it", async () => {
    vi.useFakeTimers();
    const started = gate(), release = gate();
    const research = vi.fn(async (): Promise<readonly [string, ResearchOutcome]> => {
      started.open();
      await release.opened;
      return ["completed", { text: "공식 안내", sources: [{ url: "https://example.go.kr/guide" }] }];
    });
    const service = new Workflows(personalRuntime(research).runtime);
    try {
      const id = await service.enqueue(session, randomUUID(), "공개 서류 확인");
      await started.opened;
      await vi.advanceTimersByTimeAsync(130_000);
      const store = await service.store();
      const otherWorker = await WorkflowStore.open(store.path, store.owner);
      expect(await otherWorker.claim()).toBeUndefined();
      release.open();
      await vi.advanceTimersByTimeAsync(1);
      expect((await otherWorker.jobs())[0]).toMatchObject({ id, state: "completed", result: { text: "공식 안내" } });
      expect(research).toHaveBeenCalledTimes(1);
    } finally {
      release.open();
      await service.close();
      vi.useRealTimers();
    }
  });

  it("ends a lookup that exhausts its time budget without replaying it", async () => {
    vi.useFakeTimers();
    const started = gate(), release = gate();
    const research = vi.fn(async (): Promise<readonly [string, ResearchOutcome]> => {
      started.open();
      await release.opened;
      return ["completed", { text: "늦은 답", sources: [{ url: "https://example.go.kr/guide" }] }];
    });
    const service = new Workflows(personalRuntime(research).runtime);
    try {
      const id = await service.enqueue(session, randomUUID(), "오래 걸리는 공개 자료 조사");
      await started.opened;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect((await (await service.store()).jobs())[0]).toMatchObject({ id, state: "incomplete" });
      release.open();
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await (await service.store()).jobs())[0]).toMatchObject({ id, state: "incomplete", result: null });
      expect(research).toHaveBeenCalledTimes(1);
    } finally {
      release.open();
      await service.close();
      vi.useRealTimers();
    }
  });

  it("runs the next job when a background session takes too long to open", async () => {
    vi.useFakeTimers();
    const opening = gate(), release = gate();
    const lookup = vi.fn(async (prompt: string): Promise<readonly [string, ResearchOutcome]> =>
      ["completed", { text: prompt, sources: [{ url: "https://example.go.kr/guide" }] }]);
    const { runtime, closed } = personalRuntime(lookup);
    const createSession = vi.fn(runtime.createSession).mockImplementationOnce(async () => {
      opening.open();
      await release.opened;
      return await runtime.createSession();
    });
    const service = new Workflows({ ...runtime, createSession });
    try {
      const first = await service.enqueue(session, randomUUID(), "첫째 공개 자료");
      await opening.opened;
      const second = await service.enqueue(session, randomUUID(), "둘째 공개 자료");
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      const jobs = await (await service.store()).jobs();
      expect(jobs.find(job => job.id === first)?.state).toBe("incomplete");
      expect(jobs.find(job => job.id === second)?.state).toBe("completed");
      release.open();
      await vi.advanceTimersByTimeAsync(1);
      expect(lookup.mock.calls).toEqual([["둘째 공개 자료"]]);
      expect(closed).toEqual(["cancel", "close", "cancel", "close"]);
    } finally {
      release.open();
      await service.close();
      vi.useRealTimers();
    }
  });

  it("releases a claim received during shutdown without spending an attempt", async () => {
    const lookup = vi.fn(async (): Promise<readonly [string, ResearchOutcome]> => ["incomplete", {}]);
    const service = new Workflows(personalRuntime(lookup).runtime);
    const store = await service.store();
    const id = await store.enqueue(randomUUID(), "공개 자료 확인", "ko");
    const claimed = gate(), release = gate();
    const claim = store.claim.bind(store);
    vi.spyOn(store, "claim").mockImplementationOnce(async () => {
      const job = await claim();
      claimed.open();
      await release.opened;
      return job;
    });
    try {
      await service.reconfigure();
      await claimed.opened;
      const stopped = service.close();
      release.open();
      await stopped;
      expect((await store.jobs())[0]).toMatchObject({ id, state: "queued" });
      expect(await store.claim()).toMatchObject({ id, attempts: 1 });
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      release.open();
      await service.close();
    }
  });

  it("runs a delegated job to a verified public result and closes its session", async () => {
    const { runtime, closed } = personalRuntime(async prompt => ["completed", { text: prompt + " 답", sources: [{ url: "https://www.kosaf.go.kr/a", title: "한국장학재단" }] }]);
    const service = new Workflows(runtime);
    try {
      const jobId = await service.enqueue(session, randomUUID(), "국가장학금 신청 기간");
      const store = await service.store();
      await until(async () => (await store.jobs())[0]?.state === "completed");
      expect((await store.jobs())[0]).toMatchObject({ id: jobId, result: { text: "국가장학금 신청 기간 답", sources: [{ title: "한국장학재단", url: "https://www.kosaf.go.kr/a" }] } });
      expect(closed).toEqual(["cancel", "close"]);
    } finally {
      await service.close();
    }
  });
  it("a user cancellation stops the job and a shutdown puts it back in the queue", async () => {
    const started = gate();
    const { runtime } = personalRuntime(async () => { started.open(); return await new Promise<never>(() => {}); });
    const service = new Workflows(runtime);
    const store = await service.store();
    const first = await service.enqueue(session, randomUUID(), "첫 질문");
    await started.opened;
    expect(await service.cancel(store, first)).toBe(true);
    expect((await store.jobs())[0]?.state).toBe("cancelled");
    const again = gate();
    const second = new Workflows(personalRuntime(async () => { again.open(); return await new Promise<never>(() => {}); }).runtime);
    const secondStore = await second.store();
    await second.enqueue(session, randomUUID(), "둘째 질문");
    await again.opened;
    await second.close();
    expect((await secondStore.jobs())[0]?.state).toBe("queued");
    const replay = await secondStore.claim();
    expect(replay?.attempts).toBe(1);
    await service.close();
  });
  it("refuses work without a personal device, consent or public text", async () => {
    const { runtime } = personalRuntime(async () => ["completed", {}]);
    const shared = new Workflows({ ...runtime, config: { pilotProfile: "shared" } });
    await expect(shared.enqueue(session, randomUUID(), "질문")).rejects.toMatchObject({ reason: "input" });
    const service = new Workflows(runtime);
    await expect(service.enqueue({ ...session, consentStatus: "unknown" }, randomUUID(), "질문")).rejects.toMatchObject({ reason: "input" });
    await expect(service.enqueue(session, randomUUID(), "메일 name@example.org")).rejects.toMatchObject({ reason: "input" });
    const flagged = new Workflows({ ...runtime, moderation: { screen: async () => true } });
    await expect(flagged.enqueue(session, randomUUID(), "질문")).rejects.toMatchObject({ reason: "input" });
    expect(await service.recall({ ...session, consentStatus: "unknown" }, "질문")).toEqual([]);
    const deps: { recallNotes?: (query: string) => Promise<string[]>; research?: ResearchDesk } = {};
    shared.bind({ ...session, deps });
    expect(deps.research).toBeUndefined();
    expect(await deps.recallNotes?.("질문")).toEqual([]);
  });
});
