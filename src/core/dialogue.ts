import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Action, ActionTarget } from "./actions.ts";
import type { PlaceAsk } from "./places.ts";
import type { HumanAuthHandoff, PendingConfirmation, SessionState } from "./turn.ts";

export interface ApprovalFingerprint {
  page: string;
  speech: string;
  fields: { fieldId: string; label: string; valueHash?: string | null }[];
  actions: { type: Action["type"]; role?: string | null; name?: string | null; now?: Partial<ActionTarget> | null; valueHash?: string | null }[];
}

interface Confirmed { confirmation: PendingConfirmation }
interface Acting extends Confirmed {
  action: Action;
  fingerprint: ApprovalFingerprint;
  /** 검토를 거친 일(orchestrator/task_review.ts). 승인 뒤에 검토한 일이 이어지게 세션이 붙인다. */
  reviewedTask?: unknown;
}

/**
 * 승인 대기. kind가 없거나 "submit" = 모의접수 클릭, "assist" = 실제 사이트 입력란 채우기(제출은 사용자가 직접),
 * "click" = 확인받고 누르기, "file" = 받은 파일을 모델에 보내기, "visual" = 화면 사진으로 안내 링크 찾기, "research" = 공개 자료 조사.
 * 앞의 셋은 지문(fingerprint)으로 다시 확인하고, 뒤의 셋은 행동 없이 확인만 받는다.
 * Python은 모의접수에도 kind "submit"과 url을 늘 적는다. 아래 패키지가 옮길 때까지 이 둘은 비워 둘 수 있다.
 */
export type Approval =
  | (Acting & { kind?: "submit"; url?: string })
  | (Acting & { kind: "assist"; url?: string; actions: [Action, ...Action[]]; guided?: boolean })
  | (Acting & { kind: "click"; url: string; pageTitle?: string; then?: "login-open" | "login-submit" })
  | (Confirmed & { kind: "file"; record: unknown; digest: string; question: string })
  | (Confirmed & { kind: "visual"; imagePurpose?: "visualDescribe" | "visualOrient" | "visualLink"; goal: string; publicTask?: unknown; checkpoint: unknown })
  | (Confirmed & { kind: "research"; goal: string });

export interface GuardianContact { name: string; phone: string }
/** 보호자 문자 확인을 기다리는 명령(personal/guardian.ts가 만든다). 'at'은 물은 시각(초)이고 resume은 답한 뒤 돌아갈 세션 상태다. */
export type GuardianPending =
  | { kind: "guardian-save" | "guardian-clear"; contact: GuardianContact; at: number; resume: SessionState; confirmation?: undefined }
  | { kind: "guardian-send"; contact: GuardianContact; at: number; resume: SessionState; message: string; screen: string; confirmation?: undefined };

/** 저장·삭제 확인을 기다리는 금고 명령. askVaultConfirm이 금고 명령에는 확인 문구(confirmation)를 붙인다. */
export type VaultCommand =
  | { kind: "vault-clear"; confirmation?: PendingConfirmation }
  | { kind: "vault-save"; values: Partial<Record<"name" | "address" | "phone" | "email" | "birth", string>>; confirmation?: PendingConfirmation }
  | GuardianPending;

export type AuthResume = { kind: "form" | "guided" };

export interface Guided {
  url: string;
  fieldIds: string[];
  index: number;
  suggestion?: string;
  origin?: string;
  awaitSiteAllow?: boolean;
  skipVault?: boolean;
}

/** 어느 입력란인지 되묻는 중. 검토한 일이 있으면 세션이 reviewedTask와 reviewedUrl을 붙인다. */
export interface Clarification<Candidate> {
  value: string;
  candidates: Candidate[];
  reviewedTask?: unknown;
  reviewedUrl?: string;
}

/** 한 글자 다른 사이트 이름을 맞게 들었는지 묻는 중. 모양은 understanding/sites.ts가 정한다. */
export type SiteGuess = Readonly<Record<string, unknown>>;

/** 본인인증을 사용자에게 넘긴 일 하나. 끝나면 status를 바꾸고 브라우저(page) 참조를 놓는다. */
export class AuthHandoff {
  readonly id: string;
  readonly sessionId: string;
  readonly taskId: string;
  browser: object | null;
  readonly expectedOrigin: string;
  readonly expectedPath: string;
  readonly kind: HumanAuthHandoff["kind"];
  readonly deadline: number;
  readonly site: string;
  status: HumanAuthHandoff["status"];

  constructor(fields: {
    id: string; sessionId: string; taskId: string; browser: object | null; expectedOrigin: string; expectedPath: string;
    kind: HumanAuthHandoff["kind"]; deadline: number; site: string; status?: HumanAuthHandoff["status"];
  }) {
    this.id = fields.id;
    this.sessionId = fields.sessionId;
    this.taskId = fields.taskId;
    this.browser = fields.browser;
    this.expectedOrigin = fields.expectedOrigin;
    this.expectedPath = fields.expectedPath;
    this.kind = fields.kind;
    this.deadline = fields.deadline;
    this.site = fields.site;
    this.status = fields.status ?? "waiting";
  }

  public(): HumanAuthHandoff {
    return { id: this.id, taskId: this.taskId, kind: this.kind, status: this.status, site: this.site };
  }
}

function present(slot: string | undefined): boolean {
  return slot !== undefined && slot.length > 0;
}

/**
 * 세션당 하나. 밖에서는 읽기만 하고(setter 없음), 바꾸는 길은 아래 동작뿐이다.
 * 대기 자리는 서로 독립이라 동시에 둘 이상 설 수 있다(승인·값·되묻기·맞춤·장소·금고·칸 채우기·인증 인계 뒤 이어갈 일).
 * 멈춤은 대기를 비우고, 턴을 끝내는 쪽에서 상태를 확정한다.
 */
export class DialogueState<Candidate = { fieldId: string; label: string }> {
  #state: SessionState;
  #clock: () => number;
  #approval?: Approval;
  #approvalAt = 0;
  #awaiting?: string;
  #clarification?: Clarification<Candidate>;
  #profileQuestion?: string;
  #placeAsk?: PlaceAsk;
  #vaultConfirm?: VaultCommand;
  #guided?: Guided;
  #authResume?: AuthResume;
  #authHandoff?: AuthHandoff;
  #siteGuess?: SiteGuess;
  #firstRun?: string;

  constructor(state: SessionState, clock: () => number = () => performance.now() / 1000) {
    this.#state = state;
    this.#clock = clock;
  }

  get state() { return this.#state; }
  get approval() { return this.#approval; }
  get approvalAge() { return this.#approval === undefined ? 0 : this.#clock() - this.#approvalAt; }
  /** 승인 대기, 없으면 금고 확인 대기의 확인 문구(스냅샷·TurnResult의 pendingConfirmation) */
  get confirmation() { return (this.#approval ?? this.#vaultConfirm)?.confirmation; }
  get expectsConfirmation() { return this.#approval !== undefined || this.#state === "WAITING_FOR_USER_CONFIRMATION"; }
  get awaiting() { return this.#awaiting; }
  get clarification() { return this.#clarification; }
  get profileQuestion() { return this.#profileQuestion; }
  get placeAsk() { return this.#placeAsk; }
  get vaultConfirm() { return this.#vaultConfirm; }
  get guided() { return this.#guided; }
  get authResume() { return this.#authResume; }
  get authHandoff() { return this.#authHandoff; }
  get authWaiting() { return this.#authHandoff !== undefined && this.#authHandoff.status === "waiting"; }
  /** 첫 실행 설정 3단계에서 지금 묻는 것(mic·name·name-confirm·stop·intro·practice) */
  get firstRun() { return this.#firstRun; }
  get hasPendingInteraction() {
    return this.#approval !== undefined || present(this.#awaiting) || this.#clarification !== undefined || this.#siteGuess !== undefined ||
      present(this.#profileQuestion) || present(this.#firstRun) || this.#placeAsk !== undefined || this.#vaultConfirm !== undefined ||
      this.#guided !== undefined || this.authWaiting;
  }

  commit(state: SessionState) { this.#state = state; }

  /** 멈춤: 기다리던 것을 모두 지운다. 멈춘 뒤의 "응"이 예전 질문의 대답으로 쓰이지 않게. preserveAuth면 인증 인계는 그대로 둔다. */
  stop({ preserveAuth = false }: { preserveAuth?: boolean } = {}) {
    this.#approval = undefined;
    this.#awaiting = undefined;
    this.#clarification = undefined;
    this.#profileQuestion = undefined;
    this.#firstRun = undefined;
    this.#placeAsk = undefined;
    this.#vaultConfirm = undefined;
    this.#guided = undefined;
    this.#siteGuess = undefined;
    if (!preserveAuth) this.finishAuth("cancelled");
  }

  /** 실행 직전 승인을 물었다. 다시 물으면 시간도 새로 재고, 같은 문구를 다시 물으면 새 확인 번호를 단다. */
  askApproval(approval: Approval) {
    const repeated = this.#approval !== undefined && isDeepStrictEqual(this.confirmation, approval.confirmation);
    this.#approval = repeated ? { ...approval, confirmation: { ...approval.confirmation, actionId: randomUUID() } } : approval;
    this.#vaultConfirm = undefined;
    this.#approvalAt = this.#clock();
  }

  clearApproval() { this.#approval = undefined; }
  askValue(fieldId: string) { this.#awaiting = fieldId; }
  dropValueWait() { this.#awaiting = undefined; }
  valueFilled(fieldId: string) {
    if (fieldId === this.#awaiting) this.#awaiting = undefined;
    this.#approval = undefined;
  }

  navigated(onForm: boolean) {
    this.#approval = undefined;
    if (!onForm) this.#awaiting = undefined;
  }

  askWhich(value: string, candidates: Candidate[]) { this.#clarification = { value, candidates }; }
  clearChoice() { this.#clarification = undefined; }

  /** '복지루'처럼 한 글자 다른 사이트 이름을 '복지로' 말씀이세요? 하고 물었다. */
  askSite(guess: SiteGuess) { this.#siteGuess = guess; }
  takeSiteGuess() {
    const guess = this.#siteGuess;
    this.#siteGuess = undefined;
    return guess;
  }

  askFirstRun(step: string) { this.#firstRun = step; }
  endFirstRun() { this.#firstRun = undefined; }

  askProfile(slot: string) {
    this.#profileQuestion = slot;
    this.#placeAsk = undefined;
  }

  profileDone() { this.#profileQuestion = undefined; }

  askPlace(ask: PlaceAsk | undefined) {
    this.#profileQuestion = undefined;
    this.#placeAsk = ask;
  }

  takePlaceAsk() {
    const ask = this.#placeAsk;
    this.#placeAsk = undefined;
    return ask;
  }

  /** 금고 저장·삭제를 해도 되는지 물었다. 금고 명령에는 확인 문구를 새로 붙인다. */
  askVaultConfirm(command: VaultCommand) {
    this.#vaultConfirm = command.kind === "vault-save" || command.kind === "vault-clear" ? {
      ...command,
      confirmation: {
        actionId: randomUUID(), kind: command.kind, purpose: command.kind === "vault-save" ? "내 정보 저장" : "내 정보 삭제",
        site: "청음", values: [], realSubmission: false,
      },
    } : command;
    this.#approval = undefined;
  }

  takeVaultConfirm() {
    const command = this.#vaultConfirm;
    this.#vaultConfirm = undefined;
    return command;
  }

  startGuided(url: string, fieldIds: string[]) { this.#guided = { url, fieldIds, index: 0 }; }
  endGuided() { this.#guided = undefined; }

  /** 인증 안내가 끝났다. 기다리던 중이었다면 끝난 이유를 남기고 브라우저 참조를 놓는다. 이어갈 일도 접는다. */
  finishAuth(status: HumanAuthHandoff["status"]) {
    if (this.#authHandoff !== undefined && this.authWaiting) {
      this.#authHandoff.status = status;
      this.#authHandoff.browser = null;
    }
    this.#authResume = undefined;
  }

  /** 본인인증을 사용자에게 넘긴다. 끝나면 이어서 할 일(resume)이 있으면 함께 둔다. */
  holdAuth(resume?: AuthResume, handoff?: AuthHandoff) {
    this.#authResume = resume;
    this.#authHandoff = handoff;
    this.clearApproval();
    this.dropValueWait();
    this.#vaultConfirm = undefined;
  }

  takeAuthResume() {
    const resume = this.#authResume;
    this.#authResume = undefined;
    return resume;
  }

  clearAuthResume() { this.#authResume = undefined; }
}
