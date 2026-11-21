import { z } from "zod";
import { helpHumanDraft, isFormOpen } from "../agents/web/skills/common.ts";
import { speakAnswerCard, type GroundedAnswer } from "../agents/welfare/agent.ts";
import { nextProfileSlot, parseProfileAnswer, profileQuestion } from "../agents/welfare/discovery.ts";
import type { PlaceReply } from "../agents/welfare/open_data/index.ts";
import { raceAbort } from "../core/abort.ts";
import { helpPages, type HelpGroup } from "../core/intents.ts";
import { SIMPLE_TEXT_SCHEMA } from "../core/llm.ts";
import { strip } from "../core/text.ts";
import { AGENT_IDS, draft, LangSchema, type Draft, type SemanticAction } from "../core/turn.ts";
import { FIXED } from "../language/i18n.ts";
import { REDACTED, detectSensitive, redactPictureText, redactText } from "../safety/privacy.ts";
import { unsupportedNumbers } from "../safety/verify.ts";
import { hasPhoneNumber, speakLabel, spellPhoneNumbers } from "../speech/phrasing.ts";
import { chatRoute } from "../understanding/chat.ts";
import { isQuestionLike } from "../understanding/filters.ts";
import { cleanValue, wantsTextOnlyScreen } from "../understanding/rules.ts";
import { resolveSite } from "../understanding/sites.ts";
import { replyPatterns } from "./patterns.ts";
import type { SessionOrchestrator, Turn } from "./session.ts";

export const HELP_POINTER = "'뭐라고 말하면 돼?'라고 물어보시면 할 수 있는 말을 알려 드려요.";
const simpleReply = z.object({ text: z.string() });
// 양식 입력·인증·금고 대화·모델 답변은 화면 설명에 보내지 않는다.
const SCREEN_CONTEXT_INTENTS: ReadonlySet<string> = new Set(["CHAT", "UNKNOWN", "GOAL", "OPEN_SITE", "SEARCH_WEB", "FOLLOW_LINK", "FIND_PLACE",
  "POLICY_QUESTION", "DESCRIBE_SCREEN", "READ_MAIN", "LIST_LINKS", "CURRENT_STEP", "ABOUT_SITE"]);
const SCREEN_CONTEXT_STATES: ReadonlySet<string> = new Set(["BROWSING", "IDLE", "NEEDS_CLARIFICATION"]);

export class SessionReplies {
  private readonly session: SessionOrchestrator;
  private helpPage = 0;
  constructor(session: SessionOrchestrator) { this.session = session; }

  /** 맞춤 복지 찾기: 비어 있는 항목을 하나씩 묻고, 다 모이면 찾는다(답은 이번 대화에서만 사용). */
  async discoverStep(turn: Turn, first: boolean): Promise<Draft> {
    const s = this.session;
    const next = nextProfileSlot(s.profile);
    if (next !== undefined) {
      s.dialogue.askProfile(next);
      const intro = first ? "맞춤 복지를 찾아볼게요. 몇 가지만 여쭤볼게요. 답은 이번 대화에서만 쓰고 저장하지 않아요. " : "";
      return draft(s.state, "discover", intro + profileQuestion(next, s.profile));
    }
    s.dialogue.profileDone();
    turn.ctx.trace("PLANNING", AGENT_IDS.welfare, "맞춤 복지 찾기");
    const answer = await raceAbort(signal => s.deps.welfare.discover(s.profile, signal), turn.ctx.signal);
    return this.welfareDraft(answer, "discover");
  }

  welfareDraft(answer: GroundedAnswer, semantic: SemanticAction): Draft {
    if (answer.grounded && answer.service !== undefined) this.session.grounded = { servNm: answer.service.servNm, sources: answer.sources };
    const card = answer.card;
    return draft(this.session.state, semantic, card === undefined ? answer.speech : speakAnswerCard(card),
      { sources: answer.sources, answerCard: card, reviewQuotes: answer.reviewQuotes });
  }

  async welfareReply(answer: Promise<GroundedAnswer>, semantic: SemanticAction): Promise<Draft> {
    return this.welfareDraft(await answer, semantic);
  }

  /** "쉽게 말해줘": 직전 안내를 쉬운 말로(LLM이 없거나 숫자를 바꿔 말하면 그대로 다시). */
  async rephrase(turn: Turn): Promise<Draft> {
    const s = this.session;
    const last = s.history.findLast(row => row.role === "assistant")?.text;
    if (last === undefined || last.length === 0) return draft(s.state, "rephrase", "아직 드린 안내가 없어요. 무엇을 도와드릴까요?");
    // "그 번호를 다시 천천히": 바꿔 말하지 않고 그대로, 전화번호는 한 자리씩. 전화번호를 물었으면 전화번호가 있는 문장만
    // ('그 번호'만으로는 접수번호일 수도 있어 다 말한다).
    if (replyPatterns.slowly.test(turn.text)) {
      const sentences = last.split(replyPatterns.sentenceGap).filter(sentence => strip(sentence).length > 0);
      const numbered = replyPatterns.phoneAsked.test(turn.text) ? sentences.filter(hasPhoneNumber) : [];
      return draft(s.state, "rephrase", `천천히 다시 말씀드릴게요. ${spellPhoneNumbers((numbered.length > 0 ? numbered : sentences).join(" "))}`);
    }
    const model = s.deps.webLlm ?? s.deps.llm;
    if (model !== undefined) {
      const raw = await raceAbort(signal => model.generate({
        system: "정보취약계층 사용자가 방금 들은 안내를 이해하지 못했다. 같은 내용을 더 쉬운 말로, 짧은 문장 2~4개로 다시 말해라. 새 정보를 지어내지 말고, 숫자·금액·출처는 그대로 유지. 존댓말.",
        user: last, schemaName: "simple", schema: SIMPLE_TEXT_SCHEMA, signal,
      }), turn.ctx.signal);
      const text = simpleReply.safeParse(raw).data?.text ?? "";
      const changed = unsupportedNumbers(text, [last]);
      if (changed.length > 0) {
        turn.ctx.trace("VERIFYING", AGENT_IDS.verifier, `쉬운 말에 직전 안내에 없는 숫자(${changed.join(", ")}) → 직전 안내 그대로`);
      } else if (text.length > 0) {
        return draft(s.state, "rephrase", `쉽게 다시 말씀드릴게요. ${text}`);
      }
    }
    return draft(s.state, "rephrase", `천천히 다시 말씀드릴게요. ${last}`);
  }

  /**
   * 화면 밖 자유 대화. LLM이 종류를 고른다:
   * welfare = 복지 제도 → 공식 데이터 근거 답변 / web_search = 날씨·뉴스 등 실시간 → 검색 후 요약
   * general = 일반 상식 → 바로 답 / clarify = 뜻이 불분명 → 되묻기
   */
  async freeChat(text: string, turn: Turn): Promise<Draft> {
    const s = this.session;
    const view = s.web.currentView;
    turn.ctx.trace("PLANNING", AGENT_IDS.welfare, "자유 대화 분류");
    const last = s.history.findLast(row => row.role === "assistant")?.text;
    const llm = s.deps.llm;
    const utterance = redactText(text);
    const out = llm === undefined ? {} : await raceAbort(signal => chatRoute(llm, utterance, {
      page: view?.title === undefined ? undefined : redactText(view.title),
      lastAssistant: last,
      recent: s.recentDialogue(8), askedJustNow: s.lastSemantic === "clarify",
    }, signal), turn.ctx.signal);
    const resume = view !== undefined && isFormOpen(s.web.currentView) ? s.form.askNext(view) : "";
    const withResume = (d: Draft): Draft => resume.length > 0 && d.semanticAction !== "welfare-retrieval"
      ? { ...d, speech: `${d.speech} 이어서 ${resume}` } : d;
    const route = out.route;
    if (turn.linkQuestion && route !== "general" && route !== "clarify") return draft(s.state, "clarify", "이 링크의 어떤 내용을 알고 싶으세요?");
    if (typeof route !== "string" || route.length === 0) {
      if (turn.fromVoice) return this.clarifyHeard(turn);
      return draft(s.state, "none", `죄송해요, 잘 이해하지 못했어요. 다시 한 번 말씀해 주시겠어요? ${HELP_POINTER}`);
    }
    if (route === "language") {
      const lang = LangSchema.safeParse(out.language).data;
      if (lang !== undefined) {
        s.lang = lang;
        return draft(s.state, "set-language", FIXED.switched[lang], { lang });
      }
    }
    if (route === "welfare") return this.policyQuestion(utterance, turn);
    if (route === "web_task") return withResume(await s.browse.runGoal(utterance, turn.ctx));
    if (route === "web_search" && typeof out.searchQuery === "string" && out.searchQuery.length > 0) {
      return withResume(await s.browse.webAnswer(utterance, redactText(out.searchQuery), turn.ctx));
    }
    const reply = typeof out.reply === "string" ? strip(out.reply) : "";
    return withResume(draft(s.state, route === "clarify" ? "clarify" : "chat", reply.length > 0 ? reply : "다시 한 번 말씀해 주시겠어요?"));
  }

  discover(turn: Turn): Promise<Draft> {
    const s = this.session;
    s.profile = { ...s.profile, ...parseProfileAnswer(turn.text, undefined, s.profile) };
    return this.discoverStep(turn, true);
  }

  placeReply(reply: PlaceReply): Draft {
    const s = this.session;
    s.dialogue.askPlace(reply.ask);
    return draft(s.state, reply.semantic, reply.speech, { sources: [...reply.sources], reviewQuotes: reply.reviewQuotes });
  }

  findPlace(turn: Turn): Draft {
    const s = this.session;
    return this.placeReply(s.places.answer(turn.text, s.profile.ctpv ?? undefined, { lang: s.lang }));
  }

  async openBrowser(turn: Turn): Promise<Draft> {
    const s = this.session;
    // 사이트 이름이 들어 있으면(받아쓰기 변형 포함) 크롬만 켜고 끝내지 않고 그 사이트로 간다
    if (resolveSite(turn.text, s.browse.mockSites()) !== undefined) return s.browse.openSite(turn.text, turn.ctx);
    await s.web.showBrowser();
    const view = await s.web.observe(turn.ctx).catch(() => undefined);
    return draft(s.state, "open-browser", "크롬을 열었어요. 어디로 갈까요?", { view });
  }

  /** 사람 도움: 전화는 걸지 않고, 제도·사이트 문의 번호와 짧은 말 스크립트·대신 할 일을 말한다. */
  helpHuman(): Draft {
    const s = this.session;
    const detail = s.deps.welfare.lastService;
    const contact = detail?.contacts?.find(c => replyPatterns.phone.test(c.value));
    let stepHint: string | undefined;
    if (s.state === "AUTH_HANDOFF") stepHint = "로그인·본인인증";
    else if (s.state === "APPLICATION_OPEN" || s.state === "WAITING_FOR_USER_CONFIRMATION") stepHint = "신청 작성";
    else if (s.state === "BROWSING") stepHint = "누리집 이용";
    return helpHumanDraft(s.state, {
      url: s.web.currentView?.url, contactName: contact?.name, contactNumber: contact?.value,
      serviceName: detail?.servNm ?? s.grounded?.servNm, stepHint,
    });
  }

  /**
   * '뭐라고 말하면 돼?': 의도 표의 예문을 지금 화면에 맞는 묶음부터 몇 개씩 들려준다.
   * '다른 말도 알려줘'(more)는 지난번에 멈춘 곳부터. 예문은 모두 규칙 파서가 제 의도로 알아듣는 말이다(registry 테스트).
   */
  whatCanISay(more: boolean): Draft {
    const s = this.session;
    const view = s.web.currentView;
    let lead: HelpGroup[] = ["시작", "복지 정보"];
    if (isFormOpen(view)) lead = ["신청서"];
    else if (view !== undefined && s.web.accessMode(view) === "read-only") lead = ["웹 읽기"];
    const pages = helpPages(lead, s.consentStatus === "granted");
    const index = more ? this.helpPage : 0;
    const page = pages[index];
    if (page === undefined) {
      this.helpPage = 0;
      return draft(s.state, "help-list", "더 알려 드릴 말은 없어요. 처음부터 들으시려면 '도움말'이라고 하세요.");
    }
    this.helpPage = index + 1;
    const parts = [index === 0 ? "이렇게 말해 보세요." : "이어서 알려 드릴게요."];
    for (const [group, examples] of page) parts.push(`${group}: ${examples.map(t => `'${t}'`).join(", ")}.`);
    if (s.consentStatus === "pending") parts.push("동의하시면 화면 읽기와 사이트 열기도 할 수 있어요.");
    parts.push(index === pages.length - 1 ? "처음부터 다시 들으시려면 '도움말'이라고 하세요." : "더 들으시려면 '다른 말도 알려줘'라고 하세요.");
    return draft(s.state, "help-list", parts.join(" "));
  }

  async policyQuestion(topic: string, turn: Turn): Promise<Draft> {
    const s = this.session;
    const welfare = s.deps.welfare;
    turn.ctx.trace("PLANNING", AGENT_IDS.welfare, `grounded answer (${welfare.answerMode})`);
    const answer = await raceAbort(signal => welfare.answerQuestion(topic, s.deps.today?.(), signal), turn.ctx.signal);
    if (answer.retrieval !== undefined) {
      turn.ctx.trace("VERIFYING", AGENT_IDS.welfare, `retrieved ${answer.retrieval.sections.join(",")} used=${answer.retrieval.used.length}`);
    }
    if (answer.verification?.ok === false) {
      turn.ctx.trace("VERIFYING", AGENT_IDS.verifier, `복지 답변 근거 부족 → 그 답은 말하지 않음: ${answer.verification.reasons.join(", ")}`);
    }
    const result = this.welfareDraft(answer, "welfare-retrieval");
    // 신청 중에 물어봤다면 답한 뒤 하던 일로 돌아간다.
    const current = s.web.currentView;
    const resume = current !== undefined && isFormOpen(current) ? s.form.askNext(current) : "";
    return resume.length > 0 ? { ...result, speech: `${result.speech} 이어서 ${resume}` } : result;
  }

  /**
   * 입력 칸 읽기. 신청서가 없는 화면에서 "문의할 기관 이름이 뭐야?"는 칸('이름')을 읽으라는 말이 아니라 물음이다:
   * 읽을 칸이 없으니 '입력을 대신하지 않아요'로 막지 말고 질문으로 답한다(LLM이 있을 때).
   */
  async readField(mention: string, turn: Turn): Promise<Draft> {
    const s = this.session;
    if (!isFormOpen(s.web.currentView) && s.deps.llm !== undefined && isQuestionLike(turn.text)) return this.freeChat(turn.text, turn);
    return s.form.readField(mention, turn.ctx);
  }

  async describeScreen(turn: Turn, exclusions: readonly string[] = [], confirmPicture = false): Promise<Draft> {
    const s = this.session;
    const question = turn.original ?? turn.text;
    const textOnly = exclusions.includes("screen_capture") || s.publicTask.exclusions.includes("screen_capture") ||
      wantsTextOnlyScreen(question) || wantsTextOnlyScreen(turn.text);
    const previous: string[] = [];
    for (const row of s.history.slice(-12)) {
      if (row.role !== "user" || !SCREEN_CONTEXT_STATES.has(row.state) || !SCREEN_CONTEXT_INTENTS.has(row.intentType ?? "UNKNOWN")) continue;
      const safe = strip(redactPictureText(s.historySpeech(row.text)));
      if (safe.length > 0 && !safe.includes(REDACTED) && !safe.startsWith("[") && detectSensitive(safe).kinds.length === 0) {
        previous.push(Array.from(safe).slice(0, 300).join(""));
      }
    }
    return s.browse.screen(redactPictureText(s.historySpeech(question)), turn.ctx, { previousInputs: previous.slice(-3), allowPicture: !textOnly, confirmPicture });
  }

  /** 받아쓴 말을 알아듣지 못했을 때: 들은 말을 되읽고 어느 업무인지 묻는다. */
  clarifyHeard(turn: Turn): Draft {
    const s = this.session;
    const heard = Array.from(strip(s.historySpeech(redactText(turn.text)))).slice(0, 65).join("");
    let question = "어느 기관이나 업무를 찾으세요?";
    if (s.activeService !== undefined) {
      const [agency, topic] = s.activeService;
      question = `${topic.length > 0 ? topic : agency}에 이어서 물으신 건가요, 다른 업무를 찾으시나요?`;
    }
    const lead = heard.length > 0 && !heard.includes(REDACTED) ? `'${heard}'라고 들었어요. ` : "";
    return draft(s.state, "clarify", lead + question);
  }

  async unknown(text: string, turn: Turn): Promise<Draft> {
    const s = this.session;
    const clarification = s.dialogue.clarification;
    if (clarification !== undefined) {
      const names = clarification.candidates.map(c => speakLabel(c.label)).join(", ");
      return draft("NEEDS_CLARIFICATION", "clarify", `${names} 중 어느 쪽인지 말씀해 주세요.`);
    }
    if (replyPatterns.moreServices.test(text) && s.deps.welfare.hasMatches) {
      return this.welfareDraft(s.deps.welfare.moreMatches(), "discover");
    }
    const awaiting = s.dialogue.awaiting;
    if (awaiting !== undefined && awaiting.length > 0 && isFormOpen(s.web.currentView)) {
      // 값을 기다리는 중이라도 질문이면 값으로 넣지 않고 답한 뒤 다시 묻는다.
      const field = s.web.field(awaiting);
      // 질문이 값보다 우선: "이 신청하면 언제 돈이 나와?"는 이름처럼 보여도 질문이다.
      if (isQuestionLike(text)) {
        if (replyPatterns.thisField.test(text) || s.deps.llm === undefined) return s.application.explain(undefined, turn);
        return this.freeChat(text, turn);
      }
      const value = cleanValue(text);
      const valid = field !== undefined && (field.validate?.(value).ok ?? true);
      if (!valid && s.deps.llm !== undefined) return this.freeChat(text, turn);
      if (field !== undefined) return s.form.fillOne(field, value, turn.ctx);
    }
    // 화면 밖 자유 대화: LLM이 있으면 종류를 골라 답하고, 없으면 질문일 때만 복지 근거 답변
    if (s.deps.llm !== undefined) return this.freeChat(text, turn);
    if (turn.fromVoice) return this.clarifyHeard(turn);
    if (isQuestionLike(text)) return this.policyQuestion(text, turn);
    return draft(s.state, "none", `죄송해요, 잘 이해하지 못했어요. 아무것도 실행하지 않았어요. ${HELP_POINTER}`);
  }
}
