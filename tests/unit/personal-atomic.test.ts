import { fsyncSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writePrivate } from "../../src/personal/atomic.ts";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync) };
});
const real = await vi.importActual<typeof import("node:fs")>("node:fs");

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "cheongeum-atomic-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

it("flushes the complete temporary file to disk before it replaces the target", () => {
  const path = join(directory, "profile.json");
  writeFileSync(path, "이전 내용");
  const events: string[] = [];
  let tempContents = "";
  vi.mocked(fsyncSync).mockImplementationOnce(fd => { events.push("fsync"); real.fsyncSync(fd); });
  vi.mocked(renameSync).mockImplementationOnce((from, to) => {
    events.push("rename");
    tempContents = readFileSync(from, "utf8");
    real.renameSync(from, to);
  });

  writePrivate(path, Buffer.from("새 내용"));

  expect(events).toEqual(["fsync", "rename"]);
  expect(tempContents).toBe("새 내용");
  expect(readFileSync(path, "utf8")).toBe("새 내용");
  expect(readdirSync(directory)).toEqual(["profile.json"]);
});

it("creates missing folders and keeps the file private", () => {
  const path = join(directory, "a", "b", "profile.json");
  writePrivate(path, Buffer.from("{}"));
  expect(readFileSync(path, "utf8")).toBe("{}");
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
});

it("leaves the old file and no temporary file when the replace fails", () => {
  const path = join(directory, "profile.json");
  writeFileSync(path, "이전 내용");
  vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("simulated failed replace"); });

  expect(() => writePrivate(path, Buffer.from("새 내용"))).toThrow("simulated failed replace");

  expect(readFileSync(path, "utf8")).toBe("이전 내용");
  expect(readdirSync(directory)).toEqual(["profile.json"]);
});
