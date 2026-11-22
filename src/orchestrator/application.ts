import type { FieldProfile } from "../agents/web/profile.ts";
import { recheck } from "../agents/web/approval.ts";
import { browseState, isFormOpen, outcomeFailure } from "../agents/web/skills/common.ts";
import { raceAbort } from "../core/abort.ts";
import { omitAbsent } from "../core/schema.ts";
import { strip } from "../core/text.ts";
import { AGENT_IDS, draft, type AgentHandoff, type Draft } from "../core/turn.ts";
import { speakLabel } from "../speech/phrasing.ts";
import { applicationPatterns } from "./patterns.ts";
import { ReviewedTask } from "./review_loop.ts";
import { APPROVAL_TTL_S, type SessionOrchestrator, type Turn } from "./session.ts";

// 승인을 받았지만 물어본 뒤 화면이 바뀌어 하지 않은 일(승인 대기 종류별)
const NOT_DONE = { click: "누르지 않았어요.", assist: "넣지 않았어요.", submit: "모의접수하지 않았어요." };
const NOTHING_PENDING = "지금 승인할 작업이 없습니다. 승인은 실행 직전에만 요청합니다.";

export class ApplicationCommands {
  private readonly session: SessionOrchestrator;
  constructor(session: SessionOrchestrator) { this.session = session; }

  async start(turn: Turn): Promise<Draft> {
    const s = this.session;
    // 실제 사이트 모드(practiceMode=false)에서는 "연습/모의"라고 할 때만 연습 신청서, 그 밖에는 공식 안내 페이지로 간다.
    const practice = s.deps.practiceMode !== false || applicationPatterns.practice.test(turn.text);
    const named = applicationPatterns.pension.test(turn.text);
    const welfare = s.deps.welfare;
    if (welfare.currentIsPrivate && welfare.refersToSelection(turn.text)) return s.replies.welfareDraft(await welfare.prepare(undefined), "prepare-apply");
    if (!practice || welfare.currentIsPrivate) {
      const picked = await welfare.selectService(turn.text);
      if (picked !== undefined && picked.length > 0) s.grounded = undefined;
      else if (welfare.currentIsPrivate) return draft(s.state, "clarify", "신청하려는 사업을 확인하지 못했어요. 목록 번호나 사업 이름을 다시 말씀해 주세요.");
    }
    // 어떤 제도인지 말하지 않았고 앞선 대화에도 없으면 추측하지 않고 묻는다.
    if (named && practice) return this.open(turn);
    const current = s.grounded?.servNm ?? welfare.currentServiceName;
    if (current === undefined || current.length === 0) return draft(s.state, "clarify", "어떤 제도를 신청하시려고요? 제도 이름을 말씀해 주세요.");
    if (current === "장애인연금" && practice) return this.open(turn);
    // 실제 신청은 로그인 후 사용자가 직접
    const hint = s.narrator.once("apply", " 자세히는 '본문 읽어줘', 입력 칸은 '하나씩 채워줘'라고 하세요.");
    const opened = await this.openServicePage(current, turn, ` 온라인 신청은 로그인과 본인인증 후 직접 하셔야 해요.${hint}`);
    if (opened !== undefined) return opened;
    if (!practice) {
      // 공식 상세 주소를 모르면 주소를 지어내지 않고 검색해서 연다
      const terms = await s.browse.visibleSearchTerms(`${current} 신청 방법 복지로`, turn.ctx);
      if (terms === undefined) return draft(s.state, "clarify", "공식 신청 안내를 찾을 제도 이름을 말씀해 주세요.");
      const out = await s.web.openSite(s.browse.searchUrl(terms), turn.ctx);
      if (out.status === "ok" && out.view !== undefined) {
        s.browse.afterNavigation(out.view);
        const intro = await s.narrator.pageIntro(out.view, turn.ctx);
        return draft(browseState(out.view), "agent-handoff", `${current} 공식 페이지 주소를 몰라서 신청 방법을 검색했어요. ${intro}`, { actions: out.actions, view: out.view });
      }
    }
    return draft(s.state, "clarify", `${current} 연습 신청서는 아직 없어요. 지금은 장애인연금 연습 신청서만 있어요.`);
  }

  /** Agent B가 고른 제도의 공식 상세 페이지를 Agent A가 읽기 전용으로 연다. 주소가 없거나 못 열면 undefined. */
  async openServicePage(current: string, turn: Turn, tail: string): Promise<Draft | undefined> {
    const s = this.session;
    const welfare = s.deps.welfare;
    const url = welfare.currentServiceUrl;
    if (url === undefined || url.length === 0 || s.web.guard.tierOf(url) === "none") return undefined;
    const out = await s.web.openSite(url, turn.ctx);
    if (out.status !== "ok" || out.view === undefined) return undefined;
    s.browse.afterNavigation(out.view);
    const brief = await raceAbort(signal => welfare.briefing(signal), turn.ctx.signal).catch(() => undefined);
    const speech = `${current} 공식 안내를 열었어요. ${brief ?? ""}${tail}`;
    return draft(browseState(out.view), "agent-handoff", strip(speech.replace(applicationPatterns.spaces, " ")), { actions: out.actions, view: out.view });
  }

  /**
   * "공식 안내 열어줘": 신청 시작 없이 고른 제도의 공식 안내만 연다. 번호·제도 이름을 말했으면 그 제도를 먼저 고른다.
   * 어떤 제도인지 모르거나 말한 제도를 찾지 못하면 묻는다(다른 제도를 열거나 주소를 지어내지 않음).
   */
  async openOfficial(service: string | undefined, turn: Turn): Promise<Draft> {
    const s = this.session;
    const welfare = s.deps.welfare;
    let current: string | undefined;
    if (service !== undefined && service.length > 0) {
      const hit = welfare.findInMatches(service) === undefined ? undefined : welfare.pick(service);
      current = hit === undefined ? await welfare.selectService(service, { ctpv: s.profile.ctpv, sgg: s.profile.sgg }) : hit.servNm;
      if (current === undefined || current.length === 0) {
        return draft(s.state, "clarify", `'${service}'에 맞는 제도를 찾지 못했어요. 목록 번호나 제도 이름을 다시 말씀해 주세요.`);
      }
      s.grounded = undefined;
    } else {
      current = s.grounded?.servNm ?? welfare.currentServiceName;
    }
    if (current === undefined || current.length === 0) return draft(s.state, "clarify", "어떤 제도의 공식 안내를 열까요? 제도 이름이나 목록 번호를 말씀해 주세요.");
    const hint = s.narrator.once("official", " 자세히는 '본문 읽어줘'라고 하세요.");
    const opened = await this.openServicePage(current, turn, hint);
    return opened ?? draft(s.state, "clarify", `${current}의 공식 안내 주소를 확인하지 못했어요. '복지로에서 ${current} 찾아줘'라고 하시면 찾아볼게요.`);
  }

  async open(turn: Turn): Promise<Draft> {
    const s = this.session;
    turn.ctx.trace("PLANNING", AGENT_IDS.orchestrator, "Agent A: 신청서 열기, Agent B: 근거 안내");
    // Agent B가 방금 근거를 찾아 답했다면, 그 근거와 목표 주소를 Agent A로 넘긴다(허용 도메인만).
    const grounded = s.grounded;
    s.grounded = undefined;
    let handoff: AgentHandoff | undefined;
    if (grounded !== undefined) {
      const targetUrl = s.web.profile.urls.apply;
      handoff = omitAbsent({
        from: AGENT_IDS.welfare, to: AGENT_IDS.web, taskId: turn.id,
        goal: `${grounded.servNm} 모의 신청서 열기`, targetUrl, sources: grounded.sources,
        requiresApprovedDomain: true as const, domainApproved: s.web.isApprovedUrl(targetUrl),
        officialUrl: grounded.sources[0]?.url,
      });
      turn.ctx.trace("PLANNING", AGENT_IDS.welfare, `handoff → ${AGENT_IDS.web} (approved=${String(handoff.domainApproved)})`);
      if (!handoff.domainApproved) return draft(s.state, "agent-handoff", "인계받은 신청 주소가 허용된 사이트가 아니라서 열지 않았습니다.", { handoff });
    }
    const fromExternal = s.web.currentView?.pageId === "external";
    const out = await s.web.openApplication(turn.ctx);
    if (out.status !== "ok" || out.view === undefined) return outcomeFailure(out, "IDLE");
    const context = await raceAbort(signal => s.deps.welfare.applicationContext(signal), turn.ctx.signal);
    s.dialogue.dropValueWait();
    // 같은 뜻을 두 번 말하지 않는다(외부 사이트 안내가 있으면 그것만).
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
      const visible = view.fields.filter(f => f.visible && f.type !== "checkbox");
      const current = visible.find(f => f.fieldId === s.form.lastFieldId) ?? visible[0];
      if (current !== undefined) field = s.web.field(current.fieldId);
    }
    if (field === undefined) return draft(s.state, "explain-field", "어떤 항목을 설명할지 알 수 없습니다. 항목 이름을 함께 말씀해 주세요.");
    turn.ctx.trace("PLANNING", AGENT_IDS.welfare, `glossary ${field.fieldId}`);
    const answer = await s.deps.welfare.explainField(field.fieldId, speakLabel(field.label));
    s.form.fieldExplained(field.fieldId);
    return draft(isFormOpen(s.web.currentView) ? s.form.formState() : s.state, "explain-field", answer.speech, { field: field.fieldId, sources: answer.sources });
  }

  async approve(turn: Turn): Promise<Draft> {
    const s = this.session;
    const pending = s.dialogue.approval;
    const run = pending !== undefined && "reviewedTask" in pending ? pending.reviewedTask : undefined;
    if (!(run instanceof ReviewedTask)) return this.#execute(turn);
    // 1회 승인과 같은 지문을 확인해야 기존 작업을 이어 간다.
    turn.ctx = run.context(turn.ctx);
    return s.progress.review(async () => s.review.run(run, turn, await this.#execute(turn)));
  }

  /**
   * 승인 문. 물어볼 때 읽어 준 그대로(지문: 누를 대상·화면 주소·입력 칸 값)일 때만 실행한다. 다르면 승인을 버리고 무엇이 바뀌었는지 말한다.
   * 그대로라도 물은 지 2분이 지났으면 실행하지 않고 요약을 다시 읽어 새로 묻는다. 그대로이고 2분 안이면 다시 묻지 않는다.
   */
  async #execute(turn: Turn): Promise<Draft> {
    const s = this.session;
    const d = s.dialogue;
    const approval = d.approval;
    if (approval === undefined) return draft(s.state, "none", NOTHING_PENDING);
    if (approval.kind === "click" && approval.then === "login-submit") {
      const ended = s.browse.authEndIfUnavailable(turn.ctx);
      if (ended !== undefined) return ended;
    }
    const expired = () => d.approvalAge >= APPROVAL_TTL_S;
    if (approval.kind === "plan") return s.browse.knownPlans.approve(approval.grant, turn.ctx);
    if (approval.kind === "research") {
      const late = expired();
      d.clearApproval();
      const delegate = s.deps.delegateResearch;
      const saved = !late && s.consentStatus === "granted" && delegate !== undefined && await delegate(approval.confirmation.actionId, approval.goal);
      return draft("IDLE", "none", saved ? "조사를 맡겼어요. 결과가 나오면 알려 드릴게요." : "조사를 시작하지 못했어요. 개인 기기 설정과 질문을 확인해 주세요.",
        saved ? {researchDelivery: "queued"} : {});
    }
    if (approval.kind === "visual") {
      if (expired()) {
        d.clearApproval();
        return draft("BROWSING", "clarify", "시간이 지나 사진 전송 요청을 닫았어요. 필요한 업무를 다시 말씀해 주세요.");
      }
      return s.browse.resumeVisual(approval, turn.ctx);
    }
    if (approval.kind === "file") {
      if (expired()) {
        d.clearApproval();
        return s.browse.readDownload({}, approval.question, turn.ctx);
      }
      return s.browse.analyzeApproved(approval, turn.ctx, s.lang);
    }
    const kind = approval.kind ?? "submit";
    const view = await s.web.observe(turn.ctx);
    if (turn.ctx.signal.aborted || d.approval !== approval) return draft(s.state, "none", "이 확인 요청은 취소됐어요.");
    // 확인한 조작 그대로를 실행한다. 확인과 실행 사이에 같은 객체가 바뀌어도 따라가지 않는다(검토하던 일은 복사하지 않는다).
    const { reviewedTask: _reviewed, ...asked } = approval;
    const checked = structuredClone(asked);
    const actions = checked.kind === "assist" ? checked.actions : [checked.action];
    const originals = asked.kind === "assist" ? asked.actions : [asked.action];
    actions.forEach((copy, index) => s.web.copyObservedTarget(originals[index]!, copy));
    const [now, rechecked] = recheck(checked.fingerprint, view, actions);
    const bindRecord = kind === "assist" || approval.reviewedTask !== undefined || (kind === "click" && !s.web.isApprovedUrl(approval.url ?? ""));
    const changed = bindRecord && approval.url !== view.url ? "여쭤본 뒤에 화면 주소가 바뀌었어요." : rechecked;
    if (changed !== undefined) {
      d.clearApproval();
      return draft(d.authWaiting ? "AUTH_HANDOFF" : browseState(view), "none", `${changed} 그래서 ${NOT_DONE[kind]} 바뀐 대로 하시려면 한 번 더 말씀해 주세요.`, { view });
    }
    if (expired()) {
      d.askApproval({ ...approval, fingerprint: now });
      return draft("WAITING_FOR_USER_CONFIRMATION", kind === "click" ? "confirm-click" : "prepare-submit",
        `여쭤본 지 ${APPROVAL_TTL_S / 60}분이 지나서 다시 여쭤볼게요. ${now.speech}`, { view, masked: true });
    }
    // 실행한 뒤에도 같은 승인이 남아 있으면(확인하지 못해 다시 묻는 경우) 물은 시각을 새로 잰다.
    const keepAsking = <T>(result: T): T => {
      if (d.approval === approval) d.askApproval(approval);
      return result;
    };
    return turn.ctx.granted(actions.map(a => a.id), async () => {
      if (checked.kind === "click") return keepAsking(await s.browse.clickApproved(checked, turn.ctx));
      if (checked.kind === "assist") {
        const filled = await s.form.assistApproved(checked.actions, turn.ctx);
        if (checked.guided === true && s.guided.active() && filled.semanticAction === "fill") return s.guided.afterAssist(filled, turn.ctx);
        return keepAsking(filled);
      }
      return keepAsking(await s.form.submitApproved(checked.action, turn.ctx));
    });
  }
}
