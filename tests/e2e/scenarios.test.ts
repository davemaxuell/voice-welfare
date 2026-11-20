import { afterAll, afterEach, expect, it } from "vitest";
import { DEMO_SCENARIO_PATH, isActivePc, loadScenarioFile, runScenario } from "../../src/evaluation/index.ts";
import { createTestRuntime } from "./session-runtime.ts";

const runtime = createTestRuntime();
afterEach(runtime.closeSessions);
afterAll(runtime.close);
const { scenarios } = loadScenarioFile(DEMO_SCENARIO_PATH);
it.each(scenarios.filter(s => isActivePc(s) || s.id === "S5-agent-collaboration"))("test_demo_scenario", async scenario => {
  const { session } = await runtime.createBrowserSession();
  const report = await runScenario(scenario, session);
  const failures = report.steps.filter(s => !s.pass).map(s => s.utterance + " → " + s.failures.join(", "));
  expect(failures, scenario.id).toEqual([]);
});
