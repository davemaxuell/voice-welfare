import { randomBytes } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../src/core/assets.ts";
import { createKeyEntry, type KeyringApi } from "../../src/personal/credential_store.ts";
import { Seal } from "../../src/personal/seal.ts";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

/** Models the Windows store: one table keyed by credential target. Pinned entries have no getPassword, like the hazard they stand for. */
function fakeKeyring() {
  const byTarget = new Map<string, { account: string; password: string }>();
  class Entry {
    readonly #target: string;
    readonly #user: string;
    constructor(service: string, user: string) {
      this.#target = `${user}.${service}`;
      this.#user = user;
    }
    getPassword() { return byTarget.get(this.#target)?.password ?? null; }
    setPassword(password: string) { byTarget.set(this.#target, { account: this.#user, password }); }
    static withTarget(target: string, _service: string, user: string) {
      return { setPassword(password: string) { byTarget.set(target, { account: user, password }); } };
    }
  }
  const keyring: KeyringApi = {
    Entry,
    findCredentials(_service, target) {
      const found = target === undefined || target === null ? undefined : byTarget.get(target);
      return found === undefined ? [] : [found];
    },
  };
  return { keyring, byTarget };
}

const windows = (keyring: KeyringApi) => createKeyEntry("svc", "data-key", { platform: "win32", keyring });

describe("createKeyEntry", () => {
  it("uses the library's own naming away from Windows", () => {
    const { keyring, byTarget } = fakeKeyring();
    const entry = createKeyEntry("svc", "data-key", { platform: "darwin", keyring });
    entry.setPassword(KEY_A);
    expect([...byTarget.keys()]).toEqual(["data-key.svc"]);
    expect(entry.getPassword()).toBe(KEY_A);
  });

  it("on Windows reads the key Python stored under the service name", () => {
    const { keyring, byTarget } = fakeKeyring();
    byTarget.set("svc", { account: "data-key", password: KEY_A });
    expect(windows(keyring).getPassword()).toBe(KEY_A);
  });

  it("on Windows prefers Python's key when an earlier TypeScript build left a different one", () => {
    const { keyring, byTarget } = fakeKeyring();
    byTarget.set("svc", { account: "data-key", password: KEY_A });
    byTarget.set("data-key.svc", { account: "data-key", password: KEY_B });
    const entry = windows(keyring);
    expect(entry.getPassword()).toBe(KEY_A);
    expect(entry.legacyPasswords?.()).toEqual([KEY_B]);
  });

  it("on Windows adopts a key an earlier TypeScript build stored under the library default", () => {
    const { keyring, byTarget } = fakeKeyring();
    byTarget.set("data-key.svc", { account: "data-key", password: KEY_B });
    expect(windows(keyring).getPassword()).toBe(KEY_B);
    expect(byTarget.get("svc")).toEqual({ account: "data-key", password: KEY_B });
  });

  it("on Windows reports no key when nothing is stored and writes only under the service name", () => {
    const { keyring, byTarget } = fakeKeyring();
    const entry = windows(keyring);
    expect(entry.getPassword()).toBeNull();
    entry.setPassword(KEY_A);
    expect([...byTarget.keys()]).toEqual(["svc"]);
  });

  it("on Windows treats an empty stored value as no key", () => {
    const { keyring, byTarget } = fakeKeyring();
    byTarget.set("svc", { account: "data-key", password: "" });
    expect(windows(keyring).getPassword()).toBeNull();
  });

  it("on Windows ignores a credential for another account under the same name", () => {
    const { keyring, byTarget } = fakeKeyring();
    byTarget.set("svc", { account: "someone-else", password: KEY_A });
    expect(windows(keyring).getPassword()).toBeNull();
  });
});

describe("Seal with the Windows key entry", () => {
  const plain = Buffer.from('{"ok":true}');

  it("opens a vault sealed with the key Python stored", () => {
    const { keyring, byTarget } = fakeKeyring();
    byTarget.set("svc", { account: "data-key", password: KEY_A });
    const blob = new Seal({ key: Buffer.from(KEY_A, "hex") }).seal(plain);
    expect(new Seal({ entry: windows(keyring) }).open(blob)).toEqual(plain);
  });

  it("opens a vault sealed with the earlier build's key when both names exist and differ", () => {
    const { keyring, byTarget } = fakeKeyring();
    byTarget.set("svc", { account: "data-key", password: KEY_A });
    byTarget.set("data-key.svc", { account: "data-key", password: KEY_B });
    const blob = new Seal({ key: Buffer.from(KEY_B, "hex") }).seal(plain);
    expect(new Seal({ entry: windows(keyring) }).open(blob)).toEqual(plain);
  });

  it("still refuses a vault sealed with a key it has never seen", () => {
    const { keyring, byTarget } = fakeKeyring();
    byTarget.set("svc", { account: "data-key", password: KEY_A });
    byTarget.set("data-key.svc", { account: "data-key", password: KEY_B });
    const blob = new Seal({ key: randomBytes(32) }).seal(plain);
    expect(() => new Seal({ entry: windows(keyring) }).open(blob)).toThrow();
  });

  it("creates one key under the service name on a fresh install and reuses it", () => {
    const { keyring, byTarget } = fakeKeyring();
    const blob = new Seal({ entry: windows(keyring) }).seal(plain);
    expect([...byTarget.keys()]).toEqual(["svc"]);
    expect(new Seal({ entry: windows(keyring) }).open(blob)).toEqual(plain);
  });
});

describe("source guard", () => {
  it("lets only credential_store.ts mention withTarget, and only to write", () => {
    const uses: string[] = [];
    for (const file of globSync("src/**/*.ts", { cwd: REPO_ROOT })) {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      const name = file.split(sep).join("/");
      for (const match of text.matchAll(/withTarget\([^)]*\)\s*\.\s*(\w+)/gu)) uses.push(`${name} ${match[1] ?? ""}`);
      if (text.includes("withTarget") && !/withTarget\([^)]*\)\s*\.\s*\w+/u.test(text)) uses.push(`${name} keeps the entry in a variable`);
    }
    expect(uses).toEqual(["src/personal/credential_store.ts setPassword"]);
  });
});
