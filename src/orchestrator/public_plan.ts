// 공공업무 요청을 세션에서 받는 자리: 판단(public_task.ts)을 묻고, 읽기 전용 조회나 검토를 거치는 일로 보낸다.
import { randomUUID } from "node:crypto";
import { raceAbort } from "../core/abort.ts";
import type { Intent } from "../core/intents.ts";
import { ackKind, agree } from "../core/lexicon.ts";
import type { Redacted } from "../core/llm.ts";
import { rstripChars, stripChars } from "../core/text.ts";
import { AGENT_IDS, draft, type Draft, type Lang, type SourceCitation, type TurnResult } from "../core/turn.ts";
import { FIXED } from "../language/i18n.ts";
import { REDACTED, detectSensitive, redactText } from "../safety/privacy.ts";
import { isExactCommand, pictureCommandParts } from "../understanding/fastpath.ts";
import { isPictureRequest } from "../understanding/rules.ts";
import { mentionsKnownSite, publicServiceSite, siteLabel } from "../understanding/sites.ts";
import { publicPatterns } from "./patterns.ts";
import { ASK_SERVICE, LOOKUP_UNAVAILABLE, PublicTask, REJECTED, decide, reviewCompletion, type PublicDecision } from "./public_task.ts";
import { LIVE_DIFFICULTY, ReviewedTask } from "./review_loop.ts";
import { withContext, type Detection, type PublicTurn, type SessionOrchestrator, type Turn } from "./session.ts";
import { wordSuggestions } from "./speech_repair.ts";

/** 조용한 조회(현재 탭을 건드리지 않는 공개 출처 확인)가 돌려주는 답. 찾지 못하면 빈 객체. */
export interface QuietAnswer {
  speech?: string;
  sources?: SourceCitation[];
  reviewQuotes?: readonly string[];
  reviewQuoteSources?: Readonly<Record<string, readonly string[]>>;
}
export interface PlanningContext { language: Lang; agency: string; service: string; recentTurns: PublicTurn[]; region?: string }
type SearchMode = PublicTask["searchMode"];
interface Bounds { research?: boolean; maxSteps?: number; continuePage?: boolean; requestedSteps?: readonly string[] }

const PLAN_STATES = new Set(["IDLE", "BROWSING", "NEEDS_CLARIFICATION"]);
const LOOKUPS = { browser: "GOAL", welfare: "POLICY_QUESTION", places: "FIND_PLACE" } as const;
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
      !isExactCommand(text) && !isPictureRequest(rstripChars(text, ".!。")) && pictureCommandParts(text, s.rules).length === 0 &&
      (s.publicTask.question.length > 0 || ackKind(text) === undefined);
  }

  /** 저장해 둔 조사 한 건. 격리된 새 작업 세션에서만 부른다. */
  async research(prompt: string, language: Lang): Promise<[state: string, result: { text?: string; sources?: SourceCitation[] }]> {
    const s = this.session;
    if (s.consentStatus !== "granted" || s.deps.llm === undefined || detectSensitive(prompt).hasSecretValue) return ["incomplete", {}];
    const text = redactText(prompt);
    s.lang = language;
    const turn = s.beginTurn(text);
    const planned = await this.plan(text, turn, { research: true });
    if (planned === undefined) return ["incomplete", {}];
    let limited = false;
    if (turn.researchState === "completed" && planned.review === undefined) {
      turn.researchState = await reviewCompletion(s.deps.webLlm, text, turn.researchEvidence, turn.ctx.signal);
      if (turn.ctx.signal.aborted || turn.researchState === "incomplete") return ["incomplete", {}];
      limited = turn.researchState === "partial";
    }
    const result = await s.localize(planned);
    return [turn.researchState, { text: limited ? `${LIMITED[result.lang]} ${result.speech}` : result.speech, sources: result.sources }];
  }

  async plan(text: Redacted, turn: Turn, { research = false }: { research?: boolean } = {}): Promise<TurnResult | undefined> {
    const s = this.session;
    const llm = s.deps.llm;
    if (llm === undefined) return undefined;
    const lang = s.lang;
    let task = s.publicTask;
    const asking = task.question.length > 0;
    if (task.goal.length === 0 && !asking && s.activeService !== undefined) {
      task = new PublicTask({ ...task, agency: s.activeService[0], subject: s.activeService[1] });
    }
    const clarify = (speech: string) => {
      turn.intentType = "CLARIFY";
      return s.finish(turn, draft(s.state, "clarify", speech, { lang }));
    };
    const reply = agree(text);
    if (asking && reply === "no") {
      s.publicTask = new PublicTask();
      return clarify(spoken(REJECTED, lang));
    }
    if (asking && reply === "yes" && task.choices.length > 1) return clarify(`${task.question} ${task.choices.join(" / ")}`);
    const [candidates, clear] = turn.fromVoice && lang === "ko" && !asking ? wordSuggestions(text) : [[], false];
    turn.ctx.trace("PLANNING", AGENT_IDS.orchestrator, "공공업무 결정");
    const agency = task.agency ?? null;
    const recent = s.publicTurns.filter(r => r.agency === agency);
    const notes = s.deps.recallNotes !== undefined && !research ? await s.deps.recallNotes(text) : [];
    const scanner = s.deps.scanner;
    const decision = await decide(llm, text, lang, task, {
      voice: turn.fromVoice, recent, signal: turn.ctx.signal, ...(research ? { research: true } : {}),
      ...(notes.length > 0 ? { savedNotes: notes } : {}),
      speechCandidates: candidates.slice(0, 2).map(c => c.label), corroborated: clear,
      ...(scanner === undefined ? {} : { scan: (texts: readonly string[]) => scanner.scan(texts) }),
    });
    if (s.superseded(turn) || turn.ctx.signal.aborted) return s.finish(turn, draft("STOPPED", "none", FIXED.stopBusy[lang], { lang }));
    if (decision === undefined) return asking ? clarify(task.question) : undefined;
    const previousReview = s.reviewQuestion;
    s.reviewQuestion = undefined;
    const source = decision.source ?? undefined;
    const lookup = decision.kind === "find_information" || decision.kind === "review_before_output";
    if (previousReview !== undefined && previousReview[0] === task && decision.continuation && lookup && source !== undefined) {
      const run = previousReview[1];
      run.task = task.advance(decision);
      run.route = source;
      s.publicTask = run.task;
      turn.intentType = "REVIEW_BEFORE_OUTPUT";
      return s.finish(turn, await s.review.run(run, turn));
    }
    // 독립된 단서 없이 발음만 비슷한 기관·증명서 중 하나를 실행하지 않는다.
    if (candidates.length > 1 && !clear && (decision.kind === "open_agency" || lookup)) return undefined;
    if (research && !(decision.kind === "clarify" || decision.kind === "find_information" ||
        (decision.kind === "review_before_output" && source !== undefined))) return undefined;
    const live = LIVE_DIFFICULTY.getStore();
    if (decision.kind === "review_before_output" || (!research && decision.kind === "find_information" && live === "hard")) {
      const requirements = decision.requirements ?? [];
      const reviewed = new ReviewedTask({
        request: text, task: task.advance(decision), requirements: requirements.length > 0 ? requirements : [text],
        route: source ?? "existing", difficulty: live ?? decision.difficulty ?? "medium", counter: turn.ctx.counter, background: research,
      });
      turn.intentType = "REVIEW_BEFORE_OUTPUT";
      s.publicTask = reviewed.task;
      const result = await s.review.run(reviewed, turn);
      if (research) turn.researchState = result.review?.status ?? "incomplete";
      return s.finish(turn, result);
    }
    if (decision.kind === "delegate_research") {
      turn.intentType = "CLARIFY";
      if (s.deps.delegateResearch === undefined) return s.finish(turn, draft(s.state, "clarify", "자료 조사를 맡기려면 이용 설정에서 개인 기기를 선택해 주세요."));
      const question = decision.goal ?? "";
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
    if (decision.kind === "read_skill") {
      if (decision.skill == null) throw new RangeError("읽기 기술이 없는 결정");
      turn.intentType = decision.skill;
      return s.finish(turn, s.gate([decision.skill]) ?? await s.dispatch(skillIntent(decision.skill), turn, decision.exclusions));
    }
    if (decision.kind === "existing") {
      if (asking) s.publicTask = new PublicTask({ ...task, question: "", choices: [] });
      return undefined;
    }
    task = task.advance(decision);
    if (decision.kind === "clarify") {
      turn.researchState = "needs_input";
      s.publicTask = task;
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
  async execute(task: PublicTask, turn: Turn, mode: SearchMode | undefined, { research = false, maxSteps, continuePage = false, requestedSteps = [] }: Bounds = {}): Promise<Draft> {
    const s = this.session;
    const lang = s.lang;
    const bounds = maxSteps === undefined ? {} : { maxSteps, continuePage, requestedSteps };
    const kind = turn.intentType;
    if (!research && (kind === "OPEN_SITE" || mode === "visible")) await s.web.showBrowser();
    if (kind === "OPEN_SITE") return s.browse.openSite(task.agency ?? "", turn.ctx);
    if (kind === "FIND_PLACE") {
      const found = s.replies.findPlace({ ...turn, text: redactText(task.goal) });
      return mode === "quiet" && found.semanticAction === "find-place" && (found.sources ?? []).length === 0 ? this.quietLookup(task, turn) : found;
    }
    if (kind === "POLICY_QUESTION") {
      const answer = await s.deps.welfare.publicFacts(task.subject, task.goal, task.facts, turn.ctx.signal);
      if (answer !== undefined) return s.replies.welfareDraft(answer, "welfare-retrieval");
      if (task.subject.length === 0) {
        const prompt = spoken(ASK_SERVICE, lang);
        return { ...draft(s.state, "clarify", prompt, { lang }), taskQuestion: prompt };
      }
      if (turn.ctx.signal.aborted) return draft("STOPPED", "none", FIXED.stopBusy[lang], { lang });
      if (mode === "quiet") return this.quietLookup(task, turn);
      const official = new PublicTask({ ...task, agency: task.agency != null && task.agency.length > 0 ? task.agency : "복지로" });
      return s.browse.runGoal(official.goal, turn.ctx, { publicTask: official, ...bounds });
    }
    if (mode === "quiet") return this.quietLookup(task, turn);
    return s.browse.runGoal(task.goal, turn.ctx, { publicTask: task, ...bounds });
  }

  /** 현재 탭과 저장 작업을 건드리지 않고 이 턴에서 공개 출처를 확인한다. */
  async quietLookup(task: PublicTask, turn: Turn): Promise<Draft> {
    const s = this.session;
    const lang = s.lang;
    const signal = turn.ctx.signal;
    const search = s.deps.quietSearch;
    let answer: QuietAnswer = {};
    if (search !== undefined && s.consentStatus === "granted" && !signal.aborted &&
        [task.goal, task.subject].every(term => s.speakable(term) && detectSensitive(term).kinds.length === 0)) {
      try { answer = await raceAbort(within => search(task, lang, within), signal); }
      catch { answer = {}; }
    }
    if (signal.aborted) return draft("STOPPED", "none", FIXED.stopBusy[lang], { lang });
    if (answer.sources !== undefined && answer.sources.length > 0 && answer.speech !== undefined && answer.speech.length > 0) {
      return draft(s.state, "web-answer", answer.speech, {
        sources: answer.sources, reviewQuotes: answer.reviewQuotes, reviewQuoteSources: answer.reviewQuoteSources, lang,
      });
    }
    return draft(s.state, "web-answer", spoken(LOOKUP_UNAVAILABLE, lang), { lang });
  }

  /** 계획에 주는 지금 맥락: 어느 기관·업무 이야기인지와 그 기관의 최근 대화 */
  planningContext(goal: string, siteUrl?: string): PlanningContext {
    const s = this.session;
    const here = siteUrl !== undefined && siteUrl.length > 0 ? siteUrl : s.web.currentView?.url ?? "";
    let label = siteLabel(here);
    if (label.length === 0 && s.activeService !== undefined) label = s.activeService[0];
    const service = s.activeService?.[0] === label ? s.activeService[1] : "";
    const context: PlanningContext = { language: s.lang, agency: label, service, recentTurns: s.publicTurns.filter(turn => turn.agency === label) };
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
