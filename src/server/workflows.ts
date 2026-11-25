// Consented, personal-device features that outlive the foreground conversation.
import { isIPv6 } from "node:net";
import { dirname, join } from "node:path";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { raceAbort } from "../core/abort.ts";
import { InMemoryEventLog } from "../core/events.ts";
import { DATA_DATE, SourceData, StoredResearch, researchSummary, type ResearchCheckpoint, type ResearchOutcome, type ResearchPlan, type ResearchProgress, type ResearchStop } from "../core/research.ts";
import { RESEARCH_UNDELIVERED } from "../core/research_copy.ts";
import { strip } from "../core/text.ts";
import { draft, LangSchema, type Draft, type Lang } from "../core/turn.ts";
import { REDACTED, detectSensitive, redactPictureText, type SecretSpan } from "../safety/privacy.ts";
import { withDeadline } from "../voice/live.ts";
import { AsyncLock } from "./recovery.ts";
import { LEASE_SECONDS, MAX_ATTEMPTS, WorkflowRejected, WorkflowStore, canonicalUuid, installationOwner, type ClaimedJob, type Note } from "./workflow_store.ts";

/** PiiScanner.scan: 글마다 모델이 찾은 비밀 구간. 모델이 없으면 규칙만 쓴다. */
export type Scan = (texts: readonly string[]) => Promise<(readonly SecretSpan[])[]>;
async function spansOf(scan: Scan | undefined, text: string): Promise<readonly SecretSpan[]> {
  return scan === undefined ? [] : (await scan([text]))[0] ?? [];
}

// Stdlib re: \b and \s are Unicode, \s also takes \x1c-\x1f, and [a-zA-Z] with IGNORECASE also takes İ and ı.
const LINK_OR_KEY = /(?<![\p{L}\p{N}_])sk-[a-zA-Zİı0-9_-]{12,}|https?:\/\/[^\p{White_Space}\x1c-\x1f/]+@|https?:\/\/[^\p{White_Space}\x1c-\x1f]+\?/iu;

export function safeInput(value: unknown, maximum: number, modelSpans: readonly SecretSpan[] = []): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = strip(value);
  const length = Array.from(text).length;
  if (length < 1 || length > maximum || text.includes(REDACTED) || detectSensitive(text, modelSpans).hasSecretValue
    || LINK_OR_KEY.test(text) || redactPictureText(text, modelSpans) !== text) {
    return undefined;
  }
  return text;
}

/** str.partition */
function partition(text: string, separator: string): [string, boolean, string] {
  const index = text.indexOf(separator);
  return index < 0 ? [text, false, ""] : [text.slice(0, index), true, text.slice(index + separator.length)];
}

/** urllib.parse.urlsplit의 scheme·netloc·hostname·port 글·username·password. Python이 ValueError를 내는 주소에서는 RangeError를 던진다. */
export function splitUrl(raw: string) {
  const url = raw.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url);
  const rest = scheme === null ? url : url.slice(scheme[0].length);
  const netloc = rest.startsWith("//") ? /^[^/?#]*/.exec(rest.slice(2))?.[0] ?? "" : "";
  if (netloc.includes("[") !== netloc.includes("]")) throw new RangeError("Invalid IPv6 URL");
  if (/[^\x00-\x7f]/.test(netloc)) {
    const plain = netloc.replace(/[@:#?]/g, "");
    const normalized = plain.normalize("NFKC");
    if (plain !== normalized && /[/?#@:]/.test(normalized)) throw new RangeError("netloc contains invalid characters under NFKC normalization");
  }
  const at = netloc.lastIndexOf("@");
  const userinfo = at < 0 ? undefined : netloc.slice(0, at);
  const hostport = netloc.slice(at + 1);
  const [, open, inside] = partition(hostport, "[");
  let host: string, port: string;
  if (open) {
    const [name, , after] = partition(inside, "]");
    if (!(isIPv6(name) || /^v[a-fA-F0-9]+\..+$/.test(name))) throw new RangeError("Invalid IPv6 URL");
    host = name;
    port = partition(after, ":")[2];
  } else {
    [host, , port] = partition(hostport, ":");
  }
  // hostname lowers the address but keeps the IPv6 zone after % as written.
  const [address, zoned, zone] = partition(host, "%");
  const colon = userinfo?.indexOf(":") ?? -1;
  return {
    scheme: (scheme?.[1] ?? "").toLowerCase(),
    netloc,
    hostname: host === "" ? undefined : address.toLowerCase() + (zoned ? "%" + zone : ""),
    port: port === "" ? undefined : port,
    username: userinfo === undefined ? undefined : colon < 0 ? userinfo : userinfo.slice(0, colon),
    password: userinfo === undefined || colon < 0 ? undefined : userinfo.slice(colon + 1),
  };
}

/** SplitResult.port: an ASCII decimal in 0..65535, or a RangeError where Python raises ValueError. */
export function urlPort(port: string | undefined): number | undefined {
  if (port === undefined) return undefined;
  if (!/^[0-9]+$/.test(port)) throw new RangeError("Port could not be cast to integer value as " + JSON.stringify(port));
  const value = Number(port);
  if (value > 65535) throw new RangeError("Port out of range 0-65535");
  return value;
}

export type { ResearchOutcome } from "../core/research.ts";
type SavedSource = { title: string; url: string; lastCheckedAt?: string; version?: string; data?: SourceData };
type PublicOutcome = ResearchOutcome<SavedSource> & { text: string; sources: SavedSource[] };
const take = (text: string, count: number) => Array.from(text).slice(0, count).join("");

async function safeData(value: SourceData | undefined, scan: Scan | undefined): Promise<SourceData | undefined> {
  if (value === undefined) return undefined;
  const kind = SourceData.shape.kind.safeParse(value.kind);
  const origin = safeInput(value.origin, 100, await spansOf(scan, value.origin));
  if (!kind.success || origin === undefined) return undefined;
  const date = value.date !== undefined && DATA_DATE.test(value.date) ? value.date : undefined;
  return { kind: kind.data, origin, ...(date === undefined ? {} : { date }) };
}

export async function publicResult(state: string, result: ResearchOutcome, scan?: Scan): Promise<[string, PublicOutcome | undefined]> {
  const sources: PublicOutcome["sources"] = [];
  const urls = new Map<string, string>();
  for (const item of (result.sources ?? []).slice(0, result.proof === undefined ? 8 : 32)) {
    const url = item.url ?? "";
    let parts: ReturnType<typeof splitUrl>;
    try {
      parts = splitUrl(url);
    } catch {
      continue;
    }
    const parsed = URL.parse(url);
    if (parts.scheme !== "https" || parsed === null || parts.hostname === undefined || parsed.port !== ""
        || isTruthy(parts.username) || isTruthy(parts.password)) continue;
    if ([...parsed.searchParams].some(([name, value]) => /token|session|password|secret|auth|credential|email|user|key/i.test(name)
        || detectSensitive(value).hasSecretValue)) continue;
    parsed.hash = "";
    // Keep checked public reference URLs only. No browser state, screenshots, or raw turn records.
    const title = isTruthy(item.title) ? item.title ?? "" : parts.hostname;
    const lastCheckedAt = item.lastCheckedAt?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
    const version = item.version === undefined ? undefined : safeInput(item.version, 100, await spansOf(scan, item.version));
    const safeUrl = take(url.split("#")[0] ?? "", 2048);
    const data = await safeData(item.data, scan);
    sources.push({ title: take(redactPictureText(title, await spansOf(scan, title)), 180), url: safeUrl,
      ...(lastCheckedAt === undefined ? {} : { lastCheckedAt }), ...(version === undefined ? {} : { version }),
      ...(data === undefined ? {} : { data }) });
    urls.set(url, safeUrl);
  }
  const raw = result.text ?? "";
  const text = take(redactPictureText(raw, await spansOf(scan, raw)), 2400);
  if ((state === "completed" || state === "partial") && (sources.length === 0 || text === "")) return ["incomplete", undefined];
  const missing: string[] = [];
  for (const part of (result.missing ?? []).slice(0, 32)) {
    const checked = safeInput(part, 600, await spansOf(scan, part));
    if (checked !== undefined) missing.push(checked);
  }
  const proof = [];
  for (const item of (result.proof ?? []).slice(0, 32)) {
    const url = urls.get(item.url);
    const quote = safeInput(item.quote, 1400, await spansOf(scan, item.quote));
    if (url !== undefined && quote !== undefined) proof.push({ quote, url });
  }
  if (state === "incomplete" && missing.length > 0) return [state, { text: "", sources: [], missing, reason: result.reason }];
  if (state !== "completed" && state !== "partial" && state !== "needs_input") return ["incomplete", undefined];
  return [state, { text, sources, ...(missing.length === 0 ? {} : { missing }), ...(proof.length === 0 ? {} : { proof }),
    ...(result.reason === undefined ? {} : { reason: result.reason }) }];
}
function isTruthy(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== "";
}

export interface ResearchSession {
  researchPublic(prompt: string, language: string, progress?: ResearchProgress): Promise<readonly [string, ResearchOutcome]>;
  cancel(): void;
  close(): Promise<void>;
}
export interface WorkspaceSession {
  speakable?(text: string): boolean;
  readonly consentStatus: string;
  readonly lang: string;
  readonly generation: number;
  readonly deps?: {
    recallNotes?: ((query: string) => Promise<string[]>) | undefined;
    delegateResearch?: ((requestId: string, query: string) => Promise<boolean>) | undefined;
    readResearch?: ((language: Lang) => Promise<Draft | undefined>) | undefined;
  } | undefined;
}
export interface WorkflowRuntime {
  readonly settings?: { readonly path: string; readonly completed: boolean; readonly preferences: { readonly deviceUse: string } } | undefined;
  readonly config: { readonly pilotProfile?: string | undefined };
  createSession(options: { background: boolean }): Promise<ResearchSession>;
  readonly embedding?: { readonly model: string; embed(text: string): Promise<unknown> } | undefined;
  readonly moderation?: { screen(text: string): Promise<unknown> } | undefined;
  readonly scan?: Scan | undefined;
}

// asyncio의 기다림처럼 이 타이머만으로 프로세스를 붙잡지 않는다.
const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, Math.max(0, ms)).unref(); });
const RESEARCH_TIME_LIMIT_MS = 5 * 60_000;
const RESEARCH_TOTAL_MS = 3 * RESEARCH_TIME_LIMIT_MS;
const MAX_CONTINUATIONS = 2;
const RENEW_EVERY_MS = LEASE_SECONDS * 1000 / 2;
const RESEARCH_SPEECH = {
  ko: { none: "아직 확인할 조사 결과가 없어요.", sources: "출처", checked: "확인일", undated: "날짜 기록 없음", missing: "확인이 남은 항목" },
  en: { none: "There are no saved research results ready yet.", sources: "Sources", checked: "Checked", undated: "Date unavailable", missing: "Still to verify" },
  zh: { none: "目前还没有可查看的调查结果。", sources: "来源", checked: "核实日期", undated: "日期未知", missing: "待核实项目" },
  ja: { none: "確認できる調査結果はまだありません。", sources: "出典", checked: "確認日", undated: "日付不明", missing: "確認が残っている項目" },
};

export class Workflows {
  readonly events = new InMemoryEventLog();
  readonly runtime: WorkflowRuntime;
  readonly dsn: string;
  #store: WorkflowStore | undefined;
  readonly #opening = new AsyncLock();
  #worker: Promise<void> | undefined;
  #stopping = false;
  #wake: () => void = () => {};
  #woken = false;
  #active: AbortController | undefined;
  #jobId: string | undefined;

  constructor(runtime: WorkflowRuntime, dsn = "") {
    this.runtime = runtime;
    this.dsn = dsn;
  }

  get personal(): boolean {
    const settings = this.runtime.settings;
    return settings !== undefined && settings.completed && settings.preferences.deviceUse === "personal"
      && this.runtime.config.pilotProfile !== "shared";
  }

  async store(): Promise<WorkflowStore> {
    return await this.#opening.run(async () => {
      if (this.#store === undefined) {
        const settings = this.runtime.settings;
        if (settings === undefined) throw new TypeError("settings are not available");
        const directory = dirname(settings.path);
        this.#store = await WorkflowStore.open(join(directory, "workflows.sqlite3"), installationOwner(directory), this.dsn);
      }
      return this.#store;
    });
  }

  /** safeInput, with the PII model spans when the runtime has a scanner. */
  async safeText(value: unknown, maximum: number): Promise<string | undefined> {
    if (typeof value !== "string") return undefined;
    return safeInput(value, maximum, await spansOf(this.runtime.scan, strip(value)));
  }

  async reconfigure(): Promise<void> {
    if (this.personal) {
      this.#worker ??= this.#loop().finally(() => { this.#worker = undefined; });
      this.#signal();
    } else {
      await this.close();
    }
  }

  async close(): Promise<void> {
    const worker = this.#worker;
    if (worker === undefined) return;
    this.#stopping = true;
    this.#active?.abort("shutdown");
    this.#signal();
    try {
      await worker;
    } finally {
      this.#stopping = false;
    }
  }

  #signal(): void {
    this.#woken = true;
    this.#wake();
  }

  async #research(job: ClaimedJob, progress: ResearchProgress): Promise<[string, PublicOutcome | undefined]> {
    const signal = progress.signal;
    const session = await this.runtime.createSession({ background: true });
    try {
      return await raceAbort(async () => {
        const [state, result] = await session.researchPublic(job.prompt, job.language, progress);
        signal.throwIfAborted();
        return await publicResult(state, result, this.runtime.scan);
      }, signal);
    } finally {
      session.cancel();
      await session.close();
    }
  }

  async #safePlan(plan: ResearchPlan, previous?: ResearchPlan): Promise<ResearchPlan> {
    const fields = [plan.goal, plan.subject, plan.agency ?? "", ...plan.steps.flatMap(step => [step.requirement, step.clarification ?? ""])];
    const scans = await this.runtime.scan?.(fields);
    if (fields.some((value, i) => value !== "" && safeInput(value, 600, scans?.[i]) === undefined)) throw new WorkflowRejected("input");
    const steps = await Promise.all(plan.steps.map(async (step, i) => {
      if (step === previous?.steps[i]) return step;
      if (step.outcome?.status === "verified") {
        const [state, finding] = await publicResult("completed", step.outcome.finding, this.runtime.scan);
        if (state !== "completed" || finding?.proof === undefined || finding.proof.length !== step.outcome.finding.proof.length) {
          return { ...step, outcome: { status: "unavailable" } as const };
        }
        const supported = new Set(finding.proof.map(proof => proof.url));
        const verified: ResearchPlan["steps"][number] = { ...step, outcome: { status: "verified", finding: {
          text: finding.text, sources: finding.sources.filter(source => supported.has(source.url)), proof: [...finding.proof],
        } } };
        return verified;
      }
      if (step.outcome?.status !== "waiting") return step;
      const question = await this.safeText(step.outcome.question, 600);
      return { ...step, outcome: question === undefined ? { status: "unavailable" } as const : { status: "waiting", question } as const };
    }));
    return { ...plan, steps };
  }

  async #loop(): Promise<void> {
    while (this.personal && !this.#stopping) {
      this.#woken = false;
      const woken = new Promise<void>(resolve => { this.#wake = resolve; });
      try {
        const store = await this.store();
        const job = this.#stopping ? undefined : await store.claim();
        if (job !== undefined) {
          if (this.#stopping || !this.personal) {
            await store.retry(job, { shutdown: true });
            return;
          }
          await this.#run(store, job);
          continue;
        }
      } catch {
        // Research worker unavailable. Try again on the next wake.
      }
      if (this.#stopping) return;
      if (!this.#woken) await Promise.race([woken, pause(8000)]);
    }
  }

  async #run(store: WorkflowStore, job: ClaimedJob): Promise<void> {
    const saved = await store.progress(job);
    if (this.#stopping || !this.personal) {
      await store.retry(job, { shutdown: true });
      return;
    }
    let checkpoint = saved?.checkpoint;
    let revision = saved?.revision ?? 0;
    const from = Date.now();
    const activeMs = () => (saved?.checkpoint.activeMs ?? 0) + Math.max(0, Date.now() - from);
    const record = (reason: ResearchStop) => {
      this.events.record({ sessionId: "", turnId: job.id, actionType: "research-attempt",
        success: reason === "verified", errorCode: reason, latencyMs: Math.max(0, Date.now() - from),
        at: new Date().toISOString(), attempts: job.attempts });
    };
    if (checkpoint !== undefined && activeMs() >= RESEARCH_TOTAL_MS) {
      const [state, result] = researchSummary(checkpoint.plan, true);
      await store.finish(job, state, result);
      record("budget");
      return;
    }
    const saving = new AsyncLock();
    this.#jobId = job.id;
    const controller = new AbortController();
    this.#active = controller;
    let settled = false;
    // A stalled browser startup or cleanup must also release the worker at its deadline.
    const progress: ResearchProgress = {
      get checkpoint() { return checkpoint; },
      signal: controller.signal,
      save: async plan => {
        const safe = await this.#safePlan(plan, checkpoint?.plan);
        return await saving.run(async () => {
          controller.signal.throwIfAborted();
          const updated: ResearchCheckpoint = { ...checkpoint, version: 1, activeMs: activeMs(), continuations: checkpoint?.continuations ?? 0, plan: safe };
          if (!await store.saveProgress(job, revision, updated)) {
            controller.abort("lease_lost");
            controller.signal.throwIfAborted();
          }
          revision += 1;
          checkpoint = updated;
          return safe;
        });
      },
    };
    const research = raceAbort(() => this.#research(job, progress), controller.signal);
    const done = research.then(() => { settled = true; }, () => { settled = true; });
    const timeout = setTimeout(() => controller.abort("timeout"),
      Math.min(RESEARCH_TIME_LIMIT_MS, Math.max(0, RESEARCH_TOTAL_MS - activeMs()))).unref();
    let renewAt = Date.now() + RENEW_EVERY_MS;
    let outcome: [string, PublicOutcome | undefined];
    try {
      while (!settled && !controller.signal.aborted) {
        await Promise.race([done, pause(3000)]);
        if (settled || controller.signal.aborted) break;
        if (Date.now() >= renewAt) {
          if (!await store.renewClaim(job)) controller.abort("lease_lost");
          renewAt = Date.now() + RENEW_EVERY_MS;
        } else if (!await store.ownsClaim(job)) {
          controller.abort("lease_lost");
        }
      }
      outcome = await research;
      controller.signal.throwIfAborted();
    } catch (error) {
      await saving.run(async () => {});
      const reason: unknown = controller.signal.aborted ? controller.signal.reason : undefined;
      // Shutdown releases the claim. An explicit cancellation has already revoked its lease in SQL.
      if (reason === "shutdown") {
        if (checkpoint !== undefined) await store.saveProgress(job, revision, { ...checkpoint, activeMs: activeMs() });
        await store.retry(job, { shutdown: true });
        record("interrupted");
      } else if (reason === "timeout") {
        if (checkpoint === undefined) await store.finish(job, "incomplete");
        else if (checkpoint.continuations < MAX_CONTINUATIONS && activeMs() < RESEARCH_TOTAL_MS &&
            checkpoint.plan.steps.some(step => step.outcome === undefined)) {
          await store.saveProgress(job, revision, { ...checkpoint, continuations: checkpoint.continuations + 1, activeMs: activeMs() }, { yieldJob: true });
        } else {
          const [state, result] = researchSummary(checkpoint.plan, true);
          await store.finish(job, state, result);
        }
        record("budget");
      } else if (error instanceof WorkflowRejected) {
        await store.finish(job, "incomplete");
        record("policy");
      } else if (reason !== "cancelled" && reason !== "lease_lost") {
        if (checkpoint !== undefined && job.attempts >= MAX_ATTEMPTS) {
          const [state, result] = researchSummary(checkpoint.plan);
          await store.finish(job, state, result);
        } else {
          if (checkpoint !== undefined) await store.saveProgress(job, revision, { ...checkpoint, activeMs: activeMs() });
          await store.retry(job);
        }
        record("source_unavailable");
      } else {
        record(reason);
      }
      return;
    } finally {
      clearTimeout(timeout);
      if (!settled) {
        controller.abort("cancelled");
        await done;
      }
      this.#jobId = undefined;
      this.#active = undefined;
    }
    const [state, result] = outcome;
    const published = await store.finish(job, state, result);
    record(published ? result?.reason ?? (state === "completed" ? "verified" : state === "needs_input" ? "needs_input" : "no_progress") : "lease_lost");
  }

  async cancel(store: WorkflowStore, jobId: string): Promise<boolean> {
    const changed = await store.cancel(jobId);
    if (changed && this.#jobId === jobId) this.#active?.abort("cancelled");
    return changed;
  }

  async embedded(text: string): Promise<[unknown, string | undefined]> {
    const provider = this.runtime.embedding;
    if (provider !== undefined) {
      try {
        const vector = await withDeadline(4000, provider.embed(text));
        return [vector, provider.model];
      } catch {
        // Notes still work by keyword without an embedding.
      }
    }
    return [undefined, undefined];
  }

  async enqueue(session: WorkspaceSession, requestId: string, query: string, current: () => boolean = () => true): Promise<string> {
    if (!this.personal || session.consentStatus !== "granted" || await this.safeText(query, 600) === undefined) throw new WorkflowRejected("input");
    const screen = this.runtime.moderation;
    if (screen !== undefined) {
      let flagged: unknown;
      try {
        flagged = await withDeadline(4000, screen.screen(query));
      } catch {
        flagged = undefined;
      }
      if (flagged !== undefined && flagged !== null && flagged !== false) throw new WorkflowRejected("input");
    }
    const store = await this.store();
    if (!this.personal || session.consentStatus !== "granted" || !current()) throw new WorkflowRejected("input");
    const jobId = await store.enqueue(requestId, query, session.lang);
    await this.reconfigure();
    return jobId;
  }

  async recall(session: WorkspaceSession, query: string): Promise<Note[]> {
    if (!this.personal || session.consentStatus !== "granted" || await this.safeText(query, 600) === undefined) return [];
    try {
      const store = await this.store();
      if (!await store.hasNotes()) return [];
      const [vector, model] = await this.embedded(query);
      if (!this.personal || session.consentStatus !== "granted") return [];
      const matches = await store.search(query, vector, model);
      return this.personal && session.consentStatus === "granted" ? matches : [];
    } catch {
      // Unavailable optional memory must not prevent a foreground public-service lookup.
      return [];
    }
  }

  bind(session: WorkspaceSession): void {
    const deps = session.deps;
    if (deps === undefined) return;
    deps.recallNotes = async query => (await this.recall(session, query)).map(note => note.body);
    const delegate = async (requestId: string, query: string) => {
      try {
        const generation = session.generation;
        return (await this.enqueue(session, requestId, query, () => session.generation === generation)) !== "";
      } catch {
        return false;
      }
    };
    deps.delegateResearch = this.personal ? delegate : undefined;
    deps.readResearch = async lang => {
      const permitted = () => this.personal && session.consentStatus === "granted";
      if (!permitted()) return undefined;
      const generation = session.generation;
      const copy = RESEARCH_SPEECH[lang];
      const jobs = await (await this.store()).jobs();
      if (!permitted() || generation !== session.generation) return undefined;
      for (const job of jobs) {
        if (!["completed", "partial", "needs_input", "incomplete"].includes(job.state)) continue;
        const saved = StoredResearch.safeParse(job.result);
        if (!saved.success) continue;
        const { text, sources, missing } = saved.data;
        if ((text ?? "").length === 0 && missing.length === 0) continue;
        const citations = sources.map(source => ({ ...source, lastCheckedAt: source.lastCheckedAt ?? "" }));
        return draft("IDLE", "web-answer", [
          job.prompt, text,
          ...(sources.length === 0 ? [] : [copy.sources, ...sources.map(source =>
            `${source.title} · ${copy.checked} ${source.lastCheckedAt ?? copy.undated}`)]),
          ...(missing.length === 0 ? [] : [copy.missing, ...missing]),
        ].filter(Boolean).join(". "), { lang, sources: citations });
      }
      return draft("IDLE", "web-answer", copy.none, { lang });
    };
  }
}

type Access<S> = (sid: string, c: Context) => S | Response;
type Body = (c: Context) => Promise<Record<string, unknown> | undefined>;

export function registerWorkflows<S extends WorkspaceSession>(app: Hono, service: Workflows, access: Access<S>, body: Body): void {
  const base = "/api/session/:sid/workspace";
  const reject = (code: string, status = 400) => Response.json({ error: code }, { status });
  const sidOf = (c: Context) => c.req.param("sid") ?? "";
  const authorize = (sid: string, c: Context): S | Response => {
    const session = access(sid, c);
    if (session instanceof Response) return session;
    if (!service.personal || session.consentStatus !== "granted") return reject("WORKSPACE_PERSONAL_REQUIRED", 403);
    return session;
  };

  app.get(base, async c => {
    const session = authorize(sidOf(c), c);
    if (session instanceof Response) return session;
    const store = await service.store();
    const [jobs, notes] = await Promise.all([store.jobs(), store.notes()]);
    return c.json({ jobs, notes });
  });

  app.get(base + "/deliveries", async c => {
    const session = authorize(sidOf(c), c);
    if (session instanceof Response) return session;
    const store = await service.store();
    const rows = await store.pendingDeliveries();
    const pending = rows.map(job => {
      const result = StoredResearch.safeParse(job.result);
      if (result.success && [result.data.text ?? "", ...result.data.missing].some(value => session.speakable?.(value) === false)) {
        const lang = LangSchema.safeParse(job.language).data ?? "ko";
        return {...job, result: {text: RESEARCH_UNDELIVERED[lang]}};
      }
      return job;
    });
    return c.json({pending});
  });
  app.delete(base + "/research/:jobId/delivery/:token", async c => {
    const session = authorize(sidOf(c), c);
    if (session instanceof Response) return session;
    await (await service.store()).heard(c.req.param("jobId") ?? "", c.req.param("token") ?? "");
    return c.json({heard: true});
  });

  app.post(base + "/research", async c => {
    const sid = sidOf(c);
    const session = authorize(sid, c);
    if (session instanceof Response) return session;
    const payload = await body(c) ?? {};
    const query = await service.safeText(payload.text, 600);
    if (query === undefined || payload.consent !== true) return reject("PUBLIC_TEXT_REQUIRED");
    let requestId: string;
    try {
      requestId = canonicalUuid(typeof payload.requestId === "string" ? payload.requestId : String(payload.requestId ?? "None"));
    } catch {
      return reject("REQUEST_ID_REQUIRED");
    }
    try {
      const jobId = await service.enqueue(session, requestId, query, () => authorize(sid, c) === session);
      return c.json({ id: jobId });
    } catch (error) {
      if (!(error instanceof WorkflowRejected)) throw error;
      if (error.reason === "input") return reject("PUBLIC_TEXT_REQUIRED");
      return reject(error.reason === "limit" ? "WORKSPACE_LIMIT" : "REQUEST_CONFLICT", 409);
    }
  });

  app.delete(base + "/research/:jobId/claim", async c => {
    const session = authorize(sidOf(c), c);
    if (session instanceof Response) return session;
    return c.json({ cancelled: await service.cancel(await service.store(), c.req.param("jobId") ?? "") });
  });

  app.post(base + "/research/:jobId/answer", async c => {
    const sid = sidOf(c);
    const session = authorize(sid, c);
    if (session instanceof Response) return session;
    const generation = session.generation;
    const payload = await body(c);
    const version = z.number().int().positive().safeParse(payload?.questionRevision);
    if (!version.success) return reject("REQUEST_CONFLICT", 409);
    const answer = await service.safeText(payload?.text, 600);
    if (answer === undefined || payload?.consent !== true) return reject("PUBLIC_TEXT_REQUIRED");
    if (authorize(sid, c) !== session || session.generation !== generation) return reject("PUBLIC_TEXT_REQUIRED");
    const store = await service.store();
    if (!await store.answer(c.req.param("jobId") ?? "", version.data, answer)) return reject("REQUEST_CONFLICT", 409);
    await service.reconfigure();
    return c.json({ queued: true });
  });

  app.delete(base + "/research/:jobId", async c => {
    const session = authorize(sidOf(c), c);
    if (session instanceof Response) return session;
    const store = await service.store();
    return c.json({ deleted: await store.deleteJob(c.req.param("jobId") ?? "") });
  });

  app.post(base + "/notes", async c => {
    const sid = sidOf(c);
    const session = authorize(sid, c);
    if (session instanceof Response) return session;
    const payload = await body(c) ?? {};
    const text = await service.safeText(payload.text, 300);
    if (text === undefined || payload.consent !== true) return reject("PUBLIC_TEXT_REQUIRED");
    const [vector, model] = await service.embedded(text);
    const check = authorize(sid, c);
    if (check instanceof Response) return check;
    const store = await service.store();
    try {
      return c.json({ id: await store.note(text, vector, model) });
    } catch (error) {
      if (error instanceof WorkflowRejected) return reject("WORKSPACE_LIMIT", 409);
      throw error;
    }
  });

  app.post(base + "/notes/search", async c => {
    const session = authorize(sidOf(c), c);
    if (session instanceof Response) return session;
    const query = await service.safeText((await body(c) ?? {}).text, 600);
    if (query === undefined) return reject("PUBLIC_TEXT_REQUIRED");
    return c.json({ notes: await service.recall(session, query) });
  });

  app.delete(base + "/notes/:noteId", async c => {
    const session = authorize(sidOf(c), c);
    if (session instanceof Response) return session;
    const store = await service.store();
    return c.json({ deleted: await store.deleteNote(c.req.param("noteId") ?? "") });
  });
}
