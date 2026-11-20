import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { raceAbort } from "../../src/core/abort.ts";
import { REPLAY_LIMIT, RequestConflict, RequestLedger, Sessions } from "../../src/server/recovery.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
function gate() {
  let open = () => {};
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

it("test_dropped_response_replays_inflight_operation_once", async () => {
  const ledger = new RequestLedger();
  const entered = gate(), finish = gate();
  const effects: string[] = [];
  const work = async () => {
    entered.open();
    await finish.opened;
    effects.push("synthetic field write");
    return { ok: true };
  };
  const caller = new AbortController();
  const dropped = raceAbort(() => ledger.once("1", bytes("same operation"), work), caller.signal);
  await entered.opened;
  caller.abort();
  await expect(dropped).rejects.toMatchObject({ name: "AbortError" });
  await expect(ledger.once("1", bytes("different operation"), work)).rejects.toBeInstanceOf(RequestConflict);
  finish.open();
  expect(await ledger.once("1", bytes("same operation"), work)).toEqual({ ok: true });
  expect(effects).toEqual(["synthetic field write"]);
});

it("test_detached_grace_expires_and_restart_cannot_recover", async () => {
  const closed = gate();
  const sessions = new Sessions({ graceS: 0 });
  const session = { id: "synthetic", close: async () => { closed.open(); }, detachForRecovery: () => ({ state: "IDLE" }) };
  sessions.add(session);
  const token = sessions.enable(session.id).token;
  const attempt = randomUUID();
  expect(new Sessions().recover(token, attempt)).toBeUndefined();
  sessions.detach(session.id);
  await closed.opened;
  expect(sessions.recover(token, attempt)).toBeUndefined();
});

it("sequence keys must be fresh decimal numbers and the replay window only drops finished requests", async () => {
  const ledger = new RequestLedger<number>();
  for (const key of ["", "0", "-1", "１", "1.0", "1234567890123"]) {
    await expect(ledger.once(key, bytes("x"), async () => 1), key).rejects.toBeInstanceOf(RequestConflict);
  }
  expect(await ledger.once(undefined, bytes("x"), async () => 7)).toBe(7);
  expect(await ledger.once("000000000002", bytes("x"), async () => 2)).toBe(2);
  await expect(ledger.once("1", bytes("x"), async () => 1)).rejects.toBeInstanceOf(RequestConflict);
  const held = gate();
  const pending = Array.from({ length: REPLAY_LIMIT }, (_, i) => ledger.once(String(i + 3), bytes("x"), async () => { await held.opened; return i; }));
  await expect(ledger.once("41", bytes("x"), async () => 0)).rejects.toBeInstanceOf(RequestConflict);
  held.open();
  await Promise.all(pending);
  expect(await ledger.once("42", bytes("x"), async () => 42)).toBe(42);
});

it("a detached writer recovers once with fresh credentials and the same attempt replays", () => {
  const sessions = new Sessions();
  const session = { id: "s1", close: async () => {}, detachForRecovery: () => ({ state: "BROWSING" }) };
  sessions.add(session);
  const lease = sessions.enable("s1");
  const old = lease.credentials();
  expect(() => sessions.recover(old.token, "a1")).toThrow(RequestConflict);
  sessions.detach("s1");
  expect([lease.writer, lease.checkpoint]).toEqual([undefined, { state: "BROWSING" }]);
  const recovered = sessions.recover(old.token, "a1");
  expect(recovered?.[0]).toBe("s1");
  expect([lease.waiting, lease.token === old.token, lease.writer === old.writer]).toEqual([true, false, false]);
  expect(sessions.recover(old.token, "a1")).toEqual(recovered);
  expect(sessions.recover(old.token, "a2")).toBeUndefined();
  expect(() => sessions.recover("토큰", "a3")).toThrow(TypeError);
  sessions.clear();
  expect([sessions.size, sessions.get("s1"), sessions.leases.size]).toEqual([0, undefined, 0]);
});
