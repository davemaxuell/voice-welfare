import type { Intent, IntentType } from "../core/intents.ts";
import type { ModelIntentContext, Redacted, StructuredLlm } from "../core/llm.ts";
import { hasText, strip } from "../core/text.ts";
import { fastIntent, pictureCommandParts } from "./fastpath.ts";
import { isQuestionLike } from "./filters.ts";
import { planWithLlm } from "./llm_planner.ts";
import { cleanValue, isPictureRequest, type IntentProvider, type RuleBasedIntentProvider } from "./rules.ts";

/** ② 말 이해. 안전 명령과 대화 중인 선택을 먼저 처리하고, 모델이 없거나 계획에 실패하면 규칙을 쓴다. */
export const PLAN_TIMEOUT_MS = 8_000;
// 번호로 고르는 대답("2번", "3번 눌러줘")은 방금 안내한 선택지에 대한 말이라 모델 계획을 거치지 않는다.
export const ORDINAL_REPLY = /^\p{Nd}{1,2}\p{White_Space}*번(?:이요|요|(?:을|를)?\p{White_Space}*(?:눌러|열어|선택해)(?:\p{White_Space}*(?:줘요?|주세요))?)?[.!。]?$/u;
// 목표 하나의 조각일 수 있는 것: 읽기·묻기뿐(입력·신청 시작처럼 따로 할 일이 섞이면 나눈다)
const GOAL_PARTS: ReadonlySet<IntentType> = new Set(["GOAL", "CURRENT_STEP", "DESCRIBE_SCREEN", "READ_MAIN", "ABOUT_SITE", "POLICY_QUESTION", "UNKNOWN"]);

/** 연속된 입력 명령은 하나로 합친다(한 번에 화면 확인). */
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
  /** 오케스트레이터의 INTENT_DETECTED 기록에 남길 이해 경로 */
  by: string;
}

/** llm·intentProvider는 테스트가 세션을 만든 뒤 바꾸므로 부를 때마다 읽는다. */
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
  maxSteps?: number;
}

/** 가린 말에서 잘라 낸 조각은 그대로 가린 말이다. */
function isPartOf(part: string, whole: Redacted): part is Redacted {
  return whole.includes(part);
}

async function planWithin(timeoutMs: number, plan: (signal: AbortSignal) => Promise<Intent[] | undefined>): Promise<Intent[] | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, timeoutMs);
  });
  try {
    return await Promise.race([plan(controller.signal), expired]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
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
    const llm = this.deps.llm;
    if (llm === undefined) {
      const result = await this.byRules(text, ctx, "rules");
      if (result.intents[0]?.type !== "UNKNOWN" || hasText(ctx.awaitingFieldId) || this.contextual(text, turn)) return result;
      const provider = this.deps.intentProvider;
      return { intents: [await provider.parse(text, ctx)], by: provider.name };
    }
    const fast = fastIntent(text, ctx, this.rules);
    if (fast !== undefined && fast.type !== "DESCRIBE_PICTURE") return { intents: [fast], by: "fast" };
    // 사진을 요청한 절은 모델이 대신 만들 수 없다. 함께 요청한 읽기 등도 원래 순서로 처리한다.
    const parts = pictureCommandParts(text, this.rules);
    if (parts.length > 0) {
      const intents: Intent[] = [];
      let by = "fast";
      for (const part of parts) {
        if (!isPartOf(part, text)) throw new Error("명령 조각이 원래 말에 없습니다");
        const step = await this.understand(part, ctx, { ...turn, maxSteps: undefined });
        if (step.intents.some(intent => intent.type === "APPROVE")) return { intents: [{ type: "UNKNOWN", text }], by: "rules" };
        intents.push(...step.intents);
        if (step.by !== "fast") by = step.by;
      }
      return { intents: mergeFills(intents), by };
    }
    if (fast !== undefined) return { intents: [fast], by: "fast" };
    if (this.contextual(text, turn)) return { intents: [await this.rules.parse(text, ctx)], by: "rules" };
    turn.trace("LLM 계획");
    const plan = await planWithin(PLAN_TIMEOUT_MS, signal => planWithLlm(llm, text, ctx, this.vocabulary, {
      page: turn.page, history: turn.recent, maxSteps: turn.maxSteps, signal,
    }));
    if (plan === undefined) return this.byRules(text, ctx, "rules-fallback");
    if (plan.length === 1) return { intents: plan, by: llm.name };
    const kept = mergeFills(plan.filter(intent => intent.type !== "UNKNOWN" || intent.text !== text));
    return { intents: kept.length > 0 ? kept : [{ type: "UNKNOWN", text }], by: llm.name };
  }

  private contextual(text: string, turn: TurnContext): boolean {
    const { awaited } = turn;
    if (awaited !== undefined && !isQuestionLike(text) && (awaited.validate === undefined || awaited.validate(cleanValue(text)).ok)) return true;
    return turn.clarifying || ORDINAL_REPLY.test(strip(text));
  }

  private async byRules(text: Redacted, ctx: ModelIntentContext, by: string): Promise<Understood> {
    const parts = this.rules.splitCommands(text);
    const single = await this.rules.parse(text, ctx);
    if (parts.length > 1) {
      const parsed: Intent[] = [];
      for (const part of parts) parsed.push(await this.rules.parse(part, ctx));
      // "정부24에서 … 찾아줘. 로그인하지 말고, 어떤 단계부터 … 알려줘"는 목표 하나: 나누면 뒤의 조건·질문을 잃는다
      if (single.type === "GOAL" && parsed.every(intent => GOAL_PARTS.has(intent.type))) return { intents: [single], by };
      if (parsed.every(intent => intent.type !== "UNKNOWN")) {
        // 절을 나누더라도 승인·사진 요청의 범위는 전체 발화로 확인한다.
        if (parsed.some(intent => intent.type === "APPROVE"
          || (intent.type === "DESCRIBE_PICTURE" && !isPictureRequest(intent.question, { utterance: text })))) {
          return { intents: [single], by };
        }
        return { intents: mergeFills(parsed), by };
      }
    }
    return { intents: [single], by };
  }
}
