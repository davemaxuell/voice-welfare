import { z } from "zod";
import { INTENTS, parseIntent, type Intent } from "../core/intents.ts";
import {
  OPENAI_BASE_URL, chatCompletion, configured, redactedJson, type ChatEndpoint, type LlmConfig,
  type ModelIntentContext, type Redacted, type StructuredLlm,
} from "../core/llm.ts";
import { cleanValue, RuleBasedIntentProvider } from "./rules.ts";

export const LLM_INTENT_TYPES = INTENTS.filter(i => i.llm).map(i => i.type);
export const INTENT_JSON_SCHEMA = {
  name: "intent",
  strict: true,
  schema: {
    type: "object", additionalProperties: false,
    required: ["type", "fills", "fieldMention", "topic", "text", "more", "site", "list"],
    properties: {
      type: { type: "string", enum: LLM_INTENT_TYPES },
      fills: {
        type: ["array", "null"],
        items: {
          type: "object", additionalProperties: false, required: ["fieldMention", "value"],
          properties: { fieldMention: { type: "string" }, value: { type: "string" } },
        },
      },
      fieldMention: { type: ["string", "null"] }, topic: { type: ["string", "null"] },
      text: { type: ["string", "null"] }, more: { type: ["boolean", "null"] },
      site: { type: ["string", "null"] }, list: { type: ["boolean", "null"] },
    },
  },
} as const;

const flatObject = z.record(z.string(), z.unknown());
const fillList = z.array(z.object({ fieldMention: z.unknown(), value: z.string() }));

function supplied(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

export function flatToIntent(raw: unknown, utterance: string): Intent | undefined {
  const parsed = flatObject.safeParse(raw);
  if (!parsed.success) return undefined;
  const flat = parsed.data;
  const type = flat.type;
  if (!LLM_INTENT_TYPES.some(kind => kind === type)) return undefined;
  const candidate: Record<string, unknown> = { type };
  switch (type) {
    case "FILL": {
      const parsedFills = fillList.safeParse(flat.fills);
      if (!parsedFills.success) return undefined;
      candidate.fills = parsedFills.data.map(f => ({ fieldMention: f.fieldMention, value: cleanValue(f.value) }))
        .filter(f => f.value.length > 0);
      break;
    }
    case "READ_FIELD":
    case "EDIT_FIELD": candidate.fieldMention = flat.fieldMention ?? undefined; break;
    case "EXPLAIN":
      if (supplied(flat.fieldMention)) candidate.fieldMention = flat.fieldMention;
      break;
    case "POLICY_QUESTION": candidate.topic = flat.topic ?? utterance; break;
    case "GOAL": candidate.goal = flat.topic ?? utterance; break;
    case "OPEN_SITE": candidate.target = flat.topic ?? utterance; break;
    case "FOLLOW_LINK": candidate.name = flat.topic; break;
    case "SEARCH":
      candidate.query = flat.topic;
      if (supplied(flat.site)) candidate.site = flat.site;
      break;
    case "READ_MAIN":
    case "LIST_LINKS":
    case "WHAT_CAN_I_SAY": candidate.more = flat.more === true; break;
    case "READ_DOWNLOAD": candidate.list = flat.list === true; break;
    case "SERVICE_DETAIL":
    case "PRECHECK":
    case "PREPARE_APPLY":
      if (supplied(flat.topic)) candidate.service = flat.topic;
      break;
    case "UNKNOWN": candidate.text = utterance; break;
  }
  return parseIntent(candidate);
}

export function systemPrompt(vocabulary: readonly string[]): string {
  const kinds = INTENTS.filter(i => i.llm).map(i => `- ${i.type}: ${i.describe}`).join("\n");
  return `너는 한국어 복지 신청 도우미의 의도 분류기다. 사용자 발화 하나를 지정된 JSON 스키마로 분류한다.
type 의미:
${kinds}
fieldMention은 반드시 다음 항목명 중 하나를 그대로 쓴다: ${vocabulary.join(", ")}.
규칙: 확실하지 않으면 UNKNOWN. 사용자가 말하지 않은 값을 추측·보완하지 마라. 비밀번호·주민등록번호·계좌번호는 절대 FILL로 만들지 마라.
쓰지 않는 칸은 null로 둔다.`;
}

interface IntentEndpoint extends ChatEndpoint {
  structured: boolean;
  rules: RuleBasedIntentProvider;
  vocabulary: readonly string[];
}

export class OpenAICompatibleIntentProvider {
  readonly name: string;
  private readonly config: IntentEndpoint;
  private readonly fetchImpl: typeof fetch;

  constructor(config: IntentEndpoint, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.name = `${config.structured ? "openai" : "openai-compatible"}(${config.model})+mock-rule`;
  }

  async parse(text: Redacted, ctx: ModelIntentContext): Promise<Intent> {
    const cfg = this.config;
    const ruled = await cfg.rules.parse(text, ctx);
    if (ruled.type !== "UNKNOWN" || (ctx.awaitingFieldId !== undefined && ctx.awaitingFieldId !== "")) return ruled;
    const output = await chatCompletion({ ...cfg, timeoutMs: cfg.timeoutMs === 0 ? 10_000 : cfg.timeoutMs ?? 10_000 }, {
      system: systemPrompt(cfg.vocabulary),
      user: redactedJson({ state: ctx.state, awaitingField: ctx.awaitingFieldId ?? null, utterance: text }),
      format: cfg.structured ? { type: "json_schema", json_schema: INTENT_JSON_SCHEMA } : { type: "json_object" },
    }, this.fetchImpl);
    return flatToIntent(output, text) ?? ruled;
  }
}

export function createIntentProvider(cfg: LlmConfig, vocabulary: readonly string[], fetchImpl: typeof fetch = fetch) {
  const rules = new RuleBasedIntentProvider(vocabulary);
  const provider = configured(cfg.provider) ? cfg.provider.toLowerCase() : "mock";
  if (provider === "mock") return rules;
  if (!["openai", "qwen", "openai-compatible"].includes(provider)) {
    console.warn(`[llm] 알 수 없는 LLM_PROVIDER(${provider}) → mock 사용`);
    return rules;
  }
  const baseUrl = configured(cfg.baseUrl) ? cfg.baseUrl : provider === "openai" ? OPENAI_BASE_URL : undefined;
  const missing = Object.entries({ LLM_API_KEY: cfg.apiKey, LLM_MODEL: cfg.model, LLM_BASE_URL: baseUrl })
    .filter(([, value]) => value === undefined || value === "").map(([key]) => key);
  if (!configured(cfg.apiKey) || !configured(cfg.model) || !configured(baseUrl)) {
    console.warn(`[llm] ${missing.join(", ")} 미설정 → mock 규칙 파서만 사용합니다.`);
    return rules;
  }
  return new OpenAICompatibleIntentProvider({
    ...cfg, model: cfg.model, apiKey: cfg.apiKey, baseUrl, structured: provider === "openai", rules, vocabulary,
  }, fetchImpl);
}

export const PLAN_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["steps"],
  properties: { steps: { type: "array", items: INTENT_JSON_SCHEMA.schema } },
};

export function planSystem(vocabulary: readonly string[]): string {
  return `${systemPrompt(vocabulary)}
사용자가 한 번에 여러 가지를 말할 수 있다. 말한 순서대로 steps 배열에 하나씩 넣어라(최대 6개).
예: "부산 예시구 예시로 10 사는 김하늘이고 다음으로 넘어가줘" → FILL(이름=김하늘), FILL(주소=부산 예시구 예시로 10), NEXT.
값이 불완전해도 바꾸거나 채우지 말고 들은 그대로 넣어라(검증은 시스템이 한다). 하나뿐이면 steps에 하나만.`;
}

export async function planWithLlm(
  llm: StructuredLlm, text: Redacted, ctx: ModelIntentContext, vocabulary: readonly string[],
  page?: Redacted, history: readonly Redacted[] = [],
): Promise<Intent[] | undefined> {
  const raw = await llm.generate({
    system: planSystem(vocabulary),
    user: redactedJson({ state: ctx.state, awaitingField: ctx.awaitingFieldId ?? null, page: page ?? null, recent: history, utterance: text }),
    schemaName: "intent_plan", schema: PLAN_JSON_SCHEMA,
  });
  const plan = z.object({ steps: z.array(z.unknown()).min(1) }).safeParse(raw);
  if (!plan.success) return undefined;
  const intents: Intent[] = [];
  for (const step of plan.data.steps.slice(0, 6)) {
    const intent = flatToIntent(step, text);
    if (intent === undefined) return undefined;
    intents.push(intent);
  }
  return intents;
}
