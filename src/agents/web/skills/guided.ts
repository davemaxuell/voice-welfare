import type { Action, ObservedField } from "../../../core/actions.ts";
import type { DialogueState } from "../../../core/dialogue.ts";
import { hasText, strip } from "../../../core/text.ts";
import { draft, type Draft } from "../../../core/turn.ts";
import { tryUrl } from "../../../core/url.ts";
import { josa, speakLabel } from "../../../speech/phrasing.ts";
import type { Narrator } from "../../../speech/screen.ts";
import { cleanValue, type RuleBasedIntentProvider } from "../../../understanding/rules.ts";
import { isQuestionLike } from "../../../understanding/filters.ts";
import { siteLabel } from "../../../understanding/sites.ts";
import type { ExecContext, PageView, WebExecutionAgent } from "../agent.ts";
import type { FieldProfile } from "../profile.ts";
import { requestAssist } from "./form.ts";
import { outcomeFailure } from "./common.ts";

export const guidedPatterns = {
  stop: /^(그만|끝|됐어|중단)/u,
  yes: /^(응|네|예|맞아|그래|좋아)/u,
  no: /^(아니|아뇨|아니요|취소|됐어|하지\p{White_Space}*마)/u,
  skip: /^(건너뛰|넘어가|패스|다음\p{White_Space}*칸|비워)/u,
  yesPrefix: /^(응|네)[,\p{White_Space}]+/u,
  onlyYes: /^(응|네|예|맞아|그래|좋아)(?=\n?$)/u,
  start: /(하나씩|차례로|순서대로|전부|다)\p{White_Space}*(채워|입력|써)(?!했|었)|입력\p{White_Space}*(칸|란)\p{White_Space}*(을|를)?\p{White_Space}*(채워|입력해)/u,
  request: /(?:채워|입력해|써)\s*(?:줘요?|주세요|주실래요?|주시겠어요?|줄래요?)?[.!?。！？~]*$/u,
  excludes: /말고|빼고|제외|않|하지\s*마|건너뛰[고어]/u,
  secret: /(비밀\p{White_Space}*번호|password|인증\p{White_Space}*번호|otp|주민|계좌|카드|동의|약관)/iu,
};
interface VaultCallbacks {
  savedValue(label: string): string | undefined;
  siteAllowed?(origin: string): boolean;
  allowSite?(origin: string): void;
}
type Guided = NonNullable<DialogueState["guided"]>;
function eligible(f: ObservedField): boolean {
  return f.visible && !f.sensitive && f.searchable !== true && f.type !== "checkbox" && f.type !== "password" && !guidedPatterns.secret.test(f.label);
}
const together = "입력 칸을 모두 지나왔어요. 내용을 확인하신 뒤 제출이나 신청 버튼은 직접 눌러 주세요.";

export class GuidedFill {
  readonly web: WebExecutionAgent;
  readonly dialogue: DialogueState<FieldProfile>;
  readonly narrator: Narrator;
  readonly #rules: RuleBasedIntentProvider;
  readonly #vault: VaultCallbacks;
  #offered?: {guided: Guided; fieldId: string; document?: string; target?: Action};

  constructor(web: WebExecutionAgent, dialogue: DialogueState<FieldProfile>, narrator: Narrator, rules: RuleBasedIntentProvider, vault: VaultCallbacks) {
    this.web = web;
    this.dialogue = dialogue;
    this.narrator = narrator;
    this.#rules = rules;
    this.#vault = vault;
  }

  active(): boolean {
    const g = this.dialogue.guided;
    if (!g) return false;
    if (this.web.currentView?.url === g.url) return true;
    this.dialogue.endGuided();
    return false;
  }

  async resumeAfterAuth(view: PageView, ctx: ExecContext): Promise<string> {
    const g = this.dialogue.guided;
    if (!g) return "";
    g.url = view.url;
    const origin = tryUrl(view.url)?.origin ?? view.url;
    if (g.origin !== origin) {
      g.origin = origin;
      g.skipVault = false;
      g.suggestion = undefined;
      g.awaitSiteAllow = false;
    }
    const visible = new Set(view.fields.filter(eligible).map(f => f.fieldId));
    g.fieldIds = g.fieldIds.filter(id => visible.has(id));
    if (g.fieldIds.length === 0) {
      this.dialogue.endGuided();
      return "이 화면에는 이어서 채울 칸이 없어요. 필요하면 '칸 채워줘'라고 말씀해 주세요.";
    }
    g.index = Math.min(g.index, g.fieldIds.length - 1);
    if (this.web.guard.directActions) await this.#rememberField(g, view, ctx);
    return this.#question(g, view);
  }

  async answer(text: string, ctx: ExecContext): Promise<Draft | undefined> {
    const g = this.dialogue.guided;
    if (!g) return;
    const direct = this.web.guard.directActions;
    const view = direct ? await this.web.observe(ctx) : this.web.currentView;
    if (!view) return;
    const offered = this.#offered;
    if (direct && (view.url !== g.url || offered?.guided !== g || offered.fieldId !== g.fieldIds[g.index] ||
        offered.document !== this.web.adapter.documentId?.())) {
      this.dialogue.endGuided();
      return draft("BROWSING", "clarify", "입력 화면이 바뀌었어요. 새 화면에서 채울 칸을 말씀해 주세요.", {view, privateHistory: true});
    }
    if (!this.active()) return;
    if (guidedPatterns.stop.test(text)) {
      this.dialogue.endGuided();
      return draft("BROWSING", "none", "칸 채우기를 멈췄어요. 제출 버튼은 직접 눌러 주세요.");
    }
    if (direct && isQuestionLike(text)) return draft("BROWSING", "clarify", this.#question(g, view), {view});
    if (g.awaitSiteAllow === true) {
      const origin = g.origin ?? "";
      if (guidedPatterns.yes.test(text) && origin.length > 0) {
        this.#vault.allowSite?.(origin);
        g.awaitSiteAllow = false;
        return draft("BROWSING", "fill", `알겠어요. ${this.#question(g, view)}`, {view});
      }
      if (guidedPatterns.no.test(text)) {
        g.awaitSiteAllow = false;
        g.suggestion = undefined;
        g.skipVault = true;
        return draft("BROWSING", "fill", `이 사이트에는 저장된 값을 쓰지 않을게요. ${this.#question(g, view)}`, {view});
      }
      const site = siteLabel(view.url);
      return draft("BROWSING", "clarify", `${site.length > 0 ? site : origin}에 저장된 내 정보를 쓸까요? 맞으면 '응', 아니면 '아니'라고 해 주세요.`);
    }
    if (guidedPatterns.skip.test(text)) return this.#advance(g, "건너뛸게요.", ctx);
    const other = await this.#rules.parse(text, {state: this.dialogue.state});
    if (!["UNKNOWN", "FILL", "APPROVE", "REJECT"].includes(other.type)) {
      this.dialogue.endGuided();
      return;
    }
    const field = view.fields.find(f => f.fieldId === g.fieldIds[g.index] && eligible(f));
    if (!field) return this.#advance(g, "", ctx);
    const value = guidedPatterns.yes.test(text) && hasText(g.suggestion)
      ? g.suggestion : cleanValue(text.replace(guidedPatterns.yesPrefix, ""));
    if (value.length === 0 || guidedPatterns.onlyYes.test(value)) return draft("BROWSING", "clarify", `${speakLabel(field.label)}에 넣을 값을 말씀해 주세요.`);
    const action = this.web.buildAssistAction(field, value);
    if (!await this.web.observedAction(action, ctx.signal, direct ? offered?.target : undefined)) {
      this.dialogue.endGuided();
      return draft("BROWSING", "clarify", "입력 칸이 바뀌었어요. 채울 칸을 다시 말씀해 주세요.", {view, privateHistory: true});
    }
    if (this.web.guard.directActions) {
      const out = await this.web.assistFill([action], ctx);
      return out.status === "ok" ? this.#advance(g, "넣고 확인했어요.", ctx, out.actions) : outcomeFailure(out, "BROWSING");
    }
    const siteName = siteLabel(view.url);
    const site = siteName.length > 0 ? siteName : tryUrl(view.url)?.host ?? view.url;
    const label = speakLabel(field.label);
    const speech = `${site} ${label} 칸에 '${value}' 넣을까요? 맞으면 '응', 아니면 '아니'라고 해 주세요.`;
    return requestAssist(this.dialogue, view, [action], [{label, value}], site, speech, true);
  }

  async #advance(g: Guided, prefix: string, ctx: ExecContext, actions?: Draft["actions"]): Promise<Draft> {
    g.index += 1;
    return this.#nextField(g, await this.web.observe(ctx), prefix, ctx, actions);
  }

  async #rememberField(g: Guided, view: PageView, ctx: ExecContext): Promise<void> {
    this.#offered = undefined;
    const field = view.fields.find(candidate => candidate.fieldId === g.fieldIds[g.index] && eligible(candidate));
    if (!field || view.url !== g.url) return;
    const document = this.web.adapter.documentId?.();
    let target;
    if (this.web.adapter.bindTarget !== undefined) {
      target = {...this.web.buildAssistAction(field, ""), type: "focus" as const, value: undefined};
      if (!await this.web.observedAction(target, ctx.signal)) return;
    }
    this.#offered = {guided: g, fieldId: field.fieldId, document, target};
  }

  async #nextField(g: Guided, now: PageView, prefix: string, ctx: ExecContext, actions: NonNullable<Draft["actions"]> = []): Promise<Draft> {
    const origin = tryUrl(now.url)?.origin;
    if (this.web.guard.directActions && origin !== undefined && this.#vault.siteAllowed?.(origin) === true && g.skipVault !== true) {
      const known = [];
      for (const id of g.fieldIds.slice(g.index)) {
        const field = now.fields.find(f => f.fieldId === id && eligible(f));
        const value = field && this.#vault.savedValue(field.label);
        if (!field || field.filled === true || !hasText(value)) break;
        const action = this.web.buildAssistAction(field, value);
        if (!await this.web.observedAction(action, ctx.signal)) break;
        known.push(action);
      }
      if (known.length > 0) {
        const out = await this.web.assistFill(known, ctx);
        actions = [...actions, ...out.actions];
        if (out.status !== "ok" || !out.view) return {...outcomeFailure(out, "BROWSING"), actions};
        now = out.view;
        g.index += known.length;
        prefix += ` 저장된 값으로 ${known.length}개 칸을 채웠어요.`;
      }
    }
    if (g.index >= g.fieldIds.length) {
      this.dialogue.endGuided();
      return draft("BROWSING", "fill", `${prefix} ${this.web.guard.directActions ? "입력할 칸을 모두 지나왔어요." : together}`, {view: now, actions});
    }
    if (this.web.guard.directActions) await this.#rememberField(g, now, ctx);
    return draft("BROWSING", "fill", strip(`${prefix} ${this.#question(g, now)}`), {view: now, actions});
  }

  async afterAssist(filled: Draft, ctx: ExecContext): Promise<Draft> {
    if (!this.active()) return filled;
    const g = this.dialogue.guided;
    return g === undefined ? filled : this.#advance(g, "넣고 확인했어요.", ctx, filled.actions);
  }

  wantsStart(text: string): boolean {
    return this.web.currentView?.pageId === "external" && guidedPatterns.start.test(text) &&
      (!this.web.guard.directActions || (guidedPatterns.request.test(text.trim()) && !guidedPatterns.excludes.test(text)));
  }

  async start(ctx: ExecContext): Promise<Draft> {
    const view = await this.web.observe(ctx);
    const fields = view.fields.filter(eligible);
    if (fields.length === 0) return draft(this.dialogue.state, "none", "이 화면에는 제가 채울 수 있는 입력 칸이 없어요. 로그인이나 인증 칸은 직접 입력해 주세요.", {view});
    this.dialogue.startGuided(view.url, fields.map(f => f.fieldId));
    const g = this.dialogue.guided!;
    g.origin = tryUrl(view.url)?.origin ?? view.url;
    g.skipVault = false;
    const intro = `입력 칸이 ${fields.length}개 있어요.`;
    if (!this.web.guard.directActions) return draft("BROWSING", "fill", `${intro} 하나씩 여쭤볼게요. ${this.#question(g, view)}`, {view});
    return this.#nextField(g, view, intro, ctx);
  }

  #question(g: Guided, view: PageView): string {
    const field = view.fields.find(f => f.fieldId === g.fieldIds[g.index] && eligible(f));
    if (!field) return "";
    const origin = tryUrl(view.url)?.origin ?? "";
    const saved = g.skipVault === true || (this.web.guard.directActions && this.#vault.siteAllowed?.(origin) !== true)
      ? undefined : this.#vault.savedValue(field.label);
    const first = this.narrator.once("guided", " 건너뛰려면 '건너뛰기', 그만하려면 '그만'.");
    if (hasText(saved) && origin.length > 0 && this.#vault.siteAllowed?.(origin) === false) {
      g.suggestion = undefined;
      g.awaitSiteAllow = true;
      g.origin = origin;
      const site = siteLabel(view.url);
      return `${site.length > 0 ? site : origin}에 저장된 내 정보를 쓸까요? 맞으면 '응', 아니면 '아니'라고 해 주세요.${first}`;
    }
    g.awaitSiteAllow = false;
    g.suggestion = saved;
    const label = speakLabel(field.label);
    if (hasText(saved)) return `${g.index + 1}번째, ${label}. 저장된 ${josa(`'${saved}'`, "을", "를")} 넣을까요? 맞으면 '응', 다르면 넣을 값을 말씀하세요.${first}`;
    return `${g.index+1}번째, ${label}. 무엇을 넣을까요?${first}`;
  }
}
