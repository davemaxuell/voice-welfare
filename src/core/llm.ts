// LLM 호출(모든 단계가 함께 씀): OpenAI 호환 Chat Completions + strict json_schema.
// openai·qwen/openai-compatible. 모델 ID는 코드에 두지 않고 .env로만. 실패하면 undefined(호출자가 규칙으로 대체).
// 의도 계획 프롬프트·스키마는 understanding/llm_planner.ts.
// 화면 사진은 글 호출(generate)과 다른 클래스·다른 메서드(OpenAIVisionLlm.see)로만 간다.
// 전용 Ollama 공급자는 없다(주인 결정 2026-11-20): 로컬 서버는 openai-compatible과 LLM_BASE_URL로 쓴다.
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { raceAbort } from "./abort.ts";
import { Picture } from "./picture.ts";
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

type ContentPart =
  | { type: "text"; text: string }
  | { type: "file"; file: { filename: string; file_data: string } }
  | { type: "image_url"; image_url: { url: string; detail?: string } };
type ChatContent = Redacted | readonly ContentPart[];

/** 모델에 첨부해 보내는 파일 하나(받은 PDF·이미지). 사진(Picture)과 달리 가림 계약이 없고 글 호출에만 붙는다. */
export class FileAttachment {
  readonly name: string;
  readonly mime: string;
  readonly content: Uint8Array;

  constructor(name: string, mime: string, content: Uint8Array) {
    this.name = name;
    this.mime = mime;
    this.content = content;
    Object.freeze(this);
  }

  contentPart(): ContentPart {
    const url = `data:${this.mime};base64,${Buffer.from(this.content).toString("base64")}`;
    if (this.mime === "application/pdf") return { type: "file", file: { filename: this.name, file_data: url } };
    return { type: "image_url", image_url: { url } };
  }
}

export interface LlmRequest {
  system: string;
  user: Redacted;
  schemaName: string;
  schema: object;
  signal?: AbortSignal;
  attachment?: FileAttachment;
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
export const LOCAL_LLM_URL = /localhost|127\.0\.0\.1/u;

// 위임한 한 턴이 공유 클라이언트를 바꾸지 않고 한 모델 계열의 추론량만 바꿀 수 있다. 값은 [모델 계열, 추론량]이다.
export const REASONING_EFFORT_OVERRIDE = new AsyncLocalStorage<readonly [family: string, effort: string] | null>();

export function resolveReasoningEffort(model: string, baseUrl: string, fallback?: string): string | undefined {
  const override = REASONING_EFFORT_OVERRIDE.getStore();
  if (override !== undefined && override !== null && baseUrl.replace(/\/+$/u, "") === OPENAI_BASE_URL) {
    const [family, effort] = override;
    if (model === family || model.startsWith(`${family}-`)) return effort;
  }
  return fallback;
}

// 글 하나만 돌려받는 구조화 출력(번역, 쉬운 말로 다시 말하기, 본문 요약이 함께 쓴다)
export const SIMPLE_TEXT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 역할별 인증은 요청에만 두고, 런타임이 이 연결 묶음을 함께 쓴다. Node의 fetch가 연결을 다시 쓰고 쿠키 저장소가 없어서
 * 풀 자체는 하는 일이 적다. 시험이 가짜 fetch를 넣는 자리이고, close는 진행 중인 요청을 끊는다.
 */
export class ModelConnections {
  readonly #fetch: typeof fetch;
  readonly #inFlight = new Set<AbortController>();

  constructor(fetchImpl: typeof fetch = fetch) {
    this.#fetch = fetchImpl;
  }

  async post(url: string, headers: Record<string, string>, body: string, signal?: AbortSignal): Promise<Response> {
    const own = new AbortController();
    this.#inFlight.add(own);
    try {
      const response = await this.#fetch(url, {
        method: "POST", headers, body, signal: signal === undefined ? own.signal : AbortSignal.any([signal, own.signal]),
      });
      // httpx처럼 본문까지 다 받은 뒤에 돌려준다. close가 본문을 받는 중에도 끊을 수 있게 이 안에서 읽는다.
      return new Response(await response.arrayBuffer(), { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      this.#inFlight.delete(own);
    }
  }

  async close(): Promise<void> {
    for (const request of this.#inFlight) request.abort();
    this.#inFlight.clear();
  }
}

/** POST → JSON. 실패하면 undefined. */
export async function postJson(
  url: string, headers: Record<string, string>, body: unknown, timeoutS: number, signal?: AbortSignal, pool?: ModelConnections,
): Promise<unknown> {
  try {
    const timeout = AbortSignal.timeout(timeoutS * 1000);
    const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
    return await raceAbort(async (active) => {
      const response = await (pool ?? new ModelConnections()).post(url, headers, JSON.stringify(body), active);
      if (!response.ok) return undefined;
      const parsed: unknown = await response.json();
      return parsed;
    }, combined);
  } catch {
    return undefined;
  }
}

const envelope = z.object({
  choices: z.tuple([z.object({
    message: z.object({ content: z.string(), refusal: z.unknown().optional() }),
  })]).rest(z.unknown()),
});

export function messageContent(body: unknown): string | undefined {
  const parsed = envelope.safeParse(body);
  if (!parsed.success) return undefined;
  const { content, refusal } = parsed.data.choices[0].message;
  return content.length === 0 || Boolean(refusal) ? undefined : content;
}

// strict 스키마가 요구하는 null 속성을 지운다. 배열의 null은 자리를 유지한다.
function parseContent(content: string): unknown {
  try {
    return JSON.parse(content, function (this: unknown, _key: string, value: unknown) {
      return value === null && !Array.isArray(this) ? undefined : value;
    });
  } catch {
    return undefined;
  }
}

export interface ChatEndpoint {
  baseUrl: string;
  model: string;
  apiKey?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  provider?: string;
  pool?: ModelConnections;
}

type ResponseFormat = { type: "json_schema"; json_schema: { name: string; strict: true; schema: object } } | { type: "json_object" };
interface ChatRequest {
  system: string;
  user: ChatContent;
  format: ResponseFormat;
  signal?: AbortSignal;
}

function effortFor(endpoint: ChatEndpoint, format: ResponseFormat): string | undefined {
  if (format.type !== "json_schema") return undefined;
  const base = configured(endpoint.reasoningEffort) ? endpoint.reasoningEffort : undefined;
  const effort = (endpoint.provider ?? "openai").toLowerCase() === "openai"
    ? resolveReasoningEffort(endpoint.model, endpoint.baseUrl, base) : base;
  return configured(effort) ? effort : undefined;
}

/** 채팅 한 번의 응답 본문 그대로(실패하면 undefined). 글 호출·사진 호출·의도 분류가 같은 요청과 같은 실패 처리를 쓴다. */
async function requestChat(endpoint: ChatEndpoint, request: ChatRequest): Promise<unknown> {
  const body = {
    model: endpoint.model,
    response_format: request.format,
    reasoning_effort: effortFor(endpoint, request.format),
    temperature: request.format.type === "json_object" ? 0 : undefined,
    messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (configured(endpoint.apiKey)) headers.Authorization = `Bearer ${endpoint.apiKey}`;
  const timeoutMs = endpoint.timeoutMs === undefined || endpoint.timeoutMs === 0 ? 30_000 : endpoint.timeoutMs;
  return postJson(`${endpoint.baseUrl.replace(/\/+$/u, "")}/chat/completions`, headers, body, timeoutMs / 1000, request.signal, endpoint.pool);
}

export async function chatCompletion(
  endpoint: ChatEndpoint, request: ChatRequest, fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const content = messageContent(await requestChat({ ...endpoint, pool: endpoint.pool ?? new ModelConnections(fetchImpl) }, request));
  return content === undefined ? undefined : parseContent(content);
}

/** Python urllib.parse.urlsplit(url).hostname: 주소 모양이 아니면 undefined, 있으면 소문자. */
function splitHostname(url: string): string | undefined {
  const cleaned = url.replace(/^[\u0000-\u0020]+/u, "").replace(/[\t\n\r]/gu, "");
  const found = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/([^/?#]*)/u.exec(cleaned);
  if (found === null) return undefined;
  const host = (found[1] ?? "").slice((found[1] ?? "").lastIndexOf("@") + 1);
  const name = host.startsWith("[") ? host.slice(1).split("]")[0] : host.split(":")[0];
  return name === undefined || name.length === 0 ? undefined : name.toLowerCase();
}

/** Chat Completions 한 번(strict json_schema). 글 호출과 사진 호출이 같은 요청·같은 실패 처리(undefined)를 쓴다. */
class OpenAIChat {
  readonly model: string;
  readonly baseUrl: string;
  readonly reasoningEffort: string | undefined;
  readonly timeoutMs: number;
  readonly provider: string;
  readonly name: string;
  readonly fileRecipient: string;
  readonly pool: ModelConnections | undefined;
  readonly usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  readonly #apiKey: string | undefined;

  constructor(options: ChatEndpoint) {
    this.model = options.model;
    this.pool = options.pool;
    this.baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.reasoningEffort = options.reasoningEffort;
    this.timeoutMs = options.timeoutMs === undefined || options.timeoutMs === 0 ? 30_000 : options.timeoutMs;
    this.provider = configured(options.provider) ? options.provider : "openai";
    this.name = `${this.provider}(${options.model})`;
    this.fileRecipient = options.baseUrl.replace(/\/+$/u, "") === OPENAI_BASE_URL
      ? "OpenAI" : `설정된 서버 ${splitHostname(options.baseUrl) ?? "None"}`;
  }

  /** 키는 열거되지 않는 읽기 전용 값이라 JSON·로그에 실려 나가지 않는다. */
  get apiKey(): string | undefined {
    return this.#apiKey;
  }

  protected async ask(
    request: { system: string; content: ChatContent; schemaName: string; schema: object; signal?: AbortSignal },
  ): Promise<unknown> {
    this.usage.calls++;
    const raw = await requestChat({
      baseUrl: this.baseUrl, model: this.model, apiKey: this.#apiKey, reasoningEffort: this.reasoningEffort,
      timeoutMs: this.timeoutMs, provider: this.provider, pool: this.pool,
    }, {
      system: request.system, user: request.content, signal: request.signal,
      format: { type: "json_schema", json_schema: { name: request.schemaName, strict: true, schema: request.schema } },
    });
    const usage = isRecord(raw) ? raw.usage : undefined;
    if (isRecord(usage)) {
      const input = usage.prompt_tokens, output = usage.completion_tokens;
      if (typeof input === "number" && Number.isInteger(input)) this.usage.inputTokens += input;
      if (typeof output === "number" && Number.isInteger(output)) this.usage.outputTokens += output;
    }
    const content = messageContent(raw);
    return content === undefined ? undefined : parseContent(content);
  }
}

/** OpenAI Structured Outputs(strict json_schema) 범용 호출. 실패하면 undefined(호출자가 규칙 기반으로 대체). */
export class OpenAIStructuredLlm extends OpenAIChat implements StructuredLlm {
  generate({ system, user, schemaName, schema, signal, attachment }: LlmRequest): Promise<unknown> {
    if (attachment === undefined) return this.ask({ system, content: user, schemaName, schema, signal });
    if (this.provider !== "openai") return Promise.resolve(undefined);
    return this.ask({ system, content: [{ type: "text", text: user }, attachment.contentPart()], schemaName, schema, signal });
  }
}

/**
 * 화면 사진 한 장을 보는 호출. generate가 없어 글 역할(의도·목표·답)을 대신할 수 없고,
 * see는 Picture(가림이 끝난 사진)만 받는다. 바이트·파일 경로·주소를 받는 길은 없다.
 */
export class OpenAIVisionLlm extends OpenAIChat {
  readonly detail: string;

  constructor(options: ChatEndpoint & { detail?: string }) {
    super(options);
    this.detail = options.detail ?? "high";
  }

  async see({ system, user, picture, schemaName, schema, signal }: {
    system: string; user: Redacted; picture: Picture; schemaName: string; schema: object; signal?: AbortSignal;
  }): Promise<unknown> {
    if (!Picture.isPicture(picture)) throw new TypeError("see는 Picture만 받습니다.");
    return this.ask({
      system, schemaName, schema, signal,
      content: [{ type: "text", text: user }, { type: "image_url", image_url: { url: picture.dataUrl(), detail: this.detail } }],
    });
  }
}

// openai는 키가 필요하고, qwen·openai-compatible은 LLM_BASE_URL이 필요하다(예: DashScope 호환 모드). 그 밖의 값(ollama 포함)은 지원하지 않는다.
const PROVIDERS = new Set(["openai", "qwen", "openai-compatible"]);

/** [공급자, 주소]. 쓸 수 없는 설정(mock, 지원하지 않는 공급자, 모델·주소·키 없음)이면 undefined. */
function endpointOf(cfg: LlmConfig): { provider: string; baseUrl: string } | undefined {
  const provider = configured(cfg.provider) ? cfg.provider.toLowerCase() : "mock";
  if (provider === "mock" || !configured(cfg.model) || !PROVIDERS.has(provider)) return undefined;
  const baseUrl = configured(cfg.baseUrl) ? cfg.baseUrl : provider === "openai" ? OPENAI_BASE_URL : undefined;
  if (baseUrl === undefined) return undefined;
  if (!configured(cfg.apiKey) && !LOCAL_LLM_URL.test(baseUrl)) return undefined;
  return { provider, baseUrl };
}

/**
 * 구조화 LLM 만들기. OpenAI 호환 Chat Completions + json_schema를 쓰는 공급자를 지원한다.
 *  - openai: 키 필요, reasoning_effort 사용
 *  - qwen / openai-compatible: LLM_BASE_URL 필요. 로컬 서버(localhost·127.0.0.1)는 키 없이도 된다.
 */
export function createStructuredLlm(cfg: LlmConfig, { pool }: { pool?: ModelConnections } = {}): OpenAIStructuredLlm | undefined {
  const at = endpointOf(cfg);
  if (at === undefined || !configured(cfg.model)) return undefined;
  return new OpenAIStructuredLlm({
    pool, provider: at.provider, model: cfg.model, baseUrl: at.baseUrl, apiKey: cfg.apiKey,
    // reasoning_effort는 OpenAI 추론 모델 전용(다른 공급자는 거부할 수 있음)
    reasoningEffort: at.provider === "openai" ? cfg.reasoningEffort : undefined,
    timeoutMs: cfg.timeoutMs === undefined || cfg.timeoutMs === 0 ? undefined : cfg.timeoutMs,
  });
}

/**
 * 사진 모델 만들기(LLM_VISION_* 역할). 주인 결정(2026-11-18): 화면 사진은 OpenAI로만 보낸다.
 * 공급자가 openai가 아니거나 모델·키가 없으면 undefined이고, 그때는 사진 기능이 없다(다른 공급자로 대신하지 않는다).
 */
export function createVisionLlm(cfg: LlmConfig, { detail = "high", pool }: { detail?: string; pool?: ModelConnections } = {}): OpenAIVisionLlm | undefined {
  const at = endpointOf(cfg);
  if (at === undefined || at.provider !== "openai" || at.baseUrl.replace(/\/+$/u, "") !== OPENAI_BASE_URL || !configured(cfg.apiKey)) return undefined;
  if (!configured(cfg.model)) return undefined;
  return new OpenAIVisionLlm({
    pool, provider: "openai", model: cfg.model, baseUrl: at.baseUrl, apiKey: cfg.apiKey, reasoningEffort: cfg.reasoningEffort,
    timeoutMs: cfg.timeoutMs === undefined || cfg.timeoutMs === 0 ? 120_000 : cfg.timeoutMs, detail,
  });
}
