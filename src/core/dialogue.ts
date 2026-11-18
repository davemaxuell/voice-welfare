import type { Action, ActionTarget } from "./actions.ts";
import type { PendingConfirmation, SessionState } from "./turn.ts";

export interface ApprovalFingerprint {
  page: string;
  speech: string;
  fields: { fieldId: string; label: string; valueHash?: string }[];
  actions: { type: Action["type"]; role?: string; name?: string; now?: ActionTarget; valueHash?: string }[];
}

type Approval = { action: Action; confirmation: PendingConfirmation; fingerprint: ApprovalFingerprint } & (
  | { kind?: undefined }
  | { kind: "assist"; actions: [Action, ...Action[]]; guided?: boolean }
  | { kind: "click"; url: string; then?: "login-open" | "login-submit" }
);
type VaultCommand = { kind: "vault-clear" } | {
  kind: "vault-save";
  values: Partial<Record<"name" | "address" | "phone" | "email" | "birth", string>>;
};
type AuthResume = { kind: "form" | "guided" };
interface Guided {
  url: string;
  fieldIds: string[];
  index: number;
  suggestion?: string;
  origin?: string;
  awaitSiteAllow?: boolean;
  skipVault?: boolean;
}

/** 상태와 독립인 대기 자리들. 멈춤은 대기를 비우고, 턴을 끝내는 쪽에서 상태를 확정한다. */
export class DialogueState<Candidate = { fieldId: string; label: string }> {
  #state: SessionState;
  #clock: () => number;
  #approval?: Approval;
  #approvalAt = 0;
  #awaiting?: string;
  #clarification?: { value: string; candidates: Candidate[] };
  #profileQuestion?: string;
  #vaultConfirm?: VaultCommand;
  #guided?: Guided;
  #authResume?: AuthResume;

  constructor(state: SessionState, clock: () => number = () => performance.now() / 1000) {
    this.#state = state;
    this.#clock = clock;
  }

  get state() { return this.#state; }
  get approval() { return this.#approval; }
  get approvalAge() { return this.#approval === undefined ? 0 : this.#clock() - this.#approvalAt; }
  get confirmation() { return this.#approval?.confirmation; }
  get expectsConfirmation() { return this.#approval !== undefined || this.#state === "WAITING_FOR_USER_CONFIRMATION"; }
  get awaiting() { return this.#awaiting; }
  get clarification() { return this.#clarification; }
  get profileQuestion() { return this.#profileQuestion; }
  get vaultConfirm() { return this.#vaultConfirm; }
  get guided() { return this.#guided; }
  get authResume() { return this.#authResume; }

  commit(state: SessionState) { this.#state = state; }
  stop() {
    this.#approval = undefined;
    this.#awaiting = undefined;
    this.#clarification = undefined;
    this.#profileQuestion = undefined;
    this.#vaultConfirm = undefined;
    this.#guided = undefined;
    this.#authResume = undefined;
  }

  askApproval(approval: Approval) {
    this.#approval = approval;
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
  askProfile(slot: string) { this.#profileQuestion = slot; }
  profileDone() { this.#profileQuestion = undefined; }
  askVaultConfirm(command: VaultCommand) { this.#vaultConfirm = command; }
  takeVaultConfirm() {
    const command = this.#vaultConfirm;
    this.#vaultConfirm = undefined;
    return command;
  }

  startGuided(url: string, fieldIds: string[]) { this.#guided = { url, fieldIds, index: 0 }; }
  endGuided() { this.#guided = undefined; }
  holdAuth(resume?: AuthResume) { this.#authResume = resume; }
  takeAuthResume() {
    const resume = this.#authResume;
    this.#authResume = undefined;
    return resume;
  }

  clearAuthResume() { this.#authResume = undefined; }
}
