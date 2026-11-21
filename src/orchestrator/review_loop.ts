// 여러 단계를 거치는 요청을 끝까지 하고, 답하기 전에 원래 요청과 대조하는 고리(task_review.ts가 판정한다).
import { AsyncLocalStorage } from "node:async_hooks";
import { BrowserJourney } from "../agents/web/journey.ts";
import { accessBlocked, stillNeedsAuth } from "../agents/web/auth_page.ts";
import { raceAbort } from "../core/abort.ts";
import type { Intent } from "../core/intents.ts";
import type { Redacted } from "../core/llm.ts";
import { hasText, strip } from "../core/text.ts";
import { tryUrl } from "../core/url.ts";
import { todayIso } from "../core/time.ts";
import { AGENT_IDS, draft, type Draft, type DraftAction, type SourceCitation, type TaskReviewSummary } from "../core/turn.ts";
import { FIXED, translateIn } from "../language/i18n.ts";
import { PERSONAL_BROWSE_TEXT } from "../speech/browse_phrases.ts";
import { HISTORY_DESCRIBED } from "../speech/picture.ts";
import { redactPictureText, redactText } from "../safety/privacy.ts";
import { PublicTask, publicDestinations } from "./public_task.ts";
import { PLAN_STOP_STATES, byLengthDesc, isAbort, replaceValues, withContext, type SessionOrchestrator, type Turn } from "./session.ts";
import { evidenceFromDraft, inspectionEvidence, pageMatches, reviewBeforeOutput, reviewEvidence, type ReviewEvidence, type Route } from "./task_review.ts";

// 검토 횟수, 전체 탐색 판단 횟수, 실제 브라우저 조작 횟수. 재시도와 승인 후 재개가 함께 사용한다.
export const REVIEW_LIMITS = { easy: [2, 8, 8], medium: [3, 16, 16], hard: [5, 32, 32] } as const;
export type Difficulty = keyof typeof REVIEW_LIMITS;
export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === "string" && Object.hasOwn(REVIEW_LIMITS, value);
}
/** 음성 턴이 고른 난이도. 요청마다 따로 흐른다(Python의 ContextVar). */
export const LIVE_DIFFICULTY = new AsyncLocalStorage<Difficulty | undefined>();

type Step = readonly [intent: Intent, said: Redacted];
interface PlannedAction {
  readonly id: number;
  readonly step: Step;
  status: "ready" | "waiting" | "observed" | "unresolved";
}
interface ReviewedFields {
  request: Redacted;
  task: PublicTask;
  requirements: readonly string[];
  route: Route;
  difficulty: Difficulty;
  counter?: { actions: number };
  rounds?: number;
  remaining?: Step[];
  originalOperations?: Set<string>;
  privateValues?: string[];
  background?: boolean;
  inspection?: "answer" | "arrival";
  publicArrival?: boolean;
}

/** 검토를 거치는 일 하나. 승인·되물음·본인인증으로 멈췄다 이어 가도 같은 횟수 한도와 근거를 쓴다. */
export class ReviewedTask {
  readonly request: Redacted;
  task: PublicTask;
  readonly requirements: readonly string[];
  route: Route;
  readonly difficulty: Difficulty;
  rounds: number;
  browserSteps = 0;
  readonly counter: { actions: number };
  readonly evidence: ReviewEvidence[] = [];
  readonly sources = new Map<string, SourceCitation>();
  readonly attempted = new Set<string>();
  readonly originalOperations: Set<string>;
  readonly plan: PlannedAction[] = [];
  readonly publicFactsOnly: boolean;
  readonly privateValues: string[];
  readonly retries = new Set<string>();
  readonly background: boolean;
  readonly journey?: BrowserJourney;
  readonly inspection?: "answer" | "arrival";
  readonly publicArrival: boolean;
  readonly entryOrigin?: string;

  constructor(fields: ReviewedFields & { publicFactsOnly?: boolean }) {
    this.request = fields.request;
    this.task = fields.task;
    this.requirements = fields.requirements;
    this.route = fields.route;
    this.difficulty = fields.difficulty;
    this.counter = fields.counter ?? { actions: 0 };
    this.rounds = fields.rounds ?? 0;
    this.addSteps(fields.remaining ?? []);
    this.publicFactsOnly = fields.publicFactsOnly ?? false;
    this.originalOperations = fields.originalOperations ?? new Set();
    this.privateValues = fields.privateValues ?? [];
    this.background = fields.background ?? false;
    this.inspection = this.background ? undefined : fields.inspection;
    this.publicArrival = !this.background && fields.publicArrival === true;
    if (this.inspection !== undefined) {
      const supplied = publicDestinations(fields.request).urls;
      if (supplied.size === 1) this.entryOrigin = [...supplied.keys()][0];
    }
    if (!this.background) this.journey = new BrowserJourney(REVIEW_LIMITS[this.difficulty][1]);
  }

  addSteps(steps: readonly Step[]): void {
    for (const step of steps) this.plan.push({ id: this.plan.length + 1, step, status: "ready" });
  }
}

const RETRY_READS: ReadonlySet<string> = new Set(["OPEN_SITE", "FOLLOW_LINK", "GOAL", "SEARCH", "READ_MAIN",
  "ABOUT_SITE", "CURRENT_STEP", "POLICY_QUESTION", "FIND_PLACE"]);
const ALLOWED: ReadonlySet<string> = new Set(["OPEN_SITE", "OPEN_OFFICIAL", "OPEN_BROWSER", "FOLLOW_LINK", "GOAL", "SEARCH",
  "START_APPLICATION", "FILL", "NEXT", "PREV", "READ_FIELD", "REVIEW", "PREPARE_SUBMIT",
  "LOGIN", "DESCRIBE_SCREEN", "READ_MAIN", "CURRENT_STEP", "ABOUT_SITE", "LIST_LINKS", "POLICY_QUESTION", "FIND_PLACE"]);
const EXCLUDED: ReadonlyMap<string, readonly string[]> = new Map([
  ["personal_input", ["FILL"]], ["submission", ["PREPARE_SUBMIT"]], ["login", ["LOGIN"]],
  ["application", ["START_APPLICATION", "FILL", "PREPARE_SUBMIT"]],
]);
const LIMITED_READS = ["login", "application", "submission", "personal_input"];
const INDEPENDENT_LOOKUPS = new Set<Intent["type"]>(["POLICY_QUESTION", "FIND_PLACE"]);
const SCREEN_READS = new Set<Intent["type"]>(["DESCRIBE_SCREEN", "READ_MAIN", "ABOUT_SITE", "CURRENT_STEP", "LIST_LINKS", "READ_FIELD", "REVIEW"]);
const LOOKUP_KINDS = { browser: "GOAL", quiet: "GOAL", welfare: "POLICY_QUESTION", places: "FIND_PLACE" } as const;
const evidenceKey = (e: ReviewEvidence) => JSON.stringify([e.kind, e.text, e.receiptId, e.sources, e.publicPhone, e.valueVerified, e.pageKey]);

export class ReviewLoop {
  private readonly session: SessionOrchestrator;
  constructor(session: SessionOrchestrator) { this.session = session; }

  static intentAllowed(kind: string, exclusions: readonly string[]): boolean {
    return ALLOWED.has(kind) && !exclusions.some(item => EXCLUDED.get(item)?.includes(kind) === true);
  }

  #stopped(): Draft {
    const lang = this.session.lang;
    return draft("STOPPED", "stop", FIXED.stopBusy[lang], { lang });
  }

  async run(run: ReviewedTask, turn: Turn, resumed?: Draft): Promise<Draft> {
    const started = Date.now();
    const previousActions = run.counter.actions;
    const record = (result: Draft): Draft => {
      const status = result.review?.status;
      const reason = status === "completed" ? "verified" : result.state === "STOPPED" ? "cancelled"
        : status === "needs_input" ? "needs_input" : result.actions?.some(action => !action.policy.allowed) === true ? "policy"
        : run.rounds >= REVIEW_LIMITS[run.difficulty][0] || run.browserSteps >= REVIEW_LIMITS[run.difficulty][1] ? "budget"
        : run.evidence.length === 0 && run.route !== "existing" ? "source_unavailable" : "no_progress";
      this.session.deps.events?.record({ sessionId: this.session.id, turnId: turn.id, actionType: "task-review", success: status === "completed",
        errorCode: reason, latencyMs: Date.now() - started, at: new Date().toISOString(), toolCalls: run.counter.actions - previousActions });
      return result;
    };
    try {
      const result = await this.#review(run, turn, resumed);
      // 사진 속 내용은 검토 모델과 대화 기록에 보내지 않고, 확인한 조작 결과와 함께 한 번 읽어 준다.
      if (resumed?.semanticAction === "describe-screen" && resumed.pictureHistory === HISTORY_DESCRIBED &&
          result.state !== "STOPPED" && !turn.ctx.signal.aborted && !this.session.superseded(turn)) {
        return record({...result, speech: strip(`${resumed.speech} ${result.speech}`), pictureHistory: HISTORY_DESCRIBED, privateHistory: true});
      }
      return record(result);
    }
    catch (error) {
      if (isAbort(error)) return record(this.#stopped());
      throw error;
    }
  }

  async #review(run: ReviewedTask, turn: Turn, resumed: Draft | undefined): Promise<Draft> {
    const s = this.session;
    const [rounds, , actions] = REVIEW_LIMITS[run.difficulty];
    const personal = run.inspection !== undefined;
    const privateValues = personal ? [...new Set([...run.privateValues, ...s.privateValuesForRedaction()])] : run.privateValues;
    turn.ctx = withContext(turn.ctx, { counter: run.counter, actionLimit: actions,
      ...(personal ? { browsingScope: "personal-inspection" } : {}) });
    const logs: DraftAction[] = [];
    let last = resumed;
    let missing: readonly string[] = run.requirements;

    const record = async (result: Draft) => {
      logs.push(...result.actions ?? []);
      run.browserSteps += result.browserIterations ?? 0;
      if (personal) {
        if (hasText(result.summary)) run.evidence.push(...await inspectionEvidence(result, s.deps.scanner, privateValues));
        return;
      }
      for (const source of result.sources ?? []) run.sources.set(source.url, source);
      run.evidence.push(...evidenceFromDraft(result));
      if (result.semanticAction === "describe-screen" && result.pictureHistory === HISTORY_DESCRIBED) {
        const captured = result.actions?.find(({action, policy, result: receipt}) => action.type === "capture" && policy.allowed &&
          receipt?.ok === true && "verified" in receipt && receipt.verified && receipt.actionId === action.id);
        if (captured) run.evidence.push(reviewEvidence("action", "화면 사진을 확인해 음성 설명을 준비했어요.", {receiptId: captured.action.id}));
      }
    };
    const summary = (status: TaskReviewSummary["status"]): TaskReviewSummary =>
      ({ status, difficulty: run.difficulty, rounds: run.rounds, maxRounds: rounds, browserIterations: run.browserSteps });
    const asks = (result: Draft) => result.taskQuestion !== undefined && result.taskQuestion.length > 0;
    const needsInput = (result: Draft) => this.#needsInput(result);
    const pause = (result: Draft): Draft => {
      const d = s.dialogue;
      const pending = d.approval;
      const clarification = d.clarification;
      const handoff = d.authHandoff;
      if (run.journey) {
        if (result.state === "WAITING_FOR_USER_CONFIRMATION") run.journey.blockedBy = "approval";
        if (result.state === "AUTH_HANDOFF") run.journey.pause(handoff?.kind === "captcha" ? "captcha" : "auth", handoff?.expectedOrigin);
      }
      if (result.navigationHandoff !== undefined) result.navigationHandoff.reviewedTask = run;
      else if (pending !== undefined && result.state === "WAITING_FOR_USER_CONFIRMATION") Object.assign(pending, { reviewedTask: run });
      else if (clarification !== undefined && result.state === "NEEDS_CLARIFICATION") {
        clarification.reviewedTask = run;
        clarification.reviewedUrl = s.web.currentView?.url;
      } else if (asks(result) && !run.background) {
        s.publicTask = new PublicTask({ ...run.task, question: result.taskQuestion });
        s.reviewQuestion = [s.publicTask, run];
      } else if (result.state === "AUTH_HANDOFF" && d.authWaiting && handoff !== undefined) s.authReview = [handoff.id, run];
      else if (d.placeAsk !== undefined) s.placeReview = [d.placeAsk, run];
      else if (result.state !== "AUTH_HANDOFF" && result.state !== "STOPPED" && !run.background) {
        const speech = personal
          ? strip(`${(result.lang ?? "ko") === s.lang ? result.speech : ""} ${PERSONAL_BROWSE_TEXT.incomplete[s.lang]}`)
          : result.speech + " 전체 요청은 아직 완료하지 못했어요.";
        return { ...result, actions: logs, review: summary("incomplete"), speech, lang: personal ? s.lang : result.lang };
      }
      return { ...result, actions: logs, review: summary("needs_input") };
    };

    const settled = await s.progress.review(async (): Promise<Draft | undefined> => {
      if (resumed !== undefined) {
        await record(resumed);
        const waiting = run.plan.find(action => action.status === "waiting");
        if (waiting !== undefined && !needsInput(resumed)) waiting.status = this.#actionSucceeded(resumed) ? "observed" : "unresolved";
        if (needsInput(resumed) || resumed.semanticAction === "none") return pause(resumed);
        if (run.journey?.blockedBy === "approval") run.journey.resumeAfterApproval();
      }
      let resuming = resumed !== undefined;
      while (run.rounds < rounds) {
        if (turn.ctx.signal.aborted || s.superseded(turn)) return this.#stopped();
        if (personal) {
          if (turn.ctx.publicLookup || s.web.guard.config.publicLookupOnly === true) break;
          const remaining = REVIEW_LIMITS[run.difficulty][1] - run.browserSteps;
          if (remaining <= 0) break;
          const refused = s.gate(["GOAL"]);
          if (refused) return pause(refused);
          await s.web.showBrowser();
          last = await s.browse.runGoal(run.task.goal, turn.ctx, { journey: run.journey, agency: run.task.agency, entryOrigin: run.entryOrigin, inspectionOutcome: run.inspection, privateValues,
            maxSteps: remaining, continuePage: run.browserSteps > 0 || resuming, exclusions: run.task.exclusions, requestedSteps: missing });
          await record(last);
          if (needsInput(last)) return pause(last);
          if (!hasText(last.summary)) break;
        } else if (run.route === "existing") {
          for await (const work of this.actions(run, turn, missing[0] ?? "", { resuming })) {
            last = work;
            await record(work);
            if (needsInput(work)) return pause(work);
          }
        } else if (!resuming) {
          const work = await this.lookup(run, turn, missing);
          if (work === undefined) break;
          last = work;
          await record(work);
          if (needsInput(work)) return pause(work);
          if (!run.background && run.task.searchMode === "visible" && work.view && (work.browserIterations ?? 0) > 0 &&
              !run.retries.has("blocked-public-entry") && (stillNeedsAuth(work.view) || accessBlocked(work.view))) {
            run.retries.add("blocked-public-entry");
            continue;
          }
        }
        resuming = false;
        if (turn.ctx.signal.aborted) return this.#stopped();
        let repair = "";
        let verdict;
        for (;;) {
          run.rounds += 1;
          turn.ctx.trace("VERIFYING", AGENT_IDS.orchestrator, `요청 완료 검토 ${run.rounds}/${rounds}`);
          const correction = repair;
          verdict = await raceAbort(signal => reviewBeforeOutput(s.deps.llm, s.historySpeech(run.request), run.evidence, signal, {
            language: s.lang, requirements: run.requirements, exclusions: run.task.exclusions, privateValues, repairReason: correction,
            inspection: run.inspection, publicArrival: run.publicArrival,
            publicFactsOnly: run.publicFactsOnly, ...(run.publicFactsOnly ? { publicContext: run.task.goal } : {}),
          }), turn.ctx.signal);
          if (repair.length > 0 || run.rounds >= rounds || verdict.repairReason.length === 0) break;
          repair = verdict.repairReason;
        }
        if (verdict.status === "complete" && !run.plan.some(action => action.status === "ready" || action.status === "waiting" ||
            (action.status === "unresolved" && !RETRY_READS.has(action.step[0].type)))) {
          if (verdict.confirmedPage !== undefined && verdict.confirmedPage.length > 0) {
            const current = await s.web.observe(turn.ctx).catch(() => undefined);
            if (!pageMatches(verdict, current, privateValues, personal)) break;
            if (personal && verdict.currentQuotes !== undefined && verdict.currentQuotes.length > 0) {
              const confirmed = await inspectionEvidence({ view: current, reviewQuotes: verdict.currentQuotes }, s.deps.scanner, privateValues);
              if (!verdict.currentQuotes.every(quote => confirmed.some(e => e.kind === "fact" && e.text === quote))) break;
            }
            if (turn.ctx.signal.aborted || s.superseded(turn)) return this.#stopped();
            const site = personal && current ? tryUrl(current.url) : undefined;
            if (site) {
              s.inspectedScreen = {task: run.task, confirmedPageKey: verdict.confirmedPageKey};
              const url = site.origin + "/";
              run.sources.set(url, {url, title: site.host, lastCheckedAt: todayIso(), note: PERSONAL_BROWSE_TEXT.currentPage[s.lang]});
            }
          }
          return draft(last?.state ?? s.state, "review-before-output", verdict.answer, {
            lang: s.lang, review: summary("completed"), actions: logs, sources: [...run.sources.values()],
            reviewQuotes: verdict.facts === undefined ? undefined : Object.keys(verdict.facts), reviewQuoteSources: verdict.facts,
          });
        }
        missing = verdict.missing.length > 0 ? verdict.missing : run.requirements;
        if (verdict.status !== "retry" || verdict.nextRoute === undefined) break;
        let route = personal ? "browser" as const : verdict.nextRoute;
        const mode = run.task.searchMode;
        if (mode === "quiet" && route === "browser") route = "quiet";
        if (mode === "visible" && route === "quiet") route = "browser";
        if (route === "existing") {
          if (run.background || mode === "quiet") break;
          if (mode === "visible") route = "browser";
          else if (!run.requirements.includes(missing[0] ?? "")) break;
        }
        const retry = JSON.stringify([route, missing, new Set(run.evidence.map(evidenceKey)).size]);
        if (run.retries.has(retry)) break;
        run.retries.add(retry);
        run.route = route;
      }
      return undefined;
    });
    if (settled !== undefined) return settled;

    const said = replaceValues(s.historySpeech(missing.join(" / ")), run.privateValues.filter(value => value.length > 0));
    const detail = Array.from(strip(redactPictureText(said))).slice(0, 320).join("");
    const lang = personal ? s.lang : "ko";
    const milestone = run.journey?.lastMilestone;
    const checkpoint = personal && hasText(milestone) ? `${milestone} ` : "";
    const speech = checkpoint + PERSONAL_BROWSE_TEXT.incomplete[lang] +
      (detail.length > 0 ? " " + PERSONAL_BROWSE_TEXT.missing[lang].replace("{detail}", () => detail) : "");
    return draft(last?.state ?? s.state, "review-before-output", speech, { lang, review: summary("incomplete"), actions: logs, sources: [...run.sources.values()] });
  }

  /** 사용자가 말한 조작을 차례로 한다. 기존 권한 문을 통과한 요청만 실행하고, 검토 결과로 승인이나 입력을 만들지 않는다. */
  async *actions(run: ReviewedTask, turn: Turn, missing: string, { resuming }: { resuming: boolean }): AsyncGenerator<Draft, void, void> {
    const s = this.session;
    const [, steps, actions] = REVIEW_LIMITS[run.difficulty];
    const signal = turn.ctx.signal;
    if (!run.plan.some(action => action.status === "ready") && !resuming) {
      let requested: Redacted | undefined = run.rounds === 0 ? run.request : redactText(missing);
      const translator = s.deps.webLlm ?? s.deps.llm;
      if (s.lang !== "ko") {
        const korean = translator === undefined ? undefined : await translateIn(translator, requested, s.lang, signal);
        requested = korean === undefined ? undefined : redactText(korean);
      }
      if (requested === undefined || requested.length === 0) return;
      const said = requested;
      const step: Turn = { ...turn, text: said, original: undefined };
      const understood = await raceAbort(() => s.understand(said, step, { maxSteps: actions }), signal);
      if (run.rounds === 0) for (const intent of understood.intents) run.originalOperations.add(JSON.stringify(intent));
      const intents = understood.intents.filter(intent => run.rounds === 0 ||
        (RETRY_READS.has(intent.type) && !run.attempted.has(JSON.stringify(intent))));
      run.addSteps(intents.map((intent): Step => [intent, said]));
    }
    const failures: Intent["type"][] = [];
    for (const action of run.plan) {
      if (signal.aborted) return;
      const [intent, said] = action.step;
      const kind = intent.type;
      if (action.status !== "ready") {
        if (action.status === "unresolved") failures.push(kind);
        continue;
      }
      if (failures.length > 0 && !INDEPENDENT_LOOKUPS.has(kind) &&
          !(SCREEN_READS.has(kind) && failures.every(failed => SCREEN_READS.has(failed)))) continue;
      const operation = JSON.stringify(intent);
      if (!ReviewLoop.intentAllowed(kind, run.task.exclusions)) {
        action.status = "unresolved";
        failures.push(kind);
        continue;
      }
      if (intent.type === "FILL") {
        const values = intent.fills.map(fill => fill.value);
        if (values.some(value => !said.includes(value))) {
          action.status = "unresolved";
          failures.push(kind);
          continue;
        }
        run.privateValues.push(...values);
      }
      const retryRead = run.rounds > 0 && !run.originalOperations.has(operation);
      run.attempted.add(operation);
      const limitedRead = retryRead || ((kind === "GOAL" || kind === "FOLLOW_LINK" || kind === "SEARCH") &&
        LIMITED_READS.some(item => run.task.exclusions.includes(item)));
      const local: Turn = { ...turn, text: said, intentType: kind, ctx: withContext(turn.ctx, { publicLookup: limitedRead }) };
      const refused = s.gate([kind]);
      if (refused !== undefined) {
        yield refused;
        return;
      }
      let last: Draft;
      if (intent.type === "GOAL") {
        // 남은 조작은 그대로 둔다. 다음 검토가 무엇이 빠졌는지 본다.
        if (run.browserSteps >= steps) return;
        last = await s.browse.runGoal(intent.goal, local.ctx, {
          maxSteps: steps - run.browserSteps, exclusions: run.task.exclusions, requestedSteps: [intent.goal], journey: run.journey,
        });
      } else {
        last = await s.route(intent, local, {exclusions: run.task.exclusions, confirmPicture: true});
      }
      action.status = this.#needsInput(last) ? "waiting" : this.#actionSucceeded(last) ? "observed" : "unresolved";
      if (action.status === "unresolved") failures.push(kind);
      yield last;
      if (action.status === "waiting") return;
    }
  }

  #needsInput(result: Draft): boolean {
    return PLAN_STOP_STATES.has(result.state) || hasText(result.taskQuestion) || this.session.dialogue.placeAsk !== undefined ||
      result.semanticAction === "clarify" || result.semanticAction === "consent";
  }

  #actionSucceeded(result: Draft): boolean {
    return result.semanticAction !== "none" && (result.actions ?? []).every(({ action, policy, result: receipt }) =>
      policy.allowed && receipt?.ok === true && "verified" in receipt && receipt.verified === true && receipt.actionId === action.id);
  }

  /** 쌓인 근거를 보존하고, 재시도는 원래 기관·조건 안에서 빠진 항목만 조사한다. */
  async lookup(run: ReviewedTask, turn: Turn, missing: readonly string[]): Promise<Draft | undefined> {
    const s = this.session;
    const [, steps] = REVIEW_LIMITS[run.difficulty];
    const goal = run.rounds === 0 ? run.task.goal : `확인할 항목: ${missing[0] ?? ""}\n원래 대상과 조건: ${run.task.goal}`;
    const hidden = [...new Set(run.privateValues.filter(value => value.length > 0))].sort(byLengthDesc);
    let subtask = new PublicTask({ ...run.task, goal: replaceValues(goal, hidden), subject: replaceValues(run.task.subject, hidden) });
    if ((run.rounds > 0 || run.publicArrival && subtask.facts.length === 0) && run.route === "browser") subtask = new PublicTask({ ...subtask, facts: ["other"] });
    let mode = run.background && run.task.searchMode !== "quiet" ? undefined : run.task.searchMode;
    if (run.route === "quiet" || (mode === "quiet" && run.route === "browser")) mode = "quiet";
    else if (run.route === "browser") mode = "visible";
    if (run.route === "existing") throw new RangeError("조회가 아닌 길");
    const kind = LOOKUP_KINDS[run.route];
    const refused = s.gate([kind]);
    if (refused !== undefined) return refused;
    if (mode === "visible" && run.browserSteps >= steps) return undefined;
    const step: Turn = { ...turn, intentType: kind, ctx: withContext(turn.ctx, { publicLookup: true }) };
    return s.planner.execute(subtask, step, mode, {
      research: run.background, maxSteps: Math.max(0, steps - run.browserSteps), continuePage: run.browserSteps > 0, journey: run.journey,
      requestedSteps: missing.map(part => replaceValues(part, hidden)),
    });
  }
}
