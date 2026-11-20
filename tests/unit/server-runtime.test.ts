import { expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Seal } from "../../src/personal/seal.ts";
import { SettingsStore } from "../../src/server/settings.ts";
import { AgentRuntime, loadConfig } from "../../src/server/runtime.ts";
import { STACK } from "../../src/core/model_stack.ts";
import { createVoiceProviders } from "../../src/voice/config.ts";
import { OpenAISttProvider, UnsupportedSttProvider } from "../../src/voice/stt.ts";
import { makeApp, speechPace } from "../../src/server/app.ts";
import { listenPort, main } from "../../src/server/main.ts";

it("test_load_config_role_overrides", () => {
  const cfg = loadConfig({
    LLM_PROVIDER: "openai",
    LLM_MODEL: "gpt-4o-mini",
    LLM_API_KEY: "main",
    LLM_GOAL_PROVIDER: "openai-compatible",
    LLM_GOAL_MODEL: "qwen2.5:7b",
    LLM_UNDERSTAND_MODEL: "gpt-4o",
    REQUIRE_CONSENT: "false",
    HEADLESS: "true",
  });
  expect(cfg.llm.model).toBe("gpt-4o-mini");
  expect(cfg.llmGoal).toMatchObject({ provider: "openai-compatible", model: "qwen2.5:7b" });
  expect(cfg.llmGoal.apiKey).toBeUndefined();
  expect(cfg.llmUnderstand).toMatchObject({ provider: "openai", model: "gpt-4o" });
  expect(cfg.llmWeb.model).toBe(STACK.utility);
});

it("test_single_key_defaults_and_independent_role_endpoints", () => {
  const cfg = loadConfig({ LLM_API_KEY: "local-test-key" });
  expect([cfg.voice.liveModel, cfg.llm.model, cfg.llmWeb.model, cfg.llmVision.model, cfg.llmRecovery.model, cfg.voice.sttModel])
    .toEqual([STACK.voice, STACK.agent, STACK.utility, STACK.vision, STACK.recovery, STACK.transcription]);
  expect([cfg.voice.apiKey, cfg.llmUnderstand.apiKey, cfg.llmRecovery.apiKey]).toEqual(Array<string>(3).fill("local-test-key"));
  const mixed = loadConfig({ OPENAI_API_KEY: "local-test-key", LLM_WEB_BASE_URL: "https://other.example/v1", VOICE_BASE_URL: "https://voice.example/v1" });
  expect(mixed.llmWeb.apiKey).toBeUndefined();
  expect(mixed.voice.apiKey).toBeUndefined();
});

it("test_legacy_settings_use_only_authenticated_voice_apis", () => {
  for (const legacy of ["local", "browser", "mock"]) {
    const env = { STT_PROVIDER: legacy, TTS_PROVIDER: legacy, STT_LOCAL_MODEL: "old/model", STT_BASE_URL: "http://localhost:8000/v1" };
    const [stt, tts] = createVoiceProviders(loadConfig(env).voice);
    expect(stt).toBeInstanceOf(UnsupportedSttProvider); expect(tts.supported).toBe(false);
    const [keyedStt, keyedTts] = createVoiceProviders(loadConfig({ ...env, OPENAI_API_KEY: "sk-test" }).voice);
    expect(keyedStt).toBeInstanceOf(OpenAISttProvider); expect(keyedTts.supported).toBe(true);
    expect([keyedStt.baseUrl, keyedTts.baseUrl]).toEqual(["https://api.openai.com/v1", "https://api.openai.com/v1"]);
  }
});

it("test_pace_from_saved_rate", () => {
  expect(speechPace(1.25)).toBe(1);
  expect(speechPace(0.9)).toBeCloseTo(0.72);
  for (const rate of [null, "빠르게", 50, false]) expect(speechPace(rate)).toBeUndefined();
});

it("test_check_key_endpoint_never_echoes_the_key", async () => {
  const seen: string[] = [];
  const rt = await AgentRuntime.create(loadConfig({}), async (input, init) => {
    seen.push(String(input), new Headers(init?.headers).get("authorization") ?? "");
    return new Response(null, { status: 401 });
  });
  const api = makeApp(rt);
  const check = (body: object) => api.request("/api/settings/check-key", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    expect(await (await check({ apiKey: "sk-secret-123" })).json()).toEqual({ result: "invalid" });
    const bad = await check({ apiKey: "has space" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("has space");
    expect((await check({})).status).toBe(400);
    expect(seen).toEqual(["https://api.openai.com/v1/models", "Bearer sk-secret-123"]);
  } finally { await rt.close(); }
});

it("test_saving_without_any_key_is_refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cheongeum-settings-"));
  const store = new SettingsStore(join(dir, "preferences.json"), () => new Seal({ key: Buffer.alloc(32, 99) }));
  const runtime = new AgentRuntime(loadConfig({}), undefined, undefined, async () => { throw new Error("unexpected provider call"); }, store);
  const api = makeApp(runtime);
  const save = (body: object) => api.request("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    expect(await (await api.request("/api/health")).json()).toMatchObject({ setupRequired: true, firstRun: "stage2", stt: { supported: false } });
    const refused = await save({ deviceUse: "personal" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "KEY_REQUIRED" });
    expect(existsSync(store.path)).toBe(false);
    expect((await save({ deviceUse: "personal", apiKey: "sk-test" })).status).toBe(200);
  } finally { await api.workflows.close(); await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("uses the configured port unless an explicit port was requested", () => {
  expect(listenPort(undefined, false, { PORT: "" })).toBe(8787);
  expect(listenPort(undefined, true, { DESKTOP_PORT: "" })).toBe(8790);
  expect(listenPort("0", false, { PORT: "9001" })).toBe(0);
  expect(listenPort("9002", false, { PORT: "9001" })).toBe(9002);
  expect(() => listenPort("abc", false, {})).toThrow();
});

it("starts the CLI on a bound loopback port using an explicitly supplied settings file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cheongeum-cli-"));
  const envFile = join(dir, "service.env");
  writeFileSync(envFile, "\ufeffCHEONGEUM_SETTINGS_DIR=" + JSON.stringify(dir) + "\nLLM_PROVIDER=mock\nPII_MODEL=\n", "utf8");
  const saved = new Map(["CHEONGEUM_SETTINGS_DIR", "LLM_PROVIDER", "PII_MODEL"].map(key => [key, process.env[key]]));
  try {
    for (const key of saved.keys()) delete process.env[key];
    const service = await main(["--no-mock", "--host", "127.0.0.1", "--port", "0", "--env-file", envFile]);
    try {
      const addr = service.server.address();
      if (addr === null || typeof addr === "string") throw new Error("no TCP listener");
      const data = await (await fetch("http://127.0.0.1:" + addr.port + "/api/health")).json();
      expect(data).toMatchObject({ setupRequired: true, settingsAvailable: true, firstRun: "stage2" });
      expect(data).toHaveProperty("datasets");
    } finally { await service.stop(); }
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  }
});
