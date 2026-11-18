import { expect, it } from "vitest";
import { checkExpectations, DEMO_SCENARIO_PATH, isActivePc, loadScenarioFile } from "../../src/evaluation/index.ts";

it("test_scenario_file_and_evaluator", () => {
  const file = loadScenarioFile(DEMO_SCENARIO_PATH);
  expect(file.scenarios.filter(isActivePc).map(s => s.id)).toEqual([
    "S1-normal-flow", "S2-field-validation", "S3-sensitive-auth-handoff", "S4-stop-cancel",
  ]);
  const failures = checkExpectations({ utterance: "x", expect: { somethingNew: true } },
    { state: "IDLE", actions: [], sources: [], missingFields: [], speech: "", flags: { masked: false, secretDetected: false } }, "[]");
  expect(failures).toEqual(["somethingNew: unsupported expectation key"]);
});
