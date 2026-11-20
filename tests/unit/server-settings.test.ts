import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Seal } from "../../src/personal/seal.ts";
import { checkOpenaiKey } from "../../src/server/key_check.ts";
import { originRefusal, rawHeaderList, requestRefusal, boundedBody } from "../../src/server/request_policy.ts";
import { Preferences, SettingsInput, SettingsStore } from "../../src/server/settings.ts";
import { fakeFetch } from "../helpers.ts";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "cheongeum-settings-test-"));
  folders.push(dir);
  return dir;
}
const store = (path: string) => new SettingsStore(path, () => new Seal({ key: Buffer.alloc(32, "a") }));

describe("key check", () => {
  it.each([[200, "ok"], [401, "invalid"], [403, "invalid"], [429, "quota"], [500, "network"]] as const)("test_key_check_maps_status", async (status, expected) => {
    const fetcher = fakeFetch(request => {
      expect([request.method, request.url, request.headers.get("authorization")]).toEqual(["GET", "https://api.openai.com/v1/models", "Bearer sk-test"]);
      return Response.json({}, { status });
    });
    expect(await checkOpenaiKey("sk-test", "https://api.openai.com/v1/", { fetch: fetcher })).toBe(expected);
    expect(fetcher.calls).toHaveLength(1);
  });
  it("test_key_check_network_error", async () => {
    const down: typeof fetch = async () => { throw new TypeError("fetch failed"); };
    expect(await checkOpenaiKey("sk-test", "https://api.openai.com/v1", { fetch: down })).toBe("network");
  });
  it("a redirect is not a usable key", async () => {
    const moved = fakeFetch(request => {
      expect(request.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } });
    });
    expect(await checkOpenaiKey("sk-test", "https://api.openai.com/v1", { fetch: moved })).toBe("network");
  });
});

describe("settings store", () => {
  it("test_first_save_starts_setup_progress_at_stage2", () => {
    const path = join(folder(), "preferences.json");
    const settings = store(path);
    settings.save(SettingsInput.parse({ apiKey: "sk-test", deviceUse: "personal" }));
    expect(settings.firstRun).toBe("stage2");
    expect(store(path).firstRun).toBe("stage2");
  });
  it("test_settings_file_from_before_this_feature_counts_as_done", () => {
    const path = join(folder(), "preferences.json");
    const { browser: _browser, ...old } = Preferences.parse({});
    writeFileSync(path, JSON.stringify({ preferences: old, credential: "", lastService: null }), "utf8");
    const settings = new SettingsStore(path);
    expect([settings.completed, settings.firstRun]).toEqual([true, "done"]);
  });
  it("test_set_first_run_survives_reload_and_rejects_unknown_steps", () => {
    const path = join(folder(), "preferences.json");
    const settings = store(path);
    settings.save(SettingsInput.parse({ apiKey: "sk-test", language: "en", speed: 1.6, deviceUse: "personal" }));
    settings.setFirstRun("intro");
    const again = store(path);
    expect([again.firstRun, again.key, again.preferences.language, again.preferences.speed]).toEqual(["intro", "sk-test", "en", 1.6]);
    expect(() => again.setFirstRun("nope")).toThrow("nope");
    expect(store(path).firstRun).toBe("intro");
  });
  it("test_browser_choice_is_kept_on_personal_pc_and_forced_to_separate_on_shared", () => {
    const settings = store(join(folder(), "preferences.json"));
    settings.save(SettingsInput.parse({ apiKey: "sk-test", browser: "chrome", deviceUse: "personal" }));
    expect(settings.preferences.browser).toBe("chrome");
    settings.save(SettingsInput.parse({ browser: "chrome", deviceUse: "shared" }));
    expect(settings.preferences.browser).toBe("separate");
  });
  it("seals the key, keeps an earlier key and never writes it in plain text", () => {
    const path = join(folder(), "preferences.json");
    const settings = store(path);
    settings.save(SettingsInput.parse({ apiKey: "  sk-secret  ", region: "서울" }));
    expect(settings.preferences.region).toBe("서울특별시");
    settings.save(SettingsInput.parse({ language: "ja", region: "서울특별시" }));
    const file = readFileSync(path, "utf8");
    expect(file).not.toContain("sk-secret");
    expect(Object.keys(z.record(z.string(), z.unknown()).parse(JSON.parse(file)))).toEqual(["preferences", "credential", "lastService", "firstRun"]);
    const again = store(path);
    expect([again.key, again.preferences.region, again.preferences.language, again.completed, again.loadError]).toEqual(["sk-secret", "서울특별시", "ja", true, false]);
  });
  it("remembers a known service only on a personal PC that asked for it", () => {
    const path = join(folder(), "preferences.json");
    const settings = store(path);
    settings.save(SettingsInput.parse({ apiKey: "sk-test", deviceUse: "personal", rememberService: true }));
    settings.rememberService("정부24", "없는 업무");
    expect(settings.lastService).toBeUndefined();
    settings.rememberService("정부24", "주민등록등본");
    expect(store(path).lastService).toEqual(["정부24", "주민등록등본"]);
    settings.save(SettingsInput.parse({ deviceUse: "shared", rememberService: true }));
    expect([settings.preferences.rememberService, settings.lastService, store(path).lastService]).toEqual([false, undefined, undefined]);
    settings.rememberService("복지로", "");
    expect(settings.lastService).toBeUndefined();
  });
  it("a missing file needs setup, and a damaged file or lost key keeps setup open with an error", () => {
    const dir = folder();
    const fresh = store(join(dir, "none.json"));
    expect([fresh.completed, fresh.loadError, fresh.firstRun]).toEqual([false, false, "stage2"]);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{", "utf8");
    expect([store(broken).completed, store(broken).loadError]).toEqual([false, true]);
    const sealed = join(dir, "sealed.json");
    store(sealed).save(SettingsInput.parse({ apiKey: "sk-test", language: "zh" }));
    const otherKey = new SettingsStore(sealed, () => new Seal({ key: Buffer.alloc(32, "b") }));
    expect([otherKey.loadError, otherKey.completed, otherKey.key, otherKey.preferences.language]).toEqual([true, false, "", "zh"]);
    const bom = join(dir, "bom.json");
    writeFileSync(bom, "﻿" + JSON.stringify({ preferences: {}, credential: "" }), "utf8");
    expect([store(bom).completed, store(bom).firstRun]).toEqual([true, "done"]);
    const loose = join(dir, "loose.json");
    writeFileSync(loose, JSON.stringify({ preferences: {}, credential: "YWJj=" }), "utf8");
    expect(store(loose).loadError).toBe(true);
  });
  it("claims the startup guide once per settings folder", () => {
    const settings = store(join(folder(), "preferences.json"));
    expect([settings.claimStartupGuide(), settings.claimStartupGuide()]).toEqual([true, false]);
    expect(store(join(folder(), "missing", "preferences.json")).claimStartupGuide()).toBeUndefined();
  });
  it("validates preferences and keys as Python strict mode does", () => {
    // Python Preferences.model_validate와 SettingsInput.apiKey로 계산한 값
    const ok = (fields: Record<string, unknown>) => ({ language: "ko", region: "", speed: 1.35, rememberService: false, deviceUse: "unidentified", browser: "separate", ...fields });
    const cases: Array<[Record<string, unknown>, Record<string, unknown> | undefined]> = [
      [{}, ok({})], [{ speed: 1 }, ok({ speed: 1 })], [{ speed: true }, undefined], [{ speed: "1.2" }, undefined], [{ speed: 0.74 }, undefined],
      [{ speed: 2 }, ok({ speed: 2 })], [{ speed: 2.01 }, undefined], [{ region: "서울" }, ok({ region: "서울특별시" })],
      [{ region: "서울시" }, ok({ region: "서울특별시" })], [{ region: "경기" }, ok({ region: "경기도" })], [{ region: "없는도" }, undefined],
      [{ region: null }, undefined], [{ region: "가".repeat(21) }, undefined], [{ region: "😀".repeat(11) }, undefined],
      [{ language: "fr" }, undefined], [{ language: "EN" }, undefined], [{ language: null }, undefined], [{ rememberService: 1 }, undefined],
      [{ browser: "chrome" }, ok({ browser: "chrome" })], [{ extra: 1 }, undefined],
    ];
    for (const [input, expected] of cases) {
      const parsed = Preferences.safeParse(input);
      expect(parsed.success ? parsed.data : undefined, JSON.stringify(input)).toEqual(expected);
    }
    const keys: Array<[unknown, string | undefined]> = [["", ""], ["  sk-abc  ", "sk-abc"], ["sk abc", undefined], ["sk-é", undefined],
      ["sk-\tx", undefined], ["a".repeat(512), "a".repeat(512)], ["a".repeat(513), undefined], [" " + "a".repeat(512) + " ", "a".repeat(512)],
      ["　sk　", "sk"], [null, undefined], [5, undefined], ["sk-\x7f", undefined]];
    for (const [apiKey, expected] of keys) {
      const parsed = SettingsInput.safeParse({ apiKey });
      expect(parsed.success ? parsed.data.apiKey : undefined, JSON.stringify(apiKey)).toBe(expected);
    }
  });
});

const header = z.tuple([z.string(), z.string()]);
const refusal = z.tuple([z.number(), z.string()]).nullable();
const oracle = z.object({
  origin: z.array(z.tuple([z.array(header), z.string(), z.number().nullable(), z.boolean(), refusal])),
  request: z.array(z.tuple([z.string(), z.string(), z.array(header), refusal])),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/server/request-policy.json", import.meta.url), "utf8")));
const headers = (pairs: Array<[string, string]>) => rawHeaderList(pairs.flat());

describe("request policy", () => {
  it("refuses hosts and origins exactly as Python does", () => {
    for (const [pairs, scheme, port, required, expected] of oracle.origin) {
      expect(originRefusal(headers(pairs), scheme, port ?? undefined, { required }) ?? null, JSON.stringify(pairs)).toEqual(expected);
    }
  });
  it("refuses media types and lengths exactly as Python does", () => {
    for (const [method, path, pairs, expected] of oracle.request) {
      const request = { method, path, scheme: "http", headers: headers([["host", "localhost:8787"], ...pairs]) };
      expect(requestRefusal(request, 8787) ?? null, JSON.stringify([method, path, pairs])).toEqual(expected);
    }
  });
  it("stops reading a body that grows past the limit", async () => {
    async function* chunks() { yield new Uint8Array(4); yield new Uint8Array(4); }
    expect(Array.from(await boundedBody(chunks(), 8) ?? [])).toEqual(Array.from(new Uint8Array(8)));
    expect(await boundedBody(chunks(), 7)).toBeUndefined();
  });
});
