import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ModelConnections, OPENAI_BASE_URL, createStructuredLlm, type StructuredLlm } from "../src/core/llm.ts";
import { REPO_ROOT } from "../src/core/assets.ts";
import { decide, PublicTask, type Fact, type PublicDecision } from "../src/orchestrator/public_task.ts";
import { redactText } from "../src/safety/privacy.ts";
import { loadConfig } from "../src/server/runtime.ts";

interface Case {
  id: string; lang: string; words: string; kind: PublicDecision["kind"]; agency?: string;
  facts?: Fact[]; task?: PublicTask; excluded?: string; skills?: string[]; reply?: string;
}
const SCHOLARSHIP = new PublicTask({ agency: "한국장학재단", subject: "국가장학금", goal: "국가장학금 신청 기간", facts: ["dates"] });
const DOCUMENT = new PublicTask({ agency: "정부24", goal: "주민등록 서류", question: "Do you mean 등본 or 초본?", choices: ["등본", "초본"] });
const cases: Case[] = [
  { id: "unlisted-homepage", lang: "ko", words: "하이코리아 홈페이지 열어줘", kind: "existing" },
  { id: "switch-unlisted-site", lang: "en", words: "Open the Maple Library homepage instead.", kind: "existing", task: SCHOLARSHIP },
  { id: "open-screen-result", lang: "ko", words: "지금 화면에서 두 번째 검색 결과를 열어 주세요.", kind: "existing" },
  { id: "skip-login", lang: "ko", words: "정부24에서 로그인은 건너뛰고 주민등록등본 발급 서류만 알려줘", kind: "find_information", agency: "정부24", facts: ["documents"], excluded: "login" },
  { id: "done-login", lang: "ko", words: "로그인은 됐고 국가장학금 서류만 알려줘", kind: "find_information", agency: "한국장학재단", facts: ["documents"] },
  { id: "several-facts", lang: "ko", words: "국가장학금 신청 기간이랑 준비할 서류를 한 번에 알려줘", kind: "find_information", agency: "한국장학재단", facts: ["dates", "documents"] },
  { id: "ko-correction", lang: "ko", words: "장학재단 말고 고용24에서 실업급여 받는 조건이 궁금해", kind: "find_information", agency: "고용24", facts: ["eligibility"], task: SCHOLARSHIP },
  { id: "ko-ambiguous", lang: "ko", words: "민원이요. 증명서인지 불편 신고인지 설명을 못 들었어요", kind: "clarify" },
  { id: "en-followup", lang: "en", words: "And what paperwork do I need for that?", kind: "find_information", agency: "한국장학재단", facts: ["documents"], task: SCHOLARSHIP },
  { id: "en-switch", lang: "en", words: "Now open the 국민신문고 website instead.", kind: "open_agency", agency: "국민신문고", task: SCHOLARSHIP },
  { id: "en-negation", lang: "en", words: "On Gov24, just find the documents for a residence certificate. Skip signing in.", kind: "find_information", agency: "정부24", facts: ["documents"], excluded: "login", reply: "I mean 주민등록표 등본. Which documents should I bring?" },
  { id: "en-correction", lang: "en", words: "I meant 초본. Which documents does it need?", kind: "find_information", agency: "정부24", facts: ["documents"], task: DOCUMENT },
  { id: "en-action", lang: "en", words: "Log into the site for me.", kind: "existing", reply: "Gov24. Please help me sign in there." },
  { id: "zh-scholarship", lang: "zh", words: "请去韩国奖学财团查国家奖学金的申请时间和材料。", kind: "find_information", agency: "한국장학재단", facts: ["dates", "documents"] },
  { id: "zh-followup", lang: "zh", words: "那要准备什么材料？", kind: "find_information", agency: "한국장학재단", facts: ["documents"], task: SCHOLARSHIP },
  { id: "zh-switch", lang: "zh", words: "换一个，打开政府24。", kind: "open_agency", agency: "정부24", task: SCHOLARSHIP },
  { id: "zh-complaint", lang: "zh", words: "请在韩国的国民申闻鼓上找投诉流程。", kind: "find_information", agency: "국민신문고", facts: ["procedure"] },
  { id: "zh-control", lang: "zh", words: "请把刚才说的再慢慢读一遍。", kind: "read_skill", skills: ["REPHRASE"] },
  { id: "ja-employment", lang: "ja", words: "雇用24で失業給付の対象条件を調べてください。申請はしないで。", kind: "find_information", agency: "고용24", facts: ["eligibility"], excluded: "application" },
  { id: "ja-followup", lang: "ja", words: "その奨学金の提出書類は？", kind: "find_information", agency: "한국장학재단", facts: ["documents"], task: SCHOLARSHIP },
  { id: "ja-switch", lang: "ja", words: "次は福祉ロ（복지로）を開いてください。", kind: "open_agency", agency: "복지로", task: SCHOLARSHIP },
  { id: "ja-docs", lang: "ja", words: "政府24で住民登録謄本の発行方法と必要書類を教えてください。", kind: "find_information", agency: "정부24", facts: ["procedure", "documents"] },
  { id: "ja-control", lang: "ja", words: "今の画面を読み上げてください。", kind: "read_skill", skills: ["DESCRIBE_SCREEN", "READ_MAIN"] },
];

function matches(c: Case, decision: PublicDecision | undefined, task: PublicTask) {
  if (decision === undefined || decision.kind !== c.kind) return false;
  const actual = task.advance(decision);
  return (c.agency === undefined || actual.agency === c.agency)
    && (c.facts ?? []).every(f => actual.facts.includes(f))
    && (c.excluded === undefined || actual.exclusions.includes(c.excluded))
    && (c.skills === undefined || (decision.skill !== undefined && c.skills.includes(decision.skill)));
}
async function trial(llm: StructuredLlm, c: Case) {
  const task = c.task ?? new PublicTask();
  const options = { voice: true, recent: [], signal: new AbortController().signal };
  const start = performance.now();
  const decision = await decide(llm, redactText(c.words), c.lang, task, options);
  const seconds = (performance.now() - start) / 1000;
  const direct = matches(c, decision, task);
  let resolved = direct;
  if (!direct && decision?.kind === "clarify" && c.reply !== undefined) {
    const pending = task.advance(decision);
    resolved = matches(c, await decide(llm, redactText(c.reply), c.lang, pending, options), pending);
  }
  return { id: c.id, direct, resolved, seconds, kind: decision?.kind ?? "unavailable" };
}
function quantile(sorted: number[], fraction: number) {
  const at = fraction * (sorted.length - 1);
  const left = sorted[Math.floor(at)]!, right = sorted[Math.ceil(at)]!;
  return left + (right - left) * (at - Math.floor(at));
}

async function main() {
  const { values } = parseArgs({ options: {
    model: { type: "string", multiple: true }, parallel: { type: "string", default: "3" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help === true) { console.log("node scripts/eval-public-tasks.ts --model MODEL [--model MODEL ...] [--parallel 1..8]"); return 0; }
  const parallel = Number(values.parallel);
  if (values.model === undefined || !Number.isInteger(parallel) || parallel < 1 || parallel > 8) {
    console.error("Specify --model and a parallelism of 1 through 8."); return 2;
  }
  const envFile = join(REPO_ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = loadConfig().llm;
  if ((config.apiKey ?? "") === "") { console.error("Set the API key for the configured planning provider."); return 1; }
  const pool = new ModelConnections();
  try {
    const models = values.model.map(model => {
      const cfg = { ...config, model };
      if (cfg.provider === "openai" && (cfg.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/u, "") === OPENAI_BASE_URL) {
        cfg.reasoningEffort = model.startsWith("gpt-6") ? "low" : undefined;
      }
      const llm = createStructuredLlm(cfg, { pool });
      if (llm === undefined) throw Error("The configured planning provider is unavailable.");
      return { model, llm, rows: new Array<Awaited<ReturnType<typeof trial>>>(cases.length) };
    });
    const queue = models.flatMap(model => cases.map((c, i) => ({ model, c, i }))).values();
    await Promise.all(Array.from({ length: parallel }, async () => {
      for (const { model, c, i } of queue) model.rows[i] = await trial(model.llm, c);
    }));
    let passed = true;
    for (const { model, rows, llm } of models) {
      const times = rows.map(r => r.seconds).sort((a, b) => a - b);
      const direct = rows.filter(r => r.direct).length, resolved = rows.filter(r => r.resolved).length;
      console.log(`${model} first decision ${direct}/${rows.length}, after clarification ${resolved}/${rows.length}; first-decision median ${quantile(times, 0.5).toFixed(2)}s, p95 ${quantile(times, 0.95).toFixed(2)}s`);
      const { calls, inputTokens, outputTokens } = llm.usage;
      console.log(`  ${calls} calls, ${inputTokens} input tokens, ${outputTokens} output tokens`);
      for (const row of rows.filter(r => !r.resolved)) console.log("  " + row.id + ": " + row.kind);
      if (resolved !== rows.length) passed = false;
    }
    return Number(!passed);
  } finally { await pool.close(); }
}
if (import.meta.main) process.exitCode = await main();
