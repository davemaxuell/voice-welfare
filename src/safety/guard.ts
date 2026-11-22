import { parseAction, type Action, type ActionType, type NativeGrant, type NoticeFacts, type NoticeProof } from "../core/actions.ts";
import { boundPlanClick, type PlanBinding } from "../core/plan.ts";
import type { PolicyDecision } from "../core/turn.ts";
import { hasText, strip } from "../core/text.ts";
import { tryUrl } from "../core/url.ts";
import { detectSensitive, redactPictureText } from "./privacy.ts";

export type AccessTier = "full" | "read-only" | "none";
export interface PolicyConfig {
  allowedOrigins: readonly string[];
  allowedActionTypes: readonly ActionType[];
  allowedFieldIds: readonly string[];
  secretFieldIds: readonly string[];
  maxActionsPerTurn: number;
  readOnlyWeb?: boolean;
  safeButtons?: readonly string[];
  readOnlyClicks?: "any" | "safe";
  publicLookupOnly?: boolean;
  defaultActionsPerTurn?: number;
}
export interface PolicyContext {
  currentUrl?: string;
  stopped?: boolean;
  approvals?: ReadonlySet<string>;
  actionsThisTurn?: number;
  publicLookup?: boolean;
  browsingScope?: "personal-inspection";
  inspection?: InspectionBinding;
  inspectionApproved?: boolean;
  actionLimit?: number;
  /** 이번 누르기가 내용만 알리는 안내 팝업을 닫는 것이라는 증명(어댑터가 누르기 직전에 다시 확인한다). 읽기 전용 사이트의 누르기에만 쓴다. */
  notice?: NoticeProof;
  /** 사이트의 confirm() 창에 답하며 같은 누르기를 되풀이한다는 허가. 누르기에만 붙고 공개 조회·화면 확인 범위에서는 쓰지 않는다. */
  native?: NativeGrant;
  plan?: PlanBinding;
}
export type ClickTier = "free" | "ask" | "hard";

export type InspectionControl =
  | { kind: "navigation"; href: string; signature: string }
  | { kind: "disclosure" | "ambiguous" | "blocked"; href?: string; signature: string };

export interface InspectionSearchEvidence {
  url: string; destination: string; parameter: string; signature: string;
  field?: { ref: string; name: string };
}

export type InspectionBinding =
  | { kind: "start" | "back"; url: string }
  | { kind: "control"; url: string; ref: string; control: InspectionControl }
  | ({ kind: "search"; fieldId: string } & InspectionSearchEvidence);

/** 칸 id와 검색 역할만 지정하거나, 양식과 함께 관찰한 바로 그 칸을 지정해야 한다. */
export function matchesInspectionSearchTarget(target: Action["target"], fieldId: string, field?: InspectionSearchEvidence["field"]): boolean {
  if (target?.role !== "searchbox" || target.fieldId !== fieldId) return false;
  const keys = Object.keys(target).length;
  return keys === 2 || (keys === 5 && field !== undefined && target.ref === field.ref && target.name === field.name && target.label === field.name);
}

export const guardPatterns = {
  secretLabel: /(비밀\p{White_Space}*번호|password|OTP|인증\p{White_Space}*번호|주민\p{White_Space}*(등록)?\p{White_Space}*번호|계좌|카드\p{White_Space}*번호)/iu,
  // 실제 사이트에서도 사용자에게 묻고 누를 수 있는 이름(로그인 화면 열기·로그인 누르기). 로그아웃은 아니다.
  loginName: /(로그인|log\p{White_Space}*-?\p{White_Space}*[iİ]n|s[iİ]gn\p{White_Space}*-?\p{White_Space}*[iİ]n)/iu,
  riskyButton: /(신청|제출|접수|등록|삭제|결제|송금|이체|구매|주문|동의|승인|확인|저장|보내기|전송|발송|로그인|로그아웃|탈퇴|가입|변경|수정|취소|인증|업로드|첨부|발급|예약|투표|좋아요|구독|subm[iİ]t|send|pay|buy|order|delete|conf[iİ]rm|log[iİ]n|s[iİ]gn)/iu,
  hardAction: /(신청|제출|접수|등록|삭제|결제|송금|이체|구매|주문|동의|승인|저장|보내기|전송|발송|로그아웃|탈퇴|가입|인증|업로드|첨부|발급|예약|투표|좋아요|구독|subm[iİ]t|send|pay|buy|order|delete|s[iİ]gn\p{White_Space}*-?\p{White_Space}*(?:up|out)|log\p{White_Space}*-?\p{White_Space}*out)/iu,
  actionAnywhere: /하기(?![가-힣])|탈퇴|결제|송금|이체|삭제|구매|주문|로그인|로그아웃|회원\p{White_Space}*가입|(?<![a-zİ])(pay|buy|order|delete|subm[iİ]t|log\p{White_Space}*([iİ]n|out)|s[iİ]gn\p{White_Space}*([iİ]n|up|out))(?![a-zİ])/iu,
  // 이름이 동작 낱말로 끝나면 동작(신청서 제출·본인 인증·전체 동의). 신청방법·제출서류처럼 뒤에 다른 말이 붙으면 정보.
  actionEnding: /(신청|제출|접수|등록|동의|승인|확인|저장|보내기|전송|발송|변경|수정|취소|인증|업로드|첨부|발급|예약|투표|좋아요|구독|가입|합니다|하세요|(?<![a-zİ])(send|conf[iİ]rm|save|apply|ok))(?=\n?$)/iu,
  trailingNoise: /(\p{White_Space}*(새\p{White_Space}*창(\p{White_Space}*열림)?|[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}가-힣]+))+(?=\n?$)/gu,
  spaces: /\p{White_Space}+/gu,
};

const inputTypes: ReadonlySet<ActionType> = new Set(["fill", "select", "check"]);
const readOnlyTypes: ReadonlySet<ActionType> = new Set(["navigate", "back", "click", "fill", "press", "scroll", "read", "focus", "capture"]);
const clickRoles: ReadonlySet<string> = new Set(["link", "tab", "scriptlink", "button", "menuitem"]);

export function isActionName(name: string): boolean {
  const trimmed = strip(name.replace(guardPatterns.spaces, " ")).replace(guardPatterns.trailingNoise, "");
  return guardPatterns.actionAnywhere.test(trimmed) || guardPatterns.actionEnding.test(trimmed);
}

/** 실제 사이트에서 역할과 이름으로 바로 누를 항목, 물어볼 항목, 거부할 항목을 가른다(이름만 보는 휴리스틱). */
export function clickTier(role: string | undefined, name: string): ClickTier {
  if (role === "link") return "free";
  if (strip(name).length === 0 || (guardPatterns.hardAction.test(name) && isActionName(name))) return "hard";
  if (role === "tab" || role === "scriptlink") return isActionName(name) ? "ask" : "free";
  if (role === "button" || role === "menuitem") return guardPatterns.riskyButton.test(name) ? "ask" : "free";
  return "ask";
}

/** 확인·로그인·결과를 남기는 조작은 여러 단계를 묶는 동의에 넣지 않는다. */
export function planControlAllowed(role: string, name: string): boolean {
  return ["button", "link", "tab", "scriptlink", "menuitem", "generic"].includes(role) && strip(name).length > 0 &&
    !/^(?:확인|ok|confirm)$/iu.test(strip(name).replace(guardPatterns.trailingNoise, "")) &&
    !(guardPatterns.hardAction.test(name) && isActionName(name)) && !guardPatterns.loginName.test(name);
}

// ---- 안내 팝업(notice) ----
// 내용만 알리는 안내 팝업을 닫는 '확인' 누르기는 이 증명이 있을 때만 묻지 않는다. 증명이 없는 '확인'은 지금처럼 묻는다.
// 어댑터는 누르기 직전에 새 관찰로 같은 사실을 얻고 같은 판정(isNotice)을 다시 해서 맞을 때만 누른다. 애매하면 모두 '안내가 아님'이다.
const NOTICE_TEXT_LIMIT = 600;
const noticeDismiss = /^(?:확인|닫기|닫음|창\p{White_Space}*닫기|close|ok)$/iu;
// 묻거나 시키는 말투의 안내에 든 '확인'은 무언가를 진행하는 단추일 수 있다.
const noticeDemand = /[?？]|하시겠|할까요|합니까|계속|진행|눌러|클릭|누르/u;
const dangerousContext = (text: string) => guardPatterns.hardAction.test(text) || guardPatterns.loginName.test(text) || guardPatterns.secretLabel.test(text);

/**
 * 팝업 사실이 '입력도 다른 조작도 없이 단추 하나뿐인, 위험한 낱말 없는 안내'이고 그 단추가 닫는 말(확인·닫기·close·OK)인지.
 * 단추가 둘 이상, 입력·양식·안을 볼 수 없는 틀, 다른 조작 요소, 잘린 글, 빈 글, 신청·제출·로그인·비밀번호 같은 낱말, 묻는 말투 중 하나라도 있거나 사실이 빠졌으면 false.
 * shadow root(열린 것·닫힌 것)가 하나라도 있거나 어댑터가 브라우저 DOM으로 세지 못했으면(shadows가 0이 아니면) 속을 알 수 없으니 안내가 아니다.
 */
export function isNotice(facts: NoticeFacts | undefined, control: { role?: string; name?: string }): boolean {
  if (facts === undefined || control.role !== "button" || !hasText(control.name)) return false;
  if (facts.kind !== "dialog" && facts.kind !== "layer") return false;
  const name = strip(control.name.replace(guardPatterns.spaces, " "));
  if (!noticeDismiss.test(name) || guardPatterns.loginName.test(name)) return false;
  if (facts.hasInputs !== false || facts.others !== 0 || facts.buttonCount !== 1 || !Array.isArray(facts.buttons) ||
    facts.buttons.length !== 1 || facts.buttons[0] !== control.name || !(facts.popups >= 1) || !hasText(facts.signature) ||
    !hasText(facts.root) || facts.shadows !== 0) return false;
  if (!(facts.textLength <= NOTICE_TEXT_LIMIT) || facts.text.length !== facts.textLength) return false;
  const body = strip(facts.text.replace(control.name, " "));
  if (body.length === 0) return false;
  const said = facts.title + " " + body;
  return !dangerousContext(said) && !noticeDemand.test(said);
}

function noticeProven(proof: NoticeProof | undefined, action: Action, currentUrl: string | undefined): boolean {
  const target = action.target;
  return proof?.kind === "notice" && action.type === "click" && target !== undefined && currentUrl !== undefined && proof.url === currentUrl &&
    Object.keys(target).length === 3 && target.ref === proof.ref && target.role === proof.role && target.name === proof.name &&
    isNotice(proof.facts, target);
}

// ---- 사이트의 confirm() 창 ----
/** 소리로 다 읽어 줄 수 있는 글자 수(이보다 길면 '긴 글'이라 대신 답하지 않는다). */
export const NATIVE_SPOKEN_LIMIT = 200;
const nativeConsequential = /변경|수정|취소|해지|지우|제거|초기화|환불|개인\p{White_Space}*정보/u;
/**
 * confirm() 창의 전체 글로 분류한다. 신청·제출·결제·삭제·로그인·비밀번호·개인정보를 다루거나 소리로 다 읽어 줄 수 없게 길면
 * 청음이 대신 '확인'으로 답하지 않는다(routine만 사용자 승인으로 답한다).
 */
export function nativeMessageRisk(message: string): "routine" | "consequential" | "long" {
  if ([...message].length > NATIVE_SPOKEN_LIMIT) return "long";
  return dangerousContext(message) || nativeConsequential.test(message) ? "consequential" : "routine";
}

const writeEndpoint = /^(?:pay(?:ment)?|checkout|purchase|submit|send|delete|remove|logout|sign[-_ ]?out|sign[-_ ]?up|register|consent|vote|upload|withdraw|commit|confirm|save|update)(?:\.[a-z0-9]+)?$/iu;
const endpointParameter = /^(?:_?method|action|operation|op|cmd|command|do)$/iu;
const searchParameter = /^(?:[\p{L}\p{N}_-]{1,64})$/u;
const secretParameter = /^(?:password|passwd|pwd|otp|pin|one[-_ ]?time[-_ ]?code|card[-_ ]?number)$/iu;
const decodePath = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };

export function isInspectionUrl(value: string): boolean {
  const url = URL.parse(value);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") return false;
  const segments = decodePath(url.pathname).split("/").filter(Boolean);
  const endpoint = segments.at(-1) ?? "";
  const resourceAction = /^\d+$/u.test(endpoint) ? segments.at(-2) ?? "" : "";
  if (writeEndpoint.test(endpoint) || writeEndpoint.test(resourceAction) ||
    guardPatterns.hardAction.test(endpoint) && isActionName(endpoint)) return false;
  return ![...url.searchParams].some(([key, val]) =>
    secretParameter.test(key) || (endpointParameter.test(key) &&
      (writeEndpoint.test(val) || /^(?:POST|PUT|PATCH|DELETE)$/iu.test(val) ||
        (guardPatterns.hardAction.test(val) && isActionName(val)))));
}

function deny(code: string, reason: string): PolicyDecision {
  return { allowed: false, code, reason };
}

function readOnly(reason: string): PolicyDecision {
  return deny("DENIED_READ_ONLY", "지원하지 않는 사이트라 읽기 전용입니다. " + reason);
}

function approveOrAsk(action: Action, ctx: PolicyContext, approved: string, pending: string): PolicyDecision {
  return ctx.approvals?.has(action.id) === true
    ? { allowed: true, code: "APPROVED", reason: approved }
    : deny("NEEDS_CONFIRMATION", pending);
}

export class PolicyGuard {
  readonly config: PolicyConfig;

  constructor(config: PolicyConfig) {
    this.config = config;
  }

  isAllowedUrl(url: string | undefined): boolean {
    const parsed = tryUrl(url);
    return parsed !== undefined && this.config.allowedOrigins.includes(parsed.origin);
  }

  tierOf(url: string | undefined): AccessTier {
    const parsed = tryUrl(url);
    if (parsed === undefined) return "none";
    if (this.config.allowedOrigins.includes(parsed.origin)) return "full";
    return this.config.readOnlyWeb === true && (parsed.protocol === "http:" || parsed.protocol === "https:") ? "read-only" : "none";
  }

  check(candidate: unknown, ctx: PolicyContext): PolicyDecision {
    const action = parseAction(candidate);
    if (action === undefined) return deny("DENIED_SCHEMA", "액션 형식이 계약과 맞지 않습니다.");
    if (ctx.stopped === true) return deny("DENIED_STOPPED", "사용자가 중단을 요청했습니다.");
    const limit = ctx.actionLimit ?? this.config.defaultActionsPerTurn;
    const ceiling = this.config.maxActionsPerTurn;
    if ((ctx.actionsThisTurn ?? 0) >= (limit === undefined ? ceiling : Math.min(ceiling, limit))) {
      return deny("DENIED_RATE_LIMIT", "한 번의 요청에서 허용된 조작 횟수를 넘었습니다.");
    }
    if (!this.config.allowedActionTypes.includes(action.type)) return deny("DENIED_ACTION_TYPE", `허용되지 않은 액션 유형(${action.type})입니다.`);

    // 이동은 목적지, 그 외는 현재 화면의 출처로 접근 등급을 정한다.
    const tier = this.tierOf(action.type === "navigate" ? action.url : ctx.currentUrl);
    if (action.type === "navigate" && !hasText(action.url)) return deny("DENIED_ORIGIN", "이동할 주소가 없습니다.");
    if (tier === "none") return deny("DENIED_ORIGIN", "허용되지 않은 주소라서 열거나 조작하지 않습니다.");
    // 사이트의 confirm() 창에 답하는 허가는 읽기 전용 사이트에서 같은 화면의 누르기를 되풀이할 때만 쓴다.
    // 공개 조회·화면 확인 범위에서는 쓰지 않고, 안내 팝업 증명과 함께 쓰지도 않는다.
    if (ctx.plan !== undefined && (this.publicLookup(ctx) || this.inspectionEnabled(ctx) || ctx.native !== undefined || ctx.notice !== undefined ||
        ctx.approvals?.has(action.id) !== true || !boundPlanClick(ctx.plan, action, ctx.currentUrl) ||
        !planControlAllowed(ctx.plan.step.role, ctx.plan.step.name))) {
      return deny("DENIED_PLAN_BINDING", "이 조작은 확인받은 순서에 들어 있지 않아요.");
    }
    if (ctx.native !== undefined) {
      if (action.type !== "click" || tier !== "read-only" || this.publicLookup(ctx) || this.inspectionEnabled(ctx) ||
        ctx.notice !== undefined || ctx.native.url !== ctx.currentUrl) {
        return deny("DENIED_TASK_SCOPE", "사이트가 물은 질문에 대신 답하는 것은 이 요청으로는 할 수 없어요.");
      }
      // 허가의 모양만으로는 답하지 않는다. 처음 눌렀던 바로 이 조작을 사용자가 방금 다시 확인했을 때(ctx.granted)만 대신 답한다.
      // 이름이 '바로 누를 수 있는' 항목이어도 같다. 어댑터가 따로 가진 기록과 맞는지는 누르기 직전에 어댑터가 다시 확인한다.
      if (ctx.approvals?.has(action.id) !== true) {
        return deny("DENIED_NATIVE_BINDING", "사이트가 물은 질문에 대신 답하려면 사용자 확인이 필요해요.");
      }
    }
    if (this.publicLookup(ctx)) {
      const role = action.target?.role;
      const name = action.target?.name ?? "";
      if (ctx.browsingScope === "personal-inspection" && action.type !== "read" && action.type !== "scroll"
        || action.risk !== "low" || action.requiresConfirmation
        || action.type === "capture" || action.type === "select" || action.type === "check"
        || ((action.type === "fill" || action.type === "press") && role !== "searchbox")
        || (action.type === "click" && (role === undefined || !clickRoles.has(role) || name.length === 0
          || isActionName(name) || guardPatterns.loginName.test(name)))) {
        return deny("DENIED_TASK_SCOPE", "정보를 찾는 요청으로는 이 동작을 할 수 없어요.");
      }
      return this.checkReadOnly(action, ctx);
    }
    if (this.inspectionEnabled(ctx)) return this.checkInspection(action, ctx);
    if (tier === "read-only") return this.checkReadOnly(action, ctx);

    const target = action.target;
    if (inputTypes.has(action.type)) {
      const field = target?.fieldId;
      if (hasText(field) && this.config.secretFieldIds.includes(field)) {
        return deny("DENIED_SECRET", "비밀번호 등 인증 정보는 에이전트가 입력하지 않습니다.");
      }
      if (guardPatterns.secretLabel.test(target?.label ?? "")) return deny("DENIED_SECRET", "민감 정보 입력란은 사용자가 직접 입력해야 합니다.");
      if (!hasText(field) || !this.config.allowedFieldIds.includes(field)) return deny("DENIED_FIELD", "허용된 입력 필드가 아닙니다.");
      // 규칙만(결정적으로): 사용자 말은 턴 입구에서 이미 모델까지 거쳤다
      if (hasText(action.value) && detectSensitive(action.value).hasSecretValue) {
        return deny("DENIED_SECRET", "입력값에 민감 정보로 보이는 내용이 있어 입력하지 않았습니다.");
      }
    }
    // 위험도는 부르는 쪽이 높일 수만 있다: 동작 이름의 버튼은 낮게 적어 와도 승인을 받는다.
    if (action.risk !== "low" || action.requiresConfirmation || (action.type === "click" && this.riskyControl(target))) {
      return approveOrAsk(action, ctx, "사용자가 실행 전에 승인했습니다.", "실행 전에 사용자 승인이 필요합니다.");
    }
    return { allowed: true, code: "ALLOWED", reason: "허용된 저위험 조작입니다." };
  }

  private publicLookup(ctx: PolicyContext): boolean {
    return this.config.publicLookupOnly === true || ctx.publicLookup === true;
  }

  inspectionEnabled(ctx: PolicyContext): boolean {
    return ctx.browsingScope === "personal-inspection" && !this.publicLookup(ctx);
  }

  private checkInspection(action: Action, ctx: PolicyContext): PolicyDecision {
    const { type, target, value } = action;
    const proof = ctx.inspection;
    const refused = () => deny("DENIED_TASK_SCOPE", "이 화면의 내용을 확인하는 범위에서만 조작할 수 있어요.");
    const missing = () => deny("DENIED_INSPECTION_BINDING", "현재 화면에서 조작할 대상을 다시 확인하지 못했어요.");
    const allowed = { allowed: true, code: "ALLOWED_INSPECTION", reason: "화면 정보를 확인하는 조작입니다." };
    if (action.risk !== "low" || action.requiresConfirmation) return refused();
    if (type === "navigate") {
      return proof?.kind === "start" && action.url === proof.url && isInspectionUrl(proof.url) ? allowed : refused();
    }
    if (type === "read" || type === "scroll") return action.target === undefined ? allowed : refused();
    if (type === "back") return action.url === undefined && proof?.kind === "back" && proof.url === ctx.currentUrl ? allowed : refused();
    if (inputTypes.has(type) && (guardPatterns.secretLabel.test((target?.label ?? "") + " " + (target?.name ?? "")) ||
      target?.fieldId !== undefined && this.config.secretFieldIds.includes(target.fieldId) ||
      value !== undefined && detectSensitive(value).hasSecretValue)) {
      return deny("DENIED_SECRET", "민감 정보는 사이트에서 직접 입력해 주세요.");
    }
    if (type === "press") {
      if (proof?.kind !== "search" || proof.url !== ctx.currentUrl || !matchesInspectionSearchTarget(target, proof.fieldId, proof.field) ||
        action.url !== proof.destination ||
        !hasText(value) || [...value].length > 100 || detectSensitive(value).hasSecretValue || redactPictureText(value) !== value ||
        !searchParameter.test(proof.parameter) || secretParameter.test(proof.parameter) || endpointParameter.test(proof.parameter) ||
        !isInspectionUrl(proof.destination) || URL.parse(proof.destination)?.origin !== URL.parse(proof.url)?.origin) return refused();
      return allowed;
    }
    if (type !== "click") return refused();
    if (proof?.kind !== "control" || proof.url !== ctx.currentUrl || proof.ref !== target?.ref ||
      !hasText(target?.name) || Object.keys(target).length !== 3) return missing();
    const name = target.name;
    const control = proof.control;
    if (control.kind === "blocked" || control.href !== undefined && !isInspectionUrl(control.href) ||
      (guardPatterns.hardAction.test(name) && isActionName(name))) {
      return readOnly("신청·제출·동의 같은 동작은 누르지 않습니다.");
    }
    if ((control.kind === "navigation" || control.kind === "disclosure") && !guardPatterns.loginName.test(name)) return allowed;
    return ctx.inspectionApproved === true
      ? { allowed: true, code: "APPROVED", reason: "사용자가 이 화면에서 이 항목을 누르도록 확인했습니다." }
      : deny("NEEDS_CONFIRMATION", "이 항목을 누르기 전에 사용자 확인이 필요합니다.");
  }

  private riskyControl(target: Action["target"]): boolean {
    const name = target?.name ?? "";
    const role = target?.role;
    if (role === "link" || (role === "button" && this.config.safeButtons?.includes(name) === true)) return false;
    if (role === "tab" || role === "scriptlink") return isActionName(name);
    return guardPatterns.riskyButton.test(name);
  }

  /** 지원하지 않는 사이트: 읽고 이동하고 검색하는 것까지만. */
  private checkReadOnly(action: Action, ctx: PolicyContext): PolicyDecision {
    const { type, target, value } = action;
    const role = target?.role;
    const name = target?.name ?? "";
    // 실제 사이트의 일반 입력란은 사용자가 이 값을 확인·승인한 경우에만 채운다. 민감 정보 칸은 승인과 무관하게 거부한다.
    if (inputTypes.has(type) && role !== "searchbox") {
      if (guardPatterns.secretLabel.test((target?.label ?? "") + " " + name)
        || (hasText(value) && detectSensitive(value).hasSecretValue)) {
        return deny("DENIED_SECRET", "민감 정보 입력란은 사용자가 직접 입력해야 합니다.");
      }
      if (action.risk !== "sensitive" || !action.requiresConfirmation) return readOnly("입력은 사용자 확인을 받은 경우에만 합니다.");
      return approveOrAsk(action, ctx, "사용자가 이 입력을 확인했습니다.", "이 칸에 입력하기 전에 사용자 확인이 필요합니다.");
    }
    if (!readOnlyTypes.has(type)) return readOnly("입력·선택은 하지 않습니다.");
    if (action.risk !== "low" || action.requiresConfirmation) return readOnly("중요한 동작은 하지 않습니다.");
    if (type === "click") {
      const tier = (this.config.readOnlyClicks ?? "safe") === "safe" ? clickTier(role, name) : "free";
      if (tier === "hard") return readOnly("신청·제출·동의 같은 동작은 누르지 않습니다.");
      if (tier === "ask" && this.publicLookup(ctx)) return readOnly("정보를 찾는 동안에는 확인이 필요한 버튼을 누르지 않습니다.");
      // 내용만 알리는 안내 팝업의 '확인'은 증명(어댑터가 누르기 직전에 다시 확인)이 있을 때만 묻지 않는다.
      if (tier === "ask" && !guardPatterns.loginName.test(name) && noticeProven(ctx.notice, action, ctx.currentUrl)) {
        return { allowed: true, code: "ALLOWED_NOTICE", reason: "내용만 알리는 안내 팝업을 닫는 조작입니다." };
      }
      if (tier === "ask" || guardPatterns.loginName.test(name)) {
        return approveOrAsk(action, ctx, "사용자가 누르라고 확인했습니다.", "누르기 전에 사용자 확인이 필요합니다.");
      }
    }
    if (type === "fill" || type === "press") {
      if (role !== "searchbox") return readOnly("검색창에만 입력할 수 있습니다.");
      if (type === "press" && value !== "Enter") return readOnly("검색 실행(Enter)만 할 수 있습니다.");
      if (type === "fill" && (!hasText(value) || Array.from(value).length > 100 || detectSensitive(value).hasSecretValue)) {
        return deny("DENIED_SECRET", "검색어에 민감 정보로 보이는 내용이 있거나 너무 길어 입력하지 않았습니다.");
      }
    }
    return { allowed: true, code: "ALLOWED_READ_ONLY", reason: "읽기 전용 범위의 조작입니다." };
  }
}
