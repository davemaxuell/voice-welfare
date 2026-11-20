import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActionLog } from "../../src/personal/action_log.ts";
import { PersonalStore } from "../../src/personal/store.ts";
import { Seal } from "../../src/personal/seal.ts";
import { redactText } from "../../src/safety/privacy.ts";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "cheongeum-personal-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

it("test_seal_roundtrip", () => {
  let value: string | null = null;
  const entry = { getPassword: () => value, setPassword: (v: string) => { value = v; } };
  const seal = new Seal({ entry });
  const plain = Buffer.from('{"ok":true}');
  const blob = seal.seal(plain);
  expect(seal.isSealed(blob)).toBe(true);
  expect(blob.subarray(0, 4)).toEqual(Buffer.from("CE1\0"));
  expect(value).toMatch(/^[0-9a-f]{64}$/u);
  expect(new Seal({ entry }).open(blob)).toEqual(plain);
  expect(seal.seal(plain)).not.toEqual(blob);
  const damaged = Buffer.from(blob);
  damaged[damaged.length - 1] = damaged.at(-1)! ^ 1;
  expect(() => seal.open(damaged)).toThrow();
  expect(() => new Seal({ key: randomBytes(32) }).open(blob)).toThrow();
  const locked = { getPassword() { throw Error("locked"); }, setPassword() { throw Error("unexpected write"); } };
  expect(() => new Seal({ entry: locked })).toThrow("locked");
});
it("test_action_log_hash_chain", () => {
  const seal = new Seal({ key: randomBytes(32) });
  const path = join(directory, "actions.sealed");
  const log = new ActionLog(path, seal);
  const entry = { host: "example.go.kr", actionType: "click", label: redactText("다음 누르기") };
  const a = log.append({ ...entry, phase: "before" });
  const b = log.append({ ...entry, phase: "after", ok: true });
  expect(b.prev).toBe(a.hash);
  const { hash, prev, ...body } = a;
  expect(hash).toBe(createHash("sha256").update(prev + JSON.stringify(body, Object.keys(body).sort((a,b) => a < b ? -1 : a > b ? 1 : 0))).digest("hex"));
  expect(seal.isSealed(readFileSync(path))).toBe(true);
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  const again = new ActionLog(path, seal);
  expect(again.recent()).toEqual([a,b]);
  expect(again.speakRecent()).toBe("오늘 한 일 1건이에요. 1. 다음 누르기, example.go.kr.");
});
it("test_action_log_refuse_path_memory", () => {
  const log = new ActionLog();
  expect(log.speakRecent()).toBe("오늘 기록된 조작이 없어요.");
  log.append({ actionType: "navigate", label: redactText("포털 열기") });
  expect(log.speakRecent()).toBe("오늘 한 일 1건이에요. 1. 포털 열기.");
});
it("test_store_file_mode", () => {
  const path = join(directory, "personal.json");
  new PersonalStore(path).saveVault({ name: "김하늘" });
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ vault: { name: "김하늘" } });
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(new PersonalStore(path).vault()).toEqual({ name: "김하늘" });
});
it("test_store_sealed", () => {
  const path = join(directory, "personal.json");
  const seal = new Seal({ key: randomBytes(32) });
  new PersonalStore(path, seal).saveVault({ name: "김하늘" });
  expect(seal.isSealed(readFileSync(path))).toBe(true);
  expect(readFileSync(path).includes(Buffer.from("김하늘"))).toBe(false);
  expect(new PersonalStore(path, seal).vault()).toEqual({ name: "김하늘" });
  writeFileSync(path, JSON.stringify({ vault: { phone: "010" }, applications: [] }));
  expect(new PersonalStore(path, seal).vault()).toEqual({ phone: "010" });
  expect(seal.isSealed(readFileSync(path))).toBe(true);
});
it("test_speech_prefs_persist", () => {
  const path = join(directory, "personal.json");
  const store = new PersonalStore(path);
  store.saveSpeech({ rate: 0.9, progressSpoken: false });
  const again = new PersonalStore(path);
  expect(again.speech()).toMatchObject({ rate: 0.9, progressSpoken: false });
  again.clearSpeech();
  expect(new PersonalStore(path).speech().rate).toBe(1.25);
});
it("저장 실패 후 변경은 기록되지 않고 다시 시도할 수 있다", () => {
  const path = join(directory, "actions.sealed");
  const log = new ActionLog(path);
  mkdirSync(path);
  expect(() => log.append({ label: redactText("실패") })).toThrow();
  expect(log.recent()).toEqual([]);
  rmSync(path, { recursive: true });
  expect(log.append({ label: redactText("다시") })).toMatchObject({ seq: 1, prev: "0".repeat(64) });
});
it("오래된 기록을 열면 보관 기간 경계의 조작부터 보여 준다", () => {
  const path = join(directory, "actions.sealed");
  let day = new Date(2026,9,18,12);
  const log = new ActionLog(path, undefined, () => day);
  log.append({ label: redactText("오래됨") });
  day = new Date(2026,9,19,12);
  const boundary = log.append({ label: redactText("보관") });
  day = new Date(2026,10,18,12);
  const next = new ActionLog(path, undefined, () => day);
  expect(next.recent()).toEqual([boundary]);
  expect(next.append({ label: redactText("다음") }).prev).toBe(boundary.hash);
});

it("동시에 등록한 두 신청은 각각의 기한을 보관한다", () => {
  const store = new PersonalStore();
  const first = store.addApplication({ service: "기초연금", appliedAt: "2026-11-18" });
  const second = store.addApplication({ service: "장애수당", appliedAt: "2026-11-18" });
  expect(first.id).not.toBe(second.id);
  expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  store.updateApplication(second.id, { dueDate: "2026-12-03" });
  expect(store.applications()).toEqual([first, { ...second, dueDate: "2026-12-03" }]);
});

it("신청 기록에서 값이 없는 칸은 저장하지 않는다", () => {
  const path = join(directory, "personal.json");
  const store = new PersonalStore(path);
  const app = store.addApplication({ service: "기초연금", appliedAt: "2026-11-18", receiptNo: undefined });
  expect(Object.keys(app)).toEqual(["service", "appliedAt", "id"]);
  expect(JSON.parse(readFileSync(path, "utf8")).applications).toEqual([app]);
});

it("모양이 맞지 않는 보호자와 부르는 이름은 읽지 않지만 다음 저장에도 지우지 않는다", () => {
  const path = join(directory, "personal.json");
  const odd = { vault: {}, guardian: { name: "홍길동", phone: "02-123-4567", note: "x" }, callName: 7, applications: [], speech: {}, siteAllow: {} };
  writeFileSync(path, JSON.stringify(odd));
  const store = new PersonalStore(path);
  expect(store.guardian()).toBeUndefined();
  expect(store.callName()).toBeUndefined();
  store.saveVault({ name: "김하늘" });
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ guardian: odd.guardian, callName: 7, vault: { name: "김하늘" } });
});

it("보호자는 이름과 휴대전화 번호가 맞을 때만 읽고 그 밖의 칸은 돌려주지 않는다", () => {
  const path = join(directory, "personal.json");
  const bad = [
    { name: "", phone: "01011223344" }, { name: "홍길동" }, { name: "홍길동", phone: 1011223344 }, { name: "홍길동", phone: "0101122334" },
    { name: "홍길동", phone: "010-1122-3344" }, { name: "홍길동", phone: "01011223344\n" }, { name: "홍길동", phone: "０１０１１２２３３４４" },
    [], "홍길동", null,
  ];
  for (const guardian of bad) {
    writeFileSync(path, JSON.stringify({ guardian }));
    expect(new PersonalStore(path).guardian(), JSON.stringify(guardian)).toBeUndefined();
  }
  writeFileSync(path, JSON.stringify({ guardian: { name: "홍길동", phone: "01611223344", note: "x" } }));
  expect(new PersonalStore(path).guardian()).toEqual({ name: "홍길동", phone: "01611223344" });
});

it("사이트 허용은 하나만 거두거나 Python처럼 이름이 없으면(빈 문자열도) 모두 거둔다", () => {
  const store = new PersonalStore();
  store.allowSite("https://a.kr");
  store.allowSite("https://b.kr");
  store.revokeSite("https://a.kr");
  expect(store.allowedSites()).toEqual(["https://b.kr"]);
  store.allowSite("https://a.kr");
  store.revokeSite();
  expect(store.allowedSites()).toEqual([]);
  store.allowSite("https://a.kr");
  store.revokeSite("");
  expect(store.allowedSites()).toEqual([]);
});

it("거절한 조작은 이유와 요청한 쪽을 적고 해시 사슬에 넣는다", () => {
  const path = join(directory, "actions.sealed");
  const seal = new Seal({ key: randomBytes(32) });
  const log = new ActionLog(path, seal);
  const refused = log.append({ actionType: "click", phase: "refused", ok: false, actor: "resident", reasonCode: "DENIED_READ_ONLY" });
  const next = log.append({ actionType: "click", label: redactText("다음"), phase: "before" });
  expect(refused).toMatchObject({ phase: "refused", ok: false, actor: "resident", reasonCode: "DENIED_READ_ONLY", label: "", host: "" });
  const { hash, prev, ...body } = refused;
  expect(Object.keys(body)).toContain("reasonCode");
  expect(hash).toBe(createHash("sha256").update(prev + JSON.stringify(body, Object.keys(body).sort((a, b) => a < b ? -1 : a > b ? 1 : 0))).digest("hex"));
  expect(next.prev).toBe(hash);
  expect(new ActionLog(path, seal).recent()).toEqual([refused, next]);
  expect(log.speakRecent()).toBe("오늘 한 일 1건이에요. 1. 다음.");
});

it("보관 기간이 지나 줄어든 기록도 번호는 마지막 번호에서 이어서 센다", () => {
  const path = join(directory, "actions.sealed");
  let day = new Date(2026, 9, 18, 12);
  const log = new ActionLog(path, undefined, () => day);
  log.append({ label: redactText("오래됨") });
  day = new Date(2026, 9, 19, 12);
  const boundary = log.append({ label: redactText("보관") });
  expect(boundary.seq).toBe(2);
  day = new Date(2026, 10, 18, 12);
  const next = new ActionLog(path, undefined, () => day);
  expect(next.append({ label: redactText("다음") })).toMatchObject({ seq: 3, prev: boundary.hash });
});

function movedAside(name: string) {
  const moved = readdirSync(directory).filter(file => file.startsWith(name + ".unreadable-"));
  expect(moved).toHaveLength(1);
  return join(directory, moved[0]!);
}
it("test_unreadable_vault_moved_aside_not_overwritten", () => {
  const path = join(directory, "personal.json");
  const original = new Seal({ key: Buffer.alloc(32, 1) });
  new PersonalStore(path, original).saveVault({ name: "김하늘" });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const fresh = new PersonalStore(path, new Seal({ key: Buffer.alloc(32, 2) }));
    expect(fresh.vault()).toEqual({});
    fresh.saveVault({ phone: "010-1234-5678" });
    const moved = movedAside("personal.json");
    expect(new PersonalStore(moved, original).vault()).toEqual({ name: "김하늘" });
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]![0])).toContain(moved);
  } finally { stderr.mockRestore(); }
});
it("test_unparsable_plain_vault_moved_aside_without_logging_contents", () => {
  const path = join(directory, "personal.json");
  const broken = '{"vault": {"name": "김하늘"';
  writeFileSync(path, broken);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    new PersonalStore(path).saveVault({ phone: "010" });
    expect(readFileSync(movedAside("personal.json"), "utf8")).toBe(broken);
    expect(String(stderr.mock.calls[0]![0])).not.toContain("김하늘");
  } finally { stderr.mockRestore(); }
  expect(new PersonalStore(path).vault()).toEqual({ phone: "010" });
});
it("test_unreadable_action_log_moved_aside_not_overwritten", () => {
  const path = join(directory, "actions.sealed");
  const original = new Seal({ key: Buffer.alloc(32, 1) });
  const first = new ActionLog(path, original).append({ label: redactText("모의 접수") });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const fresh = new ActionLog(path, new Seal({ key: Buffer.alloc(32, 2) }));
    expect(fresh.recent()).toEqual([]);
    expect(fresh.append({ label: redactText("다음") }).seq).toBe(1);
    expect(new ActionLog(movedAside("actions.sealed"), original).recent()).toEqual([first]);
    expect(stderr).toHaveBeenCalledTimes(1);
  } finally { stderr.mockRestore(); }
});
