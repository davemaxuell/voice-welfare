// 공공업무 요청을 세션에서 받는 자리: 판단(public_task.ts)을 묻고, 읽기 전용 조회나 검토를 거치는 일로 보낸다.
import { randomUUID } from "node:crypto";
import { answerAndNextStep, citeWithData } from "../agents/welfare/answer_card.ts";
import type { BrowserJourney } from "../agents/web/journey.ts";
import { BROWSE_TIME_BUDGET_MS } from "../agents/web/autopilot.ts";
import { raceAbort } from "../core/abort.ts";
import type { Intent } from "../core/intents.ts";
import { ackKind, agree } from "../core/lexicon.ts";
import { ModelTransportError, type Redacted } from "../core/llm.ts";
import { backendActivity } from "../core/progress.ts";
import { ResearchFinding, ResearchPlan, researchSummary, type ResearchOutcome, type ResearchProgress, type ResearchSource } from "../core/research.ts";
import type { z } from "zod";
import { rstripChars, stripChars } from "../core/text.ts";
import { AGENT_IDS, draft, type Draft, type Lang, type SourceCitation, type TurnResult } from "../core/turn.ts";
import { FIXED } from "../language/i18n.ts";
import { REDACTED, detectSensitive, redactText } from "../safety/privacy.ts";
import { OPEN_SITE_SEARCH } from "../speech/phrasing.ts";
import { isExactCommand, pictureCommandParts } from "../understanding/fastpath.ts";
import { isPictureRequest } from "../understanding/rules.ts";
import { goalSiteRequest, mentionsKnownSite, namedSiteCommand, publicServiceSite, siteLabel } from "../understanding/sites.ts";
import { publicPatterns } from "./patterns.ts";
import { ASK_SERVICE, FOREGROUND_BROWSER_INTENTS, LOOKUP_TIMEOUT, LOOKUP_UNAVAILABLE, PublicTask, REJECTED, decide, publicDestinations, reviewCompletion, singleBrowserIntent, type PublicDecision } from "./public_task.ts";
import type { NeedContext } from "./session_need.ts";
import { LIVE_DIFFICULTY, ReviewedTask } from "./review_loop.ts";
import { coverage, pageMatches } from "./task_review.ts";
import { withContext, type Detection, type PublicTurn, type SessionOrchestrator, type Turn } from "./session.ts";
import { wordSuggestions } from "./speech_repair.ts";

/** 조용한 조회(현재 탭을 건드리지 않는 공개 출처 확인)가 돌려주는 답. 찾지 못하면 빈 객체. */
export interface QuietAnswer {
  speech?: string;
  sources?: SourceCitation[];
  reviewQuotes?: readonly string[];
  reviewQuoteSources?: Readonly<Record<string, readonly string[]>>;
}
export interface PlanningContext { language: Lang; agency: string; service: string; recentTurns: PublicTurn[]; region?: string; need?: NeedContext }
type SearchMode = PublicTask["searchMode"];
interface Bounds { research?: boolean; maxSteps?: number; continuePage?: boolean; requestedSteps?: readonly string[]; journey?: BrowserJourney }
type ResearchReply = [string, ResearchOutcome<z.infer<typeof ResearchSource>>];

const PLAN_STATES = new Set(["IDLE", "BROWSING", "NEEDS_CLARIFICATION"]);
const LOOKUPS = { browser: "GOAL", welfare: "POLICY_QUESTION", places: "FIND_PLACE" } as const;
const CHECKING_OFFICIAL_SITES = {
  ko: "공식 사이트를 직접 확인하고 있어요.", en: "I’m checking the official websites directly.",
  zh: "我正在直接查阅官方网站。", ja: "公式サイトを直接確認しています。",
} satisfies Record<Lang, string>;
const LIMITED = {
  ko: "찾은 자료로는 질문 전체를 확인하기 어려워요.", en: "The sources cover only part of your question.",
  zh: "现有资料只涵盖了问题的一部分。", ja: "見つかった資料では、ご質問の一部しか確認できませんでした。",
} satisfies Record<Lang, string>;

/** 언어별 고정 문장. 표에 그 언어가 없으면 한국어 문장. */
function spoken(table: Readonly<Record<string, string>>, lang: Lang): string {
  return table[lang] ?? table.ko ?? "";
}

function skillIntent(skill: NonNullable<PublicDecision["skill"]>): Intent {
  if (skill === "READ_MAIN" || skill === "LIST_LINKS" || skill === "WHAT_CAN_I_SAY") return { type: skill, more: false };
  return { type: skill };
}

export class PublicPlanner {
  private readonly session: SessionOrchestrator;
  constructor(session: SessionOrchestrator) { this.session = session; }

  canPlan(text: string, sensitive: Detection): boolean {
    const s = this.session;
    return s.deps.publicPlanning !== false && s.deps.llm !== undefined && s.consentStatus === "granted" &&
      PLAN_STATES.has(s.state) && !s.dialogue.hasPendingInteraction &&
      sensitive.kinds.length === 0 && !text.includes(REDACTED) && s.speakable(text) &&
      (s.publicTask.question.length > 0 || namedSiteCommand(text) === undefined) &&
      (!isExactCommand(text) || FOREGROUND_BROWSER_INTENTS.has(s.rules.parseSync(text, {state: s.state}).type)) &&
      !isPictureRequest(rstripChars(text, ".!。")) && pictureCommandParts(text, s.rules).length === 0 &&
      (s.publicTask.question.length > 0 || ackKind(text) === undefined);
  }

  /** 저장해 둔 조사 한 건. 격리된 새 작업 세션에서만 부른다. */
  async research(prompt: string, language: Lang, progress?: ResearchProgress): Promise<ResearchReply> {
    const s = this.session;
    if (s.consentStatus !== "granted" || s.deps.llm === undefined || detectSensitive(prompt).hasSecretValue) return ["incomplete", {}];
    const text = redactText(prompt);
    s.lang = language;
    const turn = s.beginTurn(text);
    if (progress !== undefined) turn.ctx = withContext(turn.ctx, { signal: AbortSignal.any([turn.ctx.signal, progress.signal]) });
    const saved = progress?.checkpoint?.plan;
    if (saved !== undefined && progress !== undefined) return this.#continueResearch(saved, turn, progress);
    let outcome: ResearchReply | undefined;
    const planned = await this.plan(text, turn, { research: true, durable: progress === undefined ? undefined : async plan => {
      outcome = await this.#continueResearch(await progress.save(plan), turn, progress);
      return outcome;
    } });
    if (outcome !== undefined) return outcome;
    if (planned === undefined) return ["incomplete", { reason: "no_progress" }];
    let limited = false;
    if (turn.researchState === "completed" && planned.review === undefined) {
      turn.researchState = await reviewCompletion(s.deps.webLlm, text, turn.researchEvidence, turn.ctx.signal);
      if (turn.ctx.signal.aborted || turn.researchState === "incomplete") return ["incomplete", {}];
      limited = turn.researchState === "partial";
    }
    const result = await s.localize(planned);
    const found = result.answerCard === undefined ? result.speech : answerAndNextStep(result.answerCard);
    return [turn.researchState, { text: limited ? `${LIMITED[result.lang]} ${found}` : found, sources: result.sources }];
  }

  async #continueResearch(initial: ResearchPlan, turn: Turn, progress: ResearchProgress): Promise<ResearchReply> {
    const s = this.session;
    let plan = initial;
    for (let i = 0; i < plan.steps.length; i++) {
      turn.ctx.signal.throwIfAborted();
      const item = plan.steps[i];
      if (item === undefined || item.outcome !== undefined) continue;
      const updated = plan.steps.map((step, index) => index === i ? { ...step, attempts: Math.min(2, step.attempts + 1) } : step);
      if (item.attempts >= 2) {
        plan = await progress.save({ ...plan, steps: updated.map((step, index) => index === i
          ? { ...step, outcome: { status: "unavailable" } } : step) });
        continue;
      }
      plan = await progress.save({ ...plan, steps: updated });
      const context = [plan.goal, item.clarification === undefined ? "" :
        `이 항목에 관한 이용자의 추가 답변: ${item.clarification}`].filter(Boolean).join("\n");
      const lookup = new PublicTask({
        agency: plan.agency, subject: plan.subject,
        goal: `확인할 항목: ${item.requirement}\n원래 대상과 조건: ${context}`,
        exclusions: plan.exclusions, facts: ["other"], searchMode: plan.route === "quiet" ? "quiet" : undefined,
      });
      const scope = withContext(turn.ctx, { publicLookup: true });
      const attempt = { ...turn, ctx: scope };
      const work = await s.review.run(new ReviewedTask({
        request: redactText(item.requirement), task: lookup, requirements: [item.requirement], route: plan.route,
        difficulty: "easy", background: true, publicFactsOnly: true,
      }), attempt);
      s.dialogue.takePlaceAsk();
      s.placeReview = undefined;
      const checked = ResearchFinding.safeParse({
        text: work.speech, sources: work.sources, proof: Object.entries(work.reviewQuoteSources ?? {}).flatMap(([quote, urls]) =>
          urls.map(url => ({ quote, url }))),
      });
      const resolution = work.review?.status === "completed" && checked.success ? { status: "verified", finding: checked.data } as const
        : work.review?.status === "needs_input" && work.semanticAction !== "stop" ? { status: "waiting", question: work.taskQuestion ?? work.speech } as const
        : { status: "unavailable" } as const;
      turn.ctx.signal.throwIfAborted();
      plan = await progress.save({ ...plan, steps: plan.steps.map((step, index) => index === i ? { ...step, outcome: resolution } : step) });
    }
    return researchSummary(plan);
  }

  async command(turn: Turn, type: Intent["type"], execute: () => Promise<Draft>): Promise<TurnResult> {
    const s = this.session;
    turn.intentType = type;
    return s.finish(turn, s.gate([type]) ?? await execute());
  }

  async plan(text: Redacted, turn: Turn, { research = false, durable }: {
    research?: boolean;
    durable?: ((plan: ResearchPlan) => Promise<ResearchReply>) | undefined;
  } = {}): Promise<TurnResult | undefined> {
    const s = this.session;
    const llm = s.deps.llm;
    if (llm === undefined) return undefined;
    const lang = s.lang;
    let task = s.publicTask;
    const asking = task.question.length > 0;
    const last = s.inspectedScreen;
    const onInspectedPage = !research && !asking && task.goal.length === 0 && last !== undefined &&
      pageMatches(last, s.web.currentView, s.privateValuesForRedaction(), true);
    if (onInspectedPage) task = last.task;
    else if (task.goal.length === 0 && !asking && s.activeService !== undefined) {
      task = new PublicTask({ ...task, agency: s.activeService[0], subject: s.activeService[1] });
    }
    const clarify = (speech: string) => {
      turn.intentType = "CLARIFY";
      return s.finish(turn, draft(s.state, "clarify", speech, { lang }));
    };
    const reply = agree(text);
    if (asking && reply === "no") {
      s.publicTask = new PublicTask();
      s.reviewQuestion = undefined;
      return clarify(spoken(REJECTED, lang));
    }
    if (asking && reply === "yes" && task.choices.length > 1) return clarify(`${task.question} ${task.choices.join(" / ")}`);
    const [candidates, clear] = turn.fromVoice && lang === "ko" && !asking ? wordSuggestions(text) : [[], false];
    turn.ctx.trace("PLANNING", AGENT_IDS.orchestrator, "공공업무 결정");
    const agency = task.agency ?? null;
    const personalContext = onInspectedPage || s.reviewQuestion?.[1].inspection !== undefined || turn.ctx.browsingScope === "personal-inspection";
    const recent = s.publicTurns.filter(r => r.agency === agency);
    const suppliedAddress = publicDestinations(text);
    const notes = s.deps.recallNotes !== undefined && !research ? await s.deps.recallNotes(suppliedAddress.text) : [];
    const scanner = s.deps.scanner;
    const decision = await decide(llm, text, lang, task, {
      voice: turn.fromVoice, recent, signal: turn.ctx.signal, ...(research ? { research: true } : {}),
      dialogue: research || personalContext ? [] : s.plannerDialogue([], turn.plannerDialogue),
      currentInspectionScreen: onInspectedPage,
      need: research || personalContext ? undefined : s.need.context(),
      ...(notes.length > 0 ? { savedNotes: notes } : {}),
      speechCandidates: candidates.slice(0, 2).map(c => c.label), corroborated: clear,
      ...(scanner === undefined ? {} : { scan: (texts: readonly string[]) => scanner.scan(texts) }),
    });
    if (s.superseded(turn) || turn.ctx.signal.aborted) return s.finish(turn, draft("STOPPED", "none", FIXED.stopBusy[lang], { lang }));
    if (decision === undefined) return asking ? clarify(task.question) : undefined;
    if (!research && !personalContext && decision.kind !== "inspect_personal" && decision.needUpdate) {
      const quotes = decision.needUpdate.changes.flatMap(change => change.quote === null ? [] : [change.quote]);
      const spans = await scanner?.scan(quotes);
      if (s.superseded(turn) || turn.ctx.signal.aborted) return s.finish(turn, draft("STOPPED", "none", FIXED.stopBusy[lang], {lang}));
      s.need.update(decision.needUpdate, suppliedAddress.text, value => s.speakable(value), value => spans?.[quotes.indexOf(value)] ?? []);
    }
    if (!research && !asking) s.inspectedScreen = undefined;
    const previousReview = s.reviewQuestion;
    s.reviewQuestion = undefined;
    const personal = decision.kind === "inspect_personal";
    const lookup = decision.kind === "find_information" || decision.kind === "review_before_output";
    const supplied = [...suppliedAddress.urls.values()].flat();
    const literal = goalSiteRequest(text, [], {addressesOnly: true})[0] ?? (supplied.length === 1 ? supplied[0] : undefined);
    const destination = personal || research ? undefined : literal;
    const nextTask = task.advance(decision, destination);
    const browserEvidence = nextTask.destination !== undefined || nextTask.facts.includes("page_title");
    const source = lookup && browserEvidence && decision.source !== undefined ? "browser" : decision.source ?? undefined;
    if (research && personal) return undefined;
    const continuingReview = previousReview?.[0] === task && decision.continuation ? previousReview[1] : undefined;
    if (continuingReview?.inspection !== undefined && (personal || decision.kind === "clarify")) {
      turn.ctx = withContext(turn.ctx, {browsingScope: "personal-inspection"});
    }
    if (continuingReview !== undefined &&
        (continuingReview.inspection !== undefined ? personal : lookup && source !== undefined)) {
      const run = continuingReview;
      run.task = nextTask;
      run.route = source ?? "browser";
      s.publicTask = run.inspection !== undefined ? new PublicTask() : run.task;
      turn.intentType = "REVIEW_BEFORE_OUTPUT";
      return s.finish(turn, await s.review.run(run, turn));
    }
    // 독립된 단서 없이 발음만 비슷한 기관·증명서 중 하나를 실행하지 않는다.
    if (candidates.length > 1 && !clear && (decision.kind === "open_agency" || lookup || personal)) return undefined;
    if (research && !(decision.kind === "clarify" || decision.kind === "find_information" ||
        (decision.kind === "review_before_output" && source !== undefined))) return undefined;
    const live = LIVE_DIFFICULTY.getStore();
    const parts = decision.requirements ?? [];
    if (durable !== undefined && source !== undefined && parts.length > 1 && new Set(parts).size === parts.length && coverage(text, parts)) {
      const approved = nextTask;
      const plan = ResearchPlan.safeParse({
        route: approved.searchMode === "quiet" ? "quiet" : source, goal: approved.goal, subject: approved.subject,
        agency: approved.agency, exclusions: approved.exclusions, steps: parts.map(requirement => ({ requirement, attempts: 0 })),
      });
      if (plan.success) {
        await durable(plan.data);
        return undefined;
      }
    }
    const compoundLookup = decision.kind === "find_information" && source === "browser" &&
      (new Set(parts).size > 1 || decision.searchMode === "quiet" && new Set(decision.requestedFacts).size > 1);
    if (personal || decision.kind === "review_before_output" || compoundLookup || (!research && decision.kind === "find_information" && live === "hard")) {
      const requirements = decision.requirements ?? [];
      const reviewed = new ReviewedTask({
        request: personal ? suppliedAddress.text : text, task: nextTask, requirements: requirements.length > 0 ? requirements : [suppliedAddress.text],
        route: personal ? "browser" : source ?? "existing", difficulty: live ?? decision.difficulty ?? "medium",
        counter: turn.ctx.counter, background: research, inspection: personal ? decision.outcome ?? "answer" : undefined,
        publicArrival: !personal && decision.outcome === "arrival",
      });
      turn.intentType = "REVIEW_BEFORE_OUTPUT";
      s.publicTask = personal ? new PublicTask() : reviewed.task;
      const result = await s.review.run(reviewed, turn);
      if (research) turn.researchState = result.review?.status ?? "incomplete";
      return s.finish(turn, result);
    }
    if (decision.kind === "delegate_research") {
      turn.intentType = "CLARIFY";
      if (s.deps.delegateResearch === undefined) return s.finish(turn, draft(s.state, "clarify", "자료 조사를 맡기려면 이용 설정에서 개인 기기를 선택해 주세요."));
      const question = decision.goal ?? "";
      if (s.web.guard.directActions) {
        const saved = await s.deps.delegateResearch(turn.id, question);
        return s.finish(turn, draft("IDLE", "none", saved ? "조사를 맡겼어요. 결과가 나오면 알려 드릴게요." : "조사를 시작하지 못했어요. 개인 기기 설정과 질문을 확인해 주세요.",
          saved ? {researchDelivery: "queued"} : {}));
      }
      const prompt = {
        ko: `‘${question}’ 질문과 결과를 저장하고 공개 자료를 조사할까요? 앱을 다시 열면 이어서 조사해요.`,
        en: `Save the question “${question}” and its results, and research public sources? Research resumes when you reopen the app.`,
        zh: `是否保存问题“${question}”及结果，并调查公开资料？下次打开应用会继续调查。`,
        ja: `「${question}」という質問と結果を保存し、公開資料を調査しますか？アプリを再度開くと調査を再開します。`,
      }[lang];
      s.dialogue.askApproval({ kind: "research", goal: question, confirmation: {
        actionId: randomUUID(), kind: "public-research", purpose: "공개 자료 조사", description: prompt, site: "청음", values: [], realSubmission: false,
      } });
      return s.finish(turn, draft("WAITING_FOR_USER_CONFIRMATION", "clarify", prompt, { lang }));
    }
    if (decision.kind === "conversation") {
      turn.intentType = "CHAT";
      return s.finish(turn, draft(s.state, "chat", decision.reply ?? "", { lang }));
    }
    if (decision.command) {
      const intent = singleBrowserIntent(decision.command);
      return this.command(turn, intent.type, () => s.route(intent, turn));
    }
    if (decision.kind === "read_skill") {
      if (decision.skill == null) throw new RangeError("읽기 기술이 없는 결정");
      const intent = skillIntent(decision.skill);
      return this.command(turn, intent.type, () => s.dispatch(intent, turn, decision.exclusions));
    }
    if (decision.kind === "existing") {
      if (asking) s.publicTask = new PublicTask({ ...task, question: "", choices: [] });
      return undefined;
    }
    task = nextTask;
    if (decision.kind === "clarify") {
      turn.researchState = "needs_input";
      s.publicTask = task;
      if (continuingReview !== undefined) {
        continuingReview.task = task;
        s.reviewQuestion = [task, continuingReview];
      }
      return clarify(task.question);
    }
    turn.ctx = withContext(turn.ctx, { publicLookup: true });
    // 저장한 조사 작업은 이미 격리된 브라우저에서 실행 중이다.
    const mode = research ? undefined : task.searchMode;
    if (decision.kind !== "open_agency" && mode !== "visible" && source === undefined) throw new RangeError("자료 출처가 없는 조회");
    const kind = decision.kind === "open_agency" ? "OPEN_SITE" : mode === "visible" || source === undefined ? "GOAL" : LOOKUPS[source];
    turn.intentType = kind;
    const refused = s.gate([kind]);
    if (refused !== undefined) return s.finish(turn, refused);
    const result = await this.execute(task, turn, mode, { research });
    if (!s.superseded(turn)) {
      s.publicTask = new PublicTask({ ...task, question: result.taskQuestion ?? "" });
      if ((result.sources ?? []).length > 0) {
        turn.researchState = result.researchState ?? "completed";
        if (research) turn.researchEvidence = [result.researchEvidence, result.answerCard?.answer].find(found => found !== undefined && found.length > 0) ?? result.speech;
      } else if (result.taskQuestion !== undefined && result.taskQuestion.length > 0) turn.researchState = "needs_input";
    }
    return s.finish(turn, result);
  }

  /** 판단이 고른 읽기 전용 일을 한다. turn.intentType이 무엇을 할지 정한다(OPEN_SITE·FIND_PLACE·POLICY_QUESTION·GOAL). */
  async execute(task: PublicTask, turn: Turn, mode: SearchMode | undefined, { research = false, maxSteps, continuePage = false, requestedSteps = [], journey }: Bounds = {}): Promise<Draft> {
    const s = this.session;
    const lang = s.lang;
    const bounds = { research, maxSteps, continuePage, requestedSteps, journey };
    const kind = turn.intentType;
    if (!research && kind !== "OPEN_SITE" && s.consentStatus === "granted" && !turn.ctx.signal.aborted &&
        turn.ctx.browsingScope !== "personal-inspection") s.startResearchDelivery(turn.id);
    if (!research && (kind === "OPEN_SITE" || mode === "visible")) await s.web.showBrowser();
    if (kind === "OPEN_SITE") return s.browse.openSite(task.destination ?? task.agency ?? "", turn.ctx);
    if (kind === "FIND_PLACE") {
      const found = s.replies.findPlace({ ...turn, text: redactText(task.goal) });
      return mode === "quiet" && found.semanticAction === "find-place" && (found.sources ?? []).length === 0 ? this.quietLookup(task, turn, bounds) : found;
    }
    if (kind === "POLICY_QUESTION") {
      backendActivity("welfare");
      const answer = await s.deps.welfare.publicFacts(task.subject, task.goal, task.facts, turn.ctx.signal);
      if (answer !== undefined) {
        const found = s.replies.welfareDraft(answer, "welfare-retrieval");
        return research && answer.card !== undefined ? { ...found, sources: citeWithData(answer.card, answer.sources) } : found;
      }
      if (mode === "quiet" && task.goal.length > 0) return this.quietLookup(task, turn, bounds);
      if (task.subject.length === 0) {
        if (task.goal.length > 0) return s.browse.runGoal(task.goal, turn.ctx, { publicTask: task, ...bounds });
        const prompt = spoken(ASK_SERVICE, lang);
        return { ...draft(s.state, "clarify", prompt, { lang }), taskQuestion: prompt };
      }
      if (turn.ctx.signal.aborted) return draft("STOPPED", "none", FIXED.stopBusy[lang], { lang });
      const official = new PublicTask({ ...task, agency: task.agency != null && task.agency.length > 0 ? task.agency : "복지로" });
      return s.browse.runGoal(official.goal, turn.ctx, { publicTask: official, ...bounds });
    }
    if (mode === "quiet") return this.quietLookup(task, turn, bounds);
    return s.browse.runGoal(task.goal, turn.ctx, { publicTask: task, ...bounds });
  }

  /** 현재 탭과 저장 작업을 건드리지 않고 이 턴에서 공개 출처를 확인한다. */
  async quietLookup(task: PublicTask, turn: Turn, bounds: Bounds = {}): Promise<Draft> {
    if (bounds.research === true) return this.#lookup(task, turn, bounds);
    const s = this.session;
    const remaining = Math.max(0, Math.ceil(turn.started + BROWSE_TIME_BUDGET_MS - performance.now()));
    const deadline = AbortSignal.timeout(remaining);
    const signal = AbortSignal.any([deadline, turn.ctx.signal]);
    const scoped = {...turn, ctx: withContext(turn.ctx, {signal})};
    turn.researchOutcome = true;
    s.startResearchDelivery(turn.id);
    try {
      const result = await raceAbort(() => this.#lookup(task, scoped, bounds), signal);
      return {...result, researchDelivery: "outcome"};
    } catch (error) {
      if (turn.ctx.signal.aborted) return draft("STOPPED", "none", FIXED.stopBusy[s.lang], {lang: s.lang});
      if (!deadline.aborted) throw error;
      return draft(s.state, "web-answer", spoken(LOOKUP_TIMEOUT, s.lang), {lang: s.lang, researchDelivery: "outcome"});
    }
  }

  async #lookup(task: PublicTask, turn: Turn, { maxSteps, requestedSteps, research }: Bounds): Promise<Draft> {
    const s = this.session;
    const lang = s.lang;
    const signal = turn.ctx.signal;
    const search = s.deps.quietSearch;
    let answer: QuietAnswer = {};
    const permitted = s.consentStatus === "granted" && !signal.aborted &&
      [task.goal, task.subject].every(term => s.speakable(term) && detectSensitive(term).kinds.length === 0);
    if (search !== undefined && permitted && task.destination === undefined && !task.facts.includes("page_title")) {
      backendActivity("searching");
      try {
        answer = await raceAbort(within => (requestedSteps?.length ?? 0) > 0
          ? search(task, lang, within, requestedSteps) : search(task, lang, within), signal);
      }
      catch { answer = {}; }
    }
    if (signal.aborted) return draft("STOPPED", "none", FIXED.stopBusy[lang], { lang });
    if (answer.sources !== undefined && answer.sources.length > 0 && answer.speech !== undefined && answer.speech.length > 0) {
      return draft(s.state, "web-answer", answer.speech, {
        sources: answer.sources, reviewQuotes: answer.reviewQuotes, reviewQuoteSources: answer.reviewQuoteSources, lang,
      });
    }
    const browse = s.deps.browsePublicSources;
    let result: Draft | undefined;
    if (permitted && browse !== undefined && maxSteps !== 0 && task.facts.length > 0) {
      turn.ctx.trace("PLANNING", AGENT_IDS.orchestrator, "공개 웹 자료에서 근거 확인");
      if (research !== true) s.progress.milestone(`official-browser:${turn.id}`, CHECKING_OFFICIAL_SITES[lang]);
      try { result = await raceAbort(() => browse(task, turn.ctx, maxSteps, requestedSteps), signal); }
      catch (error) {
        // 모델 연결 실패는 사용자에게 알리고, 격리된 브라우저 같은 그 밖의 실패는 이 보완 경로만 건너뛴다.
        if (error instanceof ModelTransportError) throw error;
        turn.ctx.trace("PLANNING", AGENT_IDS.orchestrator, "공개 웹 자료 확인을 건너뜀");
      }
    }
    if (signal.aborted) return draft("STOPPED", "none", FIXED.stopBusy[lang], { lang });
    if (result?.sources !== undefined && result.sources.length > 0 && (result.reviewQuotes?.length ?? 0) > 0) {
      // 조용히 연 탭의 DOM 제목만 전달한다. 그 탭의 컨트롤·본문은 현재 사용자 화면이 아니다.
      const titlePages = task.facts.includes("page_title") ? result.reviewPages?.filter(page => result.reviewQuotes?.includes(page.title) === true)
        .map(page => ({...page, afterActionId: "", headings: [], selected: [], text: ""})) : undefined;
      return draft(s.state, "web-answer", result.speech, { lang: result.lang ?? "ko", sources: result.sources,
        browserIterations: result.browserIterations, researchState: result.researchState, researchEvidence: result.researchEvidence,
        ...(titlePages === undefined ? {} : {reviewPages: titlePages}),
        reviewQuotes: result.reviewQuotes, reviewQuoteSources: result.reviewQuoteSources });
    }
    if (result?.taskQuestion !== undefined && result.taskQuestion.length > 0 && s.speakable(result.taskQuestion)) {
      return draft(s.state, "clarify", result.taskQuestion, { lang: result.lang ?? "ko",
        taskQuestion: result.taskQuestion, browserIterations: result.browserIterations });
    }
    let message = spoken(LOOKUP_UNAVAILABLE, lang);
    if (result !== undefined) {
      const title = result.lastVisitedTitle;
      const reached = title !== undefined && title.length > 0 && title !== REDACTED && s.speakable(title) && detectSensitive(title).kinds.length === 0
        ? {ko: `‘${title}’ 화면까지 확인했어요.`, en: `I reached “${title}”.`,
          zh: `我找到了“${title}”页面。`, ja: `「${title}」のページまで確認しました。`}[lang] : "";
      message = [reached, message, OPEN_SITE_SEARCH[lang]].filter(Boolean).join(" ");
    }
    return draft(s.state, "web-answer", message, { lang, browserIterations: result?.browserIterations });
  }

  /** 계획에 주는 지금 맥락: 어느 기관·업무 이야기인지와 그 기관의 최근 대화 */
  planningContext(goal: string, siteUrl?: string): PlanningContext {
    const s = this.session;
    const here = siteUrl !== undefined && siteUrl.length > 0 ? siteUrl : s.web.currentView?.url ?? "";
    let label = siteLabel(here);
    if (label.length === 0 && s.activeService !== undefined) label = s.activeService[0];
    const service = s.activeService?.[0] === label ? s.activeService[1] : "";
    const context: PlanningContext = { language: s.lang, agency: label, service, recentTurns: s.publicTurns.filter(turn => turn.agency === label) };
    const need = s.need.context();
    if (need !== undefined) context.need = need;
    const region = s.profile.ctpv;
    if (region != null && region.length > 0 && publicPatterns.nearby.test(goal)) context.region = region;
    return context;
  }

  /** 방금 이야기한 기관에 이어 묻는 짧은 말("필요한 서류는?")이면 그 기관에서 찾을 목표 문장 */
  followup(text: string): string | undefined {
    const s = this.session;
    if (s.activeService === undefined || (s.state !== "IDLE" && s.state !== "BROWSING")) return undefined;
    const view = s.web.currentView;
    const [agency, topic] = s.activeService;
    if (view !== undefined && view.pageId !== "blank" && siteLabel(view.url) !== agency) return undefined;
    if (mentionsKnownSite(text, false) || publicServiceSite(text) !== undefined) return undefined;
    const words = stripChars(text.replace(publicPatterns.spaces, ""), ".!?");
    if (!publicPatterns.followup.test(words) || publicPatterns.otherTask.test(words)) return undefined;
    return [`${agency}에서`, topic, text].filter(part => part.length > 0).join(" ");
  }
}
