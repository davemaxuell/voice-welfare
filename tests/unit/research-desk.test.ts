import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchCheckpoint, ResearchPlan } from "../../src/core/research.ts";
import type { JobPhase, ResearchDesk } from "../../src/core/research_desk.ts";
import { createResearchDesk } from "../../src/server/research_desk.ts";
import { LEASE_SECONDS, MAX_ATTEMPTS, type WorkflowStore } from "../../src/server/workflow_store.ts";
import { Workflows, type ResearchSession } from "../../src/server/workflows.ts";

const folders: string[] = [];
const opened: Workflows[] = [];
afterEach(async () => {
  for (const flows of opened.splice(0)) await flows.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function setup(config: { pilotProfile?: string } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "cheongeum-desk-test-"));
  folders.push(folder);
  const runtime = {
    settings: { path: join(folder, "preferences.json"), completed: true, preferences: { deviceUse: "personal" } },
    config,
    createSession: async (): Promise<ResearchSession> => ({
      researchPublic: () => new Promise<never>(() => {}),
      cancel: () => {},
      close: async () => {},
    }),
  };
  const flows = new Workflows(runtime);
  opened.push(flows);
  const session = { consentStatus: "granted", lang: "ko", generation: 1 };
  return { flows, session, desk: createResearchDesk(flows, session) };
}

const later = () => new Promise(resolve => setTimeout(resolve, 3));
async function finished(store: WorkflowStore, prompt: string, state: string, result?: object, language = "ko") {
  await later();
  const id = await store.enqueue(randomUUID(), prompt, language);
  const job = await store.claim();
  if (job === undefined) throw new Error("Expected a claim");
  expect(await store.finish(job, state, result)).toBe(true);
  return id;
}

const source = { title: "구별되는출처제목", url: "https://www.bokjiro.go.kr/", lastCheckedAt: "2026-11-24" };
const waitingPlan = (attempts: number): ResearchPlan => ({
  route: "quiet", goal: "가 제도의 서류와 나 제도의 마감일", subject: "", exclusions: [],
  steps: [
    { requirement: "가 제도의 서류", attempts: 1, outcome: { status: "verified", finding: {
      text: "신청서를 준비하세요.", sources: [source], proof: [{ quote: "신청서를 준비하세요.", url: source.url }],
    } } },
    { requirement: "나 제도의 마감일", attempts, outcome: { status: "waiting", question: "어느 지역인가요?" } },
  ],
});
async function cancelled(store: WorkflowStore, prompt: string) {
  await later();
  const id = await store.enqueue(randomUUID(), prompt, "ko");
  expect(await store.cancel(id)).toBe(true);
  return id;
}
async function failedAfterFinding(store: WorkflowStore, prompt: string) {
  await later();
  const id = await store.enqueue(randomUUID(), prompt, "ko");
  const [verified] = waitingPlan(1).steps;
  if (verified === undefined) throw new Error("Expected a verified step");
  const plan: ResearchPlan = { ...waitingPlan(1), steps: [verified, { requirement: "나 제도의 마감일", attempts: 1 }] };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const job = await store.claim(5_000_000_000 + attempt * LEASE_SECONDS);
    if (job === undefined) throw new Error("Expected a claim");
    if (attempt === 0) expect(await store.saveProgress(job, 0, { version: 1, plan, activeMs: 1, continuations: 0 })).toBe(true);
    await store.retry(job);
  }
  expect((await store.jobs()).find(job => job.id === id)?.state).toBe("failed");
  return id;
}
async function asking(store: WorkflowStore, prompt: string, attempts: number) {
  await later();
  const id = await store.enqueue(randomUUID(), prompt, "ko");
  const job = await store.claim();
  if (job === undefined) throw new Error("Expected a claim");
  const checkpoint: ResearchCheckpoint = { version: 1, plan: waitingPlan(attempts), activeMs: 1, continuations: 0 };
  expect(await store.saveProgress(job, 0, checkpoint)).toBe(true);
  expect(await store.finish(job, "needs_input", { text: "어느 지역인가요?" })).toBe(true);
  return id;
}

describe("연구 책상", () => {
  it("같은 요청 번호로 맡기면 같은 조사 번호를 돌려주고 저장소에는 그 조사 하나만 남는다", async () => {
    const { flows, desk } = setup();
    const requestId = randomUUID();
    const first = await desk.delegate(requestId, "기초연금 신청 서류");
    expect(first).toEqual({ jobId: expect.any(String) });
    expect(await desk.delegate(requestId, "기초연금 신청 서류")).toEqual(first);
    expect((await (await flows.store()).jobs()).map(job => job.id)).toEqual([first?.jobId]);
  });

  it("같은 요청 번호에 다른 질문이면 맡기지 않고, 비밀 값이 든 질문도 맡기지 않는다", async () => {
    const { flows, desk } = setup();
    const requestId = randomUUID();
    expect(await desk.delegate(requestId, "기초연금 신청 서류")).toBeDefined();
    expect(await desk.delegate(requestId, "아동수당 신청 서류")).toBeUndefined();
    expect(await desk.delegate(randomUUID(), "비밀번호는 1234예요")).toBeUndefined();
    expect(await (await flows.store()).jobs()).toHaveLength(1);
  });

  it("목록에는 결과 글과 출처 제목과 남은 항목이 들어가지 않는다", async () => {
    const { flows, desk } = setup();
    const store = await flows.store();
    await finished(store, "기초연금 신청 서류", "partial", { text: "구별되는결과글입니다.", sources: [source], missing: ["구별되는남은항목"] });
    await asking(store, "아동수당 신청 방법", 1);
    const listed = await desk.recent(10);
    expect(listed.map(job => Object.keys(job).sort((a, b) => a.localeCompare(b)))).toEqual(listed.map(() => ["id", "language", "phase", "request"]));
    const serialized = JSON.stringify(listed);
    for (const hidden of ["구별되는결과글", "구별되는출처제목", "구별되는남은항목", "어느 지역인가요", "bokjiro"]) expect(serialized).not.toContain(hidden);
    expect(listed.map(job => job.request)).toEqual(["아동수당 신청 방법", "기초연금 신청 서류"]);
  });

  it("상태마다 알맞은 단계가 되고, 되묻는 조사는 질문 번호가 있을 때만 번호를 가진다", async () => {
    const { flows, desk } = setup();
    const store = await flows.store();
    const read = { text: "신청서를 준비하세요.", sources: [source] };
    const ids: Record<string, string> = {
      completed: await finished(store, "완료", "completed", read),
      partial: await finished(store, "일부", "partial", { missing: ["마감일"] }),
      incomplete: await finished(store, "확인 못 함", "incomplete", read),
      emptyCompleted: await finished(store, "빈 완료", "completed", { sources: [source] }),
      cancelled: await cancelled(store, "중단"),
      failed: await finished(store, "실패", "failed"),
      failedAfterFinding: await failedAfterFinding(store, "확인한 것을 남기고 실패"),
      askingWithQuestion: await asking(store, "질문 있음", 1),
      askingExhausted: await asking(store, "질문 소진", 2),
      askingWithoutCheckpoint: await finished(store, "한 번에 끝나는 조사의 질문", "needs_input", { text: "어느 지역인가요?" }),
    };
    const running = await store.enqueue(randomUUID(), "진행 중", "ko");
    expect(await store.claim()).toMatchObject({ id: running });
    const queued = await store.enqueue(randomUUID(), "대기 중", "ko");
    const phases = new Map((await desk.recent(20)).map(job => [job.id, job.phase]));
    const expected: [string, JobPhase][] = [
      [ids.completed!, { kind: "ready" }], [ids.partial!, { kind: "ready" }], [ids.incomplete!, { kind: "ready" }],
      [ids.emptyCompleted!, { kind: "ended" }], [ids.cancelled!, { kind: "ended" }], [ids.failed!, { kind: "ended" }],
      [ids.failedAfterFinding!, { kind: "ready" }],
      [ids.askingWithQuestion!, { kind: "asking", revision: 1 }], [ids.askingExhausted!, { kind: "asking", revision: undefined }],
      [ids.askingWithoutCheckpoint!, { kind: "asking", revision: undefined }],
      [running, { kind: "working" }], [queued, { kind: "working" }],
    ];
    expect(phases.size).toBe(expected.length);
    for (const [id, phase] of expected) expect(phases.get(id), id).toEqual(phase);
    expect((await desk.read(ids.failedAfterFinding!, "normal"))?.speech).toContain("신청서를 준비하세요.");
  });

  it("목록은 limit건까지 최근에 맡긴 것부터 주고 언어를 알아본다", async () => {
    const { flows, desk } = setup();
    const store = await flows.store();
    for (const [prompt, language] of [["첫째", "ko"], ["둘째", "en"], ["셋째", "xx"]] as const) await finished(store, prompt, "completed", { text: "답" }, language);
    expect((await desk.recent(2)).map(({ request, language }) => [request, language])).toEqual([["셋째", "ko"], ["둘째", "en"]]);
  });

  it("읽기는 요청한 길이로 말할 글과 출처를 주고, 읽을 것이 없거나 없는 조사는 주지 않는다", async () => {
    const { flows, desk } = setup();
    const store = await flows.store();
    const long = "첫째 문장이에요. 둘째 문장이에요. 셋째 문장이에요. 넷째 문장이에요.";
    const ready = await finished(store, "기초연금 신청 서류", "completed", { text: long, sources: [{ title: source.title, url: source.url }] });
    const empty = await finished(store, "빈 완료", "completed");
    const short = await desk.read(ready, "short");
    expect(short).toMatchObject({ jobId: ready, lang: "ko", sources: [{ title: source.title, url: source.url, lastCheckedAt: "" }] });
    expect(short?.speech).toContain("둘째 문장이에요.");
    expect(short?.speech).not.toContain("셋째");
    expect((await desk.read(ready, "detailed"))?.speech).toContain("넷째 문장이에요.");
    expect(await desk.read(empty, "normal")).toBeUndefined();
    expect(await desk.read(randomUUID(), "normal")).toBeUndefined();
  });

  it("개인 기기가 아니면 책상을 주지 않고, 개인 기기면 세션에 책상을 붙인다", async () => {
    const shared = setup({ pilotProfile: "shared" });
    const deps: { research?: ResearchDesk } = {};
    shared.flows.bind({ ...shared.session, deps });
    expect(deps.research).toBeUndefined();
    const personal = setup();
    personal.flows.bind({ ...personal.session, deps });
    expect(deps.research).toBeDefined();
    expect(await deps.research?.delegate(randomUUID(), "기초연금 신청 서류")).toBeDefined();
  });

  it("동의를 거두면 맡기기도 목록도 읽기도 거절한다", async () => {
    const { flows, session, desk } = setup();
    const id = await finished(await flows.store(), "기초연금 신청 서류", "completed", { text: "답" });
    session.consentStatus = "declined";
    expect(await desk.recent(10)).toEqual([]);
    expect(await desk.read(id, "normal")).toBeUndefined();
    expect(await desk.delegate(randomUUID(), "아동수당 신청 서류")).toBeUndefined();
    expect(await (await flows.store()).jobs()).toHaveLength(1);
  });

  it("저장소를 읽는 사이 세션 세대가 바뀌면 읽은 것을 내주지 않는다", async () => {
    const { flows, session, desk } = setup();
    const store = await flows.store();
    const id = await finished(store, "기초연금 신청 서류", "completed", { text: "답" });
    const summaries = store.summaries.bind(store), jobs = store.jobs.bind(store);
    vi.spyOn(store, "summaries").mockImplementationOnce(async limit => { const rows = await summaries(limit); session.generation++; return rows; });
    expect(await desk.recent(10)).toEqual([]);
    expect(await desk.recent(10)).toHaveLength(1);
    vi.spyOn(store, "jobs").mockImplementationOnce(async () => { const rows = await jobs(); session.generation++; return rows; });
    expect(await desk.read(id, "normal")).toBeUndefined();
    expect(await desk.read(id, "normal")).toBeDefined();
  });

  it("맡기는 중에 세션 세대가 바뀌면 저장소에 쓰지 않는다", async () => {
    const { flows, session, desk } = setup();
    const store = await flows.store();
    const open = flows.store.bind(flows);
    vi.spyOn(flows, "store").mockImplementationOnce(async () => { session.generation++; return await open(); });
    expect(await desk.delegate(randomUUID(), "기초연금 신청 서류")).toBeUndefined();
    expect(await store.jobs()).toEqual([]);
  });
});
