// OpenAI roles in the public-service agent. Endpoints and credentials belong to the runtime.
import { ModelConnections, OPENAI_BASE_URL, postJson } from "./llm.ts";

export interface ModelStack {
  readonly voice: string;
  readonly agent: string;
  readonly utility: string;
  readonly vision: string;
  readonly recovery: string;
  readonly embedding: string;
  readonly transcription: string;
  readonly moderation: string;
}

export const STACK: ModelStack = Object.freeze({
  voice: "gpt-live-1",
  agent: "gpt-6.2-sol",
  utility: "gpt-6-luna",
  vision: "gpt-6.1-terra",
  recovery: "gpt-6.2-astra",
  embedding: "text-embedding-3-small",
  transcription: "gpt-transcribe",
  moderation: "omni-moderation-latest",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class OpenAIService {
  readonly model: string;
  readonly #key: string;
  readonly #connections: ModelConnections;

  constructor(key: string, model: string, connections: ModelConnections) {
    this.#key = key;
    this.model = model;
    this.#connections = connections;
  }

  protected async request(endpoint: string, text: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (text.trim().length === 0) return {};
    const data = await postJson(`${OPENAI_BASE_URL}/${endpoint}`, {
      Authorization: `Bearer ${this.#key}`, "Content-Type": "application/json",
    }, { model: this.model, input: text }, 15, signal, this.#connections);
    return isRecord(data) ? data : {};
  }
}

export class EmbeddingService extends OpenAIService {
  async embed(text: string, { signal }: { signal?: AbortSignal } = {}): Promise<number[] | undefined> {
    const data = (await this.request("embeddings", text, signal)).data;
    if (!Array.isArray(data) || data.length !== 1 || !isRecord(data[0])) return undefined;
    const vector: unknown = data[0].embedding;
    if (!Array.isArray(vector) || vector.length === 0) return undefined;
    const numbers: number[] = [];
    for (const item of vector) {
      if (typeof item !== "number" || !Number.isFinite(item)) return undefined;
      numbers.push(item);
    }
    return numbers;
  }
}

export class ModerationService extends OpenAIService {
  async screen(text: string, { signal }: { signal?: AbortSignal } = {}): Promise<boolean | undefined> {
    const results = (await this.request("moderations", text, signal)).results;
    if (Array.isArray(results) && results.length === 1 && isRecord(results[0])) {
      const flagged = results[0].flagged;
      if (typeof flagged === "boolean") return flagged;
    }
    return undefined;
  }
}
