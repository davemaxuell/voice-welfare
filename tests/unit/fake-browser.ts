import { ACTION_TYPES, type Action, type Observation } from "../../src/core/actions.ts";
import type { LlmRequest } from "../../src/core/llm.ts";
import { ExecContext, WebExecutionAgent } from "../../src/agents/web/agent.ts";
import { Autopilot, type AutopilotOptions } from "../../src/agents/web/autopilot.ts";
import { createMockWelfareProfile } from "../../src/agents/web/profile.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";

export const page = (url: string, title: string, extra: Partial<Observation> = {}): Observation => ({
  platform: "pc", url, title, fields: [], errors: [], dialogs: [], capturedAt: "",
  outline: { headings: [], notices: [], steps: [], buttons: [], links: [], mainLinks: [], mainText: `${title} 안내 화면입니다.` }, ...extra,
});

/** 주소로 화면을 고르는 가짜 브라우저. 열린 주소와 실행한 조작 종류를 기록한다. */
export function browser(pages: Record<string, Observation>, start = "about:blank") {
  const opened: string[] = [];
  const executed: string[] = [];
  let current = start;
  const adapter = {
    async observe() { return pages[current] ?? page(current, "빈 화면"); },
    async execute(action: Action) {
      executed.push(action.type);
      if (action.type === "navigate" && action.url !== undefined) { current = action.url; opened.push(action.url); }
      return { actionId: action.id, ok: true, verified: true, latencyMs: 0 };
    },
    async close() {},
  };
  return { adapter, opened, executed };
}

export function pilot(pages: Record<string, Observation>, replies: unknown[], options: Partial<AutopilotOptions> = {}, start = "about:blank") {
  const profile = createMockWelfareProfile("http://localhost:5174");
  const guard = new PolicyGuard({ allowedOrigins: [profile.origin], allowedActionTypes: ACTION_TYPES, allowedFieldIds: [],
    secretFieldIds: [], maxActionsPerTurn: 12, readOnlyWeb: true });
  const fake = browser(pages, start);
  const requests: LlmRequest[] = [];
  const llm = { name: "test", async generate(request: LlmRequest) { requests.push(request); return replies.shift(); } };
  const auto = new Autopilot(new WebExecutionAgent(fake.adapter, guard, profile), llm, { searchUrl: q => profile.origin + "?q=" + encodeURIComponent(q), ...options });
  return { auto, requests, ...fake };
}

export const context = (signal = new AbortController().signal) => new ExecContext({ signal, isStopped: () => signal.aborted, trace() {} });
