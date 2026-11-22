import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Action, ActionResult, ActionTarget, ExecuteGrants, ExecutionErrorCode, NativeSeen, NoticeFacts, NoticeProof, Observation,
} from "../../core/actions.ts";
import type { Redacted } from "../../core/llm.ts";
import { pickControl, type ControlPicker } from "./control_picker.ts";
import { AGENT_IDS, PIPELINE_PHASES, type DraftAction, type ExecutedAction } from "../../core/turn.ts";
import { strip } from "../../core/text.ts";
import { tryUrl } from "../../core/url.ts";
import { PolicyGuard, isNotice, type AccessTier, type InspectionBinding, type InspectionControl, type PolicyContext } from "../../safety/guard.ts";
import { AdapterError } from "./browser/index.ts";
import { redactText } from "../../safety/privacy.ts";
import { speakLabel } from "../../speech/phrasing.ts";
import type { Picture } from "../../core/picture.ts";
import { normalizeTerm, type FieldProfile, type PageId, type SiteProfile } from "./profile.ts";
import {
  Churn, NOT_READY, diffViews, hasContent, itemChanged, looksLoading, openedDialog, stillBuilding, unconfirmedMessage, type Effect,
} from "./effect.ts";
import { REFUSAL_SPEECH, ShotRefusal, planShot, type ShotPlan } from "./shot.ts";
import { nativeSpeech, noticeKey, noticeSaid, popupQuestion, revealedExcept, type NativeQuestion, type NoticeSaid, type PopupQuestion } from "./notice.ts";

interface ContextOptions {
  signal: AbortSignal;
  approvals?: Set<string>;
  isStopped(): boolean;
  trace(phase: typeof PIPELINE_PHASES[number], agent: string, note?: string): void;
  counter?: { actions: number };
  actor?: string;
  sessionId?: string;
  taskId?: string;
  publicLookup?: boolean;
  browsingScope?: "personal-inspection";
  actionLimit?: number;
  approvedGoalRefs?: ReadonlySet<string>;
}
export class ExecContext {
  readonly signal: AbortSignal;
  readonly approvals: Set<string>;
  readonly isStopped: ContextOptions["isStopped"];
  readonly trace: ContextOptions["trace"];
  readonly counter: { actions: number };
  readonly actor: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly publicLookup: boolean;
  readonly browsingScope?: "personal-inspection";
  readonly actionLimit?: number;
  readonly approvedGoalRefs?: ReadonlySet<string>;

  constructor({
    signal, approvals = new Set(), isStopped, trace, counter = { actions: 0 }, actor = "resident", sessionId = "", taskId = "",
    publicLookup = false, browsingScope, actionLimit, approvedGoalRefs,
  }: ContextOptions) {
    this.signal = signal;
    this.approvals = approvals;
    this.isStopped = isStopped;
    this.trace = trace;
    this.counter = counter;
    this.actor = actor;
    this.sessionId = sessionId;
    this.taskId = taskId;
    this.publicLookup = publicLookup;
    this.browsingScope = browsingScope;
    this.actionLimit = actionLimit;
    this.approvedGoalRefs = approvedGoalRefs;
  }
  async granted<T>(ids: readonly string[], work: () => Promise<T>): Promise<T> {
    const added = ids.filter(id => !this.approvals.has(id));
    for (const id of added) this.approvals.add(id);
    try { return await work(); }
    finally { for (const id of added) this.approvals.delete(id); }
  }
}

export type PageView = Observation & { pageId: PageId };
/** 현재 문서에서 실제로 보이는 조작 대상 몇 개(브라우저 어댑터의 controlWindow). */
export interface ControlWindow {
  url: string;
  items: Array<{
    ref: string; role: string; name: string; region: string; disabled: boolean;
    context?: string; pictureMasked?: boolean; inspection?: InspectionControl; notice?: NoticeFacts;
  }>;
  more: boolean;
}
export interface WebAdapter {
  observe(signal?: AbortSignal): Promise<Observation>;
  /** grants: 이 조작 한 번에만 붙는 허가(안내 팝업 증명·confirm() 답). 어댑터는 정책 검사와 따로 새 관찰·자기 기록으로 다시 확인한다. */
  execute(action: Action, signal?: AbortSignal, inspection?: InspectionBinding, grants?: ExecuteGrants): Promise<ActionResult>;
  close(): Promise<void>;
  readonly page?: { url(): string; isClosed?(): boolean };
  bringToFront?(): Promise<void>;
  takeDownloadNotice?(): string | undefined;
  clearSiteLogin?(options: { currentOnly: boolean }, signal?: AbortSignal): Promise<string[]>;
  controlWindow?(text?: string, offset?: number, options?: {
    ref?: string; refs?: readonly string[]; exact?: boolean; inspection?: boolean; destination?: string; notice?: boolean;
  }): Promise<ControlWindow>;
  /** 이 조작 중에 취소하거나 받아 준 사이트의 confirm() 창(한 번만 가져간다). */
  takeNative?(actionId: string): NativeSeen | undefined;
  peekNative?(actionId: string): NativeSeen | undefined;
  /** 대신 답할 수 있는 confirm() 기록을 모두 버린다. */
  dropNative?(): void;
  inspectionSearch?(fieldId: string): Promise<{ url: string; destination: string; parameter: string; signature: string } | undefined>;
  withInspection?<T>(work: () => Promise<T>): Promise<T>;
  fullPageLayout?<T>(work: () => Promise<T>): Promise<T>;
  prepareFullPage?(url: string, signal: AbortSignal): Promise<ShotRefusal | undefined>;
  capture?(plan: ShotPlan, mainText: string): Promise<Picture | ShotRefusal>;
}
/** 조작 기록 한 줄. 막힌 조작은 phase "refused"와 누가(actor), 왜(reasonCode)만 적는다. */
export interface WebAuditEntry {
  host?: string; pageKind?: string; actionType?: string; label?: Redacted;
  approvalId?: string | null; phase?: "before" | "after" | "refused"; ok?: boolean | null;
  actor?: string; reasonCode?: string;
}
export type WebActionResult = ActionResult | { actionId: string; ok: false; verified: false; errorCode: "LOG_FAILED"; latencyMs: 0 };
export type WebAction = DraftAction;
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
  /** back: 양식을 다시 보내지 않으려고 돌아가지 않은 이전 화면의 주소 */
  resubmitUrl?: string;
  /** 묻지 않고 닫은 안내 팝업이 말한 내용(아직 말하지 않은 것만). 부르는 쪽이 사용자에게 한 번 알린다. */
  notices?: NoticeSaid[];
  question?: PopupQuestion;
  manual?: NativeQuestion[];
  /** 누르는 동안 사이트가 confirm() 창으로 물어서 청음이 취소했다. 이때 status는 needs-approval이고 pending은 누른 조작이다. */
  native?: NativeQuestion;
}

// 한 번에 묻지 않고 닫는 안내 팝업의 수(끝없이 새 팝업을 띄우는 화면에 붙들리지 않게)
const MAX_NOTICES = 3;
const NOTICE_SAID_KEEP = 50;

const MAX_STEPS = 6;
// 화면이 채워지기를 기다리는 한도: 연 화면, 검색 결과(틀이 뜬 뒤 결과를 따로 받아 온다. 복지로는 10초쯤), 읽어 달라고 한 화면
const SETTLE_MS = 6000;
const SEARCH_SETTLE_MS = 12_000;
const READY_WAIT_MS = 6000;
type PendingSearch = { url: string; mainText: string };
export class WebExecutionAgent {
  readonly id = AGENT_IDS.web;
  private lastView?: PageView;
  private pendingSearch?: PendingSearch;
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
  /**
   * 브라우저 화면이 마지막으로 읽은 화면과 다른 주소로 이미 바뀌었는지(관찰 없이, 바로).
   * 멈춤 답이 '화면이 바뀌었어요'를 말할지 정한다. 아직 응답을 기다리는 이동은 주소가 그대로라 바뀐 것이 아니다.
   */
  movedSinceLastView(): boolean {
    const page = this.adapter.page;
    const before = this.lastView?.url;
    return page !== undefined && before !== undefined && before !== "" && page.url() !== before;
  }
  async showBrowser(): Promise<void> { await this.adapter.bringToFront?.(); }
  async clearLogin(currentOnly = true, signal?: AbortSignal): Promise<string[]> {
    return await this.adapter.clearSiteLogin?.({ currentOnly }, signal) ?? [];
  }
  accessMode(view = this.lastView): AccessTier { return this.guard.tierOf(view?.url); }
  #inspectionPending?: { action: Action; sessionId: string; binding: InspectionBinding };
  /** 이미 말로 알린 안내 팝업(출처와 제목·글). 같은 안내가 다시 뜨면 닫기만 하고 다시 읽지 않는다. */
  readonly #noticeSaid = new Set<string>();
  /** 닫으려다 닫히지 않은 안내(팝업 서명). 같은 팝업을 단계마다 다시 눌러 보며 기다리지 않는다. */
  readonly #noticeStuck = new Set<string>();

  async openSite(url: string, ctx: ExecContext, { personalStart = false }: { personalStart?: boolean } = {}): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const host = tryUrl(url)?.host ?? url;
    ctx.trace("PLANNING", this.id, "open " + host);
    const binding: InspectionBinding | undefined = personalStart ? { kind: "start", url } : undefined;
    const result = await this.run(this.action({ type: "navigate", url, reason: "사용자가 요청한 사이트 열기: " + host }), ctx, log, undefined, binding);
    if (result?.ok !== true) return this.failed(log, result);
    ctx.trace("VERIFYING", this.id, "페이지 내용 확인");
    const view = await this.observeUntil(ctx, v => v.url !== "about:blank" && hasContent(v), 6000);
    return { status: "ok", actions: log, view: await this.settle(ctx, view) };
  }
  async withInspection<T>(ctx: ExecContext, work: () => Promise<T>): Promise<T> {
    return this.inspectionEnabled(ctx) && this.adapter.withInspection !== undefined ? this.adapter.withInspection(work) : work();
  }

  async followNavigationUrl(url: string, ctx: ExecContext): Promise<WebOutcome> {
    const view = await this.observe(ctx);
    const destination = URL.parse(url)?.href;
    if (destination !== undefined && this.inspectionEnabled(ctx)) {
      const window = await this.adapter.controlWindow?.("", 0, { destination, inspection: true });
      const [item] = window?.items ?? [];
      if (window?.url === view.url && window.items.length === 1 && !window.more && item?.inspection?.kind === "navigation") {
        return this.followLink(item.name, ctx, false, { matchedControl: { ...item, url: window.url } });
      }
    }
    return { status: "policy-denied", actions: [], view, message: "이 화면에서 확인한 이동 주소만 열 수 있어요." };
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

  /**
   * 누를 수 있는 요소를 이름(일부만 말해도 됨)으로 찾아 누른다: 링크 우선, 없으면 버튼·탭·메뉴 항목·역할 없는 클릭 요소.
   * 여러 개가 맞으면 누르지 않고 후보를 돌려준다. 누른 뒤에는 화면이 어떻게 바뀌었는지(effect)를 함께 돌려준다.
   * expected: 사진에서 고른 항목(주소, ref, role). matchedControl: 조작 대상 창에서 고른 항목.
   */
  async followLink(name: string, ctx: ExecContext, linksOnly = false, { expected, matchedControl, visual = false, picker }: {
    expected?: readonly [url: string, ref: string, role: string];
    matchedControl?: { ref: string; role: string; url: string; context?: string; requireUnmasked?: boolean };
    visual?: boolean;
    picker?: ControlPicker;
  } = {}): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const tab = this.adapter.page;
    const view = await this.observe(ctx);
    if (visual && (this.adapter.page !== tab || planShot(view) instanceof ShotRefusal)) {
      return {status: "failed", actions: log, view, message: "화면이 바뀌어 사진에서 확인한 메뉴를 누르지 않았어요."};
    }
    let item: { ref: string; role: string; name: string; expanded?: boolean } | undefined;
    if (matchedControl !== undefined) {
      const fresh = await this.adapter.controlWindow?.("", 0, { ref: matchedControl.ref });
      const requireUnmasked = visual || matchedControl.requireUnmasked === true;
      item = fresh?.items.find(it => !it.disabled && (!requireUnmasked || it.pictureMasked !== true) && it.ref === matchedControl.ref && it.name === name && it.role === matchedControl.role &&
        it.context === matchedControl.context);
      if (item === undefined || fresh?.url !== matchedControl.url || fresh.url !== view.url) {
        return { status: "needs-clarification", actions: log, view, message: "고른 항목이 바뀌었어요. 현재 화면에서 다시 찾아 주세요." };
      }
    } else if (expected !== undefined) {
      const matches = (view.outline?.items ?? []).filter(it => !it.disabled && (!visual || it.pictureMasked !== true) && it.name === name);
      const [only] = matches;
      if (matches.length !== 1 || only === undefined || view.url !== expected[0] || only.ref !== expected[1] || only.role !== expected[2]) {
        return { status: "needs-clarification", actions: log, view, message: "사진을 찍은 뒤 항목이 바뀌었어요. 화면 사진을 다시 요청해 주세요." };
      }
      item = only;
    } else {
      const located = this.locate(view, name, false, linksOnly);
      item = located.item;
      if (item === undefined && located.hits.length === 0 && strip(name).length > 0 && this.adapter.controlWindow !== undefined) {
        const window = await this.adapter.controlWindow(name, 0, { exact: true });
        const candidates = window.items.filter(it => !it.disabled && (!linksOnly || it.role === "link"));
        if (window.url === view.url && candidates.length === 1 && !window.more) item = candidates[0];
        if (picker && candidates.length === 0 && !window.more && window.url === view.url && !visual &&
          !ctx.publicLookup && this.guard.config.publicLookupOnly !== true && ctx.browsingScope === undefined && !ctx.isStopped()) {
          const picked = await pickControl(picker, view, name, linksOnly, this.adapter, ctx.signal);
          if (picked) return this.followLink(picked.name, ctx, linksOnly, { matchedControl: { ...picked, url: view.url, requireUnmasked: true } });
        }
      }
      if (item === undefined) return this.notLocated(view, name, located.hits);
    }
    if (visual && this.adapter.page !== tab) {
      return {status: "failed", actions: log, view, message: "탭이 바뀌어 사진에서 확인한 메뉴를 누르지 않았어요."};
    }
    if (ctx.approvedGoalRefs?.has(item.ref) === true) {
      return {status: "failed", actions: log, view, message: "이미 승인받아 누른 항목이에요. 지금 화면에서 다음 단계를 찾아 주세요."};
    }
    const target = { ref: item.ref, role: item.role, name: item.name };
    // 이름이 하나뿐인 안내 팝업의 닫기 단추는 새로 읽은 팝업 사실이 '안내'로 확인될 때만 묻지 않고 누른다(어댑터가 누르기 직전에 한 번 더 확인).
    const proof = this.sameNameCount(view, item.name) === 1 ? await this.noticeProof(view, item, ctx) : undefined;
    const click = this.action({ type: "click", target, reason: `'${item.name}' 누르기(${item.role})` });
    const result = await this.run(click, ctx, log, undefined, undefined, proof === undefined ? undefined : { notice: proof });
    if (proof !== undefined && result?.errorCode === "VERIFY_FAILED") {
      // 누르기 직전에 팝업이 바뀌어 증명이 맞지 않았다. 안내로 확인되지 않은 '확인'이니 증명 없이 누를 때와 같이 사용자에게 묻는다.
      const plain = this.action({ type: "click", target: { ...target }, reason: `'${item.name}' 누르기(${item.role})` });
      const policy = this.guard.check(plain, this.policyContext(ctx, ctx.isStopped() || ctx.signal.aborted));
      if (policy.code === "NEEDS_CONFIRMATION") {
        log.push({ agent: this.id, action: plain, policy });
        return this.failed(log, undefined, view);
      }
    }
    const timedOut = this.inspectionEnabled(ctx) && result?.errorCode === "TIMEOUT";
    // 누르는 동안 사이트가 confirm() 창으로 물었다면 결과가 어떻든 사용자에게 알린다(조용히 넘기지 않는다).
    const asked = result === undefined ? undefined : this.nativeOutcome(click, view, log, ctx, false, proof !== undefined);
    if (asked !== undefined) return asked;
    if (result?.ok !== true && !timedOut) return this.failed(log, result, view);
    ctx.trace("VERIFYING", this.id, "화면 변화 확인");
    const after = await this.afterClick(view, item, ctx, log, timedOut);
    return this.settleNotices(after, view, ctx, log, proof === undefined ? undefined : { proof, item });
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

  /**
   * 사용자가 확인한 누르기. grants.native가 있으면 사이트가 물었던 confirm() 질문에 사용자가 '진행'이라고 답한 뒤 같은 조작을 한 번 되풀이하는 것이다
   * (ctx.granted로 이 조작의 승인을 받은 때만 정책이 통과시키고, 어댑터는 자기 기록과 한 번 더 맞춰 본다).
   */
  async clickApproved(action: Action, ctx: ExecContext, grants?: ExecuteGrants): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const view = await this.observe(ctx);
    const target = action.target ?? {};
    const item = view.outline?.items?.find(candidate => candidate.ref === target.ref) ?? target;
    const result = await this.run(action, ctx, log, undefined, undefined, grants);
    // 누르는 동안 사이트가 confirm() 창으로 물었다면 결과가 어떻든 사용자에게 알린다(되풀이하는 중에 또 물어도 대신 답하지 않는다).
    const asked = result === undefined ? undefined : this.nativeOutcome(action, view, log, ctx, grants?.native !== undefined);
    if (asked !== undefined) return asked;
    if (grants?.native !== undefined && result?.errorCode === "VERIFY_FAILED") {
      return {status: "failed", actions: log, view, message: "앞서 확인한 사이트 질문에 답했는지 확인하지 못했어요. 화면에서 직접 확인해 주세요."};
    }
    if (grants?.native !== undefined && result?.errorCode === "TIMEOUT") {
      return {status: "unconfirmed", actions: log, view, message: "사이트가 제때 응답하지 않아 질문이 처리됐는지 확인하지 못했어요."};
    }
    if (result?.ok !== true && result?.errorCode !== "TIMEOUT") return this.failed(log, result, view);
    ctx.trace("VERIFYING", this.id, "누른 뒤 화면 확인");
    const after = await this.afterClick(view, item, ctx, log, result.errorCode === "TIMEOUT");
    return this.settleNotices(after, view, ctx, log);
  }

  private async afterClick(before: PageView, item: ActionTarget & { expanded?: boolean }, ctx: ExecContext, log: WebAction[], timedOut: boolean): Promise<WebOutcome> {
    const quick = item.role === "tab" || item.expanded !== undefined;
    let after = await this.observeUntil(ctx, v => {
      const [effect] = diffViews(before, v, item.ref);
      return effect === "moved" ? hasContent(v) : openedDialog(before, v) || itemChanged(before, v, item.ref);
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
  /** pastFormTo: 바로 뒤의 양식 결과 화면을 건너뛰어 그 앞의 이 주소로 돌아간다(양식은 다시 보내지 않는다). */
  async back(ctx: ExecContext, pastFormTo?: string): Promise<WebOutcome> {
    const log: WebAction[] = [];
    const view = await this.observe(ctx);
    const action = pastFormTo !== undefined && pastFormTo !== ""
      ? this.action({ type: "back", url: pastFormTo, reason: "양식 결과 화면을 건너뛰어 그 앞 화면으로 돌아가기" })
      : this.action({ type: "back", reason: "이전 페이지로 돌아가기" });
    const r = await this.run(action, ctx, log, undefined, { kind: "back", url: view.url });
    if (r?.errorCode === "RESUBMIT_BLOCKED") return { ...this.failed(log, r, view), resubmitUrl: r.message };
    if (r?.ok !== true) return this.failed(log, r, view);
    if (!r.verified) return { status: 'failed', actions: log, view, message: '더 돌아갈 이전 페이지가 없습니다.' };
    const after = await this.observeUntil(ctx, v => v.url !== view.url && hasContent(v), 6000);
    return { status: "ok", actions: log, view: await this.settle(ctx, after) };
  }

  /** 화면의 검색창에 검색어를 넣고 Enter. 검색창이 아닌 입력란에는 쓰지 않는다. */
  async search(query: string, ctx: ExecContext): Promise<WebOutcome> {
    this.pendingSearch = undefined;
    const log: WebAction[] = [];
    const view = await this.observe(ctx);
    const boxes = view.fields.filter((f) => f.visible && f.searchable === true);
    const searchAction = async (action: Action, binding?: InspectionBinding): Promise<WebOutcome | undefined> => {
      const result = await this.run(action, ctx, log, undefined, binding);
      const asked = result === undefined ? undefined : this.nativeOutcome(action, view, log, ctx, false);
      return asked ?? (result?.ok === true ? undefined : this.failed(log, result, view));
    };
    if (this.inspectionEnabled(ctx)) {
      let search: Awaited<ReturnType<NonNullable<WebAdapter["inspectionSearch"]>>>;
      let fieldId: string | undefined;
      for (const box of boxes) {
        search = await this.adapter.inspectionSearch?.(box.fieldId);
        if (search?.url === view.url) { fieldId = box.fieldId; break; }
      }
      if (search === undefined || fieldId === undefined) {
        return { status: "policy-denied", actions: log, view, message: "이 화면에서는 검색에만 쓰이는 입력란을 확인하지 못했어요." };
      }
      const target = { fieldId, role: "searchbox" };
      const action = this.action({ type: "press", target, value: query, url: search.destination, reason: "현재 사이트에서 검색" });
      const blocked = await searchAction(action, { kind: "search", fieldId, ...search });
      if (blocked !== undefined) return blocked;
    } else {
      const [box] = boxes;
      if (!box) return { status: "failed", actions: log, view, message: "이 화면에서 검색창을 찾지 못했습니다." };
      const target = { fieldId: box.fieldId, role: "searchbox" };
      const fill = await searchAction(this.action({ type: "fill", target, value: query, reason: `검색어 입력: ${query}` }));
      if (fill !== undefined) return fill;
      const press = await searchAction(this.action({ type: "press", target, value: "Enter", reason: "검색 실행" }));
      if (press !== undefined) return press;
    }
    ctx.trace('VERIFYING', this.id, '검색 결과 확인');
    const changed = (v: PageView) => diffViews(view, v, undefined, this.churn.volatile())[0] !== "none" && hasContent(v);
    let after = await this.observeUntil(ctx, changed, 6000);
    after = await this.settle(ctx, after, SEARCH_SETTLE_MS);
    if (stillBuilding(after)) {
      this.pendingSearch = { url: after.url, mainText: after.outline?.mainText ?? "" };
      return { status: "unconfirmed", actions: log, view: after, message: NOT_READY };
    }
    if (!changed(after)) return { status: "unconfirmed", actions: log, view: after, message: "검색 결과가 바뀌었는지 확인하지 못했어요." };
    return { status: "ok", actions: log, view: after };
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
    if (this.pendingSearch?.url !== view.url) this.pendingSearch = undefined;
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

  /** 읽어 줄 화면: 아직 채워지는 중이면 채워질 때까지 잠깐 기다렸다가 본다. */
  async observeReady(ctx: ExecContext): Promise<PageView> {
    const view = await this.observe(ctx);
    const pending = this.pendingSearch;
    if (pending === undefined && !stillBuilding(view)) return view;
    const ready = await this.settle(ctx, view, READY_WAIT_MS, pending);
    if (this.pendingSearch === pending && !stillBuilding(ready)) this.pendingSearch = undefined;
    return ready;
  }

  /**
   * 늦게 채워지는 내용(검색 결과 등)이 다 오고 더 이상 바뀌지 않을 때까지 잠깐 기다린다(최대 maxMs).
   * 시간이 넘으면 채워지던 화면을 그대로 돌려준다: 부르는 쪽이 stillBuilding으로 보고 다 열렸다고 말하지 않는다.
   */
  private async settle(ctx: ExecContext, view: PageView, maxMs = SETTLE_MS, pendingSearch?: PendingSearch): Promise<PageView> {
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
      // 검색 응답을 받은 직후에도 사이트가 이전 틀을 잠시 표시할 수 있다.
      const awaitingResults = pendingSearch !== undefined && pendingSearch.url === next.url &&
        pendingSearch.mainText === (next.outline?.mainText ?? "");
      if (same && !stillBuilding(next) && !awaitingResults) break;
    }
    return prev;
  }

  /** 사진 바이트는 이 호출 안에만 둔다. 기록에는 조작과 결과만 남는다. */
  async capturePicture(view: PageView, ctx: ExecContext, log: WebAction[]): Promise<[Picture | undefined, string, PageView]> {
    const plan = planShot(view);
    if (plan instanceof ShotRefusal) return [undefined, plan.speech, view];
    const action = this.action({ type: "capture", reason: "요청한 브라우저 탭 사진 촬영" });
    let picture: Picture | undefined;
    let failure = "현재 웹페이지의 사진을 찍지 못했어요. 다시 요청해 주세요.";
    let seen = view;
    const layout = this.adapter.fullPageLayout?.bind(this.adapter);
    const prepare = this.adapter.prepareFullPage?.bind(this.adapter);
    const shoot = this.adapter.capture?.bind(this.adapter);
    const capture = async (): Promise<ActionResult> => {
      const start = performance.now();
      let error: ExecutionErrorCode | undefined;
      try {
        if (layout === undefined || prepare === undefined || shoot === undefined) throw new AdapterError("NOT_SUPPORTED");
        const shot = await layout(async () => {
          const prepared = await prepare(plan.url, ctx.signal);
          if (prepared !== undefined) return prepared;
          seen = await this.observe(ctx);
          const freshPlan = planShot(seen);
          if (freshPlan instanceof ShotRefusal) return freshPlan;
          if (freshPlan.url !== plan.url || ctx.signal.aborted) return new ShotRefusal("changed", REFUSAL_SPEECH.changed);
          return shoot(freshPlan, seen.outline?.mainText ?? "");
        });
        if (shot instanceof ShotRefusal) {
          failure = shot.speech;
          error = "VERIFY_FAILED";
        } else picture = shot;
      } catch (thrown) {
        if (!(thrown instanceof AdapterError)) throw thrown;
        error = thrown.code;
      }
      return {
        actionId: action.id, ok: error === undefined, verified: error === undefined, latencyMs: Math.trunc(performance.now() - start),
        ...(error === undefined ? {} : { errorCode: error }),
      };
    };
    const result = await this.run(action, ctx, log, capture);
    if (result === undefined) failure = log.at(-1)?.policy.reason ?? failure;
    else if (result.errorCode === "LOG_FAILED") failure = "촬영 기록을 남기지 못해 사진을 보내지 않았어요.";
    return [picture, failure, seen];
  }

  private action(partial: Omit<Action, 'id' | 'risk' | 'requiresConfirmation'> & Partial<Action>): Action {
    return { id: randomUUID(), risk: 'low', requiresConfirmation: false, ...partial };
  }

  /**
   * PolicyGuard 검사 후에만 어댑터를 호출한다. 저위험이고 승인이 필요 없던 조작만 TIMEOUT을 한 번 다시 한다.
   * 중요한 조작은 이미 됐을 수 있어 다시 하지 않는다(부르는 쪽이 화면을 다시 보고 알린다).
   * perform이 있으면 어댑터 대신 그것을 한 번만 부른다(화면 사진).
   */
  private inspectionEnabled(ctx: ExecContext): boolean {
    return this.guard.inspectionEnabled(this.policyContext(ctx, ctx.isStopped() || ctx.signal.aborted));
  }

  private async inspectTarget(action: Action, ctx: ExecContext): Promise<InspectionBinding | undefined> {
    const ref = action.target?.ref;
    if (ref === undefined || ctx.signal.aborted || ctx.isStopped()) return undefined;
    const fresh = await this.adapter.controlWindow?.("", 0, { ref, inspection: true });
    const [item] = fresh?.items ?? [];
    if (fresh === undefined || fresh.url !== this.lastView?.url || item?.ref !== ref || item.disabled ||
      item.role !== action.target?.role || item.name !== action.target?.name || item.inspection === undefined) return undefined;
    return { kind: "control", url: fresh.url, ref, control: item.inspection };
  }

  async run(
    action: Action, ctx: ExecContext, log: WebAction[], perform?: () => Promise<ActionResult>, binding?: InspectionBinding,
    grants?: ExecuteGrants,
  ): Promise<WebActionResult | undefined> {
    ctx.trace("POLICY_CHECK", this.id, action.type);
    const personal = this.inspectionEnabled(ctx);
    const pending = this.#inspectionPending?.action.id === action.id ? this.#inspectionPending : undefined;
    const approved = ctx.approvals.has(action.id);
    if (pending !== undefined && approved) this.#inspectionPending = undefined;
    const inspection = !personal ? undefined : action.type === "click" ? await this.inspectTarget(action, ctx) : binding;
    const matches = pending !== undefined && inspection !== undefined && pending.sessionId === ctx.sessionId &&
      isDeepStrictEqual(pending.action, action) && isDeepStrictEqual(pending.binding, inspection);
    const changed = approved && (pending !== undefined || (personal && action.type === "click")) && (!personal || !matches);
    // 허가(안내 팝업 증명·confirm() 답)는 어댑터가 누르기 직전에 다시 확인해야 뜻이 있다. 어댑터를 거치지 않는 실행(perform)에는 붙일 수 없다.
    const bound = grants !== undefined && perform !== undefined
      ? { allowed: false, code: "DENIED_GRANT_BINDING", reason: "허가가 필요한 조작은 어댑터가 확인하는 길로만 실행할 수 있어요." }
      : undefined;
    const policy = bound ?? (changed
      ? { allowed: false, code: "DENIED_INSPECTION_CHANGED", reason: "여쭤본 뒤에 항목이나 화면이 바뀌어서 누르지 않았어요." }
      : this.guard.check(action, {
        ...this.policyContext(ctx, ctx.isStopped() || ctx.signal.aborted), inspection, inspectionApproved: approved && matches,
        notice: grants?.notice, native: grants?.native,
      }));
    if (policy.code === "NEEDS_CONFIRMATION" && inspection !== undefined) {
      this.#inspectionPending = { action: structuredClone(action), sessionId: ctx.sessionId, binding: inspection };
    }
    const entry: WebAction = { agent: this.id, action, policy };
    log.push(entry);
    if (!policy.allowed) {
      try {
        await this.actionLog?.append({ actionType: action.type, phase: "refused", ok: false, actor: ctx.actor, reasonCode: policy.code });
      } catch { /* 막힌 조작은 기록하지 못해도 실행하지 않는다. */ }
      return undefined;
    }
    const writeLog = (phase: "before" | "after", ok?: boolean) => this.actionLog?.append({
      host: tryUrl(this.lastView?.url)?.hostname ?? "", pageKind: this.lastView?.pageId ?? "",
      actionType: action.type, label: personal ? undefined : actionLabel(action),
      approvalId: action.requiresConfirmation || policy.code === "APPROVED" || grants?.native !== undefined ? action.id : undefined,
      phase, ...(ok === undefined ? {} : { ok }),
    });
    try { await writeLog("before"); }
    catch {
      if (action.type === "capture" || action.requiresConfirmation || policy.code === "APPROVED" || grants?.native !== undefined) {
        entry.result = { actionId: action.id, ok: false, verified: false, errorCode: "LOG_FAILED", latencyMs: 0 };
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
    // 허가가 있으면 같은 허가를 붙여 한 번만 실행한다. 허가가 없는 호출은 지금처럼 인자를 늘리지 않는다.
    let result = perform !== undefined ? await perform()
      : grants === undefined ? await this.adapter.execute(action, ctx.signal, inspection)
        : await this.adapter.execute(action, ctx.signal, inspection, grants);
    // 시간이 넘었다고 다시 하는 것은 허가가 없는 저위험 조작뿐이다. 허가·승인이 붙은 조작은 이미 됐을 수 있고, 허가 없이 다시 하면 어댑터의 확인을 건너뛴다.
    if (!personal && perform === undefined && grants === undefined && action.risk === "low" && policy.code !== "APPROVED" && policy.code !== "ALLOWED_NOTICE" &&
      !result.ok && result.errorCode === "TIMEOUT" && this.adapter.peekNative?.(action.id) === undefined && !ctx.signal.aborted) {
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
    if (result.errorCode === "TIMEOUT" && last?.policy.code === "ALLOWED_INSPECTION") {
      return { status: "unconfirmed", actions: log, view, message: "화면이 바뀌었는지 확인하지 못했어요." };
    }
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

  // ---- 안내 팝업을 묻지 않고 닫기, 사이트의 confirm() 질문 알리기 ----

  /**
   * 묻지 않는 길은 읽기 전용 사이트의 보통 탐색에서만 연다. 지원 사이트(모의 신청서)는 handleDialogs가 맡고,
   * 정보 조회·화면 확인 범위와 멈춘 뒤에는 지금처럼 그대로 둔다(그 범위의 정책은 이 허가를 보지 않는다).
   */
  private plainReadOnly(ctx: ExecContext, view: PageView): boolean {
    return this.adapter.controlWindow !== undefined && !ctx.publicLookup && this.guard.config.publicLookupOnly !== true &&
      !this.inspectionEnabled(ctx) && !ctx.isStopped() && !ctx.signal.aborted && this.guard.tierOf(view.url) === "read-only";
  }

  /** 같은 이름의 조작 요소가 화면에 몇 개인지. 이름으로 고른 항목이 하나뿐일 때만 안내 팝업 단추로 본다(여럿이면 어느 것인지 모호하다). */
  private sameNameCount(view: PageView, name: string): number {
    const term = normalizeTerm(name);
    return (view.outline?.items ?? []).filter(item => !item.disabled && normalizeTerm(item.name) === term).length;
  }

  /**
   * 이 단추가 '내용만 알리는 안내 팝업을 닫는 단추'라는 증명을 누르기 직전의 새 관찰로 만든다.
   * 단추의 ref·역할·이름·주소와 팝업 사실(입력 없음·단추 하나·다른 조작 요소 없음·위험한 낱말 없음)이 모두 확인될 때만 만들고, 하나라도 어긋나거나 읽지 못하면
   * undefined를 돌려준다(그러면 정책이 지금처럼 묻는다). 정책과 어댑터가 각자 같은 판정(isNotice)을 다시 한다.
   */
  private async noticeProof(view: PageView, item: { ref: string; role: string; name: string }, ctx: ExecContext): Promise<NoticeProof | undefined> {
    if (item.role !== "button" || !this.plainReadOnly(ctx, view)) return undefined;
    const index = view.outline?.items?.find(candidate => candidate.ref === item.ref)?.dialog;
    const popup = index === undefined ? undefined : view.dialogs[index];
    if (popup === undefined || popup.hasInputs !== false || popup.buttons.length !== 1) return undefined;
    try {
      const fresh = await this.adapter.controlWindow?.("", 0, { ref: item.ref, notice: true });
      const [now] = fresh?.items ?? [];
      if (fresh === undefined || fresh.url !== view.url || fresh.items.length !== 1 || now === undefined || now.ref !== item.ref ||
        now.disabled || now.role !== item.role || now.name !== item.name || now.notice === undefined || !isNotice(now.notice, now)) return undefined;
      return { kind: "notice", url: fresh.url, ref: item.ref, role: item.role, name: item.name, facts: now.notice };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      return undefined;
    }
  }

  /**
   * 팝업 가운데 입력이 없고 단추 하나가 안에서 유일한 조작 요소인 것을 찾아 증명과 함께 돌려준다.
   * since가 있으면 그 화면에 이미 떠 있던 팝업(제목과 글이 같은 것)은 건너뛴다: 사용자가 방금 누른 것이 새로 연 팝업만 다룬다.
   */
  private async findNotice(view: PageView, ctx: ExecContext, since?: PageView): Promise<{ item: { ref: string; role: string; name: string }; proof: NoticeProof } | undefined> {
    const known = new Set((since?.dialogs ?? []).map(popup => popup.title + "\n" + popup.text));
    for (const [index, popup] of view.dialogs.entries()) {
      if (popup.hasInputs !== false || popup.buttons.length !== 1 || known.has(popup.title + "\n" + popup.text)) continue;
      const inside = (view.outline?.items ?? []).filter(item => item.dialog === index && !item.disabled);
      const [only] = inside;
      if (inside.length !== 1 || only === undefined || only.role !== "button") continue;
      const proof = await this.noticeProof(view, only, ctx);
      if (proof !== undefined && !this.#noticeStuck.has(proof.facts.signature)) return { item: only, proof };
    }
    return undefined;
  }

  /** 닫은 안내가 말한 내용을 만들고 '이미 말한 안내' 기록에 남긴다. */
  private noticeBody(proof: NoticeProof, name: string, origin: string): { body: NoticeSaid; repeated: boolean } {
    const body = noticeSaid(proof.facts, name);
    const key = noticeKey(origin, body);
    const repeated = this.#noticeSaid.has(key);
    this.#noticeSaid.add(key);
    for (const old of this.#noticeSaid) { if (this.#noticeSaid.size <= NOTICE_SAID_KEEP) break; this.#noticeSaid.delete(old); }
    return { body, repeated };
  }

  /**
   * 화면에 뜬 안내 팝업을 묻지 않고 닫는다(최대 MAX_NOTICES개). 닫은 안내가 말한 내용을 돌려주니 부르는 쪽이 사용자에게 한 번 알린다.
   * announce "once"(기본)는 이미 말한 안내가 다시 뜨면 닫기만 하고 다시 읽지 않고, "always"는 사용자가 방금 눌러서 연 팝업이라 늘 읽는다.
   * 닫는 누르기도 다른 조작처럼 정책 검사를 거치고 어댑터가 누르기 직전에 팝업을 다시 확인한다. 안내가 아니거나(단추가 둘, 입력, 위험한 낱말, 묻는 말투, 속을 볼 수 없는 틀)
   * 확인하지 못하면 아무것도 누르지 않는다. 닫히지 않으면 같은 팝업을 다시 누르지 않고, 닫는 데 실패해도 하던 일은 이어 간다.
   * 닫으려고 누르다가 사이트가 confirm() 창으로 물으면 그것은 안내가 아니다: 취소한 채 두고(대신 답하지 않는다) manual로 돌려줘 사용자에게 알린다.
   */
  async dismissNotices(view: PageView, ctx: ExecContext, log: WebAction[], { announce = "once", since }: {
    announce?: "once" | "always"; since?: PageView;
  } = {}): Promise<{ view: PageView; said: NoticeSaid[]; manual: NativeQuestion[] }> {
    const said: NoticeSaid[] = [];
    const manual: NativeQuestion[] = [];
    let current = view;
    for (let i = 0; i < MAX_NOTICES; i++) {
      if (this.adapter.controlWindow === undefined || current.dialogs.length === 0 || !this.plainReadOnly(ctx, current)) break;
      const found = await this.findNotice(current, ctx, since);
      if (found === undefined) break;
      const { item, proof } = found;
      const action = this.action({ type: "click", target: { ref: item.ref, role: item.role, name: item.name }, reason: "안내 팝업 닫기" });
      const result = await this.run(action, ctx, log, undefined, undefined, { notice: proof });
      // 안내를 닫다가 사이트가 질문을 띄웠다면 그것은 안내가 아니다. 대신 답하지 않고, 조용히 넘기지 않고 알린다.
      const cancelled = this.adapter.takeNative?.(action.id)?.cancelled ?? [];
      const [asked] = cancelled;
      if (asked !== undefined) {
        this.#noticeStuck.add(proof.facts.signature);
        manual.push({ record: asked, answerable: false, count: cancelled.length, scope: "auto" });
        break;
      }
      if (result?.ok !== true) {
        this.#noticeStuck.add(proof.facts.signature);
        break;
      }
      const open = (v: PageView) => v.outline?.items?.some(candidate => candidate.ref === item.ref && candidate.dialog !== undefined) === true;
      try { current = await this.observeUntil(ctx, v => !open(v), 1500); }
      catch (error) { if (ctx.signal.aborted) throw error; break; }
      if (open(current)) {
        this.#noticeStuck.add(proof.facts.signature);
        break;
      }
      const { body, repeated } = this.noticeBody(proof, item.name, tryUrl(current.url)?.origin ?? "");
      if (repeated && announce === "once") continue;
      said.push(body);
    }
    return { view: current, said, manual };
  }

  /**
   * 누른 뒤의 안내 팝업과 사이트의 질문을 다룬다. 새 화면으로 옮겨 갔으면 그 화면에 뜬 안내 팝업을 묻지 않고 닫는다.
   * 같은 화면에서 이번 누르기로 새 팝업이 떴으면 그 팝업이 안내일 때만 닫고 말해 주며,
   * 안내가 아니라 그대로 남은 팝업(단추가 둘 이상 등)은 읽어 주고 고를 것을 알려 사용자의 선택을 기다린다(question). 어느 단추도 청음이 고르지 않는다.
   * own: 사용자가 직접 누른 것이 안내 팝업의 단추(증명을 받은 누르기)였고 그 팝업이 실제로 닫혔으면 그 안내의 내용을 말해 준다.
   */
  private async settleNotices(out: WebOutcome, before: PageView, ctx: ExecContext, log: WebAction[],
    own?: { proof: NoticeProof; item: { ref: string; name: string } }): Promise<WebOutcome> {
    if (out.status !== "ok" || out.view === undefined) return out;
    let view = out.view;
    const said: NoticeSaid[] = [];
    const manual: NativeQuestion[] = [];
    const inPopup = (v: PageView, ref: string) => v.outline?.items?.some(candidate => candidate.ref === ref && candidate.dialog !== undefined) === true;
    if (own !== undefined && this.plainReadOnly(ctx, view) && !inPopup(view, own.item.ref)) {
      // 방금 시킨 누르기이니 이미 말한 안내여도 다시 읽는다.
      said.push(this.noticeBody(own.proof, own.item.name, tryUrl(view.url)?.origin ?? "").body);
    }
    const moved = out.effect === "moved";
    const opened = out.effect === "changed" && openedDialog(before, view);
    if (moved || opened) {
      const closed = await this.dismissNotices(view, ctx, log, moved ? {} : { announce: "always", since: before });
      view = closed.view;
      said.push(...closed.said);
      manual.push(...closed.manual);
    }
    const question = manual.length === 0 && (opened || moved) ? this.questionOf(view, ctx, moved ? undefined : before) : undefined;
    if (view === out.view && said.length === 0 && manual.length === 0 && question === undefined) return out;
    const next: WebOutcome = { ...out, view };
    if (said.length > 0) next.notices = said;
    if (manual.length > 0) next.manual = manual;
    if (question !== undefined) next.question = question;
    if (said.length > 0 || question !== undefined) {
      // 팝업이 한 말은 따로 읽어 주니 새로 보이는 내용에서는 뺀다(같은 내용을 두 번 읽지 않는다).
      const rest = revealedExcept(out.revealed, out.view.dialogs.flatMap(dialog => [dialog.title, dialog.text]));
      next.revealed = rest.length > 0 ? rest : undefined;
    }
    return next;
  }

  /**
   * 이번 누르기로 같은 화면에 새로 떠서 그대로 남은 팝업 가운데 입력 칸이 없는 것을, 읽어 주고 사용자가 고르게 할 질문으로 만든다.
   * 고를 수 있는 것은 팝업 안에서 관찰된 조작 요소의 이름이다. 정보 조회·화면 확인 범위와 입력 칸이 있는 팝업은 지금처럼 둔다.
   */
  questionOf(view: PageView, ctx: ExecContext, before?: PageView): PopupQuestion | undefined {
    if (!this.plainReadOnly(ctx, view)) return undefined;
    const known = new Set(before?.dialogs.map(popup => popup.title + "\n" + popup.text));
    for (const [index, popup] of view.dialogs.entries()) {
      if (popup.hasInputs !== false || popup.buttons.length < 2 || known.has(popup.title + "\n" + popup.text)) continue;
      const inside = (view.outline?.items ?? []).filter(item => item.dialog === index && !item.disabled);
      const question = popupQuestion(popup, inside.map(item => item.name), index);
      if (question !== undefined) return question;
    }
    return undefined;
  }

  /**
   * 누르는 동안 사이트가 confirm() 창으로 물어서 청음이 취소했다면 그 질문을 사용자에게 돌려준다(status needs-approval, pending은 누른 조작).
   * 소리로 다 읽어 줄 수 있고 신청·삭제·로그인 같은 말이 없는 질문 하나뿐이고, 이번이 처음 누른 것일 때만 대신 답할 수 있다(answerable).
   * 사용자가 시킨 정보 조회·화면 확인 범위에서는 대신 답할 수 없으니 취소했다고만 알리고 직접 확인하시게 한다(scope). 맡겨 둔 조사(백그라운드)는 지금처럼 아무것도 하지 않는다.
   * 멈춘 뒤에는 알릴 것이 없다. 질문 글은 어느 경우에도 모델에 보내지 않고 정책에도 쓰지 않는다.
   */
  private nativeOutcome(action: Action, view: PageView, log: WebAction[], ctx: ExecContext, replay: boolean, notice = false): WebOutcome | undefined {
    const seen = this.adapter.takeNative?.(action.id);
    const [record] = seen?.cancelled ?? [];
    if (seen === undefined || record === undefined || ctx.isStopped() || ctx.signal.aborted || this.guard.config.publicLookupOnly === true) return undefined;
    const count = seen.cancelled.length;
    let native: NativeQuestion;
    if (notice) native = {record, answerable: false, count, scope: "auto"};
    else if (this.plainReadOnly(ctx, view)) native = { record, answerable: action.type === "click" && !replay && count === 1 && record.risk === "routine", count };
    else if (this.inspectionEnabled(ctx)) native = { record, answerable: false, count, scope: "private" };
    else if (ctx.publicLookup) native = { record, answerable: false, count, scope: "lookup" };
    else return undefined;
    return { status: "needs-approval", actions: log, view, pending: action, native, message: nativeSpeech(native) };
  }

  /** 사용자가 거절했거나 멈췄을 때 사이트의 질문에 대신 답할 수 있던 기록을 버린다. */
  forgetNative(): void { this.adapter.dropNative?.(); }

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
    const policy = this.guard.check(action, this.policyContext(ctx, ctx.isStopped()));
    return { agent: this.id, action, policy };
  }

  private policyContext(ctx: ExecContext, stopped: boolean): PolicyContext {
    return {
      currentUrl: this.lastView?.url, stopped, approvals: ctx.approvals, actionsThisTurn: ctx.counter.actions,
      actionLimit: ctx.actionLimit, publicLookup: ctx.publicLookup, browsingScope: ctx.browsingScope,
    };
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
