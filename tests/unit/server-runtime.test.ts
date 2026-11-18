import { expect, it } from "vitest";
import { loadConfig } from "../../src/server/runtime.ts";
import { listenPort } from "../../src/server/main.ts";

it("test_load_config_role_overrides", () => {
  const cfg = loadConfig({
    LLM_PROVIDER: "openai",
    LLM_MODEL: "gpt-4o-mini",
    LLM_API_KEY: "main",
    LLM_GOAL_PROVIDER: "ollama",
    LLM_GOAL_MODEL: "qwen2.5:7b",
    LLM_UNDERSTAND_MODEL: "gpt-4o",
    REQUIRE_CONSENT: "false",
    HEADLESS: "true",
  });
  expect(cfg.llm.model).toBe("gpt-4o-mini");
  expect(cfg.llmGoal).toMatchObject({ provider: "ollama", model: "qwen2.5:7b" });
  expect(cfg.llmUnderstand).toMatchObject({ provider: "openai", model: "gpt-4o" });
  expect(cfg.llmWeb.model).toBe("gpt-4o-mini");
});

it("test_blank_or_zero_port_settings_fall_back_like_python", () => {
  expect(listenPort(undefined, false, { PORT: "" })).toBe(8787);
  expect(listenPort(undefined, true, { DESKTOP_PORT: "" })).toBe(8790);
  expect(listenPort("0", false, { PORT: "9001" })).toBe(9001);
  expect(listenPort("9002", false, { PORT: "9001" })).toBe(9002);
  expect(() => listenPort("abc", false, {})).toThrow();
});
