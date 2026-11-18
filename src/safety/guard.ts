import { parseAction, type Action, type ActionType } from "../core/actions.ts";
import type { PolicyDecision } from "../core/turn.ts";
import { strip } from "../core/text.ts";
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
}
export interface PolicyContext {
  currentUrl?: string;
  stopped?: boolean;
  approvals?: ReadonlySet<string>;
  actionsThisTurn?: number;
}

export const guardPatterns = {
  secretLabel: /(비밀\p{White_Space}*번호|password|OTP|인증\p{White_Space}*번호|주민\p{White_Space}*(등록)?\p{White_Space}*번호|계좌|카드\p{White_Space}*번호)/iu,
  loginName: /(로그인|log\p{White_Space}*-?\p{White_Space}*[iİ]n|s[iİ]gn\p{White_Space}*-?\p{White_Space}*[iİ]n)/iu,
  riskyButton: /(신청|제출|접수|등록|삭제|결제|송금|이체|구매|주문|동의|승인|확인|저장|보내기|전송|발송|로그인|로그아웃|탈퇴|가입|변경|수정|취소|인증|업로드|첨부|발급|예약|투표|좋아요|구독|subm[iİ]t|send|pay|buy|order|delete|conf[iİ]rm|log[iİ]n|s[iİ]gn)/iu,
  actionAnywhere: /하기(?![가-힣])|탈퇴|결제|송금|이체|삭제|구매|주문|로그인|로그아웃|회원\p{White_Space}*가입|(?<![a-zİ])(pay|buy|order|delete|subm[iİ]t|log\p{White_Space}*([iİ]n|out)|s[iİ]gn\p{White_Space}*([iİ]n|up|out))(?![a-zİ])/iu,
  actionEnding: /(신청|제출|접수|등록|동의|승인|확인|저장|보내기|전송|발송|변경|수정|취소|인증|업로드|첨부|발급|예약|투표|좋아요|구독|가입|합니다|하세요|(?<![a-zİ])(send|conf[iİ]rm|save|apply|ok))(?=\n?$)/iu,
  trailingNoise: /(\p{White_Space}*(새\p{White_Space}*창(\p{White_Space}*열림)?|[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}가-힣]+))+(?=\n?$)/gu,
  spaces: /\p{White_Space}+/gu,
};

const inputTypes: ReadonlySet<ActionType> = new Set(["fill", "select", "check"]);
const readOnlyTypes: ReadonlySet<ActionType> = new Set(["navigate", "back", "click", "fill", "press", "scroll", "read", "focus"]);

export function isActionName(name: string): boolean {
  const trimmed = strip(name.replace(guardPatterns.spaces, " ")).replace(guardPatterns.trailingNoise, "");
  return guardPatterns.actionAnywhere.test(trimmed) || guardPatterns.actionEnding.test(trimmed);
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
    if ((ctx.actionsThisTurn ?? 0) >= this.config.maxActionsPerTurn) return deny("DENIED_RATE_LIMIT", "한 번의 요청에서 허용된 조작 횟수를 넘었습니다.");
    if (!this.config.allowedActionTypes.includes(action.type)) return deny("DENIED_ACTION_TYPE", `허용되지 않은 액션 유형(${action.type})입니다.`);

    if (action.type === "navigate" && action.url === undefined) return deny("DENIED_ORIGIN", "이동할 주소가 없습니다.");
    const tier = this.tierOf(action.type === "navigate" ? action.url : ctx.currentUrl);
    if (tier === "none") return deny("DENIED_ORIGIN", "허용되지 않은 주소라서 열거나 조작하지 않습니다.");
    if (tier === "read-only") return this.checkReadOnly(action, ctx);

    const target = action.target;
    if (inputTypes.has(action.type)) {
      const field = target?.fieldId;
      if (field !== undefined && this.config.secretFieldIds.includes(field)) {
        return deny("DENIED_SECRET", "비밀번호 등 인증 정보는 에이전트가 입력하지 않습니다.");
      }
      if (guardPatterns.secretLabel.test(target?.label ?? "")) return deny("DENIED_SECRET", "민감 정보 입력란은 사용자가 직접 입력해야 합니다.");
      if (field === undefined || !this.config.allowedFieldIds.includes(field)) return deny("DENIED_FIELD", "허용된 입력 필드가 아닙니다.");
      if (action.value !== undefined && detectSensitive(action.value).hasSecretValue) {
        return deny("DENIED_SECRET", "입력값에 민감 정보로 보이는 내용이 있어 입력하지 않았습니다.");
      }
    }
    const button = target?.name ?? "";
    const riskyButton = action.type === "click" && target?.role === "button" && guardPatterns.riskyButton.test(button)
      && this.config.safeButtons?.includes(button) !== true;
    if (action.risk !== "low" || action.requiresConfirmation || riskyButton) {
      return approveOrAsk(action, ctx, "사용자가 실행 전에 승인했습니다.", "실행 전에 사용자 승인이 필요합니다.");
    }
    return { allowed: true, code: "ALLOWED", reason: "허용된 저위험 조작입니다." };
  }

  private checkReadOnly(action: Action, ctx: PolicyContext): PolicyDecision {
    const { type, target, value } = action;
    const role = target?.role;
    const name = target?.name ?? "";
    if (inputTypes.has(type) && role !== "searchbox") {
      if (guardPatterns.secretLabel.test((target?.label ?? "") + " " + name)
        || (value !== undefined && detectSensitive(value).hasSecretValue)) {
        return deny("DENIED_SECRET", "민감 정보 입력란은 사용자가 직접 입력해야 합니다.");
      }
      if (action.risk !== "sensitive" || !action.requiresConfirmation) return readOnly("입력은 사용자 확인을 받은 경우에만 합니다.");
      return approveOrAsk(action, ctx, "사용자가 이 입력을 확인했습니다.", "이 칸에 입력하기 전에 사용자 확인이 필요합니다.");
    }
    if (!readOnlyTypes.has(type)) return readOnly("입력·선택은 하지 않습니다.");
    if (action.risk !== "low" || action.requiresConfirmation) return readOnly("중요한 동작은 하지 않습니다.");
    if (type === "click") {
      if ((role === "button" || role === "link") && guardPatterns.loginName.test(name)) {
        return approveOrAsk(action, ctx, "사용자가 누르라고 확인했습니다.", "로그인 버튼은 누르기 전에 사용자 확인이 필요합니다.");
      }
      if ((this.config.readOnlyClicks ?? "safe") === "safe") {
        if (role === "tab" || role === "scriptlink") {
          if (name.length === 0 || isActionName(name)) return readOnly("신청하기·탈퇴 같은 동작 이름은 누르지 않습니다.");
        } else if (role === "button" || role === "menuitem") {
          if (name.length === 0 || guardPatterns.riskyButton.test(name)) return readOnly("신청·제출·동의 같은 동작 버튼은 누르지 않습니다.");
        } else if (role !== "link") {
          return readOnly("링크와 이동용 버튼만 누를 수 있습니다.");
        }
      }
    }
    if (type === "fill" || type === "press") {
      if (role !== "searchbox") return readOnly("검색창에만 입력할 수 있습니다.");
      if (type === "press" && value !== "Enter") return readOnly("검색 실행(Enter)만 할 수 있습니다.");
      if (type === "fill" && (value === undefined || value.length === 0 || Array.from(value).length > 100 || detectSensitive(value).hasSecretValue)) {
        return deny("DENIED_SECRET", "검색어에 민감 정보로 보이는 내용이 있거나 너무 길어 입력하지 않았습니다.");
      }
    }
    return { allowed: true, code: "ALLOWED_READ_ONLY", reason: "읽기 전용 범위의 조작입니다." };
  }
}
