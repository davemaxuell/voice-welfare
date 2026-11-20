import { parseAction, type Action, type ActionType } from "../core/actions.ts";
import type { PolicyDecision } from "../core/turn.ts";
import { hasText, strip } from "../core/text.ts";
import { tryUrl } from "../core/url.ts";
import { detectSensitive } from "./privacy.ts";

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
  actionLimit?: number;
}
export type ClickTier = "free" | "ask" | "hard";

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
    if (this.publicLookup(ctx)) {
      const role = action.target?.role;
      const name = action.target?.name ?? "";
      if (action.risk !== "low" || action.requiresConfirmation
        || action.type === "capture" || action.type === "select" || action.type === "check"
        || ((action.type === "fill" || action.type === "press") && role !== "searchbox")
        || (action.type === "click" && (role === undefined || !clickRoles.has(role) || name.length === 0
          || isActionName(name) || guardPatterns.loginName.test(name)))) {
        return deny("DENIED_TASK_SCOPE", "정보를 찾는 요청으로는 이 동작을 할 수 없어요.");
      }
      return this.checkReadOnly(action, ctx);
    }
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
