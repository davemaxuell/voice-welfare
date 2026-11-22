// node scripts/eval-sol-dialogue.ts --dry-run
// node scripts/eval-sol-dialogue.ts --live [--without-dialogue] [--case ID]
// To measure across revisions, run the same fixtures in each checkout. --without-dialogue
// measures a context ablation when used with the same revision on both sides.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { PlaywrightExecutionAdapter } from "../src/agents/web/browser/index.ts";
import { REPO_ROOT } from "../src/core/assets.ts";
import { OPENAI_BASE_URL, type LlmRequest, type StructuredLlm } from "../src/core/llm.ts";
import type { Lang } from "../src/core/turn.ts";
import type { DialogueExchange } from "../src/orchestrator/planner_dialogue.ts";
import { PublicTask, decide, parseDecision, type PublicDecision } from "../src/orchestrator/public_task.ts";
import { redactText } from "../src/safety/privacy.ts";
import { AgentRuntime, loadConfig } from "../src/server/runtime.ts";
import { SettingsStore } from "../src/server/settings.ts";

// All transcripts and example.org source records are synthetic. The planner sees
// the conversation only. It never receives the source index, oracle or answer.
const pages = {
  loan: { name: /학자금\s*대출/u, detail: "H-317", quote: {
    ko: "학자금대출은 가람관 H-317 창구에서 신청합니다.", en: "Apply for a student loan at desk H-317 in Garam Hall.",
    zh: "申请助学贷款请前往佳蓝馆的 H-317 柜台。", ja: "学資ローンはカラム館の H-317 窓口で申し込みます。" } },
  scholarship: { name: /(?:국가\s*)?장학금/u, detail: "S-218", quote: {
    ko: "국가장학금은 다솔관 S-218 창구에서 신청합니다.", en: "Apply for a national scholarship at desk S-218 in Dasol Hall.",
    zh: "申请国家奖学金请前往多松馆的 S-218 柜台。", ja: "国家奨学金はタソル館の S-218 窓口で申し込みます。" } },
  pension: { name: /기초\s*연금/u, detail: "P-409", quote: {
    ko: "기초연금은 보람관 P-409 창구에서 신청합니다.", en: "Apply for the basic pension at desk P-409 in Boram Hall.",
    zh: "申请基础养老金请前往宝蓝馆的 P-409 柜台。", ja: "基礎年金はポラム館の P-409 窓口で申し込みます。" } },
  library: { name: /솔바람\s*(?:시립\s*)?도서관/u, detail: "10:20", quote: {
    ko: "솔바람도서관은 토요일 오전 10:20에 개관합니다.", en: "Solbaram Library opens at 10:20 a.m. on Saturdays.",
    zh: "松风图书馆星期六上午 10:20 开馆。", ja: "ソルバラム図書館は土曜日の午前 10:20 に開館します。" } },
};
type PageId = keyof typeof pages;
interface Trial {
  id: string; lang: Lang; utterance: string; dialogue: DialogueExchange[]; task?: PublicTask;
  expect: { page: PageId; source?: PublicDecision["source"] } | { question: RegExp[] };
}

const studies = { user: "대학 학비 지원에는 어떤 것이 있어?", assistant: "먼저 국가장학금이 있고, 두 번째로 학자금대출이 있어요." };
const sourceQuestion = "Should I start with the Korea Student Aid Foundation (한국장학재단) or Government24 (정부24)?";
const branches = ["가람", "다솔", "보람", "느티", "누리", "두리", "미리내", "보리", "사랑", "소담", "아람", "여울", "한빛"];
const groundFloor = (name: string, i: number) => `${name} 분관은 ${i % 2 === 0 ? "동쪽" : "서쪽"} 출입문으로 들어오면 자료실이 있습니다. 안내 데스크 옆에서 확대 독서기를 이용할 수 있습니다.`;
const training = (name: string, i: number) => `${name} 분관의 전자책 이용 교육은 ${i % 2 === 0 ? "화요일 오전" : "수요일 오후"}에 열립니다. 신청 방법은 분관별 자료실 게시판에 나와 있습니다.`;
const transport = (name: string, i: number) => `${name} 분관에서는 ${i % 2 === 0 ? "정문 앞" : "후문 건너편"} 정류장을 이용할 수 있습니다. 운행이 끝나는 시각은 요일에 따라 달라집니다.`;
const longHistory = [studies,
  { user: "별도로, 지역 도서관 분관별 자료실 안내를 읽어 줘.", assistant: branches.map(groundFloor).join(" ") },
  { user: "분관별 전자책 교육 공지도 읽어 줘.", assistant: branches.map(training).join(" ") },
  { user: "돌아오는 길에 이용할 정류장 안내도 읽어 줘.", assistant: branches.map(transport).join(" ") },
];
const cases: Trial[] = [
  { id: "first-turn-tuition", lang: "en", dialogue: [],
    utterance: "I'm starting university in Korea. I need help paying tuition that I won't have to pay back. Where can I apply?",
    expect: { page: "scholarship" } },
  { id: "ko-ordinal", lang: "ko", dialogue: [studies], utterance: "두 번째 건 어디서 신청하는지 확인해줘.", expect: { page: "loan" } },
  { id: "en-mixed-reversed", lang: "en", dialogue: [{ user: "Which options can help me pay tuition?",
    assistant: "First there's 학자금대출 for borrowing. Second there's 국가장학금, a scholarship." }],
    utterance: "Where do I apply for the second one?", expect: { page: "scholarship" } },
  { id: "latest-correction", lang: "ko", dialogue: [studies, { user: "두 번째가 관심 있어.", assistant: "학자금대출 말씀이시군요." }],
    task: new PublicTask({ subject: "학자금대출", goal: "학자금대출 안내" }),
    utterance: "아, 정정할게. 처음 말한 걸로 바꿀게. 신청하는 곳을 찾아줘.", expect: { page: "scholarship" } },
  { id: "zh-ordinal", lang: "zh", dialogue: [{ user: "大学学费有什么资助方式？",
    assistant: "第一种是国家奖学金（국가장학금），第二种是助学贷款（학자금대출）。" }],
    utterance: "请查一下第二种去哪里申请。", expect: { page: "loan" } },
  { id: "ja-ordinal", lang: "ja", dialogue: [{ user: "韓国で大学の学費を支える制度を二つ教えて。",
    assistant: "一つ目は学資ローン（학자금대출）、二つ目は国家奨学金（국가장학금）です。" }],
    utterance: "二つ目はどこで申し込めるか調べて。", expect: { page: "scholarship" } },
  { id: "topic-switch", lang: "ko", dialogue: [studies, { user: "학비 얘기는 끝났어. 어르신을 위한 제도를 알려줘.",
    assistant: "첫 번째는 노인 일자리 사업이고 두 번째는 기초연금이에요." }],
    task: new PublicTask({ subject: "국가장학금", goal: "국가장학금 신청" }),
    utterance: "방금 이야기한 두 번째 건 어디서 신청하는지 확인해줘.", expect: { page: "pension" } },
  { id: "autonomous-source", lang: "ko", dialogue: [{ user: "아람시에 있는 솔바람도서관에 주말에 갈 생각이야.",
    assistant: "솔바람도서관에 방문하실 예정이군요." }],
    utterance: "토요일에 몇 시에 여는지 찾아봐 줘. 어느 사이트를 봐야 하는지는 몰라.", expect: { page: "library", source: "browser" } },
  { id: "essential-location", lang: "en", dialogue: [{ user: "I need a district office to apply in person.",
    assistant: "Each district handles applications only for residents of that district." }],
    utterance: "Please find the office for my home district. I haven't told you which district I live in.",
    expect: { question: [/district|neighbou?rhood|municipality|city|where.*live|location/iu] } },
  { id: "ambiguous-lists", lang: "en", dialogue: [{ user: "Read me both lists. I'm keeping both in front of me.",
    assistant: "For tuition: first a national scholarship, second a student loan. For housing: first rent assistance, second a housing loan." }],
    utterance: "I marked the second one, but didn't write down which list. Where do I apply?",
    expect: { question: [/tuition|student|education|school/iu, /housing|rent/iu] } },
  { id: "incomplete-list", lang: "ko", dialogue: [{ user: "지원 제도 목록을 알려줘.",
    assistant: "지원 제도를 순서대로 읽어드릴게요. 국가장학금", incomplete: true }],
    utterance: "두 번째 것은 어디서 신청해?", expect: { question: [/제도|지원|항목|목록|이름|말씀|어떤/u] } },
  { id: "four-exchange-budget", lang: "ko", dialogue: longHistory,
    utterance: "아까 학비 이야기로 돌아가서, 두 번째 건 어디서 신청하는지 확인해 줘.", expect: { page: "loan" } },
  { id: "delegate-offered-sources", lang: "en",
    dialogue: [{ user: "Where do I apply for the Korean national scholarship (국가장학금)? Please check.", assistant: sourceQuestion }],
    task: new PublicTask({ subject: "국가장학금", goal: "국가장학금의 공식 신청처 확인", facts: ["procedure"], searchMode: "quiet",
      question: sourceQuestion, choices: ["한국장학재단", "정부24"] }),
    utterance: "I don't know, you choose.", expect: { page: "scholarship" } },
];

const pageIds = Object.keys(pages) as PageId[];
const sourceUrl = (id: PageId) => `https://example.org/public-services/${id}`;
function findPage(subject: string, goal: string) {
  const matching = (text: string) => pageIds.filter(id => pages[id].name.test(text));
  const named = matching(subject);
  const candidates = named.length > 0 ? named : matching(goal);
  return candidates.length === 1 ? candidates[0] : undefined;
}
function measure(request: LlmRequest) {
  // UTF-8 input content, excluding the HTTP envelope. modelMs covers the planner round trip.
  return {
    userBytes: Buffer.byteLength(request.user),
    inputBytes: Buffer.byteLength(request.system) + Buffer.byteLength(request.user) + Buffer.byteLength(JSON.stringify(request.schema)),
  };
}

async function dryRun(c: Trial, dialogue: DialogueExchange[]) {
  const capture: StructuredLlm = { name: "offline request capture", async generate(request) {
    const input = JSON.parse(request.user);
    assert.equal(input.utterance, c.utterance);
    assert.deepEqual(input.dialogue ?? [], dialogue);
    console.log(JSON.stringify({ id: c.id, ...measure(request), modelMs: null }));
    return undefined;
  } };
  const options = { voice: true, recent: [], dialogue, signal: new AbortController().signal };
  await decide(capture, redactText(c.utterance), c.lang, c.task ?? new PublicTask(), options);
}

async function runCase(runtime: AgentRuntime, model: StructuredLlm, c: Trial, dialogue: DialogueExchange[]) {
  const session = await runtime.createSession();
  try {
    // The runtime chooses the route and produces the actual response and action log.
    // Every quiet lookup uses this same local index, whichever case called it.
    const lookups: string[] = [];
    const browserRequests: string[] = [];
    assert(session.web.adapter instanceof PlaywrightExecutionAdapter && session.web.adapter.context !== undefined);
    await session.web.adapter.context.route("**/*", route => {
      browserRequests.push(route.request().url());
      return route.abort();
    });
    session.deps.welfare.provider.findService = async subject => { lookups.push(subject); return undefined; };
    session.deps.quietSearch = async (task, lang) => {
      lookups.push(task.goal);
      const id = findPage(task.subject, task.goal);
      if (id === undefined) return {};
      const requested = id === "library" ? /토요일/u.test(task.goal) && /시각|시간|여는|개관|운영|개장/u.test(task.goal) :
        /신청|접수/u.test(task.goal) && /신청처|접수처|창구|어디|경로|방법|기관|장소|페이지|사이트/u.test(task.goal);
      if (!requested) return {};
      const url = sourceUrl(id), quote = pages[id].quote[lang];
      return { speech: quote, sources: [{ title: "Synthetic public-service notice", url, lastCheckedAt: "2026-11-23" }],
        reviewQuotes: [quote], reviewQuoteSources: { [quote]: [url] } };
    };
    let decision: PublicDecision | undefined;
    let sizes: ReturnType<typeof measure> | undefined;
    let modelMs: number | undefined;
    let contextMatched = false;
    session.deps.llm = { name: model.name, async generate(request) {
      // A compound factual lookup goes through the runtime's evidence review.
      // Let the same hosted model review the synthetic page, separately from planner timing.
      if (request.schemaName === "review_before_output") return model.generate(request);
      if (request.schemaName !== "public_service_decision") return undefined;
      const input = JSON.parse(request.user);
      contextMatched = isDeepStrictEqual(input.dialogue ?? [], dialogue) && input.utterance === c.utterance &&
        (c.task === undefined || isDeepStrictEqual(input.task, c.task.context()));
      sizes = measure(request);
      const start = performance.now();
      const raw = await model.generate(request);
      modelMs = Math.round(performance.now() - start);
      decision = parseDecision(raw);
      return raw;
    } };
    await session.setLanguage(c.lang);
    session.publicTask = c.task ?? new PublicTask();
    const options = { fromVoice: true, plannerDialogue: dialogue };
    const result = await session.handleTurn(c.utterance, options);
    const citations = result.sources.map(source => source.url);
    const question = decision?.question ?? "", choices = decision?.choices ?? [];
    const expected = c.expect;
    const noActions = result.actions.length === 0 && browserRequests.length === 0;
    const pass = contextMatched && noActions && ("page" in expected
      ? (decision?.kind === "find_information" || decision?.kind === "review_before_output") &&
        (expected.source === undefined || decision.source === expected.source) &&
        findPage(session.publicTask.subject, session.publicTask.goal) === expected.page && lookups.length > 0 &&
        citations.includes(sourceUrl(expected.page)) && result.speech.includes(pages[expected.page].detail)
      : decision?.kind === "clarify" && result.semanticAction === "clarify" && lookups.length === 0 &&
        question.length > 0 && (question.match(/[?？]/gu)?.length ?? 0) <= 1 &&
        expected.question.every(pattern => pattern.test([question, ...choices].join(" "))));
    console.log(JSON.stringify({ id: c.id, pass, contextMatched, ...sizes, modelMs, kind: decision?.kind ?? "unavailable",
      subject: session.publicTask.subject, goal: session.publicTask.goal, source: decision?.source, citations, question,
      lookupCount: lookups.length, actions: result.actions.length, browserRequests: browserRequests.length,
      ...(!pass ? { speech: result.speech, intent: result.intentType, facts: decision?.requestedFacts, review: result.review?.status } : {}) }));
    return pass;
  } finally { await session.close(); }
}

async function main() {
  const { values } = parseArgs({ options: { live: { type: "boolean" }, "dry-run": { type: "boolean" },
    "without-dialogue": { type: "boolean" }, case: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help === true || values.live !== true && values["dry-run"] !== true) {
    console.log("node scripts/eval-sol-dialogue.ts (--dry-run | --live) [--without-dialogue] [--case ID]");
    return 0;
  }
  assert(!(values.live === true && values["dry-run"] === true), "Choose either --live or --dry-run.");
  const selected = cases.filter(c => values.case === undefined || c.id === values.case);
  assert(selected.length > 0, "Unknown case ID.");
  const historyBytes = longHistory.reduce((sum, row) => sum + Buffer.byteLength(row.user) + Buffer.byteLength(row.assistant), 0);
  assert(historyBytes >= 6000 && historyBytes <= 6400, "Keep the four-exchange fixture near the planner's byte limit.");
  const dialogue = (c: Trial) => values["without-dialogue"] === true ? [] : c.dialogue;
  if (values["dry-run"] === true) {
    for (const c of selected) await dryRun(c, dialogue(c));
    return 0;
  }
  const envFile = join(REPO_ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const directory = process.env.CHEONGEUM_EVAL_SETTINGS_DIR;
  const settings = directory === undefined ? undefined : new SettingsStore(join(directory, "preferences.json"));
  // The configured inference client is separate from the synthetic shared session.
  const client = new AgentRuntime(loadConfig(), undefined, undefined, fetch, settings);
  const runtime = new AgentRuntime(loadConfig({ HEADLESS: "true", REQUIRE_CONSENT: "false", PRACTICE_MODE: "false",
    PILOT_PROFILE: "shared", READ_ONLY_WEB: "false" }));
  try {
    const model = client.understandLlm;
    if (model === undefined || model.provider !== "openai" || model.baseUrl.replace(/\/+$/u, "") !== OPENAI_BASE_URL ||
      !model.model.split("-").includes("sol")) {
      console.error("The configured OpenAI Sol planner is unavailable. Set its API configuration or CHEONGEUM_EVAL_SETTINGS_DIR.");
      return 2;
    }
    let passed = 0;
    for (const c of selected) if (await runCase(runtime, model, c, dialogue(c))) passed++;
    console.log(JSON.stringify({ model: model.name, dialogue: values["without-dialogue"] !== true, passed,
      total: selected.length, usage: model.usage }));
    return Number(passed !== selected.length);
  } finally { await runtime.close(); await client.close(); }
}
if (import.meta.main) process.exitCode = await main();
