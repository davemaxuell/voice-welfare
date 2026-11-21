import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { evaluationData } from "../core/assets.ts";
import type { WelfareService } from "../agents/welfare/data/index.ts";
import { chunkService, retrieve } from "../agents/welfare/rag.ts";
import { jsRound } from "../core/time.ts";
import type { ScenarioReport } from "./index.ts";

export const RAG_QA_PATH = join(evaluationData, "rag_qa.json");

const numberOrder = (a: number, b: number) => a - b;
function percentile(sorted: readonly number[], percent: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((percent / 100) * sorted.length))] ?? 0;
}
function pct(n: number, total: number) {
  return total === 0 ? 0 : jsRound((n / total) * 1000) / 10;
}
export function summarize(reports: readonly ScenarioReport[]) {
  const steps = reports.flatMap((r) => r.steps);
  return {
    scenarios: reports.length,
    scenariosPassed: reports.filter((r) => r.pass).length,
    steps: steps.length,
    stepsPassed: steps.filter((s) => s.pass).length,
    medianLatencyMs: percentile(steps.map((s) => s.latencyMs).sort(numberOrder), 50),
    note: "합성 시나리오 자동 실행 결과이며 사용자 테스트 결과가 아닙니다.",
  };
}
export function computeMetrics(reports: readonly ScenarioReport[]) {
  const steps = reports.flatMap((r) => r.steps);
  const results = steps.map((s) => s.result);
  const byCategory: Record<string, { passed: number; total: number; percent: number }> = {};
  for (const report of reports) {
    const item = (byCategory[report.category ?? "demo"] ??= { passed: 0, total: 0, percent: 0 });
    item.total++;
    if (report.pass) item.passed++;
  }
  for (const item of Object.values(byCategory)) item.percent = pct(item.passed, item.total);
  const fields = steps.filter((s) => typeof s.expect.field === "string" && typeof s.expect.value === "string");
  const correct = fields.filter(
    ({ result, expect }) =>
      result.field === expect.field &&
      result.value === expect.value &&
      result.observation?.fields.find((f) => f.fieldId === expect.field)?.value === expect.value,
  ).length;
  const executed = results.flatMap((r) => r.actions).filter((a) => a.result?.ok === true);
  const consequential = executed.filter((a) => a.action.risk === "consequential");
  const approved = consequential.filter((a) => a.policy.code === "APPROVED").length;
  const welfare = results.filter(
    (r) => r.semanticAction === "welfare-retrieval" || r.semanticAction === "explain-field",
  );
  const grounded = welfare.filter(
    (r) => r.semanticAction === "welfare-retrieval" ? r.answerCard?.grounded === true : r.sources.length > 0 && r.sources.every((s) => s.url.length > 0 && s.lastCheckedAt.length > 0),
  ).length;
  let repeatedActions = 0;
  for (const report of reports) {
    const ids = report.steps.flatMap(step => step.result.actions.filter(action => action.result?.ok === true).map(action => action.action.id));
    repeatedActions += ids.length - new Set(ids).size;
  }
  const latencies = results.map((r) => r.latencyMs).sort(numberOrder);
  const groups = new Map<string, number[]>();
  for (const result of results) {
    const group = groups.get(result.semanticAction);
    if (group === undefined) groups.set(result.semanticAction, [result.latencyMs]);
    else group.push(result.latencyMs);
  }
  const byAction = Object.fromEntries(
    [...groups].map(
      ([action, values]) => [action, { p50: percentile(values.sort(numberOrder), 50), count: values.length }] as const,
    ),
  );
  const recovery = reports.filter((r) => r.category === "error-recovery");
  const passed = reports.filter((r) => r.pass).length,
    recovered = recovery.filter((r) => r.pass).length;
  return {
    taskCompletion: { passed, total: reports.length, percent: pct(passed, reports.length), byCategory },
    fieldAccuracy: { correct, total: fields.length, percent: pct(correct, fields.length) },
    errorRecovery: { passed: recovered, total: recovery.length, percent: pct(recovered, recovery.length) },
    approvalCompliance: {
      approved,
      executed: consequential.length,
      percent: consequential.length > 0 ? pct(approved, consequential.length) : 100,
    },
    unauthorizedSubmissions: consequential.length - approved,
    repeatedActions,
    groundingRate: { grounded, total: welfare.length, percent: pct(grounded, welfare.length) },
    readOnlyViolations: executed.filter((a) => !["ALLOWED_READ_ONLY", "ALLOWED", "APPROVED", "ALLOWED_NOTICE"].includes(a.policy.code))
      .length,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.at(-1) ?? 0, byAction },
    steps: steps.length,
  };
}
export const RagItemSchema = z.object({ q: z.string(), expected: z.array(z.string()).min(1) });
export const RagQaSchema = z.object({ description: z.string(), service: z.string(), items: z.array(RagItemSchema) });
export type RagQa = z.infer<typeof RagQaSchema>;
export function loadRagQa(path = RAG_QA_PATH): RagQa {
  return RagQaSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
export function evaluateRetrieval(service: WelfareService, qa: RagQa, k = 3) {
  const chunks = chunkService(service);
  let hits = 0,
    reciprocal = 0;
  const misses = [];
  for (const item of qa.items) {
    const ranked = retrieve(item.q, chunks, chunks.length).map((c) => c.section);
    const rank = ranked.findIndex((section) => item.expected.includes(section));
    if (rank >= 0 && rank < k) hits++;
    else misses.push({ q: item.q, expected: item.expected, got: ranked.slice(0, k) });
    if (rank >= 0) reciprocal += 1 / (rank + 1);
  }
  const n = qa.items.length;
  if (n === 0) throw new RangeError("retrieval evaluation requires at least one question");
  return { k, questions: n, recallAtK: hits / n, mrr: reciprocal / n, misses };
}
