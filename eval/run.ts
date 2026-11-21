/**
 * 이음 서비스 평가 실행기: eval/datasets 의 시나리오를 여러 모델로 돌려 성공률·정확성·안전·지연·비용을 비교한다.
 *
 * 사용 (프로젝트 루트에서)
 *   npm run eval:models                                   # gpt-5-mini, 로컬 세트 7개, 3회 반복
 *   EVAL_MODELS=gpt-5-mini,qwen npm run eval:models        # 모델 여러 개(grok은 XAI_API_KEY·XAI_MODEL 필요)
 *   EVAL_SETS=welfare-qa,safety EVAL_REPEAT=1 npm run eval:models   # 일부 세트만, 1회
 *   EVAL_REAL=1 npm run eval:models                        # + 실제 사이트 목표(goals-real)·사이트 접근 가능성(site-coverage) (인터넷 필요)
 *   EVAL_VOICE=1 npm run eval:models                       # + 음성 경로(TTS→STT→처리→TTS) 지연·받아쓰기 정확도 (OpenAI 음성 키 필요)
 *   npm run eval:models -- --score eval/results/<폴더>/human-review.csv   # 사람 채점표 합산
 * 결과: eval/results/<날짜시각>/report.md · results.json · human-review.csv
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { PersonalStore, type SessionOrchestrator } from '@ieum/agent-core';
import { loadScenarioFile, runScenario, type Scenario, type ScenarioFile } from '@ieum/evaluation';
import type { TurnResult } from '@ieum/shared';
import { digestPage, type PageView } from '@ieum/web-agent';
import { isReachable, startMockSite } from '../apps/mock-welfare/serve';
import { AgentRuntime, loadConfig } from '../apps/server/src/runtime';
import { buildReviewHtml, reviewDataFromResults } from './lib/review-html';
import { SnapshotWelfareDataProvider } from './lib/snapshot-provider';

const root = fileURLToPath(new URL('..', import.meta.url));
loadEnv({ path: `${root}.env` });
const env = process.env;

// ---------------------------------------------------------------- 사람 채점표 합산 모드
const scoreIdx = process.argv.indexOf('--score');
if (scoreIdx > 0) {
  scoreHumanReview(process.argv[scoreIdx + 1]);
  process.exit(0);
}

// ---------------------------------------------------------------- 설정
const LOCAL_SETS = ['web-basic', 'dialogue-context', 'multi', 'welfare-qa', 'discover-apply', 'safety', 'multilingual'];
const sets = (env.EVAL_SETS ?? LOCAL_SETS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const repeat = Math.max(1, Number(env.EVAL_REPEAT ?? 3));
const withReal = env.EVAL_REAL === '1';
const withVoice = env.EVAL_VOICE === '1';

interface ModelSpec {
  key: string;
  label: string;
  env: Record<string, string>;
  /** USD / 100만 토큰. 로컬은 0(장비 비용 제외), 모르면 null */
  price: { in: number; out: number } | null;
  skip?: string;
}

/** 가격은 공개 자료 기준 추정치(2026-11 확인, 공식 가격표로 재확인 필요) */
function modelSpec(key: string): ModelSpec {
  if (key === 'grok') {
    const model = env.XAI_MODEL ?? '';
    return {
      key,
      label: `Grok (${model || '모델 미지정'})`,
      env: { LLM_PROVIDER: 'xai', LLM_MODEL: model, LLM_API_KEY: env.XAI_API_KEY ?? '', LLM_BASE_URL: '', LLM_REASONING_EFFORT: '' },
      price: env.XAI_PRICE_IN && env.XAI_PRICE_OUT ? { in: Number(env.XAI_PRICE_IN), out: Number(env.XAI_PRICE_OUT) } : null,
      skip: !env.XAI_API_KEY || !model ? 'XAI_API_KEY·XAI_MODEL 없음' : undefined,
    };
  }
  if (key === 'qwen') {
    const model = env.QWEN_MODEL ?? 'qwen2.5:7b';
    return { key, label: `Qwen (${model}, 로컬 Ollama)`, env: { LLM_PROVIDER: 'ollama', LLM_MODEL: model, LLM_API_KEY: '', LLM_BASE_URL: '', LLM_REASONING_EFFORT: '' }, price: { in: 0, out: 0 } };
  }
  // 그 밖의 이름은 OpenAI 모델 ID로 본다(예: gpt-5-mini, gpt-5)
  const PRICES: Record<string, { in: number; out: number }> = { 'gpt-5-mini': { in: 0.25, out: 2.0 } };
  return {
    key,
    label: `OpenAI ${key}`,
    env: { LLM_PROVIDER: 'openai', LLM_MODEL: key, LLM_BASE_URL: '', LLM_REASONING_EFFORT: env.LLM_REASONING_EFFORT ?? 'minimal' },
    price: PRICES[key] ?? null,
    skip: env.LLM_API_KEY ? undefined : 'LLM_API_KEY 없음',
  };
}
const models = (env.EVAL_MODELS ?? 'gpt-5-mini').split(',').map((s) => modelSpec(s.trim()));

// ---------------------------------------------------------------- LLM 호출 계측(토큰·지연)
const meter = { calls: 0, inTok: 0, outTok: 0, llmMs: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes('/chat/completions')) return realFetch(input, init);
  const t0 = Date.now();
  const res = await realFetch(input, init);
  meter.calls++;
  meter.llmMs += Date.now() - t0;
  try {
    const j = (await res.clone().json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
    meter.inTok += j.usage?.prompt_tokens ?? 0;
    meter.outTok += j.usage?.completion_tokens ?? 0;
  } catch {
    /* 사용량 없음 */
  }
  return res;
}) as typeof fetch;

// ---------------------------------------------------------------- 실행
const PORTAL_SEARCH = 'http://127.0.0.1:5174/external.html?q={q}';
const baseEnv = {
  ...env,
  MOCK_SITE_URL: 'http://localhost:5174',
  HEADLESS: env.HEADED === '1' ? 'false' : 'true',
  REQUIRE_CONSENT: 'false',
  READ_ONLY_WEB: 'true',
  VISUAL_CURSOR: 'false',
  PRACTICE_MODE: 'true',
  BROWSER_MODE: 'chromium',
  IEUM_DATA_DIR: '',
  STT_PROVIDER: 'mock',
  TTS_PROVIDER: 'mock',
};
const snapshot = new SnapshotWelfareDataProvider();
const ctx = { groundTexts: snapshot.groundTexts };

interface StepRow {
  model: string;
  set: string;
  feature: string;
  scenario: string;
  difficulty: string;
  rep: number;
  step: number;
  last: boolean;
  utterance: string;
  pass: boolean;
  failures: string[];
  latencyMs: number;
  llmCalls: number;
  inTok: number;
  outTok: number;
  costUsd: number | null;
  speech: string;
  intentType: string;
  semanticAction: string;
  lang: string;
  expectKeys: string[];
}
interface ScenarioRow {
  model: string;
  set: string;
  scenario: string;
  rep: number;
  pass: boolean;
}
const steps: StepRow[] = [];
const scenarios: ScenarioRow[] = [];

function makeRuntime(spec: ModelSpec, extra: Record<string, string> = {}) {
  const rt = new AgentRuntime(loadConfig({ ...baseEnv, ...spec.env, ...extra }));
  // 복지 데이터는 공식 API 저장본으로 고정(모델끼리 같은 자료)
  (rt as unknown as { welfareProvider: SnapshotWelfareDataProvider }).welfareProvider = snapshot;
  return rt;
}

async function freshSession(rt: AgentRuntime): Promise<SessionOrchestrator> {
  const s = await rt.createSession();
  // 금고·신청 기록은 시나리오마다 새로(앞 시나리오의 기록이 섞이지 않게)
  (s as unknown as { personal: PersonalStore }).personal = new PersonalStore();
  return s;
}

async function runSet(spec: ModelSpec, rt: AgentRuntime, setName: string, file: ScenarioFile, reps: number) {
  for (let rep = 0; rep < reps; rep++) {
    for (const scenario of file.scenarios) {
      const session = await freshSession(rt);
      const usage: { calls: number; inTok: number; outTok: number }[] = [];
      const handler = {
        handleTurn: async (text: string): Promise<TurnResult> => {
          const before = { ...meter };
          const r = await session.handleTurn(text);
          usage.push({ calls: meter.calls - before.calls, inTok: meter.inTok - before.inTok, outTok: meter.outTok - before.outTok });
          return r;
        },
        exportHistory: () => session.exportHistory(),
      };
      try {
        const report = await runScenario(scenario, handler, ctx);
        scenarios.push({ model: spec.key, set: setName, scenario: scenario.id, rep, pass: report.pass });
        report.steps.forEach((st, i) => {
          const u = usage[i] ?? { calls: 0, inTok: 0, outTok: 0 };
          steps.push({
            model: spec.key,
            set: setName,
            feature: scenario.feature ?? setName,
            scenario: scenario.id,
            difficulty: scenario.difficulty ?? 'medium',
            rep,
            step: i,
            last: i === report.steps.length - 1,
            utterance: st.utterance,
            pass: st.pass,
            failures: st.failures,
            latencyMs: st.latencyMs,
            llmCalls: u.calls,
            inTok: u.inTok,
            outTok: u.outTok,
            costUsd: spec.price ? (u.inTok * spec.price.in + u.outTok * spec.price.out) / 1e6 : null,
            speech: st.result.speech,
            intentType: st.result.intentType,
            semanticAction: st.semanticAction,
            lang: st.result.lang,
            expectKeys: Object.keys(scenario.steps[i].expect),
          });
        });
        console.log(`${report.pass ? 'PASS' : 'FAIL'} [${spec.key} #${rep + 1}] ${setName}/${scenario.id}${report.pass ? '' : `  ${report.steps.flatMap((s) => s.failures).slice(0, 2).join(' | ')}`}`);
      } catch (e) {
        scenarios.push({ model: spec.key, set: setName, scenario: scenario.id, rep, pass: false });
        console.log(`ERROR [${spec.key}] ${setName}/${scenario.id}: ${(e as Error).message}`);
      } finally {
        await session.close();
      }
    }
  }
}

const mock = (await isReachable('http://localhost:5174')) ? undefined : await startMockSite(5174);
const started = new Date();
const skipped: string[] = [];

for (const spec of models) {
  if (spec.skip) {
    skipped.push(`${spec.label}: ${spec.skip}`);
    console.log(`건너뜀 ${spec.label}: ${spec.skip}`);
    continue;
  }
  console.log(`\n=== ${spec.label} ===`);
  const local = makeRuntime(spec, { WEB_SEARCH_URL: PORTAL_SEARCH });
  for (const setName of sets) await runSet(spec, local, setName, loadScenarioFile(`${root}eval/datasets/${setName}.json`), repeat);
  await local.close();
  if (withReal) {
    // 실제 사이트: 검색은 실제 네이버, 1회
    const real = makeRuntime(spec, { WEB_SEARCH_URL: '' });
    await runSet(spec, real, 'goals-real', loadScenarioFile(`${root}eval/datasets/goals-real.json`), 1);
    await real.close();
  }
}

// ---------------------------------------------------------------- 실제 사이트 접근 가능성(모델과 무관, AI 끔)
interface SiteRow {
  name: string;
  url: string;
  opened: boolean;
  kind: string;
  title: string;
  bodyChars: number;
  contentLinks: number;
  menu: number;
  searchBox: boolean;
  inputs: number;
  ms: number;
}
const siteRows: SiteRow[] = [];
if (withReal) {
  const cov = JSON.parse(readFileSync(`${root}eval/datasets/site-coverage.json`, 'utf8')) as { sites: { name: string; url: string }[] };
  const rt = new AgentRuntime(loadConfig({ ...baseEnv, LLM_PROVIDER: 'mock', WEB_SEARCH_URL: '' }));
  for (const site of cov.sites) {
    const s = await rt.createSession();
    const t0 = Date.now();
    const r = await s.handleTurn(`${site.url.replace(/^https?:\/\//, '')} 열어줘`).catch(() => undefined);
    const view = (s as unknown as { web: { currentView?: PageView } }).web.currentView;
    const d = view && view.pageId !== 'blank' ? digestPage(view) : undefined;
    siteRows.push({
      name: site.name,
      url: site.url,
      opened: !!d && r?.semanticAction === 'open-site',
      kind: d?.kind ?? '열지 못함',
      title: (view?.title ?? '').slice(0, 40),
      bodyChars: d?.body.length ?? 0,
      contentLinks: d?.contentLinks.length ?? 0,
      menu: d?.menu.length ?? 0,
      searchBox: d?.hasSearchBox ?? false,
      inputs: d?.inputCount ?? 0,
      ms: Date.now() - t0,
    });
    console.log(`사이트 ${site.name}: ${d?.kind ?? '실패'} 본문 ${d?.body.length ?? 0}자 ${Date.now() - t0}ms`);
    await s.close();
  }
  await rt.close();
}

// ---------------------------------------------------------------- 음성 경로
interface VoiceRow {
  text: string;
  kind: string;
  lang: string;
  heard: string;
  cer: number;
  ttsInMs: number;
  sttMs: number;
  turnMs: number;
  firstAudioMs: number;
  totalMs: number;
}
const voiceRows: VoiceRow[] = [];
let voiceLabel = '';
if (withVoice) {
  const spec = models.find((m) => !m.skip);
  if (spec) {
    const rt = makeRuntime(spec, { WEB_SEARCH_URL: PORTAL_SEARCH, STT_PROVIDER: env.STT_PROVIDER ?? 'openai', TTS_PROVIDER: env.TTS_PROVIDER ?? 'openai' });
    voiceLabel = `${spec.label} · STT ${rt.stt.name} · TTS ${rt.tts.name}`;
    const set = JSON.parse(readFileSync(`${root}eval/datasets/voice-set.json`, 'utf8')) as { utterances: { text: string; speakerLang: 'ko' | 'en' | 'zh' | 'ja'; kind: string }[] };
    for (const u of set.utterances) {
      const s = await freshSession(rt);
      if (u.speakerLang !== 'ko') await s.setLanguage(u.speakerLang).catch(() => undefined);
      try {
        let t = Date.now();
        const { audio, mimeType } = await rt.tts.synthesize(u.text, { language: u.speakerLang });
        const ttsInMs = Date.now() - t;
        t = Date.now();
        const heard = (await rt.stt.transcribe(audio, { language: s.lang, mimeType })).text;
        const sttMs = Date.now() - t;
        t = Date.now();
        const r = await s.handleTurn(heard || '…');
        const turnMs = Date.now() - t;
        t = Date.now();
        const first = r.speech.split(/(?<=[.!?。])\s+/)[0]?.slice(0, 140) || r.speech.slice(0, 140);
        await rt.tts.synthesize(first, { language: r.lang });
        const firstAudioMs = Date.now() - t;
        voiceRows.push({ text: u.text, kind: u.kind, lang: u.speakerLang, heard, cer: cer(u.text, heard), ttsInMs, sttMs, turnMs, firstAudioMs, totalMs: sttMs + turnMs + firstAudioMs });
        console.log(`음성 "${u.text}" → "${heard}" CER ${cer(u.text, heard).toFixed(2)} 총 ${sttMs + turnMs + firstAudioMs}ms`);
      } catch (e) {
        console.log(`음성 실패 "${u.text}": ${(e as Error).message}`);
      } finally {
        await s.close();
      }
    }
    await rt.close();
  }
}
await mock?.close();

// ---------------------------------------------------------------- 집계·보고서
const outDir = `${root}eval/results/${stamp(started)}`;
mkdirSync(outDir, { recursive: true });
const ran = models.filter((m) => !m.skip);
const allSets = [...sets, ...(withReal ? ['goals-real'] : [])];

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const q = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

function modelSummary(key: string) {
  const sc = scenarios.filter((s) => s.model === key);
  const st = steps.filter((s) => s.model === key);
  const gold = st.filter((s) => s.expectKeys.includes('goldFacts'));
  const num = st.filter((s) => s.expectKeys.includes('noUnsupportedNumbers'));
  const safetyKeys = /^(noSuccessfulActions|mustNot|noActionTypes|agentMayHandlePassword)/;
  const safetyViolations = st.filter((s) => s.failures.some((f) => safetyKeys.test(f))).length;
  const costs = st.map((s) => s.costUsd).filter((c): c is number => c !== null);
  // 3회 모두 통과/일부만 통과(일관성)
  const byScenario = new Map<string, boolean[]>();
  for (const s of sc) byScenario.set(`${s.set}/${s.scenario}`, [...(byScenario.get(`${s.set}/${s.scenario}`) ?? []), s.pass]);
  const flaky = [...byScenario.values()].filter((v) => v.length > 1 && v.some(Boolean) && !v.every(Boolean)).length;
  return {
    scenarioPass: pct(sc.filter((s) => s.pass).length, sc.length),
    stepPass: pct(st.filter((s) => s.pass).length, st.length),
    goldAcc: pct(gold.filter((s) => !s.failures.some((f) => f.startsWith('goldFacts'))).length, gold.length),
    fabricated: pct(num.filter((s) => s.failures.some((f) => f.startsWith('noUnsupportedNumbers'))).length, num.length),
    safetyViolations,
    p50: q(st.map((s) => s.latencyMs), 0.5),
    p95: q(st.map((s) => s.latencyMs), 0.95),
    callsPerTurn: st.length ? (st.reduce((n, s) => n + s.llmCalls, 0) / st.length).toFixed(2) : '0',
    tokPerTurn: st.length ? `${Math.round(st.reduce((n, s) => n + s.inTok, 0) / st.length)} / ${Math.round(st.reduce((n, s) => n + s.outTok, 0) / st.length)}` : '—',
    costPerTurn: costs.length === st.length && st.length ? `$${(costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(5)}` : '가격 미지정',
    flaky,
    scenarioCount: byScenario.size,
  };
}

const lines: string[] = [];
lines.push(`# 이음 평가 보고서 — ${started.toLocaleString('ko-KR')}`);
lines.push('');
lines.push(`- 모델: ${ran.map((m) => m.label).join(' · ') || '없음'}${skipped.length ? ` (건너뜀: ${skipped.join('; ')})` : ''}`);
lines.push(`- 세트: ${sets.join(', ')} × ${repeat}회${withReal ? ' + goals-real·site-coverage(실제 사이트, 1회)' : ''}${withVoice ? ' + 음성 경로' : ''}`);
lines.push('- 복지 데이터는 공식 API 저장본(eval/snapshots/welfare)으로 고정, 로컬 세트는 연습 사이트·합성 포털에서 인터넷 없이 실행.');
lines.push('- 공정성: 모든 모델에 같은 시나리오·프롬프트·JSON 스키마. 단 프롬프트는 gpt-5-mini 기준으로 다듬어져 GPT에 유리할 수 있음.');
lines.push('- 자동 판정은 규칙(응답 종류·정답 숫자·금지 동작 등)이라 말의 질은 human-review.csv로 사람이 채점.');
lines.push('');
lines.push('## 1. 모델별 요약');
lines.push('| 모델 | 시나리오 성공 | 단계 성공 | 정답 사실 정확도 | 지어낸 숫자 비율 | 안전 위반 | 지연 p50 / p95(ms) | 턴당 LLM 호출 | 턴당 토큰(입/출) | 턴당 비용 | 반복 간 흔들림 |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
for (const m of ran) {
  const s = modelSummary(m.key);
  lines.push(`| ${m.label} | ${s.scenarioPass} | ${s.stepPass} | ${s.goldAcc} | ${s.fabricated} | ${s.safetyViolations} | ${s.p50} / ${s.p95} | ${s.callsPerTurn} | ${s.tokPerTurn} | ${s.costPerTurn} | ${s.flaky}/${s.scenarioCount} |`);
}
lines.push('');
lines.push('- 정답 사실 정확도: 공식 자료의 숫자·핵심어(goldFacts)를 답에 넣은 비율. 지어낸 숫자 비율: 근거 자료·질문에 없는 숫자를 말한 답의 비율(낮을수록 좋음). 안전 위반은 0이어야 함.');
lines.push('- 반복 간 흔들림: 같은 시나리오를 반복했을 때 통과·실패가 섞인 시나리오 수(LLM 답의 일관성).');
lines.push('');
lines.push('## 2. 기능(세트)별 시나리오 성공률');
lines.push(`| 세트 | ${ran.map((m) => m.key).join(' | ')} |`);
lines.push(`|---|${ran.map(() => '---').join('|')}|`);
for (const set of allSets) {
  lines.push(`| ${set} | ${ran.map((m) => { const sc = scenarios.filter((s) => s.model === m.key && s.set === set); return `${pct(sc.filter((s) => s.pass).length, sc.length)} (${sc.filter((s) => s.pass).length}/${sc.length})`; }).join(' | ')} |`);
}
lines.push('');
lines.push('## 3. 기능별 지연 p50 / p95 (ms, 서버 처리·음성 제외)');
lines.push(`| 세트 | ${ran.map((m) => m.key).join(' | ')} |`);
lines.push(`|---|${ran.map(() => '---').join('|')}|`);
for (const set of allSets) {
  lines.push(`| ${set} | ${ran.map((m) => { const xs = steps.filter((s) => s.model === m.key && s.set === set).map((s) => s.latencyMs); return xs.length ? `${q(xs, 0.5)} / ${q(xs, 0.95)}` : '—'; }).join(' | ')} |`);
}
lines.push('');
lines.push('## 4. 실패한 단계 (첫 반복 기준)');
for (const m of ran) {
  const failed = steps.filter((s) => s.model === m.key && s.rep === 0 && !s.pass);
  lines.push(`### ${m.label} — ${failed.length}건`);
  for (const f of failed.slice(0, 60)) lines.push(`- \`${f.set}/${f.scenario}\` "${f.utterance}" → ${f.intentType}/${f.semanticAction}: ${f.failures.join('; ')}<br>답: ${f.speech.replace(/\|/g, '/').slice(0, 160)}`);
  lines.push('');
}
if (siteRows.length) {
  lines.push('## 5. 실제 사이트 접근 가능성(실현 가능성)');
  lines.push('| 사이트 | 열림 | 페이지 종류 | 본문(자) | 내용 링크 | 메뉴 | 검색창 | 입력 칸 | 열기(ms) |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of siteRows) lines.push(`| ${r.name} | ${r.opened ? '✅' : '❌'} | ${r.kind} | ${r.bodyChars} | ${r.contentLinks} | ${r.menu} | ${r.searchBox ? '있음' : '—'} | ${r.inputs} | ${r.ms} |`);
  lines.push('');
}
if (voiceRows.length) {
  lines.push(`## 6. 음성 경로 (${voiceLabel})`);
  const avg = (f: (r: VoiceRow) => number) => Math.round(voiceRows.reduce((n, r) => n + f(r), 0) / voiceRows.length);
  lines.push(`- 받아쓰기 글자 오류율(CER) 평균 ${(voiceRows.reduce((n, r) => n + r.cer, 0) / voiceRows.length).toFixed(3)}, 말 끝 → 첫 음성까지 평균 ${avg((r) => r.totalMs)}ms (받아쓰기 ${avg((r) => r.sttMs)} + 처리 ${avg((r) => r.turnMs)} + 첫 문장 합성 ${avg((r) => r.firstAudioMs)}), p95 ${q(voiceRows.map((r) => r.totalMs), 0.95)}ms`);
  lines.push('- 실제 사용 시에는 여기에 말 끝 판단 대기(1.5~2초)가 더해진다. 합성 음성으로 받아쓰기를 재므로 실제 사람 목소리보다 오류율이 낮게 나올 수 있다.');
  lines.push('| 종류 | 발화 | 받아쓴 글 | CER | 총(ms) |');
  lines.push('|---|---|---|---|---|');
  for (const r of voiceRows) lines.push(`| ${r.kind} | ${r.text} | ${r.heard} | ${r.cer.toFixed(2)} | ${r.totalMs} |`);
  lines.push('');
}
lines.push('## 사람 채점');
lines.push('`human-review.csv`에 모델 이름을 가린 답이 있다. 정확성·핵심부터·이해 쉬움·길이 적절·안전을 1~5로 채운 뒤 `npm run eval:models -- --score <이 폴더>/human-review.csv`.');
writeFileSync(`${outDir}/report.md`, lines.join('\n'));

// 사람 채점표: 마지막 단계(답)만, 첫 반복, 모델 이름은 A/B/C로 가리고 행 순서를 섞는다
const reviewSets = new Set(['dialogue-context', 'multi', 'welfare-qa', 'multilingual', 'goals-real', 'web-basic']);
const blind: Record<string, string> = {};
const letters = ran.map((_, i) => String.fromCharCode(65 + i));
const shuffled = [...letters].sort(() => Math.random() - 0.5);
ran.forEach((m, i) => (blind[shuffled[i]] = m.key));
const reviewRows = steps
  .filter((s) => s.rep === 0 && s.last && reviewSets.has(s.set))
  .map((s) => ({ s, label: Object.entries(blind).find(([, k]) => k === s.model)![0] }))
  .sort(() => Math.random() - 0.5);
const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`;
const csv = [
  ['행', '시나리오', '사용자 발화', '모델(가림)', '이음 답', '정확성(1-5)', '핵심부터(1-5)', '이해 쉬움(1-5)', '길이 적절(1-5)', '안전(1-5)', '메모'].map(csvCell).join(','),
  ...reviewRows.map(({ s, label }, i) => [String(i + 1), `${s.set}/${s.scenario}`, s.utterance, label, s.speech, '', '', '', '', '', ''].map(csvCell).join(',')),
].join('\n');
writeFileSync(`${outDir}/human-review.csv`, `﻿${csv}`);
const resultsJson = { startedAt: started.toISOString(), models: ran.map((m) => ({ key: m.key, label: m.label, price: m.price })), skipped, sets, repeat, blind, summary: Object.fromEntries(ran.map((m) => [m.key, modelSummary(m.key)])), scenarios, steps, siteRows, voiceRows };
writeFileSync(`${outDir}/results.json`, JSON.stringify(resultsJson, null, 2));
// 사람이 보는 화면(더블클릭으로 열림): 사람 채점 + 자동 평가 요약
writeFileSync(`${outDir}/review.html`, buildReviewHtml(reviewDataFromResults(resultsJson)));
console.log(`\n평가 화면(브라우저로 열기): ${outDir}/review.html\n보고서: ${outDir}/report.md`);
process.exit(0);

// ---------------------------------------------------------------- 도우미
function stamp(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 글자 오류율: 공백·문장부호를 뺀 편집 거리 / 원문 글자 수 */
function cer(ref: string, hyp: string): number {
  const clean = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const a = [...clean(ref)];
  const b = [...clean(hyp)];
  if (!a.length) return b.length ? 1 : 0;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length] / a.length;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** 채운 사람 채점표를 모델별 평균으로(가린 이름은 같은 폴더 results.json의 blind로 되돌림) */
function scoreHumanReview(path: string) {
  const dir = path.replace(/[^/]+$/, '');
  const { blind, models: ms } = JSON.parse(readFileSync(`${dir}results.json`, 'utf8')) as { blind: Record<string, string>; models: { key: string; label: string }[] };
  const [header, ...rows] = parseCsv(readFileSync(path, 'utf8').replace(/^﻿/, '')).filter((r) => r.length > 4);
  const scoreCols = header.map((h, i) => ({ h, i })).filter((x) => /\(1-5\)/.test(x.h));
  const agg = new Map<string, { n: number; sums: number[] }>();
  for (const r of rows) {
    const model = blind[r[3]];
    if (!model) continue;
    const vals = scoreCols.map((c) => Number(r[c.i]));
    if (vals.some((v) => !(v >= 1 && v <= 5))) continue;
    const a = agg.get(model) ?? { n: 0, sums: scoreCols.map(() => 0) };
    a.n++;
    vals.forEach((v, i) => (a.sums[i] += v));
    agg.set(model, a);
  }
  const out = [
    `# 사람 채점 결과`,
    '',
    `| 모델 | 채점 수 | ${scoreCols.map((c) => c.h.replace('(1-5)', '')).join(' | ')} | 평균 |`,
    `|---|---|${scoreCols.map(() => '---').join('|')}|---|`,
    ...[...agg.entries()].map(([k, a]) => {
      const avgs = a.sums.map((s) => s / a.n);
      return `| ${ms.find((m) => m.key === k)?.label ?? k} | ${a.n} | ${avgs.map((v) => v.toFixed(2)).join(' | ')} | ${(avgs.reduce((x, y) => x + y, 0) / avgs.length).toFixed(2)} |`;
    }),
  ].join('\n');
  writeFileSync(`${dir}human-score.md`, out);
  console.log(out);
}
