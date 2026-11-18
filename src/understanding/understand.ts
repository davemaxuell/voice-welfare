import type { Intent } from "../core/intents.ts";
import type { ModelIntentContext, Redacted, StructuredLlm } from "../core/llm.ts";
import { isQuestionLike } from "./filters.ts";
import { planWithLlm } from "./llm_planner.ts";
import { cleanValue, type IntentProvider, type RuleBasedIntentProvider } from "./rules.ts";

export const ORDINAL_REPLY = /^\p{Nd}{1,2}\p{White_Space}*번/u;

export function mergeFills(intents: readonly Intent[]): Intent[] {
  const merged: Intent[] = [];
  for (const intent of intents) {
    const prev = merged.at(-1);
    if (intent.type === "FILL" && prev?.type === "FILL" && prev.fills.length + intent.fills.length <= 5) {
      merged[merged.length - 1] = { type: "FILL", fills: [...prev.fills, ...intent.fills] };
    } else {
      merged.push(intent);
    }
  }
  return merged;
}

export interface Understood {
  intents: Intent[];
  by: string;
}

interface UnderstandingDeps {
  llm?: StructuredLlm;
  intentProvider: IntentProvider;
}

interface TurnContext {
  awaited?: { validate?: (value: string) => { ok: boolean } };
  clarifying: boolean;
  page?: Redacted;
  recent: readonly Redacted[];
  trace: (note: string) => void;
}

export class Understanding {
  private readonly rules: RuleBasedIntentProvider;
  private readonly deps: UnderstandingDeps;
  private readonly vocabulary: readonly string[];

  constructor(rules: RuleBasedIntentProvider, deps: UnderstandingDeps, vocabulary: readonly string[]) {
    this.rules = rules;
    this.deps = deps;
    this.vocabulary = vocabulary;
  }

  async understand(text: Redacted, ctx: ModelIntentContext, turn: TurnContext): Promise<Understood> {
    const parts = this.rules.splitCommands(text);
    if (parts.length > 1) {
      const parsed: Intent[] = [];
      for (const part of parts) parsed.push(await this.rules.parse(part, ctx));
      if (parsed.every(i => i.type !== "UNKNOWN")) return { intents: mergeFills(parsed), by: "rules" };
    }
    const single = await this.rules.parse(text, ctx);
    const ruled = { intents: [single], by: "rules" };
    if (single.type !== "UNKNOWN") return ruled;

    const validValue = turn.awaited !== undefined && !isQuestionLike(text)
      && (turn.awaited.validate?.(cleanValue(text)).ok ?? true);
    const llm = this.deps.llm;
    if (validValue || turn.clarifying || ORDINAL_REPLY.test(text)
      || (ctx.awaitingFieldId !== undefined && ctx.awaitingFieldId.length > 0 && llm === undefined)) return ruled;
    if (llm === undefined) {
      const provider = this.deps.intentProvider;
      return { by: provider.name, intents: [await provider.parse(text, ctx)] };
    }
    turn.trace("LLM 계획");
    const plan = await planWithLlm(llm, text, ctx, this.vocabulary, turn.page, turn.recent);
    if (plan !== undefined && !(plan.length === 1 && plan[0]?.type === "UNKNOWN")) {
      return { by: llm.name, intents: mergeFills(plan.filter(i => i.type !== "UNKNOWN")) };
    }
    return { by: llm.name, intents: [single] };
  }
}
