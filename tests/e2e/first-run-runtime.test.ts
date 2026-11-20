import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Seal } from "../../src/personal/seal.ts";
import { makeApp } from "../../src/server/app.ts";
import { AgentRuntime, loadConfig } from "../../src/server/runtime.ts";
import { SettingsInput, SettingsStore } from "../../src/server/settings.ts";
import { testRuntimeEnv } from "../helpers.ts";

const roots: string[] = [];
const runtimes: AgentRuntime[] = [];
async function configured(deviceUse: "personal" | "shared", browser: "chrome" | "separate" = "separate") {
  const root = mkdtempSync(join(tmpdir(), "cheongeum-first-run-"));
  roots.push(root);
  const seal = () => new Seal({ key: Buffer.alloc(32, 99) });
  const store = new SettingsStore(join(root, "preferences.json"), seal);
  store.save(SettingsInput.parse({ apiKey: "sk-test", deviceUse, browser }));
  const data = join(root, "data");
  const rt = new AgentRuntime(loadConfig(testRuntimeEnv({ CHEONGEUM_DATA_DIR: data })), undefined, undefined,
    async () => { throw new Error("unexpected provider call"); }, store);
  runtimes.push(rt); rt.sealFactory = seal;
  return { rt, seal, store, data };
}
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(rt => rt.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it("test_personal_pc_choice_opens_a_sealed_store_without_pilot_profile", async () => {
  const { rt, seal, data } = await configured("personal");
  expect(rt.config.pilotProfile).toBe("unidentified"); expect(rt.personalEnabled()).toBe(true);
  const s = await rt.createSession();
  try {
    expect(s.deps.personal?.persistent).toBe(true);
    s.deps.personal?.setGuardian({ name: "홍길동", phone: "01011223344" });
    const bytes = readFileSync(join(data, "personal.json"));
    expect(seal().isSealed(bytes)).toBe(true); expect(bytes.includes(Buffer.from("홍길동"))).toBe(false);
  } finally { await s.close(); }
});
it("test_shared_pc_choice_has_no_personal_store", async () => {
  const { rt } = await configured("shared"); const s = await rt.createSession();
  try { expect(rt.personalEnabled()).toBe(false); expect(s.deps.personal).toBeUndefined(); }
  finally { await s.close(); }
});
it("test_switching_to_shared_drops_the_store_for_new_sessions", async () => {
  const { rt, store } = await configured("personal");
  const first = await rt.createSession();
  try {
    expect(first.deps.personal).toBeDefined();
    store.save(SettingsInput.parse({ deviceUse: "shared" })); rt.refreshServices();
    const second = await rt.createSession();
    try { expect(second.deps.personal).toBeUndefined(); expect(rt.personalStore()).toBeUndefined(); }
    finally { await second.close(); }
  } finally { await first.close(); }
});
it("test_usual_chrome_is_chosen_only_on_a_personal_pc", async () => {
  expect((await configured("personal", "chrome")).rt.browserMode()).toBe("chrome");
  expect((await configured("shared", "chrome")).rt.browserMode()).toBe("chromium");
});
it("test_usual_chrome_that_cannot_start_falls_back_to_separate_browser", async () => {
  const { rt } = await configured("personal", "chrome");
  vi.spyOn(rt, "openChrome").mockRejectedValue(new Error("no Chrome"));
  const api = makeApp(rt), s = await rt.createSession();
  try {
    expect(rt.browserFallback).toBe(true); expect(s.web.adapter.page).toBeDefined();
    expect(await (await api.request("/api/settings")).json()).toMatchObject({ browserFallback: true });
  } finally { await s.close(); await api.sessions.close(); }
});
