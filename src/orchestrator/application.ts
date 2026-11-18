import type { FieldProfile } from "../agents/web/profile.ts";
import { recheck } from "../agents/web/approval.ts";
import { browseState, isFormOpen, outcomeFailure } from "../agents/web/skills/common.ts";
import { raceAbort } from "../core/abort.ts";
import { omitAbsent } from "../core/schema.ts";
import { AGENT_IDS, draft, type AgentHandoff, type Draft } from "../core/turn.ts";
import { speakLabel } from "../speech/phrasing.ts";
import type { SessionOrchestrator, Turn } from "./session.ts";

const APPROVAL_TTL_SECONDS = 120;
export const applicationPatterns = {
  practice: /(연습|모의)/u,
  pension: /장애인\p{White_Space}*연금/u,
  spaces: /\p{White_Space}+/gu,
};

export class ApplicationCommands {
  private readonly session: SessionOrchestrator;
  constructor(session: SessionOrchestrator) { this.session = session; }

  async start(turn: Turn): Promise<Draft> {
    const s = this.session;
    const practice = s.deps.practiceMode !== false || applicationPatterns.practice.test(turn.text);
    const welfare = s.deps.welfare;
    if (!practice) {
      const selected = await raceAbort(signal => welfare.selectService(turn.text, signal), turn.ctx.signal);
      if (selected !== undefined) s.grounded = undefined;
    }
    if (practice && applicationPatterns.pension.test(turn.text)) return this.open(turn);
    const current = s.grounded?.servNm ?? welfare.currentServiceName;
    if (current === undefined || current.length === 0) return draft(s.state, "clarify", "어떤 제도를 신청하시려고요? 제도 이름을 말씀해 주세요.");
    if (practice && current === "장애인연금") return this.open(turn);
    const url = welfare.currentServiceUrl;
    if (url !== undefined && url.length > 0 && s.web.guard.tierOf(url) !== "none") {
      const out = await s.web.openSite(url, turn.ctx);
      if (out.status === "ok" && out.view !== undefined) {
        s.browse.afterNavigation(out.view);
        const brief = await raceAbort(signal => welfare.briefing(signal), turn.ctx.signal).catch(() => undefined);
        turn.ctx.signal.throwIfAborted();
        const hint = s.narrator.once("apply", " 자세히는 '본문 읽어줘', 입력 칸은 '하나씩 채워줘'라고 하세요.");
        const speech = current + " 공식 안내를 열었어요. " + (brief ?? "") + " 온라인 신청은 로그인과 본인인증 후 직접 하셔야 해요." + hint;
        return draft(browseState(out.view), "agent-handoff", speech.replace(applicationPatterns.spaces, " "), {actions: out.actions, view: out.view});
      }
    }
    if (!practice) {
      const out = await s.web.openSite(s.browse.searchUrl(current + " 신청 방법 복지로"), turn.ctx);
      if (out.status === "ok" && out.view !== undefined) {
        s.browse.afterNavigation(out.view);
        const intro = await s.narrator.pageIntro(out.view, turn.ctx);
        return draft(browseState(out.view), "agent-handoff", current + " 공식 페이지 주소를 몰라서 신청 방법을 검색했어요. " + intro, {actions: out.actions, view: out.view});
      }
    }
    return draft(s.state, "clarify", current + " 연습 신청서는 아직 없어요. 지금은 장애인연금 연습 신청서만 있어요.");
  }

  async open(turn: Turn): Promise<Draft> {
    const s = this.session;
    turn.ctx.trace("PLANNING", AGENT_IDS.orchestrator, "Agent A: 신청서 열기, Agent B: 근거 안내");
    const grounded = s.grounded;
    s.grounded = undefined;
    let handoff: AgentHandoff | undefined;
    if (grounded !== undefined) {
      const targetUrl = s.web.profile.urls.apply;
      handoff = omitAbsent({
        from: AGENT_IDS.welfare, to: AGENT_IDS.web, taskId: turn.id,
        goal: grounded.servNm + " 모의 신청서 열기", targetUrl, sources: grounded.sources,
        requiresApprovedDomain: true as const, domainApproved: s.web.isApprovedUrl(targetUrl),
        officialUrl: grounded.sources[0]?.url,
      });
      turn.ctx.trace("PLANNING", AGENT_IDS.welfare, "handoff → " + AGENT_IDS.web + " (approved=" + String(handoff.domainApproved) + ")");
      if (!handoff.domainApproved) return draft(s.state, "agent-handoff", "인계받은 신청 주소가 허용된 사이트가 아니라서 열지 않았습니다.", {handoff});
    }
    const fromExternal = s.web.currentView?.pageId === "external";
    const out = await s.web.openApplication(turn.ctx);
    if (out.status !== "ok" || out.view === undefined) return outcomeFailure(out, "IDLE");
    const context = await raceAbort(signal => s.deps.welfare.applicationContext(signal), turn.ctx.signal);
    s.dialogue.dropValueWait();
    const officialUrl = handoff?.officialUrl;
    const speech = [
      fromExternal ? "이 사이트에서는 실제 신청을 대신하지 않아요. 연습용 신청서를 열게요." : "",
      !fromExternal && officialUrl !== undefined && officialUrl.length > 0 && !s.web.isApprovedUrl(officialUrl) ? "실제 신청 사이트 대신 연습용 신청서를 열게요." : "",
      "장애인연금 모의 신청서를 열었어요. 연습용이라 실제로 접수되지는 않아요.", s.narrator.describeView(out.view), s.form.askNext(out.view),
    ].filter(part => part.length > 0).join(" ");
    return draft("APPLICATION_OPEN", handoff === undefined ? "navigate" : "agent-handoff", speech, {
      summary: "모의 신청서를 열었어요.", actions: out.actions, view: out.view, handoff, sources: handoff?.sources ?? context.sources,
    });
  }

  async explain(mention: string | undefined, turn: Turn): Promise<Draft> {
    const s = this.session;
    let field: FieldProfile | undefined;
    if (mention !== undefined && mention.length > 0) {
      const resolved = s.web.resolveField(mention);
      if (resolved.kind === "ok" || resolved.kind === "not-visible") field = resolved.field;
      else if (resolved.kind === "ambiguous") field = resolved.candidates[0];
    }
    if (field === undefined && isFormOpen(s.web.currentView)) {
      const view = await s.web.observe(turn.ctx);
      const visible = view.fields.filter(f => f.visible === true && f.type !== "checkbox");
      const current = visible.find(f => f.fieldId === s.form.lastFieldId) ?? visible[0];
      if (current !== undefined) field = s.web.field(current.fieldId);
    }
    if (field === undefined) return draft(s.state, "explain-field", "어떤 항목을 설명할지 알 수 없습니다. 항목 이름을 함께 말씀해 주세요.");
    turn.ctx.trace("PLANNING", AGENT_IDS.welfare, "glossary " + field.fieldId);
    const answer = await s.deps.welfare.explainField(field.fieldId, speakLabel(field.label));
    turn.ctx.signal.throwIfAborted();
    s.form.fieldExplained(field.fieldId);
    return draft(isFormOpen(s.web.currentView) ? s.form.formState() : s.state, "explain-field", answer.speech, {field:field.fieldId, sources:answer.sources});
  }

  async approve(turn: Turn): Promise<Draft> {
    const s = this.session;
    const pending = s.dialogue.approval;
    if (pending === undefined) return draft(s.state, "none", "지금 승인할 작업이 없습니다. 승인은 실행 직전에만 요청합니다.");
    const view = await s.web.observe(turn.ctx);
    turn.ctx.signal.throwIfAborted();
    if (pending !== s.dialogue.approval) return draft(s.state, "none", "지금 승인할 작업이 없습니다. 승인은 실행 직전에만 요청합니다.");
    const approval = structuredClone(pending);
    const actions = approval.kind === "assist" ? approval.actions : [approval.action];
    const [now, changed] = recheck(approval.fingerprint, view, actions);
    if (changed !== undefined) {
      const notDone = approval.kind === "click" ? "누르지 않았어요." : approval.kind === "assist" ? "넣지 않았어요." : "모의접수하지 않았어요.";
      s.dialogue.clearApproval();
      return draft(browseState(view), "none", changed + " 그래서 " + notDone + " 바뀐 대로 하시려면 한 번 더 말씀해 주세요.", {view});
    }
    if (s.dialogue.approvalAge >= APPROVAL_TTL_SECONDS) {
      s.dialogue.askApproval({...approval, fingerprint: now});
      return draft("WAITING_FOR_USER_CONFIRMATION", approval.kind === "click" ? "confirm-click" : "prepare-submit",
        "여쭤본 지 " + APPROVAL_TTL_SECONDS / 60 + "분이 지나서 다시 여쭤볼게요. " + now.speech, {view, masked: true});
    }
    return turn.ctx.granted(actions.map(a => a.id), async () => {
      if (approval.kind === "click") return s.browse.clickApproved(approval, turn.ctx);
      if (approval.kind === "assist") {
        const filled = await s.form.assistApproved(approval.actions, turn.ctx);
        if (approval.guided === true && s.guided.active() && filled.semanticAction === "fill") return s.guided.afterAssist(filled, turn.ctx);
        return filled;
      }
      return s.form.submitApproved(approval.action, turn.ctx);
    });
  }

  reject(): Draft { return this.session.form.reject(); }
}
