import { FormSkill } from "../agents/web/skills/form.ts";
import { GuidedFill } from "../agents/web/skills/guided.ts";
import { ApplicationCommands } from "./application.ts";
import { PersonalDialogue } from "../personal/dialogue.ts";
import { createHash, randomUUID } from "node:crypto";
import { ExecContext, type PageView, type WebExecutionAgent } from "../agents/web/agent.ts";
import { fieldVocabulary, type FieldProfile } from "../agents/web/profile.ts";
import { BrowseSkill } from "../agents/web/skills/browse.ts";
import { isFormOpen } from "../agents/web/skills/common.ts";
import type { DownloadStore } from "../agents/web/downloads.ts";
import type { WelfareInformationAgent } from "../agents/welfare/agent.ts";
import { PROFILE_QUESTIONS, parseProfileAnswer, type ProfileSlot, type UserProfile } from "../agents/welfare/discovery.ts";
import { DialogueState } from "../core/dialogue.ts";
import type { EventSink } from "../core/events.ts";
import type { Intent } from "../core/intents.ts";
import type { Redacted, StructuredLlm } from "../core/llm.ts";
import { TurnQueue } from "../core/mutex.ts";
import { Progress } from "../core/progress.ts";
import { omitAbsent } from "../core/schema.ts";
import { strip } from "../core/text.ts";
import { AGENT_IDS, draft, parseTurnResult, type Draft, type Lang, type SemanticAction, type SessionState,
  type SourceCitation, type TraceEntry, type TurnResult } from "../core/turn.ts";
import { FIXED, detectLangSwitch } from "../language/i18n.ts";
import { ActionLog, localDay } from "../personal/action_log.ts";
import { dueReminder, parsePersonalCommand } from "../personal/commands.ts";
import { PersonalStore, VAULT_LABELS, type VaultKey } from "../personal/store.ts";
import { consentRefusal, gateRefusal, type Consent, type GateRefusal } from "../safety/gates.ts";
import type { PiiScanner } from "../safety/pii_model.ts";
import { REDACTED, SENSITIVE_LABELS_KO, detectSensitive, maskValue, redactText, redactTextWindow } from "../safety/privacy.ts";
import { josa, speakLabel } from "../speech/phrasing.ts";
import { Narrator } from "../speech/screen.ts";
import { isQuestionLike, shortReplyKind, splitQuestions, stripAddress, stripFiller, vagueQuestion } from "../understanding/filters.ts";
import { RuleBasedIntentProvider, isProgressQuestion, isStopUtterance, type IntentProvider } from "../understanding/rules.ts";
import { Understanding } from "../understanding/understand.ts";
import { SessionReplies } from "./replies.ts";

export interface OrchestratorDeps {
  intentProvider: IntentProvider;
  web: WebExecutionAgent;
  welfare: WelfareInformationAgent;
  events?: EventSink;
  requireConsent?: boolean;
  practiceMode?: boolean;
  llm?: StructuredLlm;
  goalLlm?: StructuredLlm;
  webLlm?: StructuredLlm;
  scanner?: PiiScanner;
  searchUrlTemplate?: string;
  personal?: PersonalStore;
  actionLog?: ActionLog;
  downloads?: DownloadStore;
  sharedBrowser?: boolean;
  clock?: () => number;
  today?: () => string;
}
type Detection = ReturnType<typeof detectSensitive>;
type HistoryRow = { turnId: string; role: "user" | "assistant"; text: Redacted; at: string; state: SessionState };
export interface Turn {
  id: string; text: Redacted; original?: Redacted; intentType: string; started: number; epoch: number;
  trace: TraceEntry[]; ctx: ExecContext;
}
const PLAN_STOP_STATES = new Set<SessionState>(["NEEDS_CLARIFICATION", "VALIDATION_ERROR", "WAITING_FOR_USER_CONFIRMATION", "AUTH_HANDOFF", "STOPPED", "RECOVERING"]);
export const sessionPatterns = {
  spaces: /\p{White_Space}+/gu, phraseEnd: /[.!?。~]+(?=\n?$)/u, digit: /\p{Nd}/u,
  doneReply: /^(다\p{White_Space}*)?(했어|했어요|했습니다|했다|했고|끝났어|끝났어요|끝|완료|됐어|됐어요|됐다|입력했어|입력했어요|넣었어|넣었어요)/u,
  profileCommand: /(줘|주세요|알려|열어|도움|뭐야|어떻게|멈춰|그만)/u,
  applyMatch: /(신청|도와|하고\p{White_Space}*싶)/u,
  sentences: /(?<=[.!?。]|요\.|다\.)\p{White_Space}+/u,
};
export class NotPorted extends Error {
  constructor(route: string) { super(route); this.name = "NotPorted"; }
}

export class SessionOrchestrator {
  readonly id = randomUUID();
  readonly deps: OrchestratorDeps;
  readonly dialogue: DialogueState<FieldProfile>;
  readonly progress = new Progress();
  readonly narrator: Narrator;
  readonly browse: BrowseSkill;
  readonly personal: PersonalStore;
  readonly replies: SessionReplies;
  readonly rules: RuleBasedIntentProvider;
  readonly understanding: Understanding;
  profile: UserProfile = {};
  grounded?: { servNm: string; sources: SourceCitation[] };
  lastSemantic?: SemanticAction;
  lang: Lang = "ko";
  #consent: Consent;
  #history: HistoryRow[] = [];
  #queue = new TurnQueue();
  #controller = new AbortController();
  #approvals = new Set<string>();
  #busy = false;
  #secretHint = false;
  #secretGuarded?: string;

  readonly form: FormSkill;
  readonly guided: GuidedFill;
  readonly application: ApplicationCommands;
  readonly personalDialogue: PersonalDialogue;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    const clock = () => deps.clock?.() ?? performance.now() / 1000;
    deps.web.clock = () => clock() * 1000;
    this.#consent = deps.requireConsent === true ? "pending" : "granted";
    this.dialogue = new DialogueState(this.#consent === "pending" ? "AWAITING_CONSENT" : "IDLE", clock);
    this.personal = deps.personal ?? new PersonalStore();
    this.progress.spoken = this.personal.speech().progressSpoken;
    this.narrator = new Narrator(deps);
    this.form = new FormSkill(deps.web, this.dialogue, this.narrator);
    this.personalDialogue = new PersonalDialogue(this.personal, this.dialogue, prefs => { this.progress.spoken = prefs.progressSpoken; }, deps.actionLog);
    this.browse = new BrowseSkill({ web: deps.web, dialogue: this.dialogue, narrator: this.narrator, form: this.form, deps,
      progress: this.progress, officialText: url => deps.welfare.readableService(url) });
    const vocabulary = fieldVocabulary(deps.web.profile);
    this.rules = new RuleBasedIntentProvider(vocabulary);
    this.understanding = new Understanding(this.rules, deps, vocabulary);
    this.guided = new GuidedFill(deps.web, this.dialogue, this.narrator, this.rules, {
      savedValue: label => this.personalDialogue.savedFor(label),
      siteAllowed: origin => this.personal.siteAllowed(origin), allowSite: origin => this.personal.allowSite(origin),
    });
    this.browse.guidedResume = view => this.guided.resumeAfterAuth(view);
    this.replies = new SessionReplies(this);
    this.application = new ApplicationCommands(this);
  }
  get consentStatus() { return this.#consent; }
  get web() { return this.deps.web; }
  get state() { return this.dialogue.state; }
  get today() { return this.deps.today?.() ?? localDay(); }
  async consentTo(granted: boolean) {
    return this.#enqueue(async () => {
      const turn = this.#begin(redactText(granted ? "[동의함]" : "[동의하지 않음]"));
      turn.intentType = "CONSENT";
      this.#consent = granted ? "granted" : "declined";
      if (!granted) return this.#finish(turn, draft("IDLE", "consent", "알겠어요. 화면은 읽거나 조작하지 않고, 복지 제도 질문에만 답할게요."));
      await this.prepare();
      const due = this.reminders();
      return this.#finish(turn, draft("IDLE", "consent", "동의해 주셔서 감사합니다. 시작할게요." + (due === undefined ? "" : " 알려 드릴 게 있어요. " + due)));
    });
  }
  async handleTurn(raw: string) {
    const normalized = strip(raw.normalize("NFC")).replace(sessionPatterns.spaces, " ");
    const safe = redactText(normalized);
    if (isStopUtterance(safe)) return this.#stop(safe);
    const spoken = stripAddress(safe);
    if (spoken.length === 0) return this.#enqueue(async () => this.#fixed(safe, "네, 말씀하세요.", "ko"));
    if (isProgressQuestion(spoken)) {
      const turn = this.#begin(redactText(spoken));
      turn.intentType = "PROGRESS";
      turn.ctx.trace("INTENT_DETECTED", AGENT_IDS.orchestrator, "PROGRESS (규칙 즉시 판정)");
      return this.#finish(turn, this.#progress(this.#busy));
    }
    return this.#enqueue(async () => {
      const epoch = this.#queue.epoch;
      const spans = (await this.deps.scanner?.scan([normalized]))?.[0];
      if (epoch !== this.#queue.epoch) return this.#voided();
      const text = redactText(stripAddress(redactText(normalized, spans)));
      return this.#process(text, detectSensitive(normalized, spans));
    });
  }
  confirm(approve: boolean) {
    return this.#enqueue(() => this.#process(redactText(approve ? "[승인 버튼]" : "[거절 버튼]"), { kinds: [], hasSecretValue: false }, { type: approve ? "APPROVE" : "REJECT" }));
  }
  setLanguage(lang: Lang) { return this.#enqueue(async () => this.#switch(redactText("[언어 선택]"), lang)); }
  cancel() { return this.#stop(redactText("[멈춤 버튼]")); }
  async prepare() {
    if (this.deps.practiceMode === false) return;
    try { await this.web.openHome(this.#begin(redactText("[세션 준비]")).ctx); }
    catch { /* 첫 화면을 못 열어도 대화를 시작할 수 있다. */ }
  }
  snapshot() {
    return omitAbsent({ sessionId: this.id, state: this.state, platform: "pc" as const, observation: this.#summarize(this.web.currentView),
      pendingConfirmation: this.dialogue.confirmation, awaitingField: this.dialogue.awaiting, history: this.exportHistory(),
      mockOnly: true, speechPrefs: this.personal.speech() });
  }
  exportHistory(): HistoryRow[] { return this.#history.map(row => ({ ...row })); }
  reminders() { return dueReminder(this.personal.applications(), this.today); }
  async close() { this.#queue.invalidate(); this.#controller.abort(); await this.web.close(); }
  #enqueue(work: () => Promise<TurnResult>) {
    return this.#queue.enqueue(async () => {
      this.#busy = true;
      try { return await work(); } finally { this.#busy = false; }
    }, () => this.#voided());
  }
  #voided() {
    return this.#finish(this.#begin(redactText("[중단으로 취소된 요청]")), draft("STOPPED", "none", "중단 요청 때문에 이 요청은 실행하지 않았습니다."));
  }
  #stop(text: Redacted) {
    this.#queue.invalidate();
    this.#controller.abort();
    this.#controller = new AbortController();
    const d = this.dialogue, notes: string[] = [];
    if (this.lang === "ko") {
      if (d.approval !== undefined) notes.push("승인을 기다리던 일은 하지 않았어요.");
      const pending = d.vaultConfirm;
      if (pending?.kind === "vault-save") {
        const listed = Object.entries(pending.values).map(([k,v]) => VAULT_LABELS[k as VaultKey] + " " + v).join(", ");
        notes.push("저장하려던 " + josa(listed, "은", "는") + " 저장하지 않았어요.");
      } else if (pending !== undefined) notes.push("내 정보는 지우지 않았어요.");
      if (d.guided !== undefined) notes.push("입력 칸 채우기도 멈췄어요.");
      if (d.profileQuestion !== undefined) notes.push("맞춤 복지 질문도 그만할게요.");
    }
    d.stop();
    this.#approvals.clear();
    const turn = this.#begin(text);
    turn.intentType = "STOP";
    turn.ctx.trace("INTENT_DETECTED", AGENT_IDS.orchestrator, "STOP (규칙 즉시 판정)");
    return this.#finish(turn, draft("STOPPED", "stop", [FIXED.stop[this.lang], ...notes].join(" "), { lang: this.lang }));
  }
  #progress(busy: boolean) {
    const p = this.progress;
    const speech = p.running ? (p.latest === undefined ? "막 시작해서 화면을 보고 있어요." : "지금까지 " + p.count + "단계 했어요. 방금 " + p.latest) :
      busy ? "말씀하신 일을 하고 있어요. 조금만 기다려 주세요." :
      "지금 하고 있는 일은 없어요." + (p.latest === undefined ? "" : " 마지막으로 " + p.latest);
    return draft(this.state, "read-state", speech);
  }
  #begin(text: Redacted): Turn {
    const epoch = this.#queue.epoch;
    const started = performance.now();
    const trace: TraceEntry[] = [];
    return { id: randomUUID(), text, intentType: "NONE", started, epoch, trace,
      ctx: new ExecContext({ signal: this.#controller.signal, approvals: this.#approvals,
        isStopped: () => epoch !== this.#queue.epoch || this.state === "STOPPED",
        trace: (phase, agent, note) => trace.push(omitAbsent({ phase, agent, note, atMs: Math.floor(performance.now() - started) })),
      }) };
  }
  #fixed(text: Redacted, speech: string, lang: Lang) {
    const turn = this.#begin(text);
    turn.intentType = "CLARIFY";
    return this.#finish(turn, draft(this.state, "clarify", speech, { lang }));
  }
  #switch(text: Redacted, to: Lang) {
    const turn = this.#begin(text);
    turn.intentType = "SET_LANGUAGE";
    if (to !== "ko" && this.deps.llm === undefined) return this.#finish(turn, draft(this.state, "set-language", FIXED.needLlm[this.lang], { lang: this.lang }));
    this.lang = to;
    turn.ctx.trace("INTENT_DETECTED", AGENT_IDS.orchestrator, "SET_LANGUAGE " + to + " (규칙)");
    return this.#finish(turn, draft(this.state, "set-language", FIXED.switched[to], { lang: to }));
  }

  async #process(text: Redacted, sensitive: Detection, forced?: Intent): Promise<TurnResult> {
    const to = forced === undefined && !sensitive.hasSecretValue ? detectLangSwitch(text) : undefined;
    if (to !== undefined) return this.#switch(text, to);
    const turn = this.#begin(text);
    turn.ctx.trace("TRANSCRIBED", AGENT_IDS.orchestrator);
    try {
      const hint = this.#secretHint;
      this.#secretHint = forced === undefined && !sensitive.hasSecretValue && sensitive.kinds.some(k => k === "password" || k === "otp");
      if (sensitive.hasSecretValue) {
        turn.intentType = "SECRET_DISCLOSURE";
        const names = sensitive.kinds.map(k => SENSITIVE_LABELS_KO[k]).join(", ");
        const auth = this.state === "AUTH_HANDOFF" || sensitive.kinds.some(k => k === "password" || k === "otp");
        const instruction = this.web.currentView?.pageId === "mock-login" ? "인증 화면의 입력란에 키보드로 직접 입력해 주세요." :
          "인증이 필요하면 '로그인하고 싶어'라고 말씀하시고, 열린 화면에 직접 입력해 주세요.";
        return this.#finish(turn, draft(auth ? "AUTH_HANDOFF" : this.state, "auth-handoff",
          "보안을 위해 " + (names.length > 0 ? names : "민감 정보") + "는 저에게 말하지 마세요. 방금 말씀하신 값은 저장하거나 화면에 입력하지 않았습니다. " + instruction, { secretDetected: true }));
      }
      if (forced === undefined) {
        if (this.#maybeSpokenSecret(text, hint)) {
          turn.intentType = "SECRET_DISCLOSURE";
          turn.text = redactText(REDACTED);
          return this.#finish(turn, draft(this.state, "auth-handoff",
            "혹시 비밀번호나 인증번호라면 저에게 말하지 말고 화면의 입력란에 직접 입력해 주세요. 명령이었다면 한 번 더 말씀해 주세요.", { secretDetected: true }));
        }
        const asked = this.dialogue.profileQuestion as ProfileSlot | undefined;
        if (asked !== undefined) {
          const answer = parseProfileAnswer(text, asked);
          if (Object.keys(answer).length > 0) {
            turn.intentType = "PROFILE_ANSWER";
            this.profile = { ...this.profile, ...answer };
            return this.#finish(turn, await this.replies.discoverStep(turn, false));
          }
          const other = this.rules.parseSync(text, { state: this.state });
          if (other.type === "UNKNOWN" && Array.from(text).length <= 20 && !sessionPatterns.profileCommand.test(text) &&
              parsePersonalCommand(text, this.today) === undefined && detectLangSwitch(text) === undefined) {
            turn.intentType = "PROFILE_ANSWER";
            return this.#finish(turn, draft(this.state, "discover", "제가 잘 못 알아들었어요. " + PROFILE_QUESTIONS[asked]));
          }
          this.dialogue.profileDone();
        }
        if (this.guided.active() && this.dialogue.approval === undefined) {
          turn.intentType = "GUIDED_FILL";
          const next = await this.guided.answer(text, turn.ctx);
          if (next !== undefined) return this.#finish(turn, next);
        }
        if (this.guided.wantsStart(text)) {
          turn.intentType = "GUIDED_FILL";
          const refused = this.#refused(gateRefusal(["GUIDED_FILL"], this.#consent, this.state));
          return this.#finish(turn, refused ?? await this.guided.start(turn.ctx));
        }
        const short = this.#shortReply(text);
        if (short !== undefined) { turn.intentType = "ACK"; return this.#finish(turn, short); }
        text = redactText(stripFiller(text));
        const many = await this.#answerMany(text, turn);
        if (many !== undefined) { turn.intentType = "MULTI_QUESTION"; return this.#finish(turn, many); }
        const vague = this.dialogue.approval === undefined ? vagueQuestion(text) : undefined;
        if (vague !== undefined) { turn.intentType = "CLARIFY"; return this.#finish(turn, draft(this.state, "clarify", vague)); }
      }
      const understood = forced === undefined ? await this.#understand(text, turn) : { intents: [forced], by: "ui" };
      const [first, ...rest] = understood.intents;
      if (first === undefined) throw Error("빈 의도 목록");
      const types = understood.intents.map(i => i.type);
      turn.intentType = rest.length > 0 ? "PLAN(" + types.join(">") + ")" : first.type;
      turn.ctx.trace("INTENT_DETECTED", AGENT_IDS.orchestrator, turn.intentType + " via " + understood.by);
      const refused = this.#refused(gateRefusal([first.type, ...rest.map(i => i.type)], this.#consent, this.state));
      return this.#finish(turn, refused ?? (rest.length > 0 ? await this.#plan(understood.intents, turn) : await this.#route(first, turn)));
    } catch (error) {
      if (error instanceof NotPorted) throw error;
      const name = error instanceof Error ? error.name : "Error";
      return this.#finish(turn, draft("RECOVERING", "none", "처리 중 문제가 생겨 실행을 멈췄습니다(" + name + "). 다시 말씀해 주세요."));
    }
  }
  #maybeSpokenSecret(text: string, hint: boolean) {
    const d = this.dialogue;
    if (!hint && this.state !== "AUTH_HANDOFF" && this.web.currentView?.pageId !== "mock-login") { this.#secretGuarded = undefined; return false; }
    if (d.awaiting !== undefined || d.guided !== undefined || d.vaultConfirm !== undefined || d.profileQuestion !== undefined) return false;
    const t = strip(text.replace(sessionPatterns.phraseEnd, ""));
    if (t.length === 0 || Array.from(t).length > 30 || isQuestionLike(t) || shortReplyKind(t) !== undefined || sessionPatterns.doneReply.test(t)) return false;
    if (detectLangSwitch(t) !== undefined || parsePersonalCommand(t, this.today) !== undefined || this.rules.parseSync(t, { state: this.state }).type !== "UNKNOWN") return false;
    const hash = createHash("sha256").update(t).digest("hex");
    if (this.#secretGuarded === hash) { this.#secretGuarded = undefined; return false; }
    this.#secretGuarded = hash;
    return true;
  }
  #shortReply(text: string): Draft | undefined {
    const kind = shortReplyKind(text);
    if (kind === undefined) return undefined;
    const no = kind === "no";
    if (this.dialogue.approval !== undefined) return no ? undefined : draft(this.state, "clarify",
      "아직 확인을 기다리고 있어요. 진행하려면 '승인' 또는 '응', 하지 않으려면 '아니'라고 말씀해 주세요.");
    const awaiting = this.dialogue.awaiting;
    if (awaiting !== undefined && isFormOpen(this.web.currentView)) {
      const label = speakLabel(this.web.field(awaiting)?.label ?? "그 항목");
      return draft(this.state, "clarify", no ? "알겠어요. " + josa(label, "은", "는") + " 아직 비워 둘게요. 다른 값을 말씀하시거나 '다음으로', '멈춰'라고 해 주세요." :
        "네. " + josa(label, "을", "를") + " 말씀해 주세요.");
    }
    this.dialogue.clearChoice();
    return draft(this.state, "none", no ? "알겠어요. 그럼 무엇을 도와드릴까요?" : "네.");
  }
  async #answerMany(text: Redacted, turn: Turn) {
    if (this.state === "STOPPED") return undefined;
    const questions = await splitQuestions(this.deps.llm, text, this.recentDialogue(4), turn.ctx.signal);
    if (questions.length < 2) return undefined;
    turn.ctx.trace("PLANNING", AGENT_IDS.orchestrator, "질문 " + questions.length + "개로 나눔");
    const drafts: Draft[] = [];
    for (const q of questions) {
      if (turn.epoch !== this.#queue.epoch) break;
      const question = redactText(q);
      const first = (await this.#understand(question, turn)).intents[0];
      if (first === undefined) continue;
      const refused = this.#refused(consentRefusal([first.type], this.#consent));
      if (refused !== undefined) return refused;
      drafts.push(await this.#route(first, { ...turn, text: question }));
    }
    const last = drafts.at(-1);
    if (last === undefined) return undefined;
    return { ...last, speech: drafts.map((d,i) => String(i+1) + ". " + (d.summary ?? d.speech)).join(" "),
      actions: drafts.flatMap(d => d.actions ?? []), sources: drafts.flatMap(d => d.sources ?? []) };
  }
  #refused(refusal: GateRefusal | undefined) {
    return refusal === undefined ? undefined : draft(refusal.state ?? this.state, refusal.semanticAction, refusal.speech);
  }
  #historySpeech(speech: string) {
    const secrets = new Set(Object.values(this.personal.vault()));
    const pending = this.dialogue.vaultConfirm;
    if (pending?.kind === "vault-save") for (const value of Object.values(pending.values)) secrets.add(value);
    for (const value of [...secrets].sort((a,b) => Array.from(b).length - Array.from(a).length)) {
      if (value.length > 0) speech = speech.replaceAll(value, REDACTED);
    }
    return redactText(speech);
  }
  recentDialogue(n = 6) {
    return this.#history.slice(-n).map(row => redactText((row.role === "user" ? "사용자: " : "청음: ") + redactTextWindow(row.text, 0, 400)));
  }
  #understand(text: Redacted, turn: Turn) {
    const field = this.dialogue.awaiting;
    const view = this.web.currentView;
    return this.understanding.understand(text, { state: this.state, awaitingFieldId: field === undefined ? undefined : redactText(field) }, {
      awaited: field === undefined ? undefined : this.web.field(field), clarifying: this.dialogue.clarification !== undefined,
      page: view === undefined ? undefined : redactText(view.title), recent: this.recentDialogue(4),
      trace: note => turn.ctx.trace("PLANNING", AGENT_IDS.orchestrator, note),
    });
  }
  async #plan(intents: Intent[], turn: Turn) {
    const drafts: Draft[] = [];
    for (const [i,intent] of intents.entries()) {
      if (turn.epoch !== this.#queue.epoch) break;
      turn.ctx.trace("PLANNING", AGENT_IDS.orchestrator, "단계 " + (i+1) + "/" + intents.length + ": " + intent.type);
      const step = await this.#route(intent, turn);
      drafts.push(step);
      if (PLAN_STOP_STATES.has(step.state) || step.semanticAction === "consent") break;
    }
    const last = drafts.at(-1);
    if (last === undefined) return draft("STOPPED", "none", "중단되었습니다.");
    const skipped = intents.length - drafts.length;
    const speech = [...drafts.slice(0,-1).map(d => d.summary ?? d.speech), last.speech,
      skipped > 0 ? "나머지 " + skipped + "가지 요청은 이것부터 해결한 뒤 다시 말씀해 주세요." : ""].filter(s => s.length > 0).join(" ");
    return { ...last, summary: undefined, speech, actions: drafts.flatMap(d => d.actions ?? []), sources: drafts.flatMap(d => d.sources ?? []) };
  }
  async #route(intent: Intent, turn: Turn): Promise<Draft> {
    const ctx = turn.ctx;
    const pending = this.dialogue.clarification;
    if (pending !== undefined && (intent.type === "UNKNOWN" || (Array.from(turn.text).length <= 20 && !sessionPatterns.digit.test(turn.text)))) {
      const picked = this.web.pickCandidate(turn.text, pending.candidates);
      if (picked !== undefined) { this.dialogue.clearChoice(); return this.form.fillOne(picked, pending.value, ctx); }
    }
    if (intent.type !== "UNKNOWN") this.dialogue.clearChoice();
    const welfare = this.deps.welfare;
    if (welfare.hasMatches && this.lastSemantic !== "list-links" && ["START_APPLICATION","DISCOVER","UNKNOWN","POLICY_QUESTION"].includes(intent.type)) {
      const hit = welfare.findInMatches(turn.text);
      if (hit !== undefined) {
        welfare.pick(turn.text);
        this.grounded = undefined;
        turn.ctx.trace("PLANNING", AGENT_IDS.welfare, "찾기 결과에서 고름: " + hit.servNm);
        if (sessionPatterns.applyMatch.test(turn.text)) intent = { type: "START_APPLICATION" };
        else if (intent.type !== "POLICY_QUESTION") return this.replies.welfareDraft(await welfare.serviceDetail(hit.servNm), "discover");
      }
    }
    const refused = this.#refused(consentRefusal([intent.type], this.#consent));
    if (refused !== undefined) return refused;
    const type = intent.type;
    switch (type) {
      case "GOAL": return this.browse.runGoal(intent.goal, ctx);
      case "LOGIN": return this.browse.login(turn.text, ctx);
      case "CLEAR_LOGIN": return this.browse.clearLogin(ctx);
      case "READ_DOWNLOAD": return this.browse.readDownload(intent, ctx);
      case "AUTH_DONE": return this.browse.authDone(ctx);
      case "START_APPLICATION": return this.application.start(turn);
      case "FILL": return this.form.fill(intent.fills, ctx);
      case "READ_FIELD": return this.form.readField(intent.fieldMention, ctx);
      case "EDIT_FIELD": return this.form.editField(intent.fieldMention, ctx);
      case "REVIEW": return this.form.review(ctx);
      case "EXPLAIN": return this.explain(intent.fieldMention, turn);
      case "PREPARE_SUBMIT": return this.form.prepareSubmit(ctx);
      case "APPROVE": return this.application.approve(turn);
      case "REJECT": return this.application.reject();
      case "DISCOVER": return this.replies.discover(turn);
      case "SERVICE_DETAIL": return this.replies.welfareReply(welfare.serviceDetail(intent.service), "discover");
      case "PRECHECK": return this.replies.welfareReply(welfare.precheck(intent.service, this.profile), "precheck");
      case "PREPARE_APPLY": return this.replies.welfareReply(welfare.prepare(intent.service), "prepare-apply");
      case "PREV": return isFormOpen(this.web.currentView) ? this.form.prev(ctx) : this.browse.back(ctx);
      case "NEXT": return this.form.next(ctx);
      case "OPEN_SITE": return this.browse.openSite(intent.target, ctx);
      case "FOLLOW_LINK": return this.browse.followLink(intent.name, ctx);
      case "READ_MAIN": return this.browse.readMain(intent.more, ctx);
      case "LIST_LINKS": return this.browse.listLinks(intent.more, ctx);
      case "SEARCH": return this.browse.search(intent.query, intent.site, ctx);
      case "RESUME": return this.browse.resume(ctx);
      case "DESCRIBE_SCREEN": return this.browse.screen(turn.text, ctx);
      case "CURRENT_STEP": return this.browse.currentStep(ctx);
      case "ABOUT_SITE": return this.browse.aboutSite();
      case "OPEN_BROWSER": return this.replies.openBrowser(turn);
      case "REPHRASE": return this.replies.rephrase(turn);
      case "POLICY_QUESTION": return this.replies.policyQuestion(intent.topic, turn);
      case "HELP_HUMAN": return this.replies.helpHuman();
      case "WHAT_CAN_I_SAY": return this.replies.whatCanISay(intent.more);
      case "PROGRESS": return this.#progress(false);
      case "STOP": return draft("STOPPED", "stop", "멈췄습니다.");
      case "UNKNOWN": return this.replies.unknown(redactText(intent.text ?? turn.text), turn);
      default: throw new NotPorted(type);
    }
  }
  explain(mention: string | undefined, turn: Turn) { return this.application.explain(mention, turn); }
  #summarize(view?: PageView) {
    if (view === undefined) return undefined;
    const fields = view.fields.map(f => ({ ...f, value: f.sensitive ? "" : this.web.field(f.fieldId)?.maskOnReadback === true && f.value.length > 0 ? maskValue(f.value) : f.value }));
    return omitAbsent({ page: view.pageId, url: view.url, title: view.title, step: view.step, errors: view.errors, status: view.status, fields });
  }
  #finish(turn: Turn, out: Draft): TurnResult {
    const stopped = turn.epoch !== this.#queue.epoch && out.semanticAction !== "stop";
    const state = stopped ? "STOPPED" : out.state;
    let speech = (stopped ? "중단 요청으로 작업을 멈췄습니다. " : "") + out.speech;
    if (this.personal.speech().length === "short" && Array.from(speech).length >= 100 && !speech.includes("말하는 속도") && !speech.includes("말하기 설정")) {
      const parts = speech.split(sessionPatterns.sentences).map(strip).filter(s => s.length > 0);
      if (parts.length > 2) speech = parts.slice(0,2).join(" ");
    }
    if (!stopped) this.dialogue.commit(state);
    this.lastSemantic = out.semanticAction;
    turn.ctx.trace("SPEAKING", AGENT_IDS.orchestrator);
    const view = out.view as PageView | undefined ?? this.web.currentView;
    const at = new Date().toISOString();
    this.#history.push({ turnId: turn.id, role: "user", text: turn.text, at, state },
      { turnId: turn.id, role: "assistant", text: this.#historySpeech(speech), at, state });
    const actions = (out.actions ?? []).map(a => {
      const r = a.result;
      this.deps.events?.record(omitAbsent({ sessionId: this.id, turnId: turn.id, actionType: a.action.type, success: r?.ok ?? false,
        latencyMs: r?.latencyMs ?? 0, errorCode: r?.errorCode ?? (a.policy.allowed ? undefined : a.policy.code), at }));
      if (r?.errorCode !== "LOG_FAILED") return a;
      return { ...a, result: { actionId: a.action.id, ok: false, verified: false, errorCode: "UNKNOWN", latencyMs: 0, message: "조작 기록을 남기지 못했습니다." } };
    });
    return parseTurnResult({ sessionId: this.id, turnId: turn.id, userUtterance: turn.original ?? turn.text, intentType: turn.intentType,
      state, semanticAction: out.semanticAction, field: out.field, value: out.value, page: view?.pageId,
      accessMode: view === undefined ? undefined : this.web.accessMode(view), speech, lang: out.lang ?? "ko",
      trace: turn.trace, actions, observation: this.#summarize(view), verification: out.verification, pendingConfirmation: this.dialogue.confirmation,
      handoff: out.handoff, sources: out.sources ?? [], missingFields: out.missingFields ?? [], pendingActions: 0, realSubmission: false,
      flags: { secretDetected: out.secretDetected === true, masked: out.masked === true }, latencyMs: Math.floor(performance.now() - turn.started),
      speechPrefs: this.personal.speech() });
  }
}
