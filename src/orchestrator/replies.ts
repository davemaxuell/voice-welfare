import { z } from "zod";
import { helpHumanDraft, isFormOpen } from "../agents/web/skills/common.ts";
import type { GroundedAnswer } from "../agents/welfare/agent.ts";
import { PROFILE_QUESTIONS, nextProfileSlot, parseProfileAnswer } from "../agents/welfare/discovery.ts";
import { raceAbort } from "../core/abort.ts";
import { helpPages, type HelpGroup } from "../core/intents.ts";
import { SIMPLE_TEXT_SCHEMA } from "../core/llm.ts";
import { asciiDecimalDigits, strip } from "../core/text.ts";
import { AGENT_IDS, draft, LangSchema, type Draft, type SemanticAction } from "../core/turn.ts";
import { FIXED } from "../language/i18n.ts";
import { redactText } from "../safety/privacy.ts";
import { unsupportedNumbers } from "../safety/verify.ts";
import { speakLabel } from "../speech/phrasing.ts";
import { chatRoute } from "../understanding/chat.ts";
import { isQuestionLike } from "../understanding/filters.ts";
import { cleanValue } from "../understanding/rules.ts";
import { resolveSite } from "../understanding/sites.ts";
import type { SessionOrchestrator, Turn } from "./session.ts";

export const HELP_POINTER = "'뭐라고 말하면 돼?'라고 물어보시면 할 수 있는 말을 알려 드려요.";
export const replyPatterns = {
  phone: /^\p{Nd}/u,
  moreServices: /^(더|다른\p{White_Space}*(거|것|제도)|다음\p{White_Space}*(거|것))\p{White_Space}*(알려|말해|있어|보여)?/u,
  ordinal: /^(\p{Nd}{1,2})\p{White_Space}*번/u,
  thisField: /(이거|이\p{White_Space}*항목|여기|이\p{White_Space}*칸)/u,
};
const simpleReply = z.object({ text: z.string() });

export class SessionReplies {
  private readonly session: SessionOrchestrator;
  private helpPage = 0;
  constructor(session: SessionOrchestrator) { this.session = session; }

  async discoverStep(turn: Turn, first: boolean): Promise<Draft> {
    const s = this.session;
    const next = nextProfileSlot(s.profile);
    if (next !== undefined) {
      s.dialogue.askProfile(next);
      const intro = first ? "맞춤 복지를 찾아볼게요. 몇 가지만 여쭤볼게요. 답은 이번 대화에서만 쓰고 저장하지 않아요. " : "";
      return draft(s.state, "discover", intro + PROFILE_QUESTIONS[next]);
    }
    s.dialogue.profileDone();
    turn.ctx.trace("PLANNING", AGENT_IDS.welfare, "맞춤 복지 찾기");
    const answer = await raceAbort(signal => s.deps.welfare.discover(s.profile, signal), turn.ctx.signal);
    return this.welfareDraft(answer, "discover");
  }

  welfareDraft(answer: GroundedAnswer, semantic: SemanticAction): Draft {
    if (answer.grounded && answer.service !== undefined) this.session.grounded = {servNm: answer.service.servNm, sources: answer.sources};
    return draft(this.session.state, semantic, answer.speech, {sources: answer.sources});
  }

  async welfareReply(answer: Promise<GroundedAnswer>, semantic: SemanticAction): Promise<Draft> {
    return this.welfareDraft(await answer, semantic);
  }

  async rephrase(turn: Turn): Promise<Draft> {
    const s = this.session;
    const last = s.exportHistory().findLast(row => row.role === "assistant")?.text;
    if (last === undefined || last.length === 0) return draft(s.state, "rephrase", "아직 드린 안내가 없어요. 무엇을 도와드릴까요?");
    const llm = s.deps.llm;
    if (llm !== undefined) {
      const raw = await raceAbort(signal => llm.generate({
        system: "시각장애인 사용자가 방금 들은 안내를 이해하지 못했다. 같은 내용을 더 쉬운 말로, 짧은 문장 2~4개로 다시 말해라. 새 정보를 지어내지 말고, 숫자·금액·출처는 그대로 유지. 존댓말.",
        user: last, schemaName: "simple", schema: SIMPLE_TEXT_SCHEMA, signal,
      }), turn.ctx.signal);
      const text = simpleReply.safeParse(raw).data?.text ?? "";
      const changed = unsupportedNumbers(text, [last]);
      if (changed.length > 0) {
        turn.ctx.trace("VERIFYING", AGENT_IDS.verifier, "쉬운 말에 직전 안내에 없는 숫자(" + changed.join(", ") + ") → 직전 안내 그대로");
      } else if (text.length > 0) {
        return draft(s.state, "rephrase", "쉽게 다시 말씀드릴게요. " + text);
      }
    }
    return draft(s.state, "rephrase", "천천히 다시 말씀드릴게요. " + last);
  }

  async freeChat(text: string, turn: Turn): Promise<Draft> {
    const s = this.session;
    const view = s.web.currentView;
    turn.ctx.trace("PLANNING", AGENT_IDS.welfare, "자유 대화 분류");
    const last = s.exportHistory().findLast(row => row.role === "assistant")?.text;
    const llm = s.deps.llm;
    const utterance = redactText(text);
    const out = llm === undefined ? {} : await raceAbort(signal => chatRoute(llm, utterance, {
      page: view?.title === undefined ? undefined : redactText(view.title),
      lastAssistant: last,
      recent: s.recentDialogue(8), askedJustNow: s.lastSemantic === "clarify",
    }, signal), turn.ctx.signal);
    const resume = view !== undefined && isFormOpen(s.web.currentView) ? s.form.askNext(view) : "";
    const withResume = (d: Draft): Draft => resume.length > 0 && d.semanticAction !== "welfare-retrieval"
      ? {...d, speech: d.speech + " 이어서 " + resume} : d;
    const route = out.route;
    if (typeof route !== "string" || route.length === 0) return draft(s.state, "none", "죄송해요, 잘 이해하지 못했어요. 다시 한 번 말씀해 주시겠어요? " + HELP_POINTER);
    if (route === "language") {
      const lang = LangSchema.safeParse(out.language).data;
      if (lang !== undefined) {
        s.lang = lang;
        return draft(s.state, "set-language", FIXED.switched[lang], {lang});
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
    s.profile = {...s.profile, ...parseProfileAnswer(turn.text)};
    return this.discoverStep(turn, true);
  }

  async openBrowser(turn: Turn): Promise<Draft> {
    const s = this.session;
    if (resolveSite(turn.text, s.browse.mockSites()) !== undefined) return s.browse.openSite(turn.text, turn.ctx);
    await s.web.showBrowser();
    const view = await s.web.observe(turn.ctx).catch(() => undefined);
    turn.ctx.signal.throwIfAborted();
    return draft(s.state, "open-browser", "크롬을 열었어요. 어디로 갈까요?", {view});
  }

  helpHuman(): Draft {
    const s = this.session;
    const detail = s.deps.welfare.lastService;
    const contact = detail?.contacts?.find(c => replyPatterns.phone.test(c.value));
    let stepHint: string | undefined;
    if (s.state === "AUTH_HANDOFF") stepHint = "로그인·본인인증";
    if (s.state === "APPLICATION_OPEN" || s.state === "WAITING_FOR_USER_CONFIRMATION") stepHint = "신청 작성";
    if (s.state === "BROWSING") stepHint = "누리집 이용";
    return helpHumanDraft(s.state, {
      url: s.web.currentView?.url, contactName: contact?.name, contactNumber: contact?.value,
      serviceName: detail?.servNm ?? s.grounded?.servNm, stepHint,
    });
  }

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
    for (const [group, examples] of page) parts.push(group + ": " + examples.map(t => "'" + t + "'").join(", ") + ".");
    if (s.consentStatus === "pending") parts.push("동의하시면 화면 읽기와 사이트 열기도 할 수 있어요.");
    parts.push(index === pages.length - 1 ? "처음부터 다시 들으시려면 '도움말'이라고 하세요." : "더 들으시려면 '다른 말도 알려줘'라고 하세요.");
    return draft(s.state, "help-list", parts.join(" "));
  }

  async policyQuestion(topic: string, turn: Turn): Promise<Draft> {
    const s = this.session;
    const welfare = s.deps.welfare;
    turn.ctx.trace("PLANNING", AGENT_IDS.welfare, "grounded answer (" + welfare.answerMode + ")");
    const answer = await raceAbort(signal => welfare.answerQuestion(topic, s.deps.today?.(), signal), turn.ctx.signal);
    if (answer.retrieval !== undefined) {
      turn.ctx.trace("VERIFYING", AGENT_IDS.welfare, "retrieved " + answer.retrieval.sections.join(",") + " used=" + answer.retrieval.used.length);
    }
    if (answer.verification?.ok === false) {
      turn.ctx.trace("VERIFYING", AGENT_IDS.verifier, "복지 답변 근거 부족 → 그 답은 말하지 않음: " + answer.verification.reasons.join(", "));
    }
    const result = this.welfareDraft(answer, "welfare-retrieval");
    const current = s.web.currentView;
    const resume = current !== undefined && isFormOpen(current) ? s.form.askNext(current) : "";
    return resume.length > 0 ? {...result, speech: result.speech + " 이어서 " + resume} : result;
  }

  async unknown(text: string, turn: Turn): Promise<Draft> {
    const s = this.session;
    const clarification = s.dialogue.clarification;
    if (clarification !== undefined) {
      const names = clarification.candidates.map(c => speakLabel(c.label)).join(", ");
      return draft("NEEDS_CLARIFICATION", "clarify", names + " 중 어느 쪽인지 말씀해 주세요.");
    }
    if (replyPatterns.moreServices.test(text) && s.deps.welfare.hasMatches) {
      return this.welfareDraft(s.deps.welfare.moreMatches(), "discover");
    }
    const number = replyPatterns.ordinal.exec(text)?.[1];
    const link = number === undefined ? undefined : s.browse.listedLink(Number(asciiDecimalDigits(number)) - 1);
    if (link !== undefined) return s.browse.followLink(link, turn.ctx);

    if (s.dialogue.awaiting !== undefined && isFormOpen(s.web.currentView)) {
      const field = s.web.field(s.dialogue.awaiting);
      if (isQuestionLike(text)) {
        if (replyPatterns.thisField.test(text) || s.deps.llm === undefined) return s.explain(undefined, turn);
        return this.freeChat(text, turn);
      }
      const value = cleanValue(text);
      const valid = field !== undefined && (field.validate?.(value).ok ?? true);
      if (!valid && s.deps.llm !== undefined) return this.freeChat(text, turn);
      if (field !== undefined) return s.form.fillOne(field, value, turn.ctx);
    }
    if (s.deps.llm !== undefined) return this.freeChat(text, turn);
    if (isQuestionLike(text)) return this.policyQuestion(text, turn);
    return draft(s.state, "none", "죄송해요, 잘 이해하지 못했어요. 아무것도 실행하지 않았어요. " + HELP_POINTER);
  }
}
