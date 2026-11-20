import { expect, it } from "vitest";
import type { ExecutedAction, TurnResult } from "../../src/core/turn.ts";
import { computeMetrics, summarize, type ScenarioReport, type StepReport } from "../../src/evaluation/index.ts";

function action(code: string, ok: boolean): ExecutedAction {
  return {
    agent: "browser",
    action: { id: "submit", type: "click", risk: "consequential", requiresConfirmation: true, reason: "신청" },
    policy: { code, allowed: code === "APPROVED", reason: code },
    result: { actionId: "submit", ok, verified: ok, latencyMs: 0 },
  };
}

function step(latencyMs: number, extra: Partial<TurnResult>, expect: StepReport["expect"] = {}): StepReport {
  const result: TurnResult = {
    sessionId: "s",
    turnId: "t",
    userUtterance: "",
    intentType: "UNKNOWN",
    state: "IDLE",
    semanticAction: "none",
    speech: "",
    lang: "ko",
    trace: [],
    actions: [],
    sources: [],
    missingFields: [],
    pendingActions: 0,
    realSubmission: false,
    flags: { secretDetected: false, masked: false },
    latencyMs,
    ...extra,
  };
  return {
    result,
    expect,
    utterance: "",
    pass: true,
    failures: [],
    state: result.state,
    semanticAction: result.semanticAction,
    latencyMs,
  };
}

it("scores completed actions, screen-verified fields, citations, recovery and numeric latency quantiles", () => {
  const observation = {
    page: "form",
    url: "https://example.test/",
    title: "form",
    errors: [],
    fields: [
      {
        fieldId: "f",
        label: "f",
        type: "text",
        required: true,
        visible: true,
        value: "yes",
        filled: true,
        invalid: false,
        sensitive: false,
      },
    ],
  };
  const field = { field: "f", value: "yes" };
  const reports: ScenarioReport[] = [
    {
      id: "A",
      pass: true,
      steps: [
        step(
          100,
          {
            ...field,
            observation,
            semanticAction: "explain-field",
            sources: [{ title: "Evidence", url: "https://example.test/", lastCheckedAt: "2026-01-01" }],
            actions: [action("APPROVED", true), action("DENIED", false)],
          },
          field,
        ),
      ],
    },
    {
      id: "B",
      category: "error-recovery",
      pass: false,
      steps: [
        step(
          9,
          {
            ...field,
            observation: { ...observation, fields: [] },
            semanticAction: "welfare-retrieval",
            actions: [action("DENIED", true)],
          },
          field,
        ),
        step(12, {}),
      ],
    },
  ];
  reports[1]!.steps[0]!.pass = false;
  expect(computeMetrics(reports)).toMatchObject({
    taskCompletion: {
      passed: 1,
      total: 2,
      percent: 50,
      byCategory: { demo: { percent: 100 }, "error-recovery": { percent: 0 } },
    },
    fieldAccuracy: { correct: 1, total: 2, percent: 50 },
    errorRecovery: { passed: 0, total: 1, percent: 0 },
    approvalCompliance: { approved: 1, executed: 2, percent: 50 },
    unauthorizedSubmissions: 1,
    groundingRate: { grounded: 1, total: 2, percent: 50 },
    readOnlyViolations: 1,
    latencyMs: { p50: 12, p95: 100, max: 100, byAction: { "welfare-retrieval": { p50: 9, count: 1 } } },
    steps: 3,
  });
  expect(summarize(reports)).toMatchObject({
    scenarios: 2,
    scenariosPassed: 1,
    steps: 3,
    stepsPassed: 2,
    medianLatencyMs: 12,
  });
  expect(computeMetrics([])).toMatchObject({
    approvalCompliance: { percent: 100 },
    latencyMs: { p50: 0, p95: 0, max: 0 },
    steps: 0,
  });
});

it("counts repeated successful action IDs within a scenario and grounded welfare cards", () => {
  const source = {title:"Evidence",url:"https://example.test/",lastCheckedAt:"2026-01-01"};
  const result = {semanticAction:"welfare-retrieval",sources:[source],actions:[action("APPROVED",true)]} as const;
  const first = step(0,{...result,actions:[...result.actions],sources:[source],answerCard:{
    serviceId:"id",serviceName:"서비스",answer:"지원",fields:["benefit"],grounded:true,source,dataKind:"live",dataOrigin:"official-api",nextAction:"확인",
  }});
  const next = step(0,{semanticAction:"welfare-retrieval",sources:[source],actions:[action("APPROVED",true),action("DENIED",false)]});
  const scores = computeMetrics([{id:"a",pass:true,steps:[first,next]}, {id:"b",pass:true,steps:[next]}]);
  expect(scores.repeatedActions).toBe(1);
  expect(scores.groundingRate).toMatchObject({grounded:1,total:3});
});
