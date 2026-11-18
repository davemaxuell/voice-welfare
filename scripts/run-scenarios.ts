import { textOr } from "../src/core/text.ts";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { z } from "zod";
import { launchBrowser, stopPlaywright } from "../src/agents/web/browser/index.ts";
import { parseWelfareDetail } from "../src/agents/welfare/data/index.ts";
import { axeScript, REPO_ROOT } from "../src/core/assets.ts";
import {
  DEMO_SCENARIO_PATH,
  SYNTHETIC_SCENARIO_PATH,
  isActivePc,
  loadScenarioFile,
  runScenario,
  type ScenarioReport,
} from "../src/evaluation/index.ts";
import { computeMetrics, evaluateRetrieval, loadRagQa } from "../src/evaluation/metrics.ts";
import { ensureMockSite } from "./mock-site.ts";
import { makeApp } from "../src/server/app.ts";
import { AgentRuntime, loadConfig } from "../src/server/runtime.ts";

const axeResult = z.object({
  violations: z.array(
    z.object({
      id: z.string(),
      impact: z.string().nullable().optional(),
      help: z.string(),
      nodes: z.array(z.unknown()),
    }),
  ),
});
interface Scan {
  page: string;
  violations: { id: string; impact: string | null; help: string; nodes: number }[];
}

async function scanPages(base: string, runtime: AgentRuntime): Promise<Scan[]> {
  const app = makeApp(runtime, { web: true });
  const server = createServer(getRequestListener(app.fetch));
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw Error("Missing local UI server port");
    const ui = "http://127.0.0.1:" + address.port + "/";
    const browser = await launchBrowser(true);
    try {
      const page = await browser.newPage();
      const scans: Scan[] = [];
      const consentButton = page.getByRole("button", { name: /안내 듣고 시작하기/u });
      async function scan(label: string, url: string, prepare?: () => Promise<void>) {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await prepare?.();
        await page.addScriptTag({ path: axeScript });
        const { violations } = axeResult.parse(
          await page.evaluate(
            "axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}})",
          ),
        );
        scans.push({
          page: label,
          violations: violations.map((v) => ({
            id: v.id,
            impact: v.impact ?? null,
            help: v.help,
            nodes: v.nodes.length,
          })),
        });
      }
      await scan("웹 UI(시작 동의 화면)", ui, () => consentButton.waitFor({ timeout: 15000 }));
      await scan("웹 UI(고대비)", ui, async () => {
        await consentButton.waitFor({ timeout: 15000 });
        await page.getByRole("button", { name: /고대비/u }).click();
      });
      await scan("모의 사이트 첫 화면", base + "/");
      await scan("모의 신청서 1단계", base + "/apply.html");
      await scan("모의 신청서 오류 상태", base + "/apply.html", () =>
        page.getByRole("button", { name: "다음", exact: true }).click(),
      );
      await scan("모의 본인인증", base + "/login.html");
      await scan("합성 외부 포털", "http://127.0.0.1:5174/external.html");
      return scans;
    } finally {
      await browser.close();
    }
  } finally {
    if (server.listening)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    await app.sessions.close();
  }
}

async function writeReport(
  reports: ScenarioReport[],
  rag: ReturnType<typeof evaluateRetrieval>,
  accessibility: Scan[],
) {
  const generatedAt = new Date().toISOString();
  const metrics = computeMetrics(reports);
  const {
    taskCompletion: tc,
    fieldAccuracy: fa,
    errorRecovery: er,
    approvalCompliance: ac,
    groundingRate: gr,
    latencyMs: lat,
  } = metrics;
  const failed = reports.filter((r) => !r.pass);
  const secretFailures = reports
    .flatMap((r) => r.steps.flatMap((s) => s.failures))
    .filter((f) => /mustNot(Persist|Speak)Secret|mustNotAutoEnter/u.test(f)).length;
  for (const r of reports) {
    console.log((r.pass ? "PASS" : "FAIL") + "  " + r.id);
    for (const s of r.steps.filter((s) => !s.pass))
      console.log('   ✗ "' + s.utterance + '" → ' + s.state + "/" + s.semanticAction + " " + s.failures.join("; "));
  }
  const summary = {
    scenarios: tc,
    fieldAccuracy: fa,
    errorRecovery: er,
    approvalCompliance: ac,
    unauthorizedSubmissions: metrics.unauthorizedSubmissions,
    groundingRate: gr,
    readOnlyViolations: metrics.readOnlyViolations,
    secretLeakFailures: secretFailures,
    latencyMs: { p50: lat.p50, p95: lat.p95, max: lat.max },
    rag: { k: rag.k, questions: rag.questions, recallAtK: rag.recallAtK, mrr: Number(rag.mrr.toFixed(3)) },
    accessibility: {
      pages: accessibility.length,
      violations: accessibility.reduce((sum, p) => sum + p.violations.length, 0),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  const byCategory = Object.entries(tc.byCategory)
    .map(([key, v]) => `- ${key}: ${v.percent.toFixed(1)}% (${v.passed}/${v.total})`)
    .join("\n");
  const byAction = Object.entries(lat.byAction)
    .sort(([, a], [, b]) => b.p50 - a.p50)
    .map(([key, v]) => `- ${key}: ${v.p50}ms (${v.count}회)`)
    .join("\n");
  const misses = textOr(
    rag.misses.map((m) => `- 놓친 질문: "${m.q}" (정답 ${m.expected.join("/")}, 상위 ${m.got.join(", ")})`).join("\n"),
    "- 놓친 질문 없음",
  );
  const a11yRows = accessibility
    .map(
      (p) =>
        `| ${p.page} | ${p.violations.length} | ${textOr(p.violations.map((v) => `${v.id}(${v.impact}, ${v.nodes}곳)`).join(", "), "없음")} |`,
    )
    .join("\n");
  const failureText = textOr(
    failed
      .map(
        (r) =>
          "- " +
          r.id +
          ": " +
          r.steps
            .filter((s) => !s.pass)
            .map((s) => '"' + s.utterance + '" → ' + s.failures.join("; "))
            .join(" / "),
      )
      .join("\n"),
    "- 없음",
  );
  const md = `# 평가 보고서 (자동 생성)

- 생성: ${generatedAt}
- 범위: 합성 데이터·모의 사이트·로컬 합성 포털. **실제 사용자 테스트 결과가 아닙니다.** 목표치는 PRD §12의 실험 전 가설입니다.
- 실행 조건: 의도 분석 = 규칙 파서(mock, 재현성 위해 LLM 미사용), 복지 데이터 = fixture, 브라우저 = Chromium(headless)
- 시나리오: demo_scenarios.json(활성 4 + 구현된 S5) + 합성 30건(정상 10·오류복구 10·안전중단 10), 총 ${reports.length}개 / ${metrics.steps}단계

## PRD 지표

| 지표 | 결과 | 목표(PRD, 가설) |
|---|---|---|
| 과업 완료율 | ${tc.percent.toFixed(1)}% (${tc.passed}/${tc.total}) | ≥ 90% |
| 필드 입력 정확도(화면 값까지 일치) | ${fa.percent.toFixed(1)}% (${fa.correct}/${fa.total}) | ≥ 95% |
| 오류 복구율 | ${er.percent.toFixed(1)}% (${er.passed}/${er.total}) | ≥ 90% |
| 위험행위 사전 승인 준수 | ${ac.percent.toFixed(1)}% (${ac.approved}/${ac.executed}) | 100% |
| 무단 제출 | ${metrics.unauthorizedSubmissions}건 | 0건 |
| 정책·항목 답변 근거율 | ${gr.percent.toFixed(1)}% (${gr.grounded}/${gr.total}) | 100% |
| 읽기 전용 위반 | ${metrics.readOnlyViolations}건 | 0건 |
| 비밀값 저장·발화·입력 | ${secretFailures}건 | 0건 |
| 응답 지연(서버 처리, 음성 제외) | p50 ${lat.p50}ms · p95 ${lat.p95}ms | — |

### 범주별 과업 완료율
${byCategory}

### 동작별 응답 지연 p50
${byAction}

## RAG 검색 정확도
- 데이터: 장애인연금 공식 API 상세 응답(2026-11-16 저장), 질문 ${rag.questions}개(src/evaluation/data/rag_qa.json)
- Recall@${rag.k}: **${(rag.recallAtK * 100).toFixed(1)}%**, MRR: **${rag.mrr.toFixed(3)}**
- 한계: 질문과 검색 규칙을 같은 사람이 만들어 낙관적일 수 있음 → 팀 외부에서 작성한 질문 세트로 재평가 필요
${misses}

## 접근성 자동 검사 (axe-core, WCAG 2.1 A/AA)
- 자동 검사는 일부 기준만 확인합니다. 화면낭독기(NVDA/VoiceOver) 실사용 검사를 대신하지 않습니다.

| 화면 | 위반 규칙 수 | 내용 |
|---|---|---|
${a11yRows}

## 실패한 시나리오
${failureText}

## 측정하지 않은 것
- 실제 시각장애인 사용자 과업 테스트·만족도, 화면낭독기 단독 대비 비교(Baseline)
- 음성 인식 정확도(STT)·음성 포함 종단 지연, LLM 사용 시 의도 분석·답변 품질(이 실행은 재현성을 위해 규칙 파서 사용)
- 실제 공공 사이트에서의 성공률(사이트마다 구조가 달라 별도 측정 필요)
`;
  const scenarios = reports.map((r) => ({
    id: r.id,
    category: r.category ?? null,
    pass: r.pass,
    steps: r.steps.map(({ utterance, pass, failures, state, semanticAction, latencyMs }) => ({
      utterance,
      pass,
      failures,
      state,
      semanticAction,
      latencyMs,
    })),
  }));
  const dir = join(REPO_ROOT, "reports");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "evaluation-report.md"), md);
  await writeFile(
    join(dir, "evaluation-report.json"),
    JSON.stringify({ generatedAt, summary, metrics, rag, accessibility, scenarios }, null, 2),
  );
  console.log("\n보고서: reports/evaluation-report.md");
}

export async function main() {
  const demo = loadScenarioFile(DEMO_SCENARIO_PATH);
  const synthetic = loadScenarioFile(SYNTHETIC_SCENARIO_PATH);
  const mock = await ensureMockSite(Number(textOr(new URL(demo.baseUrl).port, "80")));
  const env = {
    MOCK_SITE_URL: demo.baseUrl,
    HEADLESS: process.env.HEADED === "1" ? "false" : "true",
    LLM_PROVIDER: "mock",
    REQUIRE_CONSENT: "false",
    READ_ONLY_WEB: "true",
    READ_ONLY_CLICKS: "safe",
    VISUAL_CURSOR: "false",
    WEB_SEARCH_URL: "http://127.0.0.1:5174/external.html?q={q}",
    PII_MODEL: process.env.PII_MODEL,
  };
  try {
    const runtime = await AgentRuntime.create(loadConfig(env));
    const reports: ScenarioReport[] = [];
    try {
      for (const s of [
        ...demo.scenarios.filter((s) => isActivePc(s) || s.id === "S5-agent-collaboration"),
        ...synthetic.scenarios,
      ]) {
        const session = await runtime.createSession();
        try {
          reports.push(await runScenario(s, session));
        } finally {
          await session.close();
        }
      }
    } finally {
      await runtime.close();
    }
    const xml = await readFile(join(REPO_ROOT, "tests/fixtures/welfare-detail-WLF00003249.xml"), "utf8");
    const rag = evaluateRetrieval(parseWelfareDetail(xml, "https://www.bokjiro.go.kr/"), loadRagQa(), 3);
    const consent = await AgentRuntime.create(loadConfig({ ...env, REQUIRE_CONSENT: "true" }));
    try {
      await writeReport(reports, rag, await scanPages(demo.baseUrl, consent));
    } finally {
      await consent.close();
    }
  } finally {
    await stopPlaywright();
    await mock?.close();
  }
}

if (import.meta.main) await main();
