import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PersonalStore } from "../../src/personal/store.ts";
import { speakCallName } from "../../src/speech/phrasing.ts";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "cheongeum-call-name-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

it("test_call_name_round_trip_and_cleared_with_vault", () => {
  const path = join(directory, "p.json");
  const store = new PersonalStore(path);
  store.setCallName("홍길동");
  expect(new PersonalStore(path).callName()).toBe("홍길동");
  store.clearVault();
  expect(new PersonalStore(path).callName()).toBeUndefined();
});

it("test_setting_none_forgets_the_call_name", () => {
  const store = new PersonalStore(join(directory, "p.json"));
  store.setCallName("홍길동");
  store.setCallName(undefined);
  expect(store.callName()).toBeUndefined();
  store.setCallName("홍길동");
  store.setCallName(null);
  expect(store.callName()).toBeUndefined();
  store.setCallName("홍길동");
  store.setCallName("");
  expect(store.callName()).toBeUndefined();
});

it("test_speak_call_name_never_doubles_nim", () => {
  expect(speakCallName("홍길동")).toBe("홍길동님");
  expect(speakCallName("길동님")).toBe("길동님");
});
