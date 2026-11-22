import { randomUUID } from "node:crypto";
import type { Action } from "../../../core/actions.ts";
import { APPROVAL_TTL_S, type ApprovalFingerprint } from "../../../core/dialogue.ts";
import { bindPlanClick, planPage, revokePlanClick, type PlanGrant, type PlanStep } from "../../../core/plan.ts";
import { draft, type Draft } from "../../../core/turn.ts";
import { clickTier, isInspectionUrl, planControlAllowed } from "../../../safety/guard.ts";
import { redactPictureText } from "../../../safety/privacy.ts";
import { ExecContext, verifiedClick, type PageView, type WebAction } from "../agent.ts";
import { fingerprint, recheck } from "../approval.ts";
import { accessBlocked, stillNeedsAuth } from "../auth_page.ts";
import type { BrowseSkill } from "./browse.ts";
import { browseState } from "./common.ts";

type Continuation = (ctx: ExecContext, completed: number) => Promise<Draft>;
export interface PlanHooks {
  onComplete?: Continuation; onMismatch?: Continuation;
  canStep?: (ctx: ExecContext, view: PageView, step: PlanStep) => boolean;
  didStep?: (ref: string) => void;
}
interface BoundStep { action: Action; fingerprint: ApprovalFingerprint; signature: string; url: string }
interface Asked {
  checked: Map<number, BoundStep>; deadline: number; context: ExecContext; hooks: PlanHooks;
}
const roles: Record<string, string> = { link: "링크", scriptlink: "링크", button: "버튼", tab: "탭", menuitem: "메뉴 항목", generic: "항목" };
const safeName = (name: string) => name.length > 0 && name.length <= 100 && !/[\n\r“”]/u.test(name) && redactPictureText(name) === name;
const eligible = (s: PlanStep) => s.kind === "click" && planPage(s.page) === s.page && safeName(s.name) && planControlAllowed(s.role, s.name);

function targetAction(ref: string, role: string, name: string): Action {
  return { id: randomUUID(), type: "click", target: { ref, role, name }, reason: `'${name}' 누르기`, risk: "low", requiresConfirmation: false };
}

/** 발화의 각 절 전체가 이름 하나를 누르라는 말이어야 한다. 모델이 고친 말이나 뒤에 다른 부탁이 붙은 절은 쓰지 않는다. */
export function spokenPlanNames(parts: readonly string[]): string[] | undefined {
  if (parts.length < 2) return undefined;
  const names: string[] = [];
  for (const part of parts) {
    const hit = /^(.+?)(?:\s+(?:링크|메뉴|탭|버튼))?(?:을|를)?\s*(?:눌러(?:\s*(?:줘|주세요|주렴))?|클릭(?:해(?:\s*(?:줘|주세요))?)?)[.!。]?$/u.exec(part);
    if (hit?.[1] === undefined) return undefined;
    const name = hit[1].trim().replace(/^['“‘"](.+)['”’"]$/u, "$1");
    if (!safeName(name)) return undefined;
    names.push(name);
  }
  return names;
}

export class KnownPlans {
  readonly #browse: BrowseSkill;
  readonly #asked = new WeakMap<PlanGrant, Asked>();

  constructor(browse: BrowseSkill) { this.#browse = browse; }

  async spoken(goal: string, names: readonly string[], ctx: ExecContext): Promise<Draft | undefined> {
    const view = await this.#browse.web.observe(ctx);
    const page = planPage(view.url);
    if (page === undefined) return undefined;
    const steps: PlanStep[] = [];
    for (const name of names) {
      const matches = view.outline?.items?.filter(i => !i.disabled && i.name === name);
      const item = matches?.[0];
      if (item === undefined || matches?.length !== 1) return undefined;
      steps.push({ page, kind: "click", role: item.role, name: item.name });
    }
    return this.offer(goal, steps, ctx);
  }

  async #bind(view: PageView, step: PlanStep, speech: string): Promise<BoundStep | undefined> {
    if (planPage(view.url) !== step.page) return undefined;
    const window = await this.#browse.web.adapter.controlWindow?.(step.name, 0, { exact: true, inspection: true });
    const item = window?.items[0];
    if (window?.url !== view.url || window.more || window.items.length !== 1 || item?.planSignature === undefined || item.planSignature.length === 0 || item.pictureMasked === true ||
        item.disabled || item.name !== step.name || item.role !== step.role || item.inspection?.kind === "blocked" ||
        (item.inspection?.href !== undefined && !isInspectionUrl(item.inspection.href))) return undefined;
    const action = targetAction(item.ref, item.role, item.name);
    const fp = fingerprint(view, [action], speech);
    if (fp.actions[0]?.now?.ref !== item.ref || fp.actions[0].now.name !== step.name || fp.actions[0].now.role !== step.role) return undefined;
    return { action, fingerprint: fp, signature: item.planSignature, url: view.url };
  }

  /** 이미 관찰한 경로에만 사용한다. 현재 화면에 있는 단계는 물을 때 요소와 지문까지 묶고, 나머지는 해당 화면에 도착했을 때 정확히 찾는다. */
  async offer(goal: string, steps: readonly PlanStep[], ctx: ExecContext, hooks: PlanHooks = {}): Promise<Draft | undefined> {
    const { web, dialogue } = this.#browse;
    const first = steps[0];
    if (!first || dialogue.approval !== undefined || dialogue.authWaiting || ctx.publicLookup || ctx.browsingScope !== undefined || web.guard.config.publicLookupOnly === true ||
        ctx.isStopped() || ctx.signal.aborted || !steps.every(eligible) ||
        !steps.some(s => clickTier(s.role, s.name) === "ask")) return undefined;
    const view = await web.observe(ctx);
    if (planPage(view.url) !== first.page || stillNeedsAuth(view) || accessBlocked(view)) return undefined;
    const sequence = steps.map((step, i) => `${i + 1}번, “${step.name}” ${roles[step.role] ?? "항목"}`).join(". ");
    const speech = `${sequence}. 이 순서대로 누를까요? 진행하려면 '네', 그만두려면 '거절'이라고 말씀해 주세요.`;
    const grant: PlanGrant = Object.freeze({ id: randomUUID(), goal, steps: Object.freeze(steps.map(s => Object.freeze({ ...s }))), cursor: 0 });
    const checked = new Map<number, BoundStep>();
    let needsConsent = false;
    for (const [i, step] of grant.steps.entries()) {
      if (step.page !== first.page) break;
      const bound = await this.#bind(view, step, speech);
      // 기억한 경로는 앞 단계를 눌러야 같은 페이지에 다음 단추가 나타날 수도 있다.
      if (!bound && i > 0 && hooks.canStep) break;
      if (!bound) return undefined;
      const policy = web.previewPolicy(bound.action, ctx).policy;
      if (!policy.allowed && policy.code !== "NEEDS_CONFIRMATION") return undefined;
      needsConsent ||= policy.code === "NEEDS_CONFIRMATION";
      checked.set(i, bound);
    }
    needsConsent ||= grant.steps.slice(checked.size).some(step => clickTier(step.role, step.name) === "ask" &&
      !(web.guard.tierOf(step.page) === "read-only" && web.guard.config.readOnlyClicks === "any"));
    if (!needsConsent || dialogue.approval !== undefined || dialogue.authWaiting || ctx.isStopped() || ctx.signal.aborted) return undefined;
    this.#asked.set(grant, { checked, deadline: web.clock() + APPROVAL_TTL_S * 1000, context: ctx, hooks });
    dialogue.askApproval({ kind: "plan", grant, confirmation: { actionId: grant.id, kind: "plan", purpose: "읽어 드린 순서대로 누르기",
      description: speech, site: new URL(first.page).host, realSubmission: false, values: [] } });
    return draft("WAITING_FOR_USER_CONFIRMATION", "confirm-click", speech, { view });
  }

  async approve(pending: PlanGrant, turn: ExecContext): Promise<Draft> {
    const { web, dialogue } = this.#browse;
    if (dialogue.approval?.kind !== "plan" || dialogue.approval.grant !== pending) return draft(dialogue.state, "none", "이 확인 요청은 끝났어요.");
    const asked = this.#asked.get(pending);
    this.#asked.delete(pending);
    dialogue.clearApproval();
    const grant = { ...pending };
    if (!asked || asked.context.sessionId !== turn.sessionId || turn.publicLookup || turn.browsingScope !== undefined ||
        web.guard.config.publicLookupOnly === true) return draft("BROWSING", "clarify", "어떤 항목을 누를지 다시 말씀해 주세요.");
    const configured = web.guard.config.defaultActionsPerTurn ?? web.guard.config.maxActionsPerTurn;
    const ctx = new ExecContext({ ...turn, counter: asked.context.counter, actionLimit: Math.min(asked.context.actionLimit ?? configured,
      turn.actionLimit ?? asked.context.actionLimit ?? configured, web.guard.config.maxActionsPerTurn) });
    const actions: WebAction[] = [];
    const append = (reply: Draft): Draft => ({ ...reply, actions: [...actions, ...(reply.actions ?? [])] });
    const live = () => !ctx.isStopped() && !ctx.signal.aborted && !asked.context.isStopped() && !asked.context.signal.aborted && web.clock() < asked.deadline;
    const expired = () => append(draft("BROWSING", "clarify", "확인 시간이 지나서 멈췄어요. 다음에 누를 항목을 말씀해 주시겠어요?"));
    const interrupted = () => ctx.isStopped() || ctx.signal.aborted ? append(draft("STOPPED", "stop", "멈췄어요.")) : expired();
    const changed = async (step: PlanStep, message?: string) => {
      if (!live()) return interrupted();
      if (asked.hooks.onMismatch) {
        const next = await asked.hooks.onMismatch(ctx, grant.cursor);
        return append({...next, speech: [...notices, next.speech].join(" ")});
      }
      return append(draft("NEEDS_CLARIFICATION", "clarify",
        (message ?? `“${step.name}” 항목이나 화면이 바뀌었어요.`) + " 남은 순서를 멈췄어요. 지금 어떤 항목을 누를까요?", { view: web.currentView }));
    };
    const notices: string[] = [];
    for (const [i, step] of grant.steps.entries()) {
      if (!live()) return interrupted();
      if (ctx.counter.actions >= (ctx.actionLimit ?? 0)) return append(draft("BROWSING", "clarify", "한 번에 할 수 있는 조작 횟수를 채워서 멈췄어요."));
      const view = await web.observe(ctx);
      if (stillNeedsAuth(view) || accessBlocked(view)) return append(await this.#browse.recognizeAuthPage(draft("BROWSING", "goal", "", { view }), undefined, ctx));
      if (asked.hooks.canStep?.(ctx, view, step) === false) return changed(step);
      const previous = asked.checked.get(i);
      const difference = previous === undefined ? undefined : recheck(previous.fingerprint, view, [previous.action])[1];
      if (difference !== undefined) return changed(step, difference);
      const bound = await this.#bind(view, step, "");
      if (!bound || previous && (previous.signature !== bound.signature || previous.url !== bound.url ||
          previous.action.target?.ref !== bound.action.target?.ref)) return changed(step);
      if (!live()) return interrupted();
      const action = bound.action;
      const proof = bindPlanClick(step, action.id, action.target!.ref!, view.url, bound.signature, () => live() && grant.cursor === i && ctx.counter.actions <= (ctx.actionLimit ?? 0));
      let out;
      try { out = await ctx.granted([action.id], () => asked.hooks.canStep
        ? web.followLink(step.name, ctx, false, {expected: [view.url, action.target!.ref!, step.role], plan: {action, proof}})
        : web.clickApproved(action, ctx, {plan: proof})); }
      finally { revokePlanClick(proof); }
      if (out.status === "needs-clarification" || out.actions.some(a => a.result?.errorCode === "VERIFY_FAILED" || a.result?.errorCode === "TARGET_NOT_FOUND" || a.result?.errorCode === "AMBIGUOUS_TARGET")) {
        actions.push(...out.actions);
        return changed(step);
      }
      if (out.status === "unconfirmed" || out.status === "ok" && !out.actions.some(row => row.action.id === action.id && verifiedClick(row))) {
        actions.push(...out.actions);
        return append(draft("NEEDS_CLARIFICATION", "clarify", `${out.message ?? "눌렸는지 확인하지 못했어요."} 여기서 멈췄어요. 다음에는 어느 항목을 누를까요?`, { view: out.view }));
      }
      const result = await this.#browse.finishApprovedClick(out, { action, url: view.url }, ctx, asked.hooks.onComplete !== undefined);
      const reply = await this.#browse.recognizeAuthPage(result, view, ctx);
      if (out.status !== "ok" || !out.view || out.effect === "none" || out.question || (out.manual?.length ?? 0) > 0 ||
          reply.state === "AUTH_HANDOFF" || reply.state === "WAITING_FOR_USER_CONFIRMATION" || reply.state === "NEEDS_CLARIFICATION") return append(reply);
      actions.push(...(reply.actions ?? []));
      if ((out.notices?.length ?? 0) > 0) notices.push(reply.speech);
      grant.cursor++;
      asked.hooks.didStep?.(action.target!.ref!);
    }
    if (!live()) return interrupted();
    if (asked.hooks.onComplete) {
      const done = await asked.hooks.onComplete(ctx, grant.cursor);
      return append({...done, speech: [...notices, done.speech].join(" ")});
    }
    const view = web.currentView;
    return append(draft(view ? browseState(view) : "BROWSING", "confirm-click", [...notices, `말씀하신 ${grant.cursor}개 항목을 차례로 눌렀어요.`].join(" "), { view }));
  }
}
