import { z } from "zod";
import { join } from "node:path";
import { REPO_ROOT } from "../src/core/assets.ts";

export const PORTAL = "127.0.0.1:5174/external.html";
export const PORTAL2 = "127.0.0.1:5174/portal2.html";

export interface LlmRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: object;
  signal?: AbortSignal;
}

interface TestLlm {
  name: string;
  generate(request: LlmRequest): Promise<unknown>;
}

interface SessionWithLlm {
  deps: { llm?: TestLlm | null; welfare: { llm?: TestLlm | null } };
}

export function testRuntimeEnv(overrides: Record<string, string> = {}) {
  const headed = process.env.HEADED === "1";
  return {
    MOCK_SITE_URL: "http://localhost:5174",
    HEADLESS: headed ? "false" : "true",
    BROWSER_SLOWMO_MS: headed ? "200" : "0",
    LLM_PROVIDER: "mock",
    DATASETS_DIR: join(REPO_ROOT, "tests/fixtures/open_data"),
    REQUIRE_CONSENT: "false",
    READ_ONLY_WEB: "true",
    READ_ONLY_CLICKS: "safe",
    VISUAL_CURSOR: "false",
    WEB_SEARCH_URL: "http://127.0.0.1:5174/external.html?q={q}",
    ...overrides,
  };
}

export function createTestRuntime<T>(env: Record<string, string>, build: (env: Record<string, string>) => T): T {
  return build(testRuntimeEnv(env));
}

export class FakeLlm implements TestLlm {
  name = "fake";
  calls: LlmRequest[] = [];
  private readonly answers: Record<string, unknown>;
  private readonly reply?: (request: LlmRequest) => unknown;

  constructor(answers: Record<string, unknown> | ((request: LlmRequest) => unknown) = {}, reply?: (request: LlmRequest) => unknown) {
    this.answers = typeof answers === "function" ? {} : answers;
    this.reply = typeof answers === "function" ? answers : reply;
  }

  async generate(request: LlmRequest) {
    this.calls.push(request);
    return this.reply === undefined ? this.answers[request.schemaName] : this.reply(request);
  }
}

export function withLlm(session: SessionWithLlm, llm: TestLlm) {
  session.deps.llm = llm;
  session.deps.welfare.llm = llm;
}

export function step(action: string, target: string | null = null, answer: string | null = null, evidence: string[] | null = null) {
  return { thought: "", action, target, answer, evidence };
}

type Steps = [ReturnType<typeof step>, ...ReturnType<typeof step>[]];

const BrowseRequest = z.looseObject({
  page: z.looseObject({ mainText: z.string(), items: z.array(z.looseObject({
    name: z.string(), kind: z.string(), expanded: z.boolean().optional(),
  })) }).nullable(),
});
export function scripted(session: SessionWithLlm, steps: Steps) {
  const seen: z.infer<typeof BrowseRequest>[] = [];
  session.deps.llm = new FakeLlm({}, ({ schemaName, user }) => {
    if (schemaName !== "browse_step") return undefined;
    seen.push(BrowseRequest.parse(JSON.parse(user)));
    return steps[Math.min(seen.length, steps.length) - 1];
  });
  return seen;
}

function latch() {
  let open = () => {};
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { open, wait };
}

export class Gate implements TestLlm {
  name = "gated";
  private readonly steps: Steps;
  private readonly at: number;
  private readonly entered = latch();
  private readonly resume = latch();
  readonly reached = this.entered.wait;
  readonly release = this.resume.open;
  calls = 0;

  constructor(steps: Steps, at: number) {
    this.steps = steps;
    this.at = at;
  }

  async generate(request: LlmRequest) {
    if (request.schemaName !== "browse_step") return undefined;
    this.calls++;
    if (this.calls === this.at) {
      this.entered.open();
      await this.resume.wait;
    }
    return this.steps[Math.min(this.calls, this.steps.length) - 1];
  }
}

export function fieldValue(result: { observation?: { fields?: { fieldId: string; value?: string }[] } }, id: string) {
  return result.observation?.fields?.find((field) => field.fieldId === id)?.value;
}

export function fakeFetch(handler: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request.clone());
    return handler(request);
  };
  return Object.assign(fetch, { calls });
}
