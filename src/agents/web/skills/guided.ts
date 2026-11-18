import type { ObservedField } from "../../../core/actions.ts";
import type { DialogueState } from "../../../core/dialogue.ts";
import { hasText, strip } from "../../../core/text.ts";
import { draft, type Draft } from "../../../core/turn.ts";
import { tryUrl } from "../../../core/url.ts";
import { josa, speakLabel } from "../../../speech/phrasing.ts";
import type { Narrator } from "../../../speech/screen.ts";
import { cleanValue, type RuleBasedIntentProvider } from "../../../understanding/rules.ts";
import { siteLabel } from "../../../understanding/sites.ts";
import type { ExecContext, PageView, WebExecutionAgent } from "../agent.ts";
import type { FieldProfile } from "../profile.ts";
import { requestAssist } from "./form.ts";

export const guidedPatterns = {
  stop: /^(그만|끝|됐어|중단)/u,
  yes: /^(응|네|예|맞아|그래|좋아)/u,
  no: /^(아니|아뇨|아니요|취소|됐어|하지\p{White_Space}*마)/u,
  skip: /^(건너뛰|넘어가|패스|다음\p{White_Space}*칸|비워)/u,
  yesPrefix: /^(응|네)[,\p{White_Space}]+/u,
  onlyYes: /^(응|네|예|맞아|그래|좋아)(?=\n?$)/u,
  start: /(하나씩|차례로|순서대로|전부|다)\p{White_Space}*(채워|입력|써)(?!했|었)|입력\p{White_Space}*(칸|란)\p{White_Space}*(을|를)?\p{White_Space}*(채워|입력해)/u,
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

  resumeAfterAuth(view: PageView): string {
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
    return this.#question(g, view);
  }

  async answer(text: string, ctx: ExecContext): Promise<Draft | undefined> {
    const g = this.dialogue.guided;
    const view = this.web.currentView;
    if (!g || !view || !this.active()) return;
    if (guidedPatterns.stop.test(text)) {
      this.dialogue.endGuided();
      return draft("BROWSING", "none", "칸 채우기를 멈췄어요. 제출 버튼은 직접 눌러 주세요.");
    }
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
    const siteName = siteLabel(view.url);
    const site = siteName.length > 0 ? siteName : tryUrl(view.url)?.host ?? view.url;
    const label = speakLabel(field.label);
    const speech = `${site} ${label} 칸에 '${value}' 넣을까요? 맞으면 '응', 아니면 '아니'라고 해 주세요.`;
    return requestAssist(this.dialogue, view, [action], [{label, value}], site, speech, true);
  }

  async #advance(g: Guided, prefix: string, ctx: ExecContext, actions?: Draft["actions"]): Promise<Draft> {
    const now = await this.web.observe(ctx);
    g.index += 1;
    if (g.index >= g.fieldIds.length) {
      this.dialogue.endGuided();
      return draft("BROWSING", "fill", `${prefix} ${together}`, {view: now, actions});
    }
    return draft("BROWSING", "fill", strip(`${prefix} ${this.#question(g, now)}`), {view: now, actions});
  }

  async afterAssist(filled: Draft, ctx: ExecContext): Promise<Draft> {
    if (!this.active()) return filled;
    const g = this.dialogue.guided;
    return g === undefined ? filled : this.#advance(g, "넣고 확인했어요.", ctx, filled.actions);
  }

  wantsStart(text: string): boolean {
    return this.web.currentView?.pageId === "external" && guidedPatterns.start.test(text);
  }

  async start(ctx: ExecContext): Promise<Draft> {
    const view = await this.web.observe(ctx);
    const fields = view.fields.filter(eligible);
    if (fields.length === 0) return draft(this.dialogue.state, "none", "이 화면에는 제가 채울 수 있는 입력 칸이 없어요. 로그인이나 인증 칸은 직접 입력해 주세요.", {view});
    this.dialogue.startGuided(view.url, fields.map(f => f.fieldId));
    const g = this.dialogue.guided!;
    g.origin = tryUrl(view.url)?.origin ?? view.url;
    g.skipVault = false;
    return draft("BROWSING", "fill", `입력 칸이 ${fields.length}개 있어요. 하나씩 여쭤볼게요. ${this.#question(g, view)}`, {view});
  }

  #question(g: Guided, view: PageView): string {
    const field = view.fields.find(f => f.fieldId === g.fieldIds[g.index] && eligible(f));
    if (!field) return "";
    const origin = tryUrl(view.url)?.origin ?? "";
    const saved = g.skipVault === true ? undefined : this.#vault.savedValue(field.label);
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
