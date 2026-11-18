import { expect, it } from "vitest";
import { loadConfig } from "../../src/server/runtime.ts";

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
