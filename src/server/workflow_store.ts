// Owner-scoped research queue and explicit notes, shared by the desktop and server workers.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ResearchCheckpoint, StoredResearch, researchSummary } from "../core/research.ts";
import type { JobPhase } from "../core/research_desk.ts";
import { casefold, strip } from "../core/text.ts";
import { AsyncLock } from "./recovery.ts";

export const DIMENSIONS = 1536;
export const LEASE_SECONDS = 120;
export const MAX_ATTEMPTS = 3;

/** Python uuid.UUID(text) then str(): 32 hex digits in any of the accepted spellings, written in canonical form. */
export function canonicalUuid(text: string): string {
  const hex = text.replaceAll("urn:", "").replaceAll("uuid:", "").replace(/^[{}]+|[{}]+$/g, "").replaceAll("-", "");
  // int(hex, 16) also takes surrounding whitespace, a sign, a 0x prefix and single underscores.
  const digits = hex.length === 32 ? /^\+?(?:0[xX]_?)?([0-9a-fA-F]+(?:_[0-9a-fA-F]+)*)$/.exec(strip(hex))?.[1] : undefined;
  if (digits === undefined) throw new RangeError("badly formed hexadecimal UUID string");
  const value = BigInt("0x" + digits.replaceAll("_", "")).toString(16).padStart(32, "0");
  return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join("-");
}

/** An OS-profile-local random identifier also partitions a shared PostgreSQL database. */
export function installationOwner(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "workflow-owner");
  if (!existsSync(path)) {
    const temporary = join(directory, `.workflow-owner-${randomUUID()}`);
    try {
      const handle = openSync(temporary, "wx", 0o600);
      try { writeSync(handle, randomUUID()); } finally { closeSync(handle); }
      try {
        linkSync(temporary, path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  const raw = readFileSync(path);
  if (raw.some(byte => byte > 0x7f)) throw new TypeError("workflow-owner is not ASCII");
  return canonicalUuid(raw.toString("latin1"));
}

export function vectorJson(vector: unknown): string | undefined {
  if (!Array.isArray(vector) || vector.length !== DIMENSIONS
    || !vector.every(n => typeof n === "number" && Number.isFinite(n)) || !vector.some(n => n !== 0)) {
    return undefined;
  }
  return JSON.stringify(vector);
}

/** Python의 ValueError("conflict" | "limit" | "input"). */
export class WorkflowRejected extends Error {
  readonly reason: "conflict" | "limit" | "input";
  constructor(reason: "conflict" | "limit" | "input") { super(reason); this.reason = reason; }
}

export interface ClaimedJob { id: string; prompt: string; language: string; attempts: number; lease: string }
export interface JobRow { id: string; prompt: string; language: string; state: string; result: unknown; question?: string; questionRevision?: number; deliveryToken?: string }
export interface JobSummary { id: string; prompt: string; language: string; phase: JobPhase }
export interface Note { id: string; body: string }
export type JobState = "completed" | "partial" | "needs_input" | "incomplete";

type Arg = string | number | null;
type Row = Record<string, unknown>;
interface Sql {
  rows(statement: string, args?: readonly Arg[]): Promise<Row[]>;
  run(statement: string, args?: readonly Arg[]): Promise<number>;
}

const count = z.object({ n: z.union([z.number(), z.bigint(), z.string()]).transform(Number) });
const claimRow = z.object({ id: z.string(), prompt: z.string(), language: z.string(), attempts: z.number() });
const jobRow = z.object({ id: z.string(), prompt: z.string(), language: z.string(), state: z.string(), result: z.string().nullable(),
  checkpoint: z.string().nullable(), revision: z.number().nullable() });
const deliveryRow = jobRow.extend({token: z.string()});
const listedRow = jobRow.extend({token: z.string().nullable()});

function readJob({checkpoint, revision, ...row}: z.infer<typeof jobRow>): JobRow {
  const saved = checkpoint === null ? undefined : ResearchCheckpoint.parse(JSON.parse(checkpoint));
  const fallback = row.state === "failed" && saved !== undefined ? researchSummary(saved.plan)[1] : null;
  const result: unknown = row.result !== null && row.result !== "" ? JSON.parse(row.result) : fallback;
  const waiting = saved?.plan.steps.find(step => step.outcome?.status === "waiting");
  const questionRevision = row.state === "needs_input" && waiting !== undefined && waiting.attempts < 2 ? revision ?? undefined : undefined;
  const question = row.state === "needs_input" && waiting?.outcome?.status === "waiting" ? waiting.outcome.question : undefined;
  return { ...row, result, ...(question === undefined ? {} : { question }), ...(questionRevision === undefined ? {} : { questionRevision }) };
}
const IN_PROGRESS = new Set(["queued", "running"]);

export function hasReading(job: Pick<JobRow, "state" | "result">): boolean {
  const saved = IN_PROGRESS.has(job.state) ? undefined : StoredResearch.safeParse(job.result).data;
  return saved !== undefined && ((saved.text ?? "").length > 0 || saved.missing.length > 0);
}

function phaseOf(job: JobRow): JobPhase {
  switch (job.state) {
    case "queued": case "running": return { kind: "working" };
    case "needs_input": return { kind: "asking", revision: job.questionRevision };
    default: return hasReading(job) ? { kind: "ready" } : { kind: "ended" };
  }
}
const noteRow = z.object({ id: z.string(), body: z.string() });
const noteVectorRow = noteRow.extend({ embedding: z.string().nullable(), model: z.string().nullable() });
const scoreRow = z.object({ id: z.string(), score: z.number() });

// node:sqlite is synchronous. Two transactions of this process must not interleave on one file, or the second
// BEGIN IMMEDIATE would block the thread that has to finish the first. Other processes wait on the busy timeout.
const fileLocks = new Map<string, AsyncLock>();
function fileLock(path: string): AsyncLock {
  let lock = fileLocks.get(path);
  if (lock === undefined) {
    lock = new AsyncLock();
    fileLocks.set(path, lock);
  }
  return lock;
}

/** psycopg placeholders as the Python store writes them, numbered for node-postgres. */
function numbered(statement: string): string {
  let index = 0;
  return statement.replaceAll("?", () => "$" + String(++index));
}

const now = () => Date.now() / 1000;
const liveClaim = "owner=? AND id=? AND state='running' AND lease=? AND expires>?";
const savedProgress = z.object({ revision: z.number(), checkpoint: z.string() });

/** Python 3.12 sum() of floats: Neumaier compensated summation. */
function floatSum(values: Iterable<number>): number {
  let total = 0, compensation = 0;
  for (const value of values) {
    const next = total + value;
    compensation += Math.abs(total) >= Math.abs(value) ? (total - next) + value : (value - next) + total;
    total = next;
  }
  return total + compensation;
}

const WORD = /[\p{L}\p{N}_]+/gu;

export class WorkflowStore {
  readonly path: string;
  readonly owner: string;
  readonly dsn: string;

  private constructor(path: string, owner: string, dsn: string) {
    this.path = path;
    this.owner = owner;
    this.dsn = dsn;
  }

  static async open(path: string, owner: string, dsn = ""): Promise<WorkflowStore> {
    const store = new WorkflowStore(path, owner, dsn);
    if (dsn === "") {
      mkdirSync(dirname(path), { recursive: true });
      closeSync(openSync(path, "a", 0o600));
    }
    await store.transaction(async sql => {
      if (dsn !== "") await sql.run("CREATE EXTENSION IF NOT EXISTS vector");
      await sql.run("CREATE TABLE IF NOT EXISTS cg_workspaces (owner TEXT PRIMARY KEY)");
      await sql.run("INSERT INTO cg_workspaces(owner) VALUES(?) ON CONFLICT DO NOTHING", [owner]);
      await sql.run(`CREATE TABLE IF NOT EXISTS cg_jobs (
                id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL, prompt TEXT NOT NULL,
                language TEXT NOT NULL, state TEXT NOT NULL, created DOUBLE PRECISION NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0, lease TEXT, expires DOUBLE PRECISION,
                result TEXT, UNIQUE(owner,request_id))`);
      await sql.run("CREATE INDEX IF NOT EXISTS cg_jobs_queue ON cg_jobs(owner,state,created)");
      await sql.run(`CREATE TABLE IF NOT EXISTS cg_job_delivery (
                id TEXT PRIMARY KEY REFERENCES cg_jobs(id) ON DELETE CASCADE, token TEXT NOT NULL)`);
      await sql.run("INSERT INTO cg_job_delivery(id,token) SELECT id,id FROM cg_jobs WHERE state IN ('queued','running') ON CONFLICT(id) DO NOTHING");
      await sql.run(`CREATE TABLE IF NOT EXISTS cg_job_progress (
                id TEXT PRIMARY KEY REFERENCES cg_jobs(id) ON DELETE CASCADE,
                revision INTEGER NOT NULL, checkpoint TEXT NOT NULL)`);
      const embedding = dsn !== "" ? `vector(${DIMENSIONS})` : "TEXT";
      await sql.run(`CREATE TABLE IF NOT EXISTS cg_notes (
                id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL, created DOUBLE PRECISION NOT NULL,
                model TEXT, embedding ${embedding}, UNIQUE(owner,body))`);
      await sql.run("CREATE INDEX IF NOT EXISTS cg_notes_owner ON cg_notes(owner,created)");
      if (dsn !== "") await sql.run("CREATE INDEX IF NOT EXISTS cg_notes_vector ON cg_notes USING hnsw(embedding vector_cosine_ops)");
    });
    return store;
  }

  async transaction<T>(body: (sql: Sql) => Promise<T>, { write = true } = {}): Promise<T> {
    if (this.dsn !== "") return await this.#postgres(body);
    return await fileLock(this.path).run(async () => {
      const db = new DatabaseSync(this.path, { timeout: 5000 });
      const sql: Sql = {
        rows: async (statement, args = []) => db.prepare(statement).all(...args),
        run: async (statement, args = []) => Number(db.prepare(statement).run(...args).changes),
      };
      try {
        if (write) db.exec("BEGIN IMMEDIATE");
        const result = await body(sql);
        if (db.isTransaction) db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      } finally {
        db.close();
      }
    });
  }

  async #postgres<T>(body: (sql: Sql) => Promise<T>): Promise<T> {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: this.dsn, connectionTimeoutMillis: 4000, statement_timeout: 8000 });
    await client.connect();
    const sql: Sql = {
      rows: async (statement, args = []) => (await client.query<Row>(numbered(statement), [...args])).rows,
      run: async (statement, args = []) => (await client.query(numbered(statement), [...args])).rowCount ?? 0,
    };
    try {
      await client.query("BEGIN");
      const result = await body(sql);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await client.end();
    }
  }

  async #lockOwner(sql: Sql): Promise<void> {
    if (this.dsn !== "") await sql.rows("SELECT owner FROM cg_workspaces WHERE owner=? FOR UPDATE", [this.owner]);
  }

  async enqueue(requestId: string, prompt: string, language: string): Promise<string> {
    return await this.transaction(async sql => {
      await this.#lockOwner(sql);
      const [existing] = await sql.rows("SELECT id,prompt,language FROM cg_jobs WHERE owner=? AND request_id=?", [this.owner, requestId]);
      if (existing !== undefined) {
        const row = claimRow.omit({ attempts: true }).parse(existing);
        if (row.prompt !== prompt || row.language !== language) throw new WorkflowRejected("conflict");
        return row.id;
      }
      const [total] = await sql.rows("SELECT count(*) AS n FROM cg_jobs WHERE owner=?", [this.owner]);
      if (count.parse(total).n >= 50) throw new WorkflowRejected("limit");
      const jobId = randomUUID();
      await sql.run("INSERT INTO cg_jobs(id,owner,request_id,prompt,language,state,created) VALUES(?,?,?,?,?,'queued',?)",
        [jobId, this.owner, requestId, prompt, language, now()]);
      await sql.run("INSERT INTO cg_job_delivery(id,token) VALUES(?,?)", [jobId, randomUUID()]);
      return jobId;
    });
  }

  async claim(at: number = now()): Promise<ClaimedJob | undefined> {
    return await this.transaction(async sql => {
      await this.#lockOwner(sql);
      await sql.run(`UPDATE cg_jobs SET state='failed',lease=NULL,expires=NULL WHERE owner=? AND state='running'
                   AND attempts>=? AND expires<=?`, [this.owner, MAX_ATTEMPTS, at]);
      const [found] = await sql.rows(`SELECT id,prompt,language,attempts FROM cg_jobs WHERE owner=? AND state IN ('queued','running')
                         AND (expires IS NULL OR expires<=?) ORDER BY COALESCE(expires,created),created,id LIMIT 1`, [this.owner, at]);
      if (found === undefined) return undefined;
      const row = claimRow.parse(found);
      const lease = randomUUID();
      const updated = await sql.run(`UPDATE cg_jobs SET state='running',attempts=attempts+1,lease=?,expires=? WHERE id=? AND owner=?
        AND state IN ('queued','running') AND (expires IS NULL OR expires<=?)`, [lease, at + LEASE_SECONDS, row.id, this.owner, at]);
      if (updated !== 1) return undefined;
      return { ...row, attempts: row.attempts + 1, lease };
    });
  }

  async retry(job: ClaimedJob, { shutdown = false } = {}): Promise<void> {
    await this.transaction(async sql => {
      const state = shutdown || job.attempts < MAX_ATTEMPTS ? "queued" : "failed";
      const delay = shutdown ? 0 : 2 ** job.attempts;
      await sql.run(`UPDATE cg_jobs SET state=?,expires=?,lease=NULL,attempts=attempts-?
                   WHERE ${liveClaim}`,
        [state, now() + delay, shutdown ? 1 : 0, this.owner, job.id, job.lease, now()]);
    });
  }

  async finish(job: ClaimedJob, state: string, result?: object): Promise<boolean> {
    const encoded = result !== undefined && Object.keys(result).length > 0 ? JSON.stringify(result) : null;
    return await this.transaction(async sql => {
      const updated = await sql.run(`UPDATE cg_jobs SET state=?,result=?,lease=NULL,expires=NULL WHERE ${liveClaim}`,
        [state, encoded, this.owner, job.id, job.lease, now()]) === 1;
      if (updated && state !== "needs_input") await sql.run("DELETE FROM cg_job_progress WHERE id=?", [job.id]);
      return updated;
    });
  }

  async progress(job: ClaimedJob): Promise<{ revision: number; checkpoint: ResearchCheckpoint } | undefined> {
    return await this.transaction(async sql => {
      const [raw] = await sql.rows(`SELECT revision,checkpoint FROM cg_job_progress WHERE id IN
        (SELECT id FROM cg_jobs WHERE ${liveClaim})`, [this.owner, job.id, job.lease, now()]);
      if (raw === undefined) return undefined;
      const stored = savedProgress.parse(raw);
      return { revision: stored.revision, checkpoint: ResearchCheckpoint.parse(JSON.parse(stored.checkpoint)) };
    }, { write: false });
  }

  async saveProgress(job: ClaimedJob, revision: number, checkpoint: ResearchCheckpoint, { yieldJob = false } = {}): Promise<boolean> {
    const encoded = JSON.stringify(ResearchCheckpoint.parse(checkpoint));
    return await this.transaction(async sql => {
      // 잠금 순서를 작업 행 → 진행 행으로 고정한다. 취소·만료 이후에는 저장할 수 없다.
      if (await sql.run(`UPDATE cg_jobs SET lease=lease WHERE ${liveClaim}`, [this.owner, job.id, job.lease, now()]) !== 1) return false;
      const changed = revision === 0
        ? await sql.run("INSERT INTO cg_job_progress(id,revision,checkpoint) VALUES(?,1,?) ON CONFLICT DO NOTHING", [job.id, encoded])
        : await sql.run("UPDATE cg_job_progress SET revision=revision+1,checkpoint=? WHERE id=? AND revision=?", [encoded, job.id, revision]);
      if (changed === 1 && yieldJob) {
        await sql.run("UPDATE cg_jobs SET state='queued',lease=NULL,expires=?,attempts=attempts-1 WHERE id=?", [now(), job.id]);
      }
      return changed === 1;
    });
  }

  async answer(jobId: string, revision: number, answer: string): Promise<boolean> {
    return await this.transaction(async sql => {
      const id = [this.owner, jobId];
      if (await sql.run("UPDATE cg_jobs SET state=state WHERE owner=? AND id=? AND state='needs_input'", id) !== 1) return false;
      const [raw] = await sql.rows("SELECT revision,checkpoint FROM cg_job_progress WHERE id=?", [jobId]);
      if (raw === undefined) return false;
      const row = savedProgress.parse(raw);
      if (row.revision !== revision) return false;
      const saved = ResearchCheckpoint.parse(JSON.parse(row.checkpoint));
      const waiting = saved.plan.steps.findIndex(step => step.outcome?.status === "waiting");
      if (waiting < 0 || (saved.plan.steps[waiting]?.attempts ?? 2) >= 2) return false;
      const plan = { ...saved.plan, steps: saved.plan.steps.map((step, i) => i === waiting ? { ...step, outcome: undefined, clarification: answer } : step) };
      await sql.run("UPDATE cg_job_progress SET revision=revision+1,checkpoint=? WHERE id=?",
        [JSON.stringify({ ...saved, plan }), jobId]);
      await sql.run("UPDATE cg_jobs SET state='queued',result=NULL,expires=?,attempts=0 WHERE owner=? AND id=?", [now(), ...id]);
      await sql.run("INSERT INTO cg_job_delivery(id,token) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token", [jobId, randomUUID()]);
      return true;
    });
  }

  async ownsClaim(job: ClaimedJob): Promise<boolean> {
    return await this.transaction(async sql => (await sql.rows(`SELECT 1 FROM cg_jobs WHERE ${liveClaim}`,
      [this.owner, job.id, job.lease, now()])).length > 0, { write: false });
  }

  async renewClaim(job: ClaimedJob): Promise<boolean> {
    return await this.transaction(async sql => {
      const at = now();
      return await sql.run(`UPDATE cg_jobs SET expires=? WHERE ${liveClaim}`,
        [at + LEASE_SECONDS, this.owner, job.id, job.lease, at]) === 1;
    });
  }

  async cancel(jobId: string): Promise<boolean> {
    return await this.transaction(async sql => {
      const cancelled = await sql.run(`UPDATE cg_jobs SET state='cancelled',result=NULL,lease=NULL,expires=NULL WHERE owner=? AND id=?
                          AND state IN ('queued','running','needs_input')`, [this.owner, jobId]) === 1;
      if (cancelled) await sql.run("DELETE FROM cg_job_progress WHERE id=?", [jobId]);
      return cancelled;
    });
  }

  async pendingDeliveries() {
    return this.transaction(async sql => {
      const rows = await sql.rows(`SELECT d.token,j.id,j.prompt,j.language,j.state,j.result,p.checkpoint,p.revision
        FROM cg_job_delivery d JOIN cg_jobs j ON j.id=d.id
        LEFT JOIN cg_job_progress p ON p.id=j.id AND j.state IN ('needs_input','failed')
        WHERE j.owner=? ORDER BY j.created,d.id`, [this.owner]);
      return rows.map(raw => {
        const {token, ...row} = deliveryRow.parse(raw);
        const {id, prompt, language, state, result} = readJob(row);
        return {id, token, prompt, language, state, result};
      });
    }, {write: false});
  }

  async heard(id: string, token: string): Promise<void> {
    await this.transaction(async sql => {
      await sql.run(`DELETE FROM cg_job_delivery WHERE id=? AND token=?
        AND EXISTS (SELECT 1 FROM cg_jobs j WHERE j.id=cg_job_delivery.id AND j.owner=? AND j.state NOT IN ('queued','running'))`,
      [id, token, this.owner]);
    });
  }

  async jobs(): Promise<JobRow[]> {
    return await this.transaction(async sql => {
      const rows = await sql.rows(`SELECT j.id,j.prompt,j.language,j.state,j.result,p.checkpoint,p.revision,d.token FROM cg_jobs j
        LEFT JOIN cg_job_progress p ON p.id=j.id AND j.state IN ('needs_input','failed')
        LEFT JOIN cg_job_delivery d ON d.id=j.id WHERE j.owner=? ORDER BY j.created DESC,j.id`, [this.owner]);
      return rows.map(raw => {
        const {token, ...row} = listedRow.parse(raw);
        return {...readJob(row), ...(token === null ? {} : {deliveryToken: token})};
      });
    }, { write: false });
  }

  async summaries(limit: number): Promise<JobSummary[]> {
    return await this.transaction(async sql => {
      const rows = await sql.rows(`SELECT j.id,j.prompt,j.language,j.state,j.result,p.checkpoint,p.revision FROM cg_jobs j
        LEFT JOIN cg_job_progress p ON p.id=j.id AND j.state IN ('needs_input','failed') WHERE j.owner=? ORDER BY j.created DESC,j.id LIMIT ?`, [this.owner, limit]);
      return rows.map(raw => {
        const job = readJob(jobRow.parse(raw));
        return { id: job.id, prompt: job.prompt, language: job.language, phase: phaseOf(job) };
      });
    }, { write: false });
  }

  async deleteJob(jobId: string): Promise<boolean> {
    return await this.transaction(async sql => await sql.run("DELETE FROM cg_jobs WHERE owner=? AND id=? AND state NOT IN ('queued','running')",
      [this.owner, jobId]) === 1);
  }

  async note(body: string, vector: unknown, model: string | undefined): Promise<string> {
    return await this.transaction(async sql => {
      await this.#lockOwner(sql);
      const [existing] = await sql.rows("SELECT id FROM cg_notes WHERE owner=? AND body=?", [this.owner, body]);
      if (existing === undefined) {
        const [total] = await sql.rows("SELECT count(*) AS n FROM cg_notes WHERE owner=?", [this.owner]);
        if (count.parse(total).n >= 100) throw new WorkflowRejected("limit");
      }
      const noteId = existing === undefined ? randomUUID() : noteRow.pick({ id: true }).parse(existing).id;
      const expression = this.dsn !== "" ? "CAST(? AS vector)" : "?";
      await sql.run(`INSERT INTO cg_notes(id,owner,body,created,model,embedding) VALUES(?,?,?,?,?,${expression})
                    ON CONFLICT(owner,body) DO UPDATE SET embedding=excluded.embedding, model=excluded.model`,
        [noteId, this.owner, body, now(), model ?? null, vectorJson(vector) ?? null]);
      return noteId;
    });
  }

  async deleteNote(noteId: string): Promise<boolean> {
    return await this.transaction(async sql => await sql.run("DELETE FROM cg_notes WHERE owner=? AND id=?", [this.owner, noteId]) === 1);
  }

  async notes(): Promise<Note[]> {
    return await this.transaction(async sql => (await sql.rows("SELECT id,body FROM cg_notes WHERE owner=? ORDER BY created DESC,id", [this.owner]))
      .map(row => noteRow.parse(row)), { write: false });
  }

  async hasNotes(): Promise<boolean> {
    return await this.transaction(async sql => (await sql.rows("SELECT 1 FROM cg_notes WHERE owner=? LIMIT 1", [this.owner])).length > 0, { write: false });
  }

  async search(query: string, vector: unknown, model: string | undefined): Promise<Note[]> {
    const encoded = vectorJson(vector);
    const scores = new Map<string, number>();
    const notes = await this.transaction(async sql => {
      if (this.dsn !== "" && encoded !== undefined) {
        const matches = await sql.rows(`SELECT id,1-(embedding <=> CAST(? AS vector)) AS score FROM cg_notes
                                 WHERE owner=? AND model=? AND embedding IS NOT NULL
                                 ORDER BY embedding <=> CAST(? AS vector) LIMIT 6`, [encoded, this.owner, model ?? null, encoded]);
        for (const match of matches) {
          const row = scoreRow.parse(match);
          scores.set(row.id, row.score);
        }
      }
      const columns = this.dsn !== "" || encoded === undefined ? "id,body" : "id,body,embedding,model";
      return (await sql.rows(`SELECT ${columns} FROM cg_notes WHERE owner=? ORDER BY created DESC,id`, [this.owner]))
        .map(row => noteVectorRow.partial({ embedding: true, model: true }).parse(row));
    }, { write: false });
    const folded = casefold(query);
    const terms = new Set(folded.match(WORD) ?? []);
    const ranked: Array<[number, Note]> = [];
    for (const note of notes) {
      const body = casefold(note.body);
      const words = new Set(body.match(WORD) ?? []);
      let lexical = [...terms].filter(term => words.has(term)).length / Math.max(1, terms.size);
      if (body.includes(folded) || folded.includes(body)) lexical = 1;
      let semantic = scores.get(note.id) ?? 0;
      if (this.dsn === "" && encoded !== undefined && Array.isArray(vector) && (note.model ?? undefined) === model
        && note.embedding !== undefined && note.embedding !== null && note.embedding !== "") {
        const other = z.array(z.number()).parse(JSON.parse(note.embedding));
        const query = vector.filter((n): n is number => typeof n === "number");
        const length = Math.min(query.length, other.length);
        const dot = floatSum(Array.from({ length }, (_, i) => (query[i] ?? 0) * (other[i] ?? 0)));
        semantic = dot / (Math.hypot(...query) * Math.hypot(...other));
      }
      if (lexical !== 0 || semantic >= 0.32) {
        ranked.push([Math.max(lexical, semantic) + Math.min(lexical, semantic) * 0.1, { id: note.id, body: note.body }]);
      }
    }
    return ranked.sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, note]) => note);
  }
}
