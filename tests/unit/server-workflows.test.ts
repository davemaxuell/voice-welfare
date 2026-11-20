import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
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
async function database(dsn: string) {
  const dir = folder();
  const path = join(dir, "queue.db");
  const owner = installationOwner(join(dir, "profile"));
  expect(installationOwner(join(dir, "profile"))).toBe(owner);
  return [await WorkflowStore.open(path, owner, dsn), await WorkflowStore.open(path, randomUUID(), dsn)] as const;
}

describe.each(databases)("%s", (kind, dsn) => {
  const options = { skip: kind === "postgres" && dsn === "" };
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

describe("research worker", () => {
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
    const deps: { recallNotes?: (query: string) => Promise<string[]>; delegateResearch?: (id: string, query: string) => Promise<boolean> } = {};
    shared.bind({ ...session, deps });
    expect(deps.delegateResearch).toBeUndefined();
    expect(await deps.recallNotes?.("질문")).toEqual([]);
  });
});
