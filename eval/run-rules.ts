/**
 * 규칙 평가(AI 끔, 재현성 우선): 결과는 eval/results/rules-report.{md,json}.
 *  1) demo_scenarios.json(활성 PC + 구현된 Phase 2) + 합성 시나리오 30건 실행 → PRD §12 지표
 *  2) RAG 검색 정확도(Recall@3, MRR) — 저장된 공식 API 응답 기준
 *  3) 접근성 자동 검사(axe-core, WCAG 2.1 A/AA) — 웹 UI·모의 사이트·합성 포털
 * 사용: npm run eval   (HEADED=1 이면 브라우저 창 표시)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import {
  computeMetrics,
  evaluateRetrieval,
  isActivePc,
  loadRagQa,
  loadScenarioFile,
  runScenario,
  type ScenarioReport,
} from '@ieum/evaluation';
import { parseWelfareDetail } from '@ieum/welfare-data';
import { isReachable, startMockSite } from '../apps/mock-welfare/serve';
import { createApp } from '../apps/server/src/app';
import { AgentRuntime, loadConfig } from '../apps/server/src/runtime';

const root = fileURLToPath(new URL('..', import.meta.url));
const demo = loadScenarioFile(`${root}eval/datasets/legacy/demo_scenarios.json`);
const synthetic = loadScenarioFile(`${root}eval/datasets/legacy/scenarios_30.json`);
const IMPLEMENTED_PHASE2 = ['S5-agent-collaboration'];

const mock = (await isReachable(demo.baseUrl)) ? undefined : await startMockSite(Number(new URL(demo.baseUrl).port));
const env = {
  MOCK_SITE_URL: demo.baseUrl,
  HEADLESS: process.env.HEADED === '1' ? 'false' : 'true',
  LLM_PROVIDER: 'mock',
  REQUIRE_CONSENT: 'false',
  READ_ONLY_WEB: 'true',
  VISUAL_CURSOR: 'false',
  WEB_SEARCH_URL: 'http://127.0.0.1:5174/external.html?q={q}',
};
const runtime = new AgentRuntime(loadConfig(env));

// ---------------------------------------------------------------- 1) 시나리오
const reports: ScenarioReport[] = [];
const scenarios = [
  ...demo.scenarios.filter((s) => isActivePc(s) || IMPLEMENTED_PHASE2.includes(s.id)),
  ...synthetic.scenarios,
];
for (const scenario of scenarios) {
  const session = await runtime.createSession();
  try {
    reports.push(await runScenario(scenario, session));
  } finally {
    await session.close();
  }
}
const metrics = computeMetrics(reports);
const secretFailures = reports
  .flatMap((r) => r.steps)
  .flatMap((s) => s.failures)
  .filter((f) => /mustNot(Persist|Speak)Secret|mustNotAutoEnter/.test(f)).length;

// ---------------------------------------------------------------- 2) RAG 검색 정확도
const detail = readFileSync(`${root}tests/fixtures/welfare-detail-WLF00003249.xml`, 'utf8');
const rag = evaluateRetrieval(parseWelfareDetail(detail, 'https://www.bokjiro.go.kr/'), loadRagQa(), 3);

// ---------------------------------------------------------------- 3) 접근성(axe)
interface AxeResult {
  page: string;
  violations: { id: string; impact: string | null | undefined; help: string; nodes: number }[];
}
const a11y: AxeResult[] = [];
{
  const consentRuntime = new AgentRuntime(loadConfig({ ...env, REQUIRE_CONSENT: 'true' }));
  const { app, closeAll } = createApp(consentRuntime);
  const api = app.listen(0);
  await new Promise((r) => api.once('listening', r));
  process.env.IEUM_API_TARGET = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const web = await createServer({ root: `${root}apps/web`, configFile: `${root}apps/web/vite.config.ts`, server: { port: 0, strictPort: false }, logLevel: 'silent' });
  await web.listen();
  const webUrl = web.resolvedUrls?.local[0] ?? 'http://localhost:5173/';

  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const scan = async (label: string, url: string, prepare?: () => Promise<void>) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await prepare?.();
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    a11y.push({ page: label, violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length })) });
  };
  await scan('웹 UI(시작 동의 화면)', webUrl, () => page.getByRole('button', { name: /안내 듣고 시작하기/ }).waitFor({ timeout: 15000 }));
  await scan('웹 UI(고대비)', webUrl, async () => {
    await page.getByRole('button', { name: /안내 듣고 시작하기/ }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: /고대비/ }).click();
  });
  await scan('모의 사이트 첫 화면', `${demo.baseUrl}/`);
  await scan('모의 신청서 1단계', `${demo.baseUrl}/apply.html`);
  await scan('모의 신청서 오류 상태', `${demo.baseUrl}/apply.html`, () => page.getByRole('button', { name: '다음', exact: true }).click());
  await scan('모의 본인인증', `${demo.baseUrl}/login.html`);
  await scan('합성 외부 포털', 'http://127.0.0.1:5174/external.html');
  await browser.close();
  await web.close();
  await closeAll();
  await new Promise((r) => api.close(r));
  await consentRuntime.close();
}

await runtime.close();
await mock?.close();

// ---------------------------------------------------------------- 보고서
const fail = reports.filter((r) => !r.pass);
for (const r of reports) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}`);
  for (const s of r.steps.filter((x) => !x.pass)) console.log(`   ✗ "${s.utterance}" → ${s.state}/${s.semanticAction} ${s.failures.join('; ')}`);
}
const a11yTotal = a11y.reduce((n, p) => n + p.violations.length, 0);
const summary = {
  scenarios: metrics.taskCompletion,
  fieldAccuracy: metrics.fieldAccuracy,
  errorRecovery: metrics.errorRecovery,
  approvalCompliance: metrics.approvalCompliance,
  unauthorizedSubmissions: metrics.unauthorizedSubmissions,
  groundingRate: metrics.groundingRate,
  readOnlyViolations: metrics.readOnlyViolations,
  secretLeakFailures: secretFailures,
  latencyMs: { p50: metrics.latencyMs.p50, p95: metrics.latencyMs.p95, max: metrics.latencyMs.max },
  rag: { k: rag.k, questions: rag.questions, recallAtK: rag.recallAtK, mrr: Number(rag.mrr.toFixed(3)) },
  accessibility: { pages: a11y.length, violations: a11yTotal },
};
console.log(JSON.stringify(summary, null, 2));

const row = (label: string, value: string, target: string) => `| ${label} | ${value} | ${target} |`;
const md = `# 평가 보고서 (자동 생성)

- 생성: ${new Date().toISOString()}
- 범위: 합성 데이터·모의 사이트·로컬 합성 포털. **실제 사용자 테스트 결과가 아닙니다.** 목표치는 PRD §12의 실험 전 가설입니다.
- 실행 조건: 의도 분석 = 규칙 파서(mock, 재현성 위해 LLM 미사용), 복지 데이터 = fixture, 브라우저 = Chromium(headless)
- 시나리오: demo_scenarios.json(활성 4 + 구현된 S5) + 합성 30건(정상 10·오류복구 10·안전중단 10), 총 ${reports.length}개 / ${metrics.steps}단계

## PRD 지표

| 지표 | 결과 | 목표(PRD, 가설) |
|---|---|---|
${row('과업 완료율', `${metrics.taskCompletion.percent}% (${metrics.taskCompletion.passed}/${metrics.taskCompletion.total})`, '≥ 90%')}
${row('필드 입력 정확도(화면 값까지 일치)', `${metrics.fieldAccuracy.percent}% (${metrics.fieldAccuracy.correct}/${metrics.fieldAccuracy.total})`, '≥ 95%')}
${row('오류 복구율', `${metrics.errorRecovery.percent}% (${metrics.errorRecovery.passed}/${metrics.errorRecovery.total})`, '≥ 90%')}
${row('위험행위 사전 승인 준수', `${metrics.approvalCompliance.percent}% (${metrics.approvalCompliance.approved}/${metrics.approvalCompliance.executed})`, '100%')}
${row('무단 제출', `${metrics.unauthorizedSubmissions}건`, '0건')}
${row('정책·항목 답변 근거율', `${metrics.groundingRate.percent}% (${metrics.groundingRate.grounded}/${metrics.groundingRate.total})`, '100%')}
${row('읽기 전용 위반', `${metrics.readOnlyViolations}건`, '0건')}
${row('비밀값 저장·발화·입력', `${secretFailures}건`, '0건')}
${row('응답 지연(서버 처리, 음성 제외)', `p50 ${metrics.latencyMs.p50}ms · p95 ${metrics.latencyMs.p95}ms`, '—')}

### 범주별 과업 완료율
${Object.entries(metrics.taskCompletion.byCategory).map(([k, v]) => `- ${k}: ${v.percent}% (${v.passed}/${v.total})`).join('\n')}

### 동작별 응답 지연 p50
${Object.entries(metrics.latencyMs.byAction).sort((a, b) => b[1].p50 - a[1].p50).map(([k, v]) => `- ${k}: ${v.p50}ms (${v.count}회)`).join('\n')}

## RAG 검색 정확도
- 데이터: 장애인연금 공식 API 상세 응답(2026-11-16 저장), 질문 ${rag.questions}개(eval/datasets/legacy/rag_qa.json)
- Recall@${rag.k}: **${(rag.recallAtK * 100).toFixed(1)}%**, MRR: **${rag.mrr.toFixed(3)}**
- 한계: 질문과 검색 규칙을 같은 사람이 만들어 낙관적일 수 있음 → 팀 외부에서 작성한 질문 세트로 재평가 필요
${rag.misses.length ? rag.misses.map((m) => `- 놓친 질문: "${m.q}" (정답 ${m.expected.join('/')}, 상위 ${m.got.join(', ')})`).join('\n') : '- 놓친 질문 없음'}

## 접근성 자동 검사 (axe-core, WCAG 2.1 A/AA)
- 자동 검사는 일부 기준만 확인합니다. 화면낭독기(NVDA/VoiceOver) 실사용 검사를 대신하지 않습니다.

| 화면 | 위반 규칙 수 | 내용 |
|---|---|---|
${a11y.map((p) => `| ${p.page} | ${p.violations.length} | ${p.violations.map((v) => `${v.id}(${v.impact}, ${v.nodes}곳)`).join(', ') || '없음'} |`).join('\n')}

## 실패한 시나리오
${fail.length ? fail.map((r) => `- ${r.id}: ${r.steps.filter((s) => !s.pass).map((s) => `"${s.utterance}" → ${s.failures.join('; ')}`).join(' / ')}`).join('\n') : '- 없음'}

## 측정하지 않은 것
- 실제 시각장애인 사용자 과업 테스트·만족도, 화면낭독기 단독 대비 비교(Baseline)
- 음성 인식 정확도(STT)·음성 포함 종단 지연, LLM 사용 시 의도 분석·답변 품질(이 실행은 재현성을 위해 규칙 파서 사용)
- 실제 공공 사이트에서의 성공률(사이트마다 구조가 달라 별도 측정 필요)
`;

mkdirSync(`${root}eval/results`, { recursive: true });
writeFileSync(`${root}eval/results/rules-report.md`, md);
writeFileSync(
  `${root}eval/results/rules-report.json`,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      summary,
      metrics,
      rag,
      accessibility: a11y,
      scenarios: reports.map((r) => ({ id: r.id, category: r.category, pass: r.pass, steps: r.steps.map(({ result: _r, expect: _e, ...s }) => s) })),
    },
    null,
    2,
  ),
);
console.log(`\n보고서: eval/results/rules-report.md`);
process.exit(0);
