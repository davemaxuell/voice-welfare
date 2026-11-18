import type { Action } from "../../../core/actions.ts";
import type { DialogueState } from "../../../core/dialogue.ts";
import type { Fill } from "../../../core/intents.ts";
import { hasText, strip } from "../../../core/text.ts";
import { AGENT_IDS, draft, type Draft, type PendingConfirmation } from "../../../core/turn.ts";
import { tryUrl } from "../../../core/url.ts";
import { maskValue } from "../../../safety/privacy.ts";
import { josa, readback, speakLabel } from "../../../speech/phrasing.ts";
import type { Narrator } from "../../../speech/screen.ts";
import type { ExecContext, PageView, WebExecutionAgent, WebOutcome } from "../agent.ts";
import { fingerprint } from "../approval.ts";
import type { FieldProfile } from "../profile.ts";
import { askAgain, browseState, fillConfirmed, isFormOpen, notOpen, outcomeFailure } from "./common.ts";

export function nextStep(view: PageView): {speech: string; fieldId?: string} {
  const step = view.step;
  if (view.pageId !== "mock-welfare" || step === undefined || hasText(view.status)) return {speech: ""};
  const empty = view.fields.filter(f => f.visible && !f.filled && f.type !== "checkbox");
  const required = empty.find(f => f.required);
  if (required) return {speech: `${josa(speakLabel(required.label), "을", "를")} 말씀해 주세요.`, fieldId: required.fieldId};
  if (step.index < step.total) {
    const optional = empty.filter(f => !f.required).map(f => speakLabel(f.label));
    if (optional.length > 0) return {speech: `${josa(optional.join(", "), "은", "는")} 선택이에요. 넣으려면 '${optional[0]}는 …'처럼 말하고, 넘어가려면 '다음으로'라고 해 주세요.`};
    return {speech: "다음 단계로 가려면 '다음으로'라고 해 주세요."};
  }
  return {speech: ""};
}

export function requestAssist(dialogue: Pick<DialogueState, "askApproval">, view: PageView,
  actions: [Action, ...Action[]], values: PendingConfirmation["values"], site: string, speech: string, guided?: boolean): Draft {
  const action = actions[0];
  dialogue.askApproval({kind: "assist", action, actions, guided,
    confirmation: {actionId: action.id, purpose: "실제 사이트 입력란 채우기(제출은 하지 않음)", site, values, realSubmission: false},
    fingerprint: fingerprint(view, actions, speech)});
  return draft("WAITING_FOR_USER_CONFIRMATION", "prepare-submit", speech, {view});
}

export class FormSkill {
  readonly web: WebExecutionAgent;
  readonly dialogue: DialogueState<FieldProfile>;
  readonly narrator: Narrator;
  #lastFieldId?: string;
  constructor(web: WebExecutionAgent, dialogue: DialogueState<FieldProfile>, narrator: Narrator) {
    this.web = web; this.dialogue = dialogue; this.narrator = narrator;
  }

  get lastFieldId() { return this.#lastFieldId; }
  fieldExplained(fieldId: string) { this.#lastFieldId = fieldId; }
  formState() {
    return this.dialogue.state === "WAITING_FOR_USER_CONFIRMATION" && this.dialogue.approval !== undefined ? "WAITING_FOR_USER_CONFIRMATION" : "APPLICATION_OPEN";
  }
  askNext(view: PageView): string {
    const {fieldId, speech} = nextStep(view);
    if (fieldId !== undefined) this.dialogue.askValue(fieldId);
    return speech;
  }

  async #assistFillRequest(fills: readonly Fill[], ctx: ExecContext): Promise<Draft> {
    const view = await this.web.observe(ctx);
    const actions: Action[] = [];
    const values: PendingConfirmation["values"] = [];
    for (const f of fills) {
      const found = this.web.assistCandidates(f.fieldMention, view);
      const field = found[0];
      if (!field) return draft(this.dialogue.state, "clarify", `'${f.fieldMention}' 칸을 화면에서 찾지 못했어요. '화면 설명해줘'라고 하시면 입력 칸을 알려 드려요.`, {view});
      if (found.length > 1) return draft(this.dialogue.state, "clarify",
        `'${f.fieldMention}'에 맞는 칸이 여러 개예요: ${found.slice(0, 4).map(x => x.label).join(", ")}. 정확한 칸 이름을 말씀해 주세요.`, {view});
      actions.push(this.web.buildAssistAction(field, f.value));
      values.push({label: speakLabel(field.label), value: f.value});
    }
    const [first, ...rest] = actions;
    if (!first) throw new Error("입력할 항목이 없습니다.");
    const site = tryUrl(view.url)?.host ?? view.url;
    const listed = values.map(v => `${v.label} 칸에 "${v.value}"`).join(", ");
    return requestAssist(this.dialogue, view, [first, ...rest], values, site, `${listed}, 이렇게 넣을까요? 맞으면 '응', 아니면 '아니'라고 해 주세요.`);
  }

  async fill(fills: readonly Fill[], ctx: ExecContext): Promise<Draft> {
    const current = this.web.currentView;
    if (!isFormOpen(current)) return current?.pageId === "external" ? this.#assistFillRequest(fills, ctx) : notOpen(current, this.dialogue.state);
    const drafts: Draft[] = [];
    for (const f of fills) {
      const resolved = this.#resolve(f.fieldMention, f.value);
      const result = "fieldId" in resolved ? await this.fillOne(resolved, f.value, ctx) : resolved;
      drafts.push(result);
      if (result.state !== "APPLICATION_OPEN") break;
    }
    const last = drafts.at(-1);
    if (!last) throw new Error("입력할 항목이 없습니다.");
    const brief = (d: Draft) => d.summary ?? d.speech;
    return {...last, actions: drafts.flatMap(d => d.actions ?? []), speech: [...drafts.slice(0, -1).map(brief), last.speech].join(" "),
      summary: drafts.map(brief).join(" ")};
  }

  #resolve(mention: string, value?: string, forRead = false): Draft | FieldProfile {
    const r = this.web.resolveField(mention);
    if (r.kind === "ok") return r.field;
    if (r.kind === "ambiguous") {
      if (hasText(value)) this.dialogue.askWhich(value, r.candidates);
      const names = r.candidates.map(c => speakLabel(c.label)).join(", ");
      return draft("NEEDS_CLARIFICATION", "clarify", `'${mention}' 입력란이 ${r.candidates.length}개 있습니다: ${names}. 어느 쪽인지 말씀해 주세요. 확인 전에는 입력하지 않습니다.`);
    }
    if (r.kind === "not-visible") {
      const f = r.field;
      if (forRead) return f;
      return draft(this.formState(), "none", f.fieldId === "residenceAddress" ? "실거주지 주소 입력란은 '실거주지가 달라'라고 말씀하시면 나타납니다."
        : `${speakLabel(f.label)} 항목은 ${f.step}단계에 있습니다. '이전으로' 또는 '다음으로'라고 말해 이동해 주세요.`, {field: f.fieldId});
    }
    return draft(this.dialogue.state, "none", `'${mention}' 항목을 이 신청서에서 찾지 못했습니다.`);
  }

  async fillOne(field: FieldProfile, raw: string, ctx: ExecContext): Promise<Draft> {
    const out = await this.web.fill(field, raw, ctx);
    const label = speakLabel(field.label);
    if (out.status === "needs-clarification") {
      this.dialogue.askValue(field.fieldId);
      return draft("NEEDS_CLARIFICATION", "clarify", `${label}: ${hasText(out.message) ? out.message : "다시 말씀해 주세요."}`, {field: field.fieldId, actions: out.actions, view: out.view});
    }
    if (out.status !== "ok") return outcomeFailure(out, this.formState());
    this.dialogue.valueFilled(field.fieldId);
    this.#lastFieldId = field.fieldId;
    const value = out.readValue ?? "";
    const shown = readback(field, value);
    const guide = out.view ? this.askNext(out.view) : "";
    return draft("APPLICATION_OPEN", "fill", fillConfirmed(label, shown, guide), {field: field.fieldId, value, actions: out.actions, view: out.view,
      verification: {fieldValueMatches: true}, masked: field.maskOnReadback, summary: fillConfirmed(label, shown)});
  }

  async readField(mention: string, ctx: ExecContext): Promise<Draft> {
    if (!isFormOpen(this.web.currentView)) return notOpen(this.web.currentView, this.dialogue.state);
    const field = this.#resolve(mention, undefined, true);
    if (!("fieldId" in field)) return field;
    const out = await this.web.read(field, ctx);
    if (out.status !== "ok") return outcomeFailure(out, this.formState());
    this.#lastFieldId = field.fieldId;
    const value = out.readValue ?? "";
    const label = speakLabel(field.label);
    const subject = josa(label, "은", "는");
    return draft(this.formState(), "read", value.length > 0 ? `${subject} "${readback(field, value)}"입니다. 틀렸으면 '${label} 수정해'라고 말씀해 주세요.`
      : `${subject} 아직 비어 있습니다.`, {field: field.fieldId, actions: out.actions, view: out.view, masked: field.maskOnReadback});
  }

  async editField(mention: string, ctx: ExecContext): Promise<Draft> {
    if (!isFormOpen(this.web.currentView)) return notOpen(this.web.currentView, this.dialogue.state);
    const field = this.#resolve(mention, undefined, true);
    if (!("fieldId" in field)) return field;
    const view = await this.web.observe(ctx);
    const observed = this.web.observedField(field.fieldId, view);
    const label = speakLabel(field.label);
    if (observed?.visible !== true) return draft(this.formState(), "none",
      `${label} 항목은 ${field.step}단계에 있습니다. 먼저 '이전으로'라고 말해 이동한 뒤 수정해 주세요.`, {field: field.fieldId, view});
    this.dialogue.askValue(field.fieldId);
    this.dialogue.clearApproval();
    const object = josa(label, "을", "를");
    return draft("AWAITING_FIELD_VALUE", "edit-field", observed.value.length > 0
      ? `${object} 수정합니다. 현재 값은 "${readback(field, observed.value)}"입니다. 새 값을 말씀해 주세요.` : `${object} 입력합니다. 값을 말씀해 주세요.`,
      {field: field.fieldId, view});
  }

  async next(ctx: ExecContext): Promise<Draft> {
    if (!isFormOpen(this.web.currentView)) return notOpen(this.web.currentView, this.dialogue.state);
    return this.#afterStepMove(await this.web.next(ctx), "navigate-next");
  }

  async prev(ctx: ExecContext): Promise<Draft> {
    if (!isFormOpen(this.web.currentView)) return notOpen(this.web.currentView, this.dialogue.state);
    const out = await this.web.prev(ctx);
    if (out.status === "ok" && out.atFirstStep === true && out.view) return draft(this.formState(), "navigate-prev", `첫 단계입니다. ${this.narrator.describeView(out.view)}`, {view: out.view});
    return this.#afterStepMove(out, "navigate-prev");
  }

  #afterStepMove(out: WebOutcome, semantic: "navigate-next" | "navigate-prev" | "prepare-submit"): Draft {
    if (out.status === "validation-error" && out.view) {
      const missing = out.missing ?? [];
      const first = missing[0];
      if (first) this.dialogue.askValue(first.fieldId);
      const details = missing.map(m => m.label + (hasText(m.error) ? `(사이트 안내: ${m.error})` : "")).join(", ");
      const guide = first ? ` 먼저 ${first.label} 값을 말씀해 주세요.` : "";
      return draft("VALIDATION_ERROR", semantic, `다음 단계로 넘어가지 못했습니다. 확인이 필요한 항목: ${details.length > 0 ? details : "화면의 오류 메시지를 확인해 주세요"}.${guide}`,
        {actions: out.actions, view: out.view, missingFields: missing.map(m => m.label)});
    }
    if (out.status === "needs-clarification") return draft("NEEDS_CLARIFICATION", semantic, hasText(out.message) ? out.message : "확인이 필요합니다.", {actions: out.actions, view: out.view});
    if (out.status !== "ok" || !out.view) return outcomeFailure(out, this.formState());
    if (out.atLastStep === true) return draft(this.formState(), semantic, "마지막 검토 단계입니다. 내용을 확인했으면 '모의 접수 내용을 확인했어'라고 말씀해 주세요.", {actions: out.actions, view: out.view});
    this.dialogue.dropValueWait();
    const guide = this.askNext(out.view);
    const popup = out.dismissedDialogs !== undefined && out.dismissedDialogs.length > 0 ? `안내 팝업 '${out.dismissedDialogs.join("', '")}'이 떠서 닫았어요. ` : "";
    const moved = semantic === "navigate-next" ? "다음 단계로 넘어갔어요." : "이전 단계로 돌아왔어요.";
    return draft("APPLICATION_OPEN", semantic, strip(`${moved} ${popup}${this.narrator.describeView(out.view)} ${guide}`), {actions: out.actions, view: out.view,
      verification: semantic === "navigate-next" ? {requiredFieldsComplete: out.requiredFieldsComplete === true} : undefined, summary: popup + moved});
  }

  #reviewValues(view: PageView) {
    return view.fields.filter(f => !f.sensitive && f.filled && f.type !== "checkbox").map(f => {
      const profile = this.web.field(f.fieldId);
      return {label: speakLabel(f.label), value: profile ? readback(profile, f.value) : maskValue(f.value)};
    });
  }

  async review(ctx: ExecContext): Promise<Draft> {
    if (!isFormOpen(this.web.currentView)) return notOpen(this.web.currentView, this.dialogue.state);
    const view = await this.web.observe(ctx);
    const values = this.#reviewValues(view);
    const missing = view.fields.filter(f => f.required && !f.filled).map(f => speakLabel(f.label));
    const head = values.length > 0 ? `지금까지 입력한 내용입니다. ${values.map(v => `${v.label}: ${v.value}`).join(". ")}.` : "아직 입력한 내용이 없습니다.";
    return draft(this.formState(), "review", head + ` 비어 있는 필수 항목: ${missing.length > 0 ? missing.join(", ") : "없음"}. 연락처 등은 일부를 가려서 읽었고, 비밀번호 같은 보안 정보는 읽지 않습니다.`, {view, masked: true, missingFields: missing});
  }

  async prepareSubmit(ctx: ExecContext): Promise<Draft> {
    if (!isFormOpen(this.web.currentView)) return notOpen(this.web.currentView, this.dialogue.state);
    ctx.trace("PLANNING", AGENT_IDS.orchestrator, "검토 단계로 이동 후 승인 요청");
    const out = await this.web.goToFinalStep(ctx);
    if (out.status !== "ok" || !out.view) return this.#afterStepMove(out, "prepare-submit");
    const action = this.web.buildSubmitAction();
    const preview = this.web.previewPolicy(action, ctx);
    const values = this.#reviewValues(out.view);
    const listed = values.map(v => `${v.label}: ${v.value}`).join(". ");
    const speech = `검토 단계입니다. 모의접수할 내용: ${listed}. 이 내용으로 모의접수할까요? 실제 복지로 접수가 아니며 어디에도 전송되지 않습니다. 승인하려면 '모의접수 승인', 그만두려면 '거절'이라고 말씀하세요. 항목을 고치려면 해당 항목을 말씀하세요.`;
    this.dialogue.askApproval({action, confirmation: {actionId: action.id, purpose: "장애인연금 모의 신청서 모의접수 (실제 제출 아님)",
      site: `${this.web.profile.name} (${this.web.profile.origin}, 로컬)`, values, realSubmission: false},
      fingerprint: fingerprint(out.view, [action], speech, out.view.fields.map(f => f.fieldId))});
    this.dialogue.dropValueWait();
    return draft("WAITING_FOR_USER_CONFIRMATION", "prepare-submit", speech, {actions: [...out.actions, preview], view: out.view, masked: true});
  }

  async assistApproved(actions: Action[], ctx: ExecContext): Promise<Draft> {
    const out = await this.web.assistFill(actions, ctx);
    if (out.status === "unconfirmed") return askAgain(out, "fill", "다시 넣으려면 '응', 그만두려면 '아니'라고 해 주세요.");
    this.dialogue.clearApproval();
    if (out.status !== "ok" || !out.view) return outcomeFailure(out, "BROWSING");
    return draft(browseState(out.view), "fill", "넣고 확인했어요. 제출이나 신청 버튼은 직접 눌러 주세요. 다른 칸도 말씀하시면 같은 방식으로 도와드릴게요.", {actions: out.actions, view: out.view});
  }

  async submitApproved(action: Action, ctx: ExecContext): Promise<Draft> {
    const out = await this.web.submitApproved(action, ctx);
    if (out.status === "unconfirmed") return askAgain(out, "submit", "다시 하려면 '승인', 그만두려면 '거절'이라고 말씀해 주세요.");
    if (out.status !== "ok") return outcomeFailure(out, "WAITING_FOR_USER_CONFIRMATION");
    this.dialogue.clearApproval();
    return draft("MOCK_SUBMITTED", "submit", `모의접수를 마쳤습니다. 모의 접수번호는 ${out.receipt}입니다. 실제 복지로 접수가 아니며 어떤 기관에도 전송되지 않았습니다.`,
      {actions: out.actions, view: out.view, verification: {receipt: out.receipt}, value: out.receipt});
  }

  reject(): Draft {
    const approval = this.dialogue.approval;
    if (!approval) return draft(this.dialogue.state, "reject", "거절할 승인 요청이 없어요.");
    this.dialogue.clearApproval();
    if (approval.kind === "assist") return draft("BROWSING", "reject", "넣지 않았어요. 다시 말씀해 주세요.");
    if (approval.kind === "click") return draft(this.web.currentView ? browseState(this.web.currentView) : "IDLE", "reject", "누르지 않았어요. 화면은 그대로예요.");
    return draft("APPLICATION_OPEN", "reject", "모의접수를 하지 않았어요. 입력 내용은 그대로 있어요.");
  }
}
