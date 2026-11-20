import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActionLog, GENESIS } from "../../src/personal/action_log.ts";
import { PersonalStore } from "../../src/personal/store.ts";
import { redactText } from "../../src/safety/privacy.ts";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "cheongeum-profile-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

it("test_interrupted_save_keeps_confirmed_profile_in_memory_and_on_disk", () => {
  const path = join(directory, "profile.json");
  const store = new PersonalStore(path);
  store.saveSpeech({ length: "short" });

  vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("simulated failed replace"); });
  expect(() => store.saveSpeech({ length: "detailed" })).toThrow("simulated failed replace");
  expect(store.speech()).toEqual(new PersonalStore(path).speech());
  expect(store.speech().length).toBe("short");
  expect(readdirSync(directory)).toEqual(["profile.json"]);

  store.saveSpeech({ length: "detailed" });
  expect(new PersonalStore(path).speech().length).toBe("detailed");
  expect(readdirSync(directory)).toEqual(["profile.json"]);
});

it("test_parallel_approval_journal_keeps_one_chain", async () => {
  const path = join(directory, "actions.json");
  const journal = new ActionLog(path);
  await Promise.all(Array.from({ length: 16 }, async (_, n) => journal.append({ label: redactText(String(n)) })));
  const rows = new ActionLog(path).recent(16);
  expect(rows.map(row => row.seq)).toEqual(Array.from({ length: 16 }, (_, n) => n + 1));
  expect(rows.map(row => row.prev)).toEqual([GENESIS, ...rows.slice(0, -1).map(row => row.hash)]);
});

it("an interrupted journal write leaves the file and the chain as they were", () => {
  const path = join(directory, "actions.json");
  const journal = new ActionLog(path);
  const first = journal.append({ label: redactText("처음") });
  const before = readFileSync(path);

  vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("simulated failed replace"); });
  expect(() => journal.append({ label: redactText("실패") })).toThrow("simulated failed replace");
  expect(readFileSync(path).equals(before)).toBe(true);
  expect(readdirSync(directory)).toEqual(["actions.json"]);
  expect(journal.append({ label: redactText("다시") })).toMatchObject({ seq: 2, prev: first.hash });
});
