import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { stopPlaywright } from "../src/agents/web/browser/index.ts";
import { REPO_ROOT } from "../src/core/assets.ts";
import { SessionStateSchema } from "../src/core/turn.ts";
import { redactText } from "../src/safety/privacy.ts";
import { AgentRuntime, loadConfig } from "../src/server/runtime.ts";

const actionTypes = new Set(["FOLLOW_LINK", "FILL", "SEARCH", "OPEN_SITE", "GOAL", "START_APPLICATION",
  "PREPARE_SUBMIT", "LOGIN", "CLEAR_LOGIN", "NEXT", "PREV", "REJECT", "APPROVE"]);
const casesSchema = z.array(z.object({ text: z.string(), state: SessionStateSchema, expect: z.array(z.string()), fast: z.boolean() })).nonempty();

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string", default: join(REPO_ROOT, "reports/understanding-eval.md") }, help: { type: "boolean", short: "h" } } });
  if (values.help === true) { console.log("node scripts/eval-understanding.ts [--out FILE]"); return 0; }
  const dotenv = join(REPO_ROOT, ".env");
  if (existsSync(dotenv)) process.loadEnvFile(dotenv);
  const cases = casesSchema.parse(JSON.parse(await readFile(join(REPO_ROOT, "tests/fixtures/understanding_cases.json"), "utf8")));
  const runtime = await AgentRuntime.create(loadConfig({ ...process.env, HEADLESS: "true", REQUIRE_CONSENT: "false", PILOT_PROFILE: "shared" }));
  try {
    const llm = runtime.sessionModels().llm;
    if (llm === undefined) { console.error("비교 평가에 쓸 말 이해 모델을 설정해 주세요."); return 1; }
    const session = await runtime.createSession({ background: true });
    try {
      let calls = 0, failedCalls = 0, fastCalls = 0, fallbacks = 0, correct = 0, wrongActions = 0;
      const rows: string[] = [], times: number[] = [];
      session.deps.llm = { name: llm.name, async generate(request) {
        calls++;
        try {
          const result = await llm.generate(request);
          if (result === undefined) failedCalls++;
          return result;
        } catch (error) { failedCalls++; throw error; }
      } };
      for (const c of cases) {
        const previous = calls, start = performance.now();
        const plan = await session.understanding.understand(redactText(c.text), { state: c.state }, {
          clarifying: false, recent: [], trace: () => {},
        });
        const ms = performance.now() - start, kind = plan.intents[0]!.type;
        const ok = c.expect.includes(kind);
        times.push(ms);
        correct += Number(ok); wrongActions += Number(!ok && actionTypes.has(kind)); fallbacks += Number(plan.by === "rules-fallback");
        if (c.fast) fastCalls += calls - previous;
        rows.push(`| ${c.text} | ${c.state} | ${c.expect.join(", ")} | ${kind} | ${plan.by} | ${ok ? "통과" : "실패"} | ${calls - previous} | ${ms.toFixed(1)} |`);
      }
      times.sort((a, b) => a - b);
      const mean = times.reduce((s, n) => s + n, 0) / times.length, p95 = times[Math.ceil(times.length * 0.95) - 1]!;
      const lines = ["# 말 이해 평가", "", "- 모델 " + llm.name,
        `- 정확도 ${correct}/${cases.length} (${(100 * correct / cases.length).toFixed(1)}%)`, `- 잘못 선택한 조작 ${wrongActions}건`,
        `- 빠른 길 모델 호출 ${fastCalls}회`, `- 전체 모델 호출 ${calls}회 (응답 없음 ${failedCalls}회, 규칙 대체 ${fallbacks}건)`,
        `- 평균 ${mean.toFixed(1)} ms · p95 ${p95.toFixed(1)} ms (최근접 순위)`, "",
        "| 발화 | 상태 | 기대 | 실제 | 판정 경로 | 결과 | 모델 호출 | 시간(ms) |", "|---|---|---|---|---|---|---:|---:|", ...rows];
      await mkdir(dirname(values.out), { recursive: true });
      await writeFile(values.out, lines.join("\n") + "\n");
      console.log(lines.slice(0, 8).join("\n"));
      return Number(fastCalls > 0 || failedCalls > 0 || fallbacks > 0);
    } finally { await session.close(); }
  } finally { await runtime.close(); await stopPlaywright(); }
}
if (import.meta.main) process.exitCode = await main();
