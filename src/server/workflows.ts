// Consented, personal-device features that outlive the foreground conversation.
import { isIPv6 } from "node:net";
import { dirname, join } from "node:path";
import type { Context, Hono } from "hono";
import { raceAbort } from "../core/abort.ts";
import { strip } from "../core/text.ts";
import { REDACTED, detectSensitive, redactPictureText, type SecretSpan } from "../safety/privacy.ts";
import { withDeadline } from "../voice/live.ts";
import { AsyncLock } from "./recovery.ts";
import { LEASE_SECONDS, WorkflowRejected, WorkflowStore, canonicalUuid, installationOwner, type ClaimedJob, type Note } from "./workflow_store.ts";

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

export interface ResearchSource { url?: string; title?: string | null }
export interface ResearchOutcome { text?: string | null; sources?: readonly ResearchSource[] }
export interface PublicOutcome { text: string; sources: Array<{ title: string; url: string }> }
const take = (text: string, count: number) => Array.from(text).slice(0, count).join("");

export async function publicResult(state: string, result: ResearchOutcome, scan?: Scan): Promise<[string, PublicOutcome | undefined]> {
  const sources: Array<{ title: string; url: string }> = [];
  for (const item of (result.sources ?? []).slice(0, 8)) {
    const url = item.url ?? "";
    let parts: ReturnType<typeof splitUrl>;
    try {
      parts = splitUrl(url);
    } catch {
      continue;
    }
    if (parts.scheme !== "https" || parts.hostname === undefined || isTruthy(parts.username) || isTruthy(parts.password)) continue;
    // Keep checked public reference URLs only. No browser state, screenshots, or raw turn records.
    const title = isTruthy(item.title) ? item.title ?? "" : parts.hostname;
    sources.push({ title: take(redactPictureText(title, await spansOf(scan, title)), 180), url: take(url, 2048) });
  }
  const raw = result.text ?? "";
  const text = take(redactPictureText(raw, await spansOf(scan, raw)), 2400);
  if ((state === "completed" || state === "partial") && (sources.length === 0 || text === "")) return ["incomplete", undefined];
  if (state !== "completed" && state !== "partial" && state !== "needs_input") return ["incomplete", undefined];
  return [state, { text, sources }];
}
function isTruthy(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== "";
}

export interface ResearchSession {
  researchPublic(prompt: string, language: string): Promise<readonly [string, ResearchOutcome]>;
  cancel(): void;
  close(): Promise<void>;
}
export interface WorkspaceSession {
  readonly consentStatus: string;
  readonly lang: string;
  readonly generation: number;
  readonly deps?: {
    recallNotes?: ((query: string) => Promise<string[]>) | undefined;
    delegateResearch?: ((requestId: string, query: string) => Promise<boolean>) | undefined;
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

export class Workflows {
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

  async #research(job: ClaimedJob, signal: AbortSignal): Promise<[string, PublicOutcome | undefined]> {
    const session = await this.runtime.createSession({ background: true });
    try {
      const [state, result] = await raceAbort(() => session.researchPublic(job.prompt, job.language), signal);
      return await publicResult(state, result, this.runtime.scan);
    } finally {
      session.cancel();
      await session.close();
    }
  }

  async #loop(): Promise<void> {
    while (this.personal && !this.#stopping) {
      this.#woken = false;
      const woken = new Promise<void>(resolve => { this.#wake = resolve; });
      try {
        const store = await this.store();
        const job = this.#stopping ? undefined : await store.claim();
        if (this.#stopping) return;
        if (job !== undefined) {
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
    this.#jobId = job.id;
    const controller = new AbortController();
    this.#active = controller;
    let settled = false;
    const research = this.#research(job, controller.signal);
    const done = research.then(() => { settled = true; }, () => { settled = true; });
    const deadline = Date.now() + (LEASE_SECONDS - 15) * 1000;
    let outcome: [string, PublicOutcome | undefined];
    try {
      while (!settled) {
        const left = deadline - Date.now();
        if (left <= 0) {
          controller.abort("timeout");
          break;
        }
        await Promise.race([done, pause(Math.min(3000, left))]);
        if (!settled && Date.now() < deadline && !await store.ownsClaim(job)) controller.abort("cancelled");
      }
      outcome = await research;
    } catch {
      const reason: unknown = controller.signal.aborted ? controller.signal.reason : undefined;
      // Shutdown releases the claim. An explicit cancellation has already revoked its lease in SQL.
      if (reason === "shutdown") {
        await store.retry(job, { shutdown: true });
      } else if (reason !== "cancelled") {
        await store.retry(job);
      }
      return;
    } finally {
      if (!settled) {
        controller.abort("cancelled");
        await done;
      }
      this.#jobId = undefined;
      this.#active = undefined;
    }
    const [state, result] = outcome;
    await store.finish(job, state, result);
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
