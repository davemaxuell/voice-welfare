// 세션 수명, 같은 탭의 쓰기 권한과 재시도.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const RECOVERY_GRACE_S = 300;
export const WRITER_LEASE_S = 60;
export const EPHEMERAL_LEASE_S = 120;
export const REPLAY_LIMIT = 32;

export class RequestConflict extends Error {
  constructor() { super("request conflict"); }
}

const tokenUrlsafe = () => randomBytes(32).toString("base64url");

/** secrets.compare_digest: 글자 수가 달라도 시간을 드러내지 않고, ASCII가 아닌 글은 받지 않는다. */
function compareDigest(a: string, b: string): boolean {
  if (!/^[\x00-\x7f]*$/.test(a) || !/^[\x00-\x7f]*$/.test(b)) throw new TypeError("comparing strings with non-ASCII characters is not supported");
  const left = Buffer.from(a, "ascii"), right = Buffer.from(b, "ascii");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

interface Recorded<T> { digest: Buffer; result: Promise<T>; done: boolean }

/** 같은 순번의 요청은 한 번만 실행한다. 응답을 잃은 탭이 다시 보내면 처음 실행의 결과를 받는다. */
export class RequestLedger<T = unknown> {
  latest = 0;
  readonly #requests = new Map<number, Recorded<T>>();

  async once(key: string | undefined, payload: Uint8Array, run: () => Promise<T>): Promise<T> {
    if (key === undefined) return await run();
    if (!/^[0-9]+$/.test(key) || key.length > 12 || Number(key) < 1) throw new RequestConflict();
    const seq = Number(key);
    const digest = createHash("sha256").update(payload).digest();
    const record = this.#requests.get(seq);
    if (record !== undefined) {
      if (!record.digest.equals(digest)) throw new RequestConflict();
      return await record.result;
    }
    if (seq <= this.latest) throw new RequestConflict();
    while (this.#requests.size >= REPLAY_LIMIT) {
      const completed = [...this.#requests].find(([, entry]) => entry.done)?.[0];
      if (completed === undefined) throw new RequestConflict();
      this.#requests.delete(completed);
    }
    this.latest = seq;
    const result = run();
    const entry: Recorded<T> = { digest, result, done: false };
    const settle = () => { entry.done = true; };
    result.then(settle, settle);
    this.#requests.set(seq, entry);
    return await result;
  }
}

export class Lease {
  token = tokenUrlsafe();
  writer: string | undefined = tokenUrlsafe();
  waiting = false;
  previous: readonly [token: string, attempt: string] | undefined;
  checkpoint: unknown;
  timer: NodeJS.Timeout | undefined;

  credentials() { return { token: this.token, writer: this.writer ?? null }; }

  cancelTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/** 앞선 생성이 끝난 뒤에 다음 생성을 시작한다. */
export class AsyncLock {
  #tail: Promise<void> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.then(() => {}, () => {});
    return result;
  }
}

export interface RecoverableSession {
  readonly id: string;
  close(): Promise<void>;
  detachForRecovery(): unknown;
}
export interface LeaseTimes { graceS: number; writerLeaseS: number; ephemeralLeaseS: number }

// asyncio의 call_later처럼 이 타이머만으로 프로세스를 붙잡지 않는다.
function later(seconds: number, callback: () => void): NodeJS.Timeout {
  return setTimeout(callback, seconds * 1000).unref();
}

/** 활성 세션을 유지하며, 분리된 세션은 유예 기간 뒤 닫는다. */
export class Sessions<S extends RecoverableSession> {
  readonly #items = new Map<string, S>();
  readonly leases = new Map<string, Lease>();
  readonly ephemeral = new Map<string, NodeJS.Timeout>();
  readonly ledgers = new Map<string, RequestLedger>();
  readonly creating = new AsyncLock();
  readonly #times: LeaseTimes;

  constructor(times: Partial<LeaseTimes> = {}) {
    this.#times = { graceS: RECOVERY_GRACE_S, writerLeaseS: WRITER_LEASE_S, ephemeralLeaseS: EPHEMERAL_LEASE_S, ...times };
  }

  get size(): number { return this.#items.size; }

  get(sid: string): S | undefined { return this.#items.get(sid); }

  add(session: S): void {
    this.#items.set(session.id, session);
    this.ledgers.set(session.id, new RequestLedger());
  }

  remove(sid: string): S | undefined {
    const lease = this.leases.get(sid);
    this.leases.delete(sid);
    lease?.cancelTimer();
    const timer = this.ephemeral.get(sid);
    this.ephemeral.delete(sid);
    if (timer !== undefined) clearTimeout(timer);
    this.ledgers.delete(sid);
    const session = this.#items.get(sid);
    this.#items.delete(sid);
    return session;
  }

  values(): S[] { return [...this.#items.values()]; }

  clear(): void {
    for (const sid of [...this.#items.keys()]) this.remove(sid);
  }

  keepEphemeral(sid: string): void {
    const timer = this.ephemeral.get(sid);
    if (timer !== undefined) clearTimeout(timer);
    this.ephemeral.set(sid, later(this.#times.ephemeralLeaseS, () => this.#expire(sid)));
  }

  enable(sid: string): Lease {
    const lease = new Lease();
    this.leases.set(sid, lease);
    this.keepAlive(sid, lease);
    return lease;
  }

  keepAlive(sid: string, lease: Lease): void {
    lease.cancelTimer();
    lease.timer = later(this.#times.writerLeaseS, () => this.detach(sid));
  }

  detach(sid: string): void {
    const lease = this.leases.get(sid);
    if (lease?.writer === undefined) return;
    lease.writer = undefined;
    lease.waiting = false;
    lease.previous = undefined;
    const session = this.#items.get(sid);
    if (session === undefined) throw new RangeError(sid);
    lease.checkpoint = session.detachForRecovery();
    this.ledgers.set(sid, new RequestLedger());
    lease.cancelTimer();
    lease.timer = later(this.#times.graceS, () => this.#expire(sid));
  }

  #expire(sid: string): void {
    const session = this.remove(sid);
    if (session !== undefined) void session.close().catch(() => {});
  }

  recover(token: string, attempt: string): readonly [string, Lease] | undefined {
    for (const [sid, lease] of this.leases) {
      if (lease.waiting && lease.previous !== undefined && lease.previous[0] === token && lease.previous[1] === attempt) return [sid, lease];
      if (!compareDigest(lease.token, token)) continue;
      if (lease.writer !== undefined) throw new RequestConflict();
      lease.previous = [token, attempt];
      lease.token = tokenUrlsafe();
      lease.writer = tokenUrlsafe();
      lease.waiting = true;
      this.keepAlive(sid, lease);
      return [sid, lease];
    }
    return undefined;
  }
}
