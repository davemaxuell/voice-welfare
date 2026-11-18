import { z } from "zod";
import { raceAbort } from "./abort.ts";
import type { SessionState } from "./turn.ts";

declare const redacted: unique symbol;
export type Redacted = string & { readonly [redacted]: true };
export interface ModelIntentContext {
  state: SessionState;
  awaitingFieldId?: Redacted;
}

type SafeJson = Redacted | SessionState | boolean | number | null | readonly SafeJson[] | { readonly [key: string]: SafeJson };

export function redactedJson(value: SafeJson): Redacted {
  // 동적 문자열은 이미 가려졌다. JSON 인코딩은 새 사용자 데이터를 추가하지 않는다.
  return JSON.stringify(value) as Redacted;
}

export interface LlmRequest {
  system: string;
  user: Redacted;
  schemaName: string;
  schema: object;
  signal?: AbortSignal;
}

export interface StructuredLlm {
  readonly name: string;
  generate(request: LlmRequest): Promise<unknown>;
}

export interface LlmConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
}

export function configured(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

export function overlayLlm(base: LlmConfig, overrides: Omit<LlmConfig, "timeoutMs"> = {}): LlmConfig {
  if (Object.values(overrides).every((value) => value === undefined || value === "")) return base;
  return {
    ...base,
    provider: configured(overrides.provider) ? overrides.provider : base.provider,
    model: configured(overrides.model) ? overrides.model : base.model,
    apiKey: overrides.apiKey ?? base.apiKey,
    baseUrl: overrides.baseUrl ?? base.baseUrl,
    reasoningEffort: overrides.reasoningEffort ?? base.reasoningEffort,
  };
}

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OLLAMA_BASE_URL = "http://localhost:11434/v1";
export const LOCAL_LLM_URL = /localhost|127\.0\.0\.1/u;
export const SIMPLE_TEXT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } },
};

export interface ChatEndpoint {
  baseUrl: string;
  model: string;
  apiKey?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  provider?: string;
}

interface ChatRequest {
  system: string;
  user: Redacted;
  format: { type: "json_schema"; json_schema: { name: string; strict: true; schema: object } } | { type: "json_object" };
  signal?: AbortSignal;
}

const envelope = z.object({
  choices: z.tuple([z.object({
    message: z.object({ content: z.string(), refusal: z.unknown().optional() }),
  })]).rest(z.unknown()),
});

export async function chatCompletion(
  endpoint: ChatEndpoint, request: ChatRequest, fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const body = {
    model: endpoint.model,
    response_format: request.format,
    reasoning_effort: request.format.type === "json_schema" && configured(endpoint.reasoningEffort) ? endpoint.reasoningEffort : undefined,
    temperature: request.format.type === "json_object" ? 0 : undefined,
    messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
  };
  const headers = new Headers({ "Content-Type": "application/json" });
  if (endpoint.apiKey !== undefined && endpoint.apiKey !== "") headers.set("Authorization", `Bearer ${endpoint.apiKey}`);
  try {
    const timeout = AbortSignal.timeout(endpoint.timeoutMs === 0 ? 30_000 : endpoint.timeoutMs ?? 30_000);
    const signal = request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal]);
    return await raceAbort(async (activeSignal) => {
      const response = await fetchImpl(`${endpoint.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
        method: "POST", headers, signal: activeSignal, body: JSON.stringify(body),
      });
      if (!response.ok) return undefined;
      const parsed = envelope.safeParse(await response.json());
      if (!parsed.success) return undefined;
      const { content, refusal } = parsed.data.choices[0].message;
      if (content.length === 0 || Boolean(refusal)) return undefined;
      // strict 스키마가 요구하는 null 속성을 지운다. 배열의 null은 자리를 유지한다.
      return JSON.parse(content, function (this: unknown, _key: string, value: unknown) {
        return value === null && !Array.isArray(this) ? undefined : value;
      }) as unknown;
    }, signal);
  } catch {
    return undefined;
  }
}

export class OpenAIStructuredLlm implements StructuredLlm {
  readonly name: string;
  private readonly endpoint: ChatEndpoint;
  private readonly fetchImpl: typeof fetch;

  constructor(endpoint: ChatEndpoint, fetchImpl: typeof fetch = fetch) {
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.name = `${configured(endpoint.provider) ? endpoint.provider : "openai"}(${endpoint.model})`;
  }

  generate({ system, user, schemaName, schema, signal }: LlmRequest): Promise<unknown> {
    return chatCompletion(this.endpoint, {
      system, user, signal, format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
    }, this.fetchImpl);
  }
}

export function createStructuredLlm(cfg: LlmConfig, fetchImpl: typeof fetch = fetch): StructuredLlm | undefined {
  const provider = configured(cfg.provider) ? cfg.provider.toLowerCase() : "mock";
  if (provider === "mock" || cfg.model === undefined || cfg.model === "") return undefined;
  const baseUrl = configured(cfg.baseUrl) ? cfg.baseUrl : provider === "openai" ? OPENAI_BASE_URL : provider === "ollama" ? OLLAMA_BASE_URL : undefined;
  if (baseUrl === undefined) return undefined;
  if (provider !== "ollama" && (cfg.apiKey === undefined || cfg.apiKey === "") && !LOCAL_LLM_URL.test(baseUrl)) return undefined;
  return new OpenAIStructuredLlm({
    model: cfg.model, provider, baseUrl, apiKey: cfg.apiKey,
    reasoningEffort: provider === "openai" ? cfg.reasoningEffort : undefined,
    timeoutMs: provider === "ollama" ? 60_000 : 30_000,
  }, fetchImpl);
}
