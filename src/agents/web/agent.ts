import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Action, ActionResult, ActionTarget, Observation } from "../../core/actions.ts";
import type { Redacted } from "../../core/llm.ts";
import { AGENT_IDS, PIPELINE_PHASES, type ExecutedAction } from "../../core/turn.ts";
import { strip } from "../../core/text.ts";
import { tryUrl } from "../../core/url.ts";
import { PolicyGuard, type AccessTier } from "../../safety/guard.ts";
import { redactText } from "../../safety/privacy.ts";
import { speakLabel } from "../../speech/phrasing.ts";
import { normalizeTerm, type FieldProfile, type PageId, type SiteProfile } from "./profile.ts";
import { Churn, diffViews, itemChanged, looksLoading, openedDialog, unconfirmedMessage, type Effect } from "./effect.ts";

interface ContextOptions {
  signal: AbortSignal;
  approvals?: Set<string>;
  isStopped(): boolean;
  trace(phase: typeof PIPELINE_PHASES[number], agent: string, note?: string): void;
  counter?: { actions: number };
}
export class ExecContext {
  readonly signal: AbortSignal;
  readonly approvals: Set<string>;
  readonly isStopped: ContextOptions["isStopped"];
  readonly trace: ContextOptions["trace"];
  readonly counter: { actions: number };

  constructor({ signal, approvals = new Set(), isStopped, trace, counter = { actions: 0 } }: ContextOptions) {
    this.signal = signal;
    this.approvals = approvals;
    this.isStopped = isStopped;
    this.trace = trace;
    this.counter = counter;
  }
  async granted<T>(ids: readonly string[], work: () => Promise<T>): Promise<T> {
    const added = ids.filter(id => !this.approvals.has(id));
    for (const id of added) this.approvals.add(id);
    try { return await work(); }
    finally { for (const id of added) this.approvals.delete(id); }
  }
}

export type PageView = Observation & { pageId: PageId };
export interface WebAdapter {
  observe(signal?: AbortSignal): Promise<Observation>;
  execute(action: Action, signal?: AbortSignal): Promise<ActionResult>;
  close(): Promise<void>;
  bringToFront?(): Promise<void>;
  clearSiteLogin?(options: { currentOnly: boolean }, signal?: AbortSignal): Promise<string[]>;
}
export interface WebAuditEntry {
  host: string; pageKind: string; actionType: Action["type"]; label: Redacted;
  approvalId?: string; phase: "before" | "after"; ok?: boolean;
}
export type WebActionResult = ActionResult | { ok: false; errorCode: "LOG_FAILED"; latencyMs: 0 };
export type WebAction = Omit<ExecutedAction, "result"> & { result?: WebActionResult };
export const webAgentPatterns = {
  assistSecret: /(비밀\p{White_Space}*번호|password|인증\p{White_Space}*번호|otp|주민|계좌|카드)/iu,
  checked: /^(예|네|응|체크)/u,
};
export function actionLabel(action: Partial<Pick<Action, "reason" | "type" | "target">>): Redacted {
  const reason = strip(action.reason ?? "");
  const fallback = strip((action.type ?? "action") + " " + (action.target?.name ?? action.target?.fieldId ?? ""));
  const safe = redactText(reason.length > 0 ? reason : fallback);
  return safe.length <= 80 ? safe : redactText([...safe].slice(0, 80).join(""));
}
export type FieldResolution =
  | { kind: 'ok'; field: FieldProfile }
  | { kind: 'ambiguous'; candidates: FieldProfile[] }
  | { kind: 'not-visible'; field: FieldProfile }
  | { kind: 'not-found' };

export type OutcomeStatus =
  | 'ok'
  | 'needs-clarification'
  | 'validation-error'
  | 'policy-denied'
  | 'failed'
  | 'aborted' | 'unconfirmed' | 'needs-approval';

export interface WebOutcome {
  status: OutcomeStatus;
  actions: WebAction[];
  view?: PageView;
  message?: string;
  readValue?: string;
  /** 사이트가 오류로 표시한 필드 라벨 */
  missing?: { fieldId: string; label: string; error?: string }[];
  dismissedDialogs?: string[];
  requiredFieldsComplete?: boolean;
  atLastStep?: boolean;
  atFirstStep?: boolean;
  receipt?: string;
  /** 링크 이름이 여러 개 맞거나 못 찾았을 때 후보 */
  candidates?: string[];
  pending?: Action;
  focused?: boolean;
  effect?: Effect;
  revealed?: string;
}

const MAX_STEPS = 6;
export class WebExecutionAgent {
  readonly id = AGENT_IDS.web;
  private lastView?: PageView;
  private lastViewAt = 0;
  private actedSinceObserve = false;
  readonly churn = new Churn();
  clock = () => performance.now();
  readonly adapter: WebAdapter;
  readonly guard: PolicyGuard;
  readonly profile: SiteProfile;
  readonly actionLog?: { append(entry: WebAuditEntry): unknown };

  constructor(adapter: WebAdapter, guard: PolicyGuard, profile: SiteProfile, actionLog?: { append(entry: WebAuditEntry): unknown }) {
    this.adapter = adapter;
    this.guard = guard;
    this.profile = profile;
    this.actionLog = actionLog;
  }
  get currentView(): PageView | undefined { return this.lastView; }
  async showBrowser(): Promise<void> { await this.adapter.bringToFront?.(); }
  async clearLogin(currentOnly = true, signal?: AbortSignal): Promise<string[]> {
    return await this.adapter.clearSiteLogin?.({ currentOnly }, signal) ?? [];
  }
  accessMode(view = this.lastView): AccessTier { return this.guard.tierOf(view?.url); }
  async openSite(url: string, ctx: ExecContext): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const host = tryUrl(url)?.host ?? url;
    ctx.trace("PLANNING", this.id, "open " + host);
    const result = await this.run(this.action({ type: "navigate", url, reason: "사용자가 요청한 사이트 열기: " + host }), ctx, log);
    if (result?.ok !== true) return this.failed(log, result);
    ctx.trace("VERIFYING", this.id, "페이지 내용 확인");
    const view = await this.observeUntil(ctx, v => v.url !== "about:blank" && this.hasContent(v), 6000);
    return { status: "ok", actions: log, view: await this.settle(ctx, view) };
  }
  private locate(view: PageView, name: string, preferButton = false, linksOnly = false) {
    const all = (view.outline?.items ?? []).filter(item => !item.disabled);
    const term = normalizeTerm(name);
    const links = all.filter(item => item.role === "link" || (!linksOnly && item.role === "scriptlink"));
    const others = linksOnly ? [] : all.filter(item => !links.includes(item));
    for (const pool of preferButton ? [others, links] : [links, others]) {
      const exact = pool.filter(item => normalizeTerm(item.name) === term);
      const matches = exact.length > 0 ? exact : pool.filter(item => [...term].length >= 2 && normalizeTerm(item.name).includes(term));
      const hits = [...new Set(matches.map(item => item.name))];
      if (hits.length > 0) return { item: hits.length === 1 ? matches[0] : undefined, hits };
    }
    return { item: undefined, hits: [] };
  }

  private notLocated(view: PageView, name: string, hits: string[]): WebOutcome {
    const message = hits.length === 0 ? `'${name}' 링크를 이 화면에서 찾지 못했습니다.` : `'${name}'에 맞는 링크가 ${hits.length}개입니다.`;
    return { status: "needs-clarification", actions: [], view, message, candidates: hits.slice(0, 5) };
  }

  async followLink(name: string, ctx: ExecContext, linksOnly = false): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const view = await this.observe(ctx);
    const { item, hits } = this.locate(view, name, false, linksOnly);
    if (item === undefined) return this.notLocated(view, name, hits);
    const target = { ref: item.ref, role: item.role, name: item.name };
    const result = await this.run(this.action({ type: "click", target, reason: `'${item.name}' 누르기(${item.role})` }), ctx, log);
    if (result?.ok !== true) return this.failed(log, result, view);
    ctx.trace("VERIFYING", this.id, "화면 변화 확인");
    return this.afterClick(view, item, ctx, log, false);
  }

  async pointAt(name: string, ctx: ExecContext, preferButton = false): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const view = await this.observe(ctx);
    const { item, hits } = this.locate(view, name, preferButton);
    if (item === undefined) return this.notLocated(view, name, hits);
    const target = { ref: item.ref, role: item.role, name: item.name };
    const result = await this.run(this.action({ type: "focus", target, reason: `'${item.name}'(으)로 이동` }), ctx, log);
    const pending = this.action({ type: "click", target: { ...target }, reason: `사용자 확인 후 '${item.name}' 누르기` });
    return { status: "needs-approval", actions: log, view, pending, focused: result?.ok === true };
  }

  async focusField(field: { fieldId?: string; label?: string }, ctx: ExecContext, log: WebAction[] = []): Promise<WebOutcome> {
    if (field.fieldId === undefined || field.fieldId.length === 0) return { status: "failed", actions: log, view: this.lastView };
    const target = field.label === undefined || field.label.length === 0 ? { fieldId: field.fieldId } : { fieldId: field.fieldId, label: field.label };
    const result = await this.run(this.action({ type: "focus", target, reason: `'${target.label ?? field.fieldId}' 칸으로 이동` }), ctx, log);
    return { status: result?.ok === true ? "ok" : "failed", actions: log, view: this.lastView, focused: result?.ok === true };
  }

  async clickApproved(action: Action, ctx: ExecContext): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const view = await this.observe(ctx);
    const target = action.target ?? {};
    const item = view.outline?.items?.find(candidate => candidate.ref === target.ref) ?? target;
    const result = await this.run(action, ctx, log);
    if (result?.ok !== true && result?.errorCode !== "TIMEOUT") return this.failed(log, result, view);
    ctx.trace("VERIFYING", this.id, "누른 뒤 화면 확인");
    return this.afterClick(view, item, ctx, log, result.errorCode === "TIMEOUT");
  }

  private async afterClick(before: PageView, item: ActionTarget & { expanded?: boolean }, ctx: ExecContext, log: WebAction[], timedOut: boolean): Promise<WebOutcome> {
    const quick = item.role === "tab" || item.expanded !== undefined;
    let after = await this.observeUntil(ctx, v => {
      const [effect] = diffViews(before, v, item.ref);
      return effect === "moved" ? this.hasContent(v) : openedDialog(before, v) || itemChanged(before, v, item.ref);
    }, quick ? 1500 : 6000);
    const volatile = this.churn.volatile();
    let [effect, revealed] = diffViews(before, after, item.ref, volatile);
    if (effect === "changed") {
      const deadline = performance.now() + 3000;
      let same = 0, failures = 0;
      while (performance.now() < deadline && !ctx.signal.aborted && failures < 3) {
        await delay(300, undefined, { signal: ctx.signal });
        let next: PageView;
        try { next = await this.observe(ctx, true); }
        catch (error) { if (ctx.signal.aborted) throw error; failures++; continue; }
        failures = 0;
        const [newEffect, newText] = diffViews(before, next, item.ref, volatile);
        same = revealed === newText ? same + 1 : 0;
        after = next;
        effect = newEffect;
        revealed = newText;
        if (effect === "moved" || (same >= (revealed.length > 0 ? 1 : 2) && !looksLoading(revealed))) break;
      }
    }
    if (timedOut && effect === "none") return { status: "unconfirmed", actions: log, view: after, message: unconfirmedMessage("눌렸는지") };
    if (effect === "moved") after = await this.settle(ctx, after);
    return { status: "ok", actions: log, view: after, readValue: item.name, effect, revealed: revealed.length > 0 ? revealed : undefined };
  }
  async back(ctx: ExecContext): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const view = await this.observe(ctx);
    const r = await this.run(this.action({ type: 'back', reason: '이전 페이지로 돌아가기' }), ctx, log);
    if (r?.ok !== true) return this.failed(log, r, view);
    if (!r.verified) return { status: 'failed', actions: log, view, message: '더 돌아갈 이전 페이지가 없습니다.' };
    return { status: 'ok', actions: log, view: await this.observeUntil(ctx, (v) => v.url !== view.url && this.hasContent(v), 6000) };
  }

  /** 화면의 검색창에 검색어를 넣고 Enter. 검색창이 아닌 입력란에는 쓰지 않는다. */
  async search(query: string, ctx: ExecContext): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const view = await this.observe(ctx);
    const box = view.fields.find((f) => f.visible && f.searchable === true);
    if (!box) return { status: 'failed', actions: log, view, message: '이 화면에서 검색창을 찾지 못했습니다.' };
    const target = { fieldId: box.fieldId, role: 'searchbox' };
    let r = await this.run(this.action({ type: 'fill', target, value: query, reason: `검색어 입력: ${query}` }), ctx, log);
    if (r?.ok !== true) return this.failed(log, r, view);
    r = await this.run(this.action({ type: 'press', target, value: 'Enter', reason: '검색 실행' }), ctx, log);
    if (r?.ok !== true) return this.failed(log, r, view);
    ctx.trace('VERIFYING', this.id, '검색 결과 확인');
    const after = await this.observeUntil(ctx, (v) => (v.url !== view.url || v.title !== view.title) && this.hasContent(v), 6000);
    return { status: 'ok', actions: log, view: await this.settle(ctx, after, 8000) };
  }

  /**
   * 입력 도우미(실제 사이트): 사용자가 말한 칸 이름으로 화면의 입력란을 찾는다.
   * 사이트 전용 설정이 없으니 레이블·placeholder로 느슨하게 맞추고, 비밀 칸은 후보에서 뺀다.
   */
  assistCandidates(mention: string, view: PageView | undefined = this.lastView) {
    const synonyms: Record<string, string[]> = {
      이름: ['성명', '이름', '신청인'],
      주소: ['주소', '거주지', '도로명'],
      연락처: ['연락처', '전화', '휴대폰', '휴대전화', '핸드폰'],
      이메일: ['이메일', '전자우편', 'email'],
      생년월일: ['생년월일', '생일'],
    };
    const m = normalizeTerm(mention);
    const keys = [m, ...Object.entries(synonyms).filter(([k, v]) => normalizeTerm(k) === m || v.some((x) => normalizeTerm(x) === m)).flatMap(([, v]) => v.map(normalizeTerm))];
    const secret = webAgentPatterns.assistSecret;
    return (view?.fields ?? []).filter(
      (f) => f.visible && !f.sensitive && f.searchable !== true && !secret.test(f.label) && keys.some((k) => [...k].length >= 2 && normalizeTerm(f.label).includes(k)),
    );
  }

  /** 승인 전용 입력 액션(sensitive + 확인 필요). PolicyGuard가 승인 없이는 실행하지 않는다. */
  buildAssistAction(field: { fieldId: string; label: string; type: string }, value: string): Action {
    const target = { fieldId: field.fieldId, name: field.label };
    const base = { id: randomUUID(), target, reason: `실제 사이트 '${field.label}' 칸 입력(사용자 확인 후)`, risk: 'sensitive' as const, requiresConfirmation: true };
    if (field.type === 'checkbox') return { ...base, type: 'check', checked: webAgentPatterns.checked.test(value) };
    if (field.type === 'select') return { ...base, type: 'select', value };
    return { ...base, type: 'fill', value };
  }

  async assistFill(actions: Action[], ctx: ExecContext): Promise<WebOutcome> {
    const log: WebAction[] = [];
    await this.observe(ctx);
    for (const action of actions) {
      const r = await this.run(action, ctx, log);
      if (r?.errorCode === "TIMEOUT") {
        const seen = await this.observe(ctx);
        if (action.type === "fill" && this.observedField(action.target?.fieldId ?? "", seen)?.value === action.value) continue;
        return { status: "unconfirmed", actions: log, view: seen, message: unconfirmedMessage(`'${action.target?.name}' 칸에 들어갔는지`) };
      }
      if (r?.ok !== true) return this.failed(log, r, this.lastView);
    }
    ctx.trace('VERIFYING', this.id, '입력값 재확인');
    const view = await this.observe(ctx);
    const mismatch = actions.find((a) => a.type === 'fill' && view.fields.find((f) => f.fieldId === a.target?.fieldId)?.value !== a.value);
    if (mismatch) return { status: 'failed', actions: log, view, message: `'${mismatch.target?.name}' 칸의 값이 요청과 달라 확인이 필요해요.` };
    return { status: 'ok', actions: log, view };
  }

  /** Agent B가 넘긴 주소가 허용 목록(PolicyGuard)에 있는지. */
  isApprovedUrl(url: string): boolean {
    return this.guard.isAllowedUrl(url);
  }

  field(fieldId: string): FieldProfile | undefined {
    return this.profile.fields.find((f) => f.fieldId === fieldId);
  }

  async close(): Promise<void> {
    await this.adapter.close();
  }

  async observe(ctx?: ExecContext, poll = false): Promise<PageView> {
    ctx?.signal.throwIfAborted();
    ctx?.trace("OBSERVING", this.id);
    const obs = await this.adapter.observe(ctx?.signal);
    ctx?.signal.throwIfAborted();
    const view: PageView = { ...obs, pageId: this.profile.classify(obs.url) };
    const now = this.clock();
    this.churn.observe(view, !poll && !this.actedSinceObserve && now - this.lastViewAt >= 1000 ? this.lastView : undefined);
    this.lastView = view;
    this.lastViewAt = now;
    this.actedSinceObserve = false;
    return view;
  }
  private async observeUntil(ctx: ExecContext, done: (v: PageView) => boolean, timeoutMs = 5000): Promise<PageView> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      try {
        const view = await this.observe(ctx, true);
        if (done(view) || performance.now() > deadline) return view;
      } catch (error) { if (ctx.signal.aborted || performance.now() > deadline) throw error; }
      await delay(100, undefined, { signal: ctx.signal });
    }
  }

  private async settle(ctx: ExecContext, view: PageView, maxMs = 6000): Promise<PageView> {
    const deadline = performance.now() + maxMs;
    let prev = view, failures = 0;
    while (performance.now() < deadline && !ctx.signal.aborted && failures < 3) {
      await delay(700, undefined, { signal: ctx.signal });
      let next: PageView;
      try { next = await this.observe(ctx, true); }
      catch (error) { if (ctx.signal.aborted) throw error; failures++; continue; }
      failures = 0;
      const same = (next.outline?.mainText ?? '') === (prev.outline?.mainText ?? '') && next.url === prev.url;
      prev = next;
      if (same) break;
    }
    return prev;
  }
  /** 화면에 내용이 그려졌는지(SPA는 주소가 먼저 바뀌고 내용이 나중에 채워진다). */
  private hasContent(v: PageView): boolean {
    return (v.outline?.linkCount ?? 0) + (v.outline?.buttons.length ?? 0) + v.fields.length > 0 || (v.outline?.mainText?.length ?? 0) > 0;
  }

  private action(partial: Omit<Action, 'id' | 'risk' | 'requiresConfirmation'> & Partial<Action>): Action {
    return { id: randomUUID(), risk: 'low', requiresConfirmation: false, ...partial };
  }

  /** PolicyGuard 검사 후에만 어댑터를 호출한다. TIMEOUT만 제한적으로 재시도. */
  async run(action: Action, ctx: ExecContext, log: WebAction[]): Promise<WebActionResult | undefined> {
    ctx.trace('POLICY_CHECK', this.id, action.type);
    const policy = this.guard.check(action, {
      currentUrl: this.lastView?.url,
      stopped: ctx.isStopped() || ctx.signal.aborted,
      approvals: ctx.approvals,
      actionsThisTurn: ctx.counter.actions,
    });
    const entry: WebAction = { agent: this.id, action, policy };
    log.push(entry);
    if (!policy.allowed) return undefined;
    const writeLog = (phase: "before" | "after", ok?: boolean) => this.actionLog?.append({
      host: tryUrl(this.lastView?.url)?.hostname ?? "", pageKind: this.lastView?.pageId ?? "",
      actionType: action.type, label: actionLabel(action), approvalId: action.requiresConfirmation ? action.id : undefined,
      phase, ...(ok === undefined ? {} : { ok }),
    });
    try { await writeLog("before"); }
    catch {
      if (action.requiresConfirmation || policy.code === "APPROVED") {
        entry.result = { ok: false, errorCode: "LOG_FAILED", latencyMs: 0 };
        return entry.result;
      }
    }
    ctx.counter.actions++;
    this.actedSinceObserve = true;
    ctx.trace('EXECUTING', this.id, action.type);
    if (ctx.signal.aborted) {
      entry.result = { actionId: action.id, ok: false, verified: false, errorCode: "ABORTED", latencyMs: 0 };
      return entry.result;
    }
    let result = await this.adapter.execute(action, ctx.signal);
    if (action.risk === "low" && policy.code !== "APPROVED" && !result.ok && result.errorCode === "TIMEOUT" && !ctx.signal.aborted) {
      result = await this.adapter.execute(action, ctx.signal);
    }
    entry.result = result;
    try { await writeLog("after", result.ok); } catch { /* 조작이 끝난 뒤에는 재실행하지 않는다. */ }
    return result;
  }

  private failed(log: WebAction[], result: WebActionResult | undefined, view?: PageView): WebOutcome {
    const last = log[log.length - 1];
    if (result === undefined && last?.policy.code === "NEEDS_CONFIRMATION") {
      return { status: "needs-approval", actions: log, view, message: last.policy.reason, pending: last.action };
    }
    if (!result) return { status: 'policy-denied', actions: log, view, message: last?.policy.reason };
    if (result.errorCode === 'ABORTED') return { status: 'aborted', actions: log, view, message: '중단되었습니다.' };
    const messages: Record<string, string> = {
      TARGET_NOT_FOUND: '화면에서 조작할 대상을 찾지 못했습니다.',
      AMBIGUOUS_TARGET: '같은 이름의 대상이 여러 개라서 실행하지 않았습니다.',
      VERIFY_FAILED: '누르려던 대상이 그사이 화면에서 바뀌어 누르지 않았습니다.',
      LOG_FAILED: '조작 기록을 남기지 못해 승인된 조작을 실행하지 않았습니다.',
      RESUBMIT_BLOCKED: '이전 화면은 양식을 보낸 결과 화면이라, 같은 내용을 다시 보내지 않도록 돌아가지 않았습니다.',
      TIMEOUT: '화면이 제때 응답하지 않았습니다.',
      NAVIGATION_FAILED: '페이지를 열지 못했습니다. 인터넷 연결이나 사이트 상태를 확인해 주세요.',
    };
    return { status: 'failed', actions: log, view, message: messages[result.errorCode ?? ''] ?? '조작에 실패했습니다.' };
  }

  /** 세션 준비: 빈 창 대신 모의 사이트 첫 화면을 띄워 둔다. */
  async openHome(ctx: ExecContext): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const r = await this.run(this.action({ type: 'navigate', url: this.profile.urls.home, reason: '모의 복지 사이트 첫 화면 표시' }), ctx, log);
    if (r?.ok !== true) return this.failed(log, r);
    return { status: 'ok', actions: log, view: await this.observe(ctx) };
  }

  async openApplication(ctx: ExecContext): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const before = await this.observe(ctx).catch(() => undefined);
    if (before?.pageId === 'mock-welfare' && before.step !== undefined && (before.status?.length ?? 0) === 0) {
      return { status: 'ok', actions: log, view: before };
    }
    ctx.trace('PLANNING', this.id, 'home → 신청 링크');
    let r = await this.run(
      this.action({ type: 'navigate', url: this.profile.urls.home, reason: '모의 복지 사이트 첫 화면으로 이동' }),
      ctx,
      log,
    );
    if (r?.ok !== true) return this.failed(log, r);
    await this.observeUntil(ctx, (v) => v.pageId === 'mock-home');
    r = await this.run(
      this.action({
        type: 'click',
        target: { role: 'link', name: this.profile.links.application },
        reason: '장애인연금 모의 신청 링크 클릭',
      }),
      ctx,
      log,
    );
    if (r?.ok !== true) return this.failed(log, r);
    ctx.trace('VERIFYING', this.id, '신청서 1단계 확인');
    const view = await this.observeUntil(ctx, (v) => v.pageId === 'mock-welfare' && v.step !== undefined);
    if (view.pageId !== 'mock-welfare' || !view.step) {
      return { status: 'failed', actions: log, view, message: '신청서 화면을 확인하지 못했습니다.' };
    }
    return { status: 'ok', actions: log, view };
  }

  async openLogin(ctx: ExecContext): Promise<WebOutcome> {
    const log: WebAction[] = [];
    ctx.trace('PLANNING', this.id, '모의 본인인증 화면');
    const r = await this.run(
      this.action({ type: 'navigate', url: this.profile.urls.login, reason: '가상 본인인증 화면 열기(입력은 사용자가 직접)' }),
      ctx,
      log,
    );
    if (r?.ok !== true) return this.failed(log, r);
    ctx.trace('VERIFYING', this.id);
    const view = await this.observeUntil(ctx, (v) => v.pageId === 'mock-login');
    return { status: view.pageId === 'mock-login' ? 'ok' : 'failed', actions: log, view };
  }

  /** 사용자가 말한 필드 이름을 화면 기준으로 해석. 둘 이상이면 실행하지 않고 되묻는다. */
  resolveField(mention: string, view: PageView | undefined = this.lastView): FieldResolution {
    const m = normalizeTerm(mention);
    const fields = this.profile.fields.filter((f) => f.sensitivity !== 'secret');
    const isVisible = (f: FieldProfile) => !!view?.fields.find((o) => o.fieldId === f.fieldId && o.visible);
    const specific = fields.filter((f) => f.aliases.some((a) => normalizeTerm(a) === m) || normalizeTerm(f.label) === m);
    if (specific.length === 1) return isVisible(specific[0]!) ? { kind: 'ok', field: specific[0]! } : { kind: 'not-visible', field: specific[0]! };
    const generic = fields.filter((f) => f.genericAliases.some((a) => normalizeTerm(a) === m));
    const visible = generic.filter(isVisible);
    if (visible.length === 1) return { kind: 'ok', field: visible[0]! };
    if (visible.length > 1) return { kind: 'ambiguous', candidates: visible };
    if (generic.length > 0) return { kind: 'not-visible', field: generic[0]! };
    return { kind: 'not-found' };
  }

  /** 되묻기 응답("실거주지 쪽")으로 후보 중 하나를 고른다. */
  pickCandidate(reply: string, candidates: FieldProfile[]): FieldProfile | undefined {
    const r = normalizeTerm(reply);
    const hits = candidates.filter((c) => [c.label, ...c.aliases].some((a) => r.includes(normalizeTerm(a))));
    return hits.length === 1 ? hits[0] : undefined;
  }

  observedField(fieldId: string, view: PageView | undefined = this.lastView) {
    return view?.fields.find((f) => f.fieldId === fieldId);
  }

  async fill(field: FieldProfile, rawValue: string, ctx: ExecContext): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const view = await this.observe(ctx);
    if (view.pageId !== 'mock-welfare') return { status: 'failed', actions: log, view, message: '신청서가 열려 있지 않습니다.' };
    const observed = this.observedField(field.fieldId, view);
    if (observed?.visible !== true) {
      return { status: 'needs-clarification', actions: log, view, message: `${speakLabel(field.label)} 항목은 지금 화면에 없습니다.` };
    }
    ctx.trace('PLANNING', this.id, `fill ${field.fieldId}`);
    const validation = field.validate ? field.validate(rawValue) : { ok: true as const, value: strip(rawValue) };
    if (!validation.ok) return { status: 'needs-clarification', actions: log, view, message: validation.message };

    const value = validation.value;
    const target = { label: field.label, fieldId: field.fieldId };
    const reason = `사용자가 요청한 ${speakLabel(field.label)} 입력`;
    const action =
      field.kind === 'checkbox'
        ? this.action({ type: 'check', target, checked: value === '예', reason })
        : field.kind === 'select'
          ? this.action({ type: 'select', target, value, reason })
          : this.action({ type: 'fill', target, value, reason });
    const r = await this.run(action, ctx, log);
    if (r?.ok !== true) return this.failed(log, r, view);

    ctx.trace('VERIFYING', this.id, `${field.fieldId} 값 재확인`);
    const after = await this.observe(ctx);
    const now = this.observedField(field.fieldId, after);
    const matches = !!now && now.value === value && r.verified;
    if (!matches) {
      return { status: 'failed', actions: log, view: after, message: '입력 후 화면의 값이 요청과 달라 확인이 필요합니다.' };
    }
    return { status: 'ok', actions: log, view: after, readValue: now.value };
  }

  async read(field: FieldProfile, ctx: ExecContext): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const view = await this.observe(ctx);
    const observed = this.observedField(field.fieldId, view);
    if (!observed) return { status: 'failed', actions: log, view, message: '해당 항목을 화면에서 찾지 못했습니다.' };
    if (!observed.visible) {
      // 다른 단계에 있는 필드는 DOM 관찰값으로 읽는다(조작 없음).
      return { status: 'ok', actions: log, view, readValue: observed.value };
    }
    const r = await this.run(
      this.action({ type: 'read', target: { label: field.label, fieldId: field.fieldId }, reason: `${speakLabel(field.label)} 값 다시 읽기` }),
      ctx,
      log,
    );
    if (r?.ok !== true) return this.failed(log, r, view);
    return { status: 'ok', actions: log, view, readValue: r.readValue ?? observed.value };
  }

  /** 정보성 팝업(버튼이 '닫기' 하나뿐)만 닫는다. 그 외 팝업은 사용자에게 묻는다. */
  private async handleDialogs(view: PageView, ctx: ExecContext, log: WebAction[]): Promise<{ view: PageView; dismissed: string[]; blocked?: string }> {
    const dismissed: string[] = [];
    let current = view;
    for (let i = 0; i < 3 && current.dialogs.length > 0; i++) {
      const d = current.dialogs[0]!;
      const closable = d.buttons.length === 1 && this.profile.buttons.dismissDialog.includes(d.buttons[0]!);
      if (!closable) return { view: current, dismissed, blocked: d.title.length > 0 ? d.title : '알 수 없는 팝업' };
      const r = await this.run(
        this.action({ type: 'click', target: { role: 'button', name: d.buttons[0] }, reason: `안내 팝업 '${d.title}' 닫기` }),
        ctx,
        log,
      );
      if (r?.ok !== true) return { view: current, dismissed, blocked: d.title };
      dismissed.push(d.title);
      current = await this.observe(ctx);
    }
    return { view: current, dismissed };
  }

  async next(ctx: ExecContext): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const before = await this.observe(ctx);
    if (before.pageId !== 'mock-welfare' || !before.step) return { status: 'failed', actions: log, view: before, message: '신청서가 열려 있지 않습니다.' };
    if (before.step.index >= before.step.total) return { status: 'ok', actions: log, view: before, atLastStep: true };

    ctx.trace('PLANNING', this.id, 'click 다음');
    const r = await this.run(
      this.action({ type: 'click', target: { role: 'button', name: this.profile.buttons.next }, reason: '다음 단계로 이동' }),
      ctx,
      log,
    );
    if (r?.ok !== true) return this.failed(log, r, before);

    ctx.trace('VERIFYING', this.id, '단계 이동·오류 확인');
    let after = await this.observe(ctx);
    if (after.errors.length > 0 || after.step?.index === before.step.index) {
      const missing = after.fields
        .filter((f) => f.visible && f.invalid)
        .map((f) => ({ fieldId: f.fieldId, label: speakLabel(f.label), error: f.error }));
      return { status: 'validation-error', actions: log, view: after, missing };
    }
    const dialogs = await this.handleDialogs(after, ctx, log);
    after = dialogs.view;
    const requiredFieldsComplete = before.fields.filter((f) => f.required && f.visible).every((f) => f.filled);
    if (dialogs.blocked !== undefined && dialogs.blocked.length > 0) {
      return {
        status: 'needs-clarification',
        actions: log,
        view: after,
        message: `예상하지 못한 팝업('${dialogs.blocked}')이 있어 진행을 멈췄습니다.`,
        dismissedDialogs: dialogs.dismissed,
      };
    }
    return { status: 'ok', actions: log, view: after, dismissedDialogs: dialogs.dismissed, requiredFieldsComplete };
  }

  async prev(ctx: ExecContext): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const before = await this.observe(ctx);
    if (before.pageId !== 'mock-welfare' || !before.step) return { status: 'failed', actions: log, view: before, message: '신청서가 열려 있지 않습니다.' };
    if (before.step.index <= 1) return { status: 'ok', actions: log, view: before, atFirstStep: true };
    const r = await this.run(
      this.action({ type: 'click', target: { role: 'button', name: this.profile.buttons.prev }, reason: '이전 단계로 이동' }),
      ctx,
      log,
    );
    if (r?.ok !== true) return this.failed(log, r, before);
    ctx.trace('VERIFYING', this.id);
    const after = await this.observe(ctx);
    return { status: after.step && after.step.index < before.step.index ? 'ok' : 'failed', actions: log, view: after };
  }

  /** 검토(마지막) 단계까지 '다음'을 눌러 이동. 중간 검증 오류가 있으면 멈춘다. */
  async goToFinalStep(ctx: ExecContext): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const dismissed: string[] = [];
    for (let i = 0; i < MAX_STEPS; i++) {
      const out = await this.next(ctx);
      log.push(...out.actions);
      dismissed.push(...(out.dismissedDialogs ?? []));
      if (out.status !== 'ok') return { ...out, actions: log, dismissedDialogs: dismissed };
      if (out.atLastStep === true) return { ...out, actions: log, dismissedDialogs: dismissed };
    }
    return { status: 'failed', actions: log, message: '검토 단계에 도달하지 못했습니다.' };
  }

  /** 모의접수 클릭 액션. consequential이므로 승인 없이는 PolicyGuard가 막는다. */
  buildSubmitAction(): Action {
    return {
      id: randomUUID(),
      type: 'click',
      target: { role: 'button', name: this.profile.buttons.submit },
      reason: '사용자 승인 후 모의접수 버튼 클릭(실제 제출 아님)',
      risk: 'consequential',
      requiresConfirmation: true,
    };
  }

  /** 승인 없이 정책 판단만 미리 기록(실행하지 않음). */
  previewPolicy(action: Action, ctx: ExecContext): ExecutedAction {
    ctx.trace('POLICY_CHECK', this.id, `${action.type} (승인 전 사전 확인)`);
    const policy = this.guard.check(action, {
      currentUrl: this.lastView?.url,
      stopped: ctx.isStopped(),
      approvals: ctx.approvals,
      actionsThisTurn: ctx.counter.actions,
    });
    return { agent: this.id, action, policy };
  }

  async submitApproved(action: Action, ctx: ExecContext): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const before = await this.observe(ctx);
    if (before.pageId !== 'mock-welfare' || !before.step || before.step.index !== before.step.total) {
      return { status: 'failed', actions: log, view: before, message: '검토 단계가 아니어서 모의접수를 실행하지 않았습니다.' };
    }
    const r = await this.run(action, ctx, log);
    if (r?.ok !== true && r?.errorCode !== "TIMEOUT") return this.failed(log, r, before);
    ctx.trace('VERIFYING', this.id, '모의 접수번호 확인');
    const after = await this.observeUntil(ctx, (v) => v.status !== undefined && this.profile.receiptPattern.test(v.status), 3000);
    const receipt = after.status?.match(this.profile.receiptPattern)?.[1];
    if (receipt === undefined && r.errorCode === "TIMEOUT") return { status: "unconfirmed", actions: log, view: after, message: unconfirmedMessage("접수됐는지") };
    if (receipt === undefined) return { status: 'failed', actions: log, view: after, message: '모의 접수번호를 확인하지 못했습니다.' };
    return { status: 'ok', actions: log, view: after, receipt };
  }
}
